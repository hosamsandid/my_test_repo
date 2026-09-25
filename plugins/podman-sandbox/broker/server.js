'use strict';

// Built-in Podman MCP server. Holds the Podman socket and exposes container
// tools that are strictly scoped to the caller's namespace via the
// aee.mcp-owner=<scopeId> label. Least privilege: this process mounts ONLY
// the socket + the signing secret; it never reads the workspace or any
// credential store. Auth: Bearer <per-scope signed token>.
const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');

// Broker SDK (plugin system Phase 4, #1520): the obligations every plugin
// broker shares — bearer-token verification, ownership-label scope filtering,
// secret masking, and the health/teardown routes — now come from the shared
// SDK instead of this broker's own podman-token.js / owner-scope.js /
// mask-env.js copies (those stay in the tree as the SDK's extraction seed +
// reference tests). Two intentional generalisations ride along: the bearer
// token is the 3-field platform scope token `{pluginId, scopeId}` (the broker
// still enforces on scopeId and never branches on pluginId or granularity), and
// the owner label is the platform-wide `aee.plugin.owner` (broker-sdk/
// scope-filter.js) so the orchestrator's teardown/reconcile pass and this
// broker agree on which resources belong to a scope. Container isolation
// behaviour is otherwise unchanged.
const {
  withUnexpectedErrors,
  verifyScopeToken,
  OWNER_LABEL_KEY,
  ownerLabelArg,
  isOwned,
  filterOwned,
  maskEnvValues,
  maskSecretsOrDefault,
  healthEndpoint,
  teardownScopeEndpoint,
  brokerConfig,
  quotaExceeded,
} = require('../../../broker-sdk');
const { validateComposeFile } = require('./compose-validate');
const { enforceNetworkIsolation, injectResourceDefaults } = require('./compose-harden');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// Runtime config comes from the orchestrator through the SDK's plugin-neutral
// AEE_PLUGIN_* env contract (#1547). The pre-plugin-system PODMAN_MCP_* names
// stay honoured as fallbacks so a hand-run broker keeps working.
const CONFIG = brokerConfig({
  fallbacks: {
    port: ['PODMAN_MCP_PORT'],
    signingSecret: ['PODMAN_MCP_SIGNING_SECRET'],
  },
});

const PORT = CONFIG.port;
const SIGNING_SECRET = CONFIG.signingSecret;
const SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';

// --- podman CLI against the mounted socket -------------------------------
function podman(args, { input } = {}) {
  const res = spawnSync('podman', ['--url', `unix://${SOCK}`, ...args], {
    encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// --- podman-compose CLI against the mounted socket -----------------------
// The bundled `podman` (4.3.1) does not support `compose` subcommand
// delegation at all, so compose operations invoke the standalone
// `podman-compose` binary directly instead of going through podman() above.
// It talks to the socket via CONTAINER_HOST rather than a `--url` flag,
// since it is not a `podman` CLI invocation.
function podmanCompose(args, { input } = {}) {
  const res = spawnSync('podman-compose', args, {
    encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CONTAINER_HOST: `unix://${SOCK}` },
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function sanitizeToken(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// --- per-scope quota (manifest `quota`, §4.6) ----------------------------
// #1287 shipped a GLOBAL container cap read over HTTP from the admin console's
// /internal/platform-settings. That endpoint was never merged, so the fetch
// always failed and — by design — failed open: no cap was ever enforced.
//
// The plugin system replaced that model (#1519): the cap is declared in the
// plugin manifest as `quota: { maxObjects, ttlSeconds? }` and enforced PER
// SCOPE, which is the unit that actually matters. A runaway loop-triggered
// agent should hit its own ceiling without being able to starve every other
// scope, and n members at agent granularity are n independent budgets — the
// grant UI states that ceiling before the toggle. The orchestrator passes the
// manifest's values in as AEE_PLUGIN_QUOTA_* at sidecar start; no cross-service
// call is involved, so there is nothing left to fail open.
const QUOTA = CONFIG.quota;
const TTL_SWEEP_INTERVAL_MS = Number(process.env.PLUGIN_TTL_SWEEP_MS) || 60000;

// --- scope-enforcing operations -----------------------------------------

// List this scope's containers (name,status,labels) via podman ps --format json.
function listOwned(scopeId) {
  const r = podman(['ps', '-a', '--filter', `label=${ownerLabelArg(scopeId)}`, '--format', 'json']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'podman ps failed');
  let arr = [];
  try { arr = JSON.parse(r.stdout || '[]'); } catch { arr = []; }
  // Defense in depth: the podman-side filter should already restrict to this
  // scope, but re-check with the shared isOwned() predicate so there is a
  // single, unit-tested source of truth for "is this container mine".
  return filterOwned(arr, scopeId);
}

// Every container owned by ANY scope (key-only label filter — `label=<key>`
// with no `=value` matches the label being present at all). Not a quota input
// any more: quotas are per scope. This backs the TTL sweep, which must see
// every scope's containers because no single caller's request is what expires
// them.
function listAllOwned() {
  const r = podman(['ps', '-a', '--filter', `label=${OWNER_LABEL_KEY}`, '--format', 'json']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'podman ps failed');
  let arr = [];
  try { arr = JSON.parse(r.stdout || '[]'); } catch { arr = []; }
  return Array.isArray(arr) ? arr : [];
}

// Reap containers older than the manifest's `quota.ttlSeconds`, across all
// scopes. This is the backstop that makes a granularity flip safe (§4.6):
// resources left under a previous scopeId keep their owner label and are never
// migrated, so without a TTL they would linger until the scope is torn down.
// Best-effort and silent on individual failures — a sweep that throws would
// take the broker's timer down with it.
function sweepExpired() {
  const ttl = QUOTA.ttlSeconds;
  if (!ttl) return { reaped: [] };
  let containers;
  try { containers = listAllOwned(); } catch { return { reaped: [] }; }
  const cutoff = Date.now() - ttl * 1000;
  const reaped = [];
  for (const c of containers) {
    // podman ps --format json reports Created as a unix timestamp (seconds).
    const createdMs = typeof c.Created === 'number'
      ? c.Created * 1000
      : Date.parse(c.Created || '');
    if (!Number.isFinite(createdMs) || createdMs > cutoff) continue;
    const id = c.Id || (Array.isArray(c.Names) ? c.Names[0] : null);
    if (!id) continue;
    const r = podman(['rm', '-f', id]);
    if (r.code === 0) reaped.push(id);
  }
  if (reaped.length) {
    process.stdout.write(`[podman-mcp] TTL sweep reaped ${reaped.length} expired container(s)\n`);
  }
  return { reaped };
}

// Resolve a container the caller named, enforcing ownership. Returns the
// libpod inspect object or throws a not-found-style error (no cross-scope
// existence disclosure).
function resolveOwned(nameOrId, scopeId) {
  const r = podman(['inspect', nameOrId, '--format', 'json']);
  if (r.code !== 0) throw new Error(`no such container: ${nameOrId}`);
  let obj;
  try {
    const parsed = JSON.parse(r.stdout);
    obj = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new Error(`no such container: ${nameOrId}`);
  }
  if (!obj) throw new Error(`no such container: ${nameOrId}`);
  const labels = (obj.Config && obj.Config.Labels) || obj.Labels || {};
  if (!isOwned({ Labels: labels }, scopeId)) throw new Error(`no such container: ${nameOrId}`);
  return obj;
}

// Compose working dir per (scope, project) — isolated. Keyed by scopeId AND
// the sanitized project name so a scope running more than one compose
// project (multiple `compose_up` calls with different `projectName`s) gets
// a distinct directory per project instead of one call's compose file
// overwriting another's on disk. The compose file content is provided by
// the caller; we stamp the owner label at create time (see
// injectOwnerLabels) so every service in the stack carries it.
function scopeComposeDir(scopeId, projectName) {
  const dir = path.join(
    os.tmpdir(), 'podman-mcp', sanitizeToken(scopeId), sanitizeToken(projectName || 'default'),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// podman does not allow adding labels to an existing container, and compose
// project names are a global (unscoped) concept in podman — so we (a) inject
// the owner label into every service at create time, from the caller's
// compose YAML, and (b) always namespace the compose project name with the
// scopeId so two callers can never collide on (and thus operate on) the same
// project, even if they both pass the same `projectName`. Also the single
// choke-point that hardens every compose file before it ever reaches disk or
// podman-compose: forces network isolation (enforceNetworkIsolation) and
// injects default resource ceilings (injectResourceDefaults).
function injectOwnerLabels(composeFile, scopeId) {
  const doc = YAML.parse(composeFile) || {};
  doc.services = doc.services || {};
  for (const name of Object.keys(doc.services)) {
    const svc = doc.services[name] || {};
    const labels = svc.labels || {};
    if (Array.isArray(labels)) {
      // Strip any pre-existing aee.mcp-owner entry the caller's YAML may
      // already carry so there is exactly one, deterministic winner —
      // podman's duplicate-key precedence for repeated `KEY=value` array
      // entries is not something we should rely on.
      const filtered = labels.filter((l) => !(typeof l === 'string' && l.startsWith(`${OWNER_LABEL_KEY}=`)));
      filtered.push(`${OWNER_LABEL_KEY}=${scopeId}`);
      svc.labels = filtered;
    } else {
      labels[OWNER_LABEL_KEY] = scopeId;
      svc.labels = labels;
    }
    doc.services[name] = svc;
  }
  enforceNetworkIsolation(doc);
  injectResourceDefaults(doc);
  return YAML.stringify(doc);
}

// Always scope the compose project name by scopeId so compose_down/logs can
// never be pointed at another scope's project, regardless of what
// `projectName` the caller supplies.
function projectFor(scopeId, projectName) {
  return `scope-${sanitizeToken(scopeId)}-${sanitizeToken(projectName || 'default')}`;
}

// --- scope teardown (called only from the orchestrator's delete cascade) --
// Remove every container owned by scopeId, best-effort. This is the LAST
// chance to ever legitimately clean these up: the caller deletes the
// scope's token/config right after this call, so nobody can re-derive
// ownership afterward. Direct force-stop + force-rm rather than
// reconstructing `podman-compose down` — a container's compose file may no
// longer exist on this service's own (os.tmpdir()-based, ephemeral) disk if
// podman-mcp itself has restarted since the compose_up that created it, so
// replaying compose teardown here could silently leave containers behind.
// Force-stop/rm works regardless of whether a container was created via
// compose_up or a plain tool call.
function teardownScopeContainers(scopeId) {
  const removed = [];
  const errors = [];
  const owned = listOwned(scopeId);
  for (const c of owned) {
    const name = (Array.isArray(c.Names) && c.Names[0]) || c.Names || c.Name || c.Id || '';
    if (!name) continue;
    // `rm -f` alone stops (force-kills) and removes in one step — no
    // separate `podman stop` first. A plain `stop` defaults to a ~10s
    // SIGTERM grace period per container before the timeout even fires,
    // which can blow well past this endpoint's caller-side timeout for a
    // scope with more than a couple of containers, for a purely cosmetic
    // (avoid-a-SIGKILL-log-line) benefit. This is teardown of an orphaned
    // scope, not a graceful shutdown, so force-kill immediately.
    const rm = podman(['rm', '-f', name]);
    if (rm.code === 0) {
      removed.push(name);
    } else {
      errors.push({ name, error: rm.stderr.trim() || 'podman rm failed' });
    }
  }
  return { removed, errors };
}

// Deliberately NO network cleanup here. An earlier version matched
// compose-created networks by `name.startsWith('scope-<scopeId>-')`, but
// that is a prefix match on the raw scopeId, not an exact one — a scope
// whose id is a leading substring of a sibling's (e.g. deleting
// `bank-transfer-team` while `bank-transfer-team-2` is still live) would
// match and attempt to remove the sibling's still-in-use network. podman's
// in-use guard blocks the removal while that sibling has running
// containers, but nothing guarantees the sibling is never idle at exactly
// that moment — a cross-scope action must be structurally impossible here,
// not just usually blocked. Reconstructing the exact set of project names a
// scope ever used (the only collision-free alternative, via
// `projectFor(scopeId, projectName)`) isn't tracked anywhere on this
// service, and the task's actual requirement is container cleanup, not
// networks — a stray empty compose network left behind by a torn-down
// scope is a much smaller footprint than the isolation risk, and podman's
// own bookkeeping doesn't require it to be removed. Containers are always
// force-removed via teardownScopeContainers() above regardless.
function teardownScope(scopeId) {
  const { removed, errors } = teardownScopeContainers(scopeId);
  return { removed, errors };
}

// --- MCP tool implementations (each derives scopeId from the request auth) -

// Only compose_up ever CREATES new containers — every other tool
// (container_exec/stop/rm/etc.) operates on containers that already exist —
// so the quota is enforced here only, before podman-compose is ever invoked
// for a call that would push THIS SCOPE over its ceiling.
async function toolComposeUp(scopeId, { composeFile, projectName } = {}) {
  if (!composeFile || typeof composeFile !== 'string') {
    throw new Error('composeFile is required');
  }
  const doc = YAML.parse(composeFile) || {};

  // Reject dangerous compose primitives before any disk I/O or subprocess call.
  // owner-label injection and project-name scoping protect post-creation ops
  // but do not validate creation-time fields like privileged / network_mode:
  // host / pid: host / dangerous cap_add / absolute host bind-mounts.
  const validation = validateComposeFile(doc);
  if (!validation.ok) {
    return { ok: false, error: `compose file rejected: ${validation.error}` };
  }

  const newServiceCount = Object.keys(doc.services || {}).length;
  // Per-scope, counted with the same ownership filter every other tool uses —
  // so what a caller is charged for is exactly what `container_list` shows it.
  const quotaError = quotaExceeded(QUOTA, listOwned(scopeId).length, { adding: newServiceCount });
  if (quotaError) {
    return {
      ok: false,
      error: `${quotaError} — this call would add ${newServiceCount} more. `
        + 'Remove containers you no longer need with `aee-podman compose down` or `aee-podman rm <name>`.',
    };
  }

  const dir = scopeComposeDir(scopeId, projectName);
  const stamped = injectOwnerLabels(composeFile, scopeId);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), stamped);
  const project = projectFor(scopeId, projectName);
  const r = podmanCompose(['-p', project, '--file', path.join(dir, 'docker-compose.yml'), 'up', '-d', '--no-recreate']);
  return { ok: r.code === 0, project, output: maskEnvValues((r.stdout + r.stderr).trim()) };
}

// The reconstructed compose file lives under os.tmpdir() (see
// scopeComposeDir), which does NOT survive a podman-mcp service restart or a
// tmp-cleanup. Running podman-compose against a missing file just produces a
// generic, low-signal error from the compose tool itself — check for it
// up front so callers get an actionable message instead.
function missingComposeFileMessage(project, composePath) {
  return `compose file for project '${project}' no longer exists (podman-mcp may have restarted since it was created) — use container_list to find any still-running containers from this project, and container_stop/container_rm to remove them individually`;
}

function toolComposeDown(scopeId, { projectName } = {}) {
  const project = projectFor(scopeId, projectName);
  const dir = scopeComposeDir(scopeId, projectName);
  const composePath = path.join(dir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    return { ok: false, project, output: missingComposeFileMessage(project, composePath) };
  }
  const r = podmanCompose(['-p', project, '--file', composePath, 'down']);
  return { ok: r.code === 0, project, output: maskEnvValues((r.stdout + r.stderr).trim()) };
}

function toolComposeLogs(scopeId, { projectName, tail } = {}) {
  const project = projectFor(scopeId, projectName);
  const dir = scopeComposeDir(scopeId, projectName);
  const composePath = path.join(dir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    throw new Error(missingComposeFileMessage(project, composePath));
  }
  const n = Number.isInteger(tail) && tail > 0 ? tail : 100;
  const r = podmanCompose(['-p', project, '--file', composePath, 'logs', '--tail', String(n)]);
  if (r.code !== 0) throw new Error(maskSecretsOrDefault(r.stderr.trim(), 'podman-compose logs failed'));
  return { project, output: maskEnvValues(r.stdout) };
}

function toolContainerList(scopeId) {
  return listOwned(scopeId).map((c) => ({
    name: (Array.isArray(c.Names) && c.Names[0]) || c.Name || c.Id || '',
    status: c.Status || c.State || '',
    image: c.Image || '',
  }));
}

function toolContainerLogs(scopeId, { name, tail } = {}) {
  if (!name) throw new Error('name is required');
  resolveOwned(name, scopeId);
  const n = Number.isInteger(tail) && tail > 0 ? tail : 100;
  const r = podman(['logs', '--tail', String(n), name]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'podman logs failed');
  return { output: r.stdout };
}

function toolContainerInspect(scopeId, { name } = {}) {
  if (!name) throw new Error('name is required');
  return resolveOwned(name, scopeId);
}

function toolContainerExec(scopeId, { name, cmd } = {}) {
  if (!name) throw new Error('name is required');
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((s) => typeof s === 'string')) {
    throw new Error('cmd must be a non-empty array of strings');
  }
  resolveOwned(name, scopeId);
  const r = podman(['exec', name, ...cmd]);
  return { ok: r.code === 0, exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
}

function toolContainerStop(scopeId, { name } = {}) {
  if (!name) throw new Error('name is required');
  resolveOwned(name, scopeId);
  const r = podman(['stop', name]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'podman stop failed');
  return { ok: true };
}

function toolContainerRm(scopeId, { name } = {}) {
  if (!name) throw new Error('name is required');
  resolveOwned(name, scopeId);
  const r = podman(['rm', '-f', name]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'podman rm failed');
  return { ok: true };
}

// --- tool registry ---------------------------------------------------------
// Every handler receives (scopeId, args) — scopeId always comes from the
// verified bearer token for the current request, never from tool args, so a
// caller cannot name another caller's scope.
const TOOLS = [
  {
    name: 'compose_up',
    description: 'Bring up a compose stack (podman-compose up -d) scoped to the caller. Every service in the compose file is stamped with the caller\'s owner label at create time.',
    inputSchema: {
      type: 'object',
      properties: {
        composeFile: { type: 'string', description: 'Contents of a docker-compose.yml' },
        projectName: { type: 'string', description: 'Optional project name (namespaced under the caller\'s scope regardless)' },
      },
      required: ['composeFile'],
    },
    handler: toolComposeUp,
  },
  {
    name: 'compose_down',
    description: 'Tear down a compose stack previously brought up by this caller.',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'Project name passed to compose_up (optional)' },
      },
    },
    handler: toolComposeDown,
  },
  {
    name: 'compose_logs',
    description: 'Fetch logs for a compose stack previously brought up by this caller.',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: { type: 'string', description: 'Project name passed to compose_up (optional)' },
        tail: { type: 'integer', description: 'Number of lines to tail (default 100)', minimum: 1 },
      },
    },
    handler: toolComposeLogs,
  },
  {
    name: 'container_list',
    description: 'List containers owned by the caller.',
    inputSchema: { type: 'object', properties: {} },
    handler: (scopeId) => toolContainerList(scopeId),
  },
  {
    name: 'container_logs',
    description: 'Fetch logs for a container owned by the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name or id' },
        tail: { type: 'integer', description: 'Number of lines to tail (default 100)', minimum: 1 },
      },
      required: ['name'],
    },
    handler: toolContainerLogs,
  },
  {
    name: 'container_inspect',
    description: 'Inspect a container owned by the caller (full libpod inspect JSON).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name or id' } },
      required: ['name'],
    },
    handler: toolContainerInspect,
  },
  {
    name: 'container_exec',
    description: 'Execute a command inside a container owned by the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name or id' },
        cmd: { type: 'array', items: { type: 'string' }, description: 'Command + args, e.g. ["ls", "-la"]' },
      },
      required: ['name', 'cmd'],
    },
    handler: toolContainerExec,
  },
  {
    name: 'container_stop',
    description: 'Stop a container owned by the caller.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name or id' } },
      required: ['name'],
    },
    handler: toolContainerStop,
  },
  {
    name: 'container_rm',
    description: 'Force-remove a container owned by the caller.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Container name or id' } },
      required: ['name'],
    },
    handler: toolContainerRm,
  },
];

function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

// --- MCP server construction (one per request, scopeId closed over) -------
function buildMcpServer(scopeId) {
  const server = new Server(
    { name: 'podman-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params || {};
    const tool = findTool(name);
    if (!tool) {
      recordCall(scopeId, name || 'unknown', 'usage-error');
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await tool.handler(scopeId, args || {});
      // A tool that returns `{ ok: false }` refused on policy/quota grounds —
      // that is a denial, not a crash, and the audit line has to say so.
      const denied = result && typeof result === 'object' && result.ok === false;
      recordCall(scopeId, name, denied ? 'denied' : 'ok');
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      recordCall(scopeId, name, 'domain-error');
      return { content: [{ type: 'text', text: `Error: ${(err && err.message) || err}` }], isError: true };
    }
  });

  return server;
}

// --- audit (§4.7) ------------------------------------------------------------
// One JSONL line per broker call, appended to the per-plugin audit volume the
// orchestrator mounts at AEE_PLUGIN_AUDIT_DIR. Inert (no writer, no throw) when
// the variable is unset, so a hand-run broker still works.
//
// `agentId` records the SCOPE, not the individual member. At agent granularity
// the two coincide by construction (plugin-audit.js). At team granularity the
// broker genuinely cannot know which member called: the scope token is
// granularity-opaque by design (§4.9) and a client-asserted agent id would be
// unauthenticated — a plausible-looking but forgeable value is worse in an
// audit log than an honest one.
const auditLog = CONFIG.auditDir
  ? require('../../../broker-sdk').auditWriter(CONFIG.auditDir, { retentionMs: 7 * 24 * 60 * 60 * 1000 })
  : null;

function recordCall(scopeId, subcommand, outcome) {
  if (!auditLog) return;
  try {
    auditLog.write({
      ts: new Date().toISOString(),
      pluginId: CONFIG.id || 'podman-sandbox',
      scopeId,
      agentId: scopeId,
      subcommand,
      outcome,
    });
  } catch (err) {
    // Audit is an obligation, not a gate: losing a line must not fail the call.
    process.stderr.write(`[podman-mcp] audit write failed: ${err.message}\n`);
  }
}

// --- auth ------------------------------------------------------------------
// Auth: extract + verify the bearer token → scopeId. Reject otherwise. The
// broker-sdk verifyScopeToken parses the `Bearer <token>` header (prefix check,
// no ReDoS-prone regex) and returns {pluginId, scopeId}; the broker enforces on
// scopeId alone — it never learns, nor branches on, whether the scope is a team
// or a single agent (granularity opacity, §4.9).
function scopeFromAuth(req) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  return v ? v.scopeId : null;
}

// Health + teardown are the two plain-REST routes the orchestrator calls on
// EVERY broker (§4.9), now provided by the SDK. Teardown is keyed on the
// token's scopeId, so ONE handler serves both team deletion and single-member
// deletion at agent granularity; the SDK guarantees resources are reaped before
// the caller invalidates the token.
const handleHealth = healthEndpoint();
const handleTeardown = teardownScopeEndpoint((scopeId) => teardownScope(scopeId), { secret: SIGNING_SECRET });

// --- HTTP wiring -------------------------------------------------------------
const httpServer = http.createServer(withUnexpectedErrors('podman-mcp', handleRequest));

async function handleRequest(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') {
    await handleHealth(req, res);
    return;
  }

  // Plain internal REST route (NOT the MCP protocol surface) dedicated to
  // scope teardown on agent/team deletion — see teardownScope() above for
  // why this is a direct podman()-level cleanup rather than a full MCP
  // JSON-RPC round-trip. Same bearer-token auth as /mcp; the SDK handler
  // verifies the token, runs teardownScope(scopeId), and reports the reaped
  // set (best-effort — a reap error is a 200 `ok:false`, never a hard failure).
  if (req.method === 'POST' && req.url === '/internal/teardown-scope') {
    await handleTeardown(req, res);
    return;
  }

  if (req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const scopeId = scopeFromAuth(req);
  if (!scopeId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // Stateless per-request server+transport pair: scopeId is closed over in
  // this request's tool handlers only, so it can never leak across requests
  // or callers.
  const mcpServer = buildMcpServer(scopeId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    mcpServer.close();
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

httpServer.listen(PORT, () => {
  const cap = QUOTA.maxObjects === null ? 'uncapped' : `${QUOTA.maxObjects}/scope`;
  const ttl = QUOTA.ttlSeconds ? `${QUOTA.ttlSeconds}s TTL` : 'no TTL';
  process.stdout.write(`[podman-mcp] listening on :${PORT} (quota: ${cap}, ${ttl})\n`);
});

// TTL sweep (§4.6). Only armed when the manifest declares one; unref'd so it
// never holds the process open by itself.
if (QUOTA.ttlSeconds) {
  const timer = setInterval(() => {
    try { sweepExpired(); } catch (err) {
      process.stderr.write(`[podman-mcp] TTL sweep failed: ${err.message}\n`);
    }
  }, TTL_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  podman,
  podmanCompose,
  listOwned,
  listAllOwned,
  sweepExpired,
  resolveOwned,
  injectOwnerLabels,
  projectFor,
  scopeFromAuth,
  teardownScope,
  recordCall,
  maskEnvValues,
  QUOTA,
  TOOLS,
};
