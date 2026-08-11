'use strict';

// ─── plugin sidecar runtime (plugin system Phase 7, #1547) ───────────────────
//
// The impure half of the plugin system's control plane: everything the pure
// planners (plugin-sidecar.js, plugin-sync.js, plugin-scope.js) decided, carried
// out against libpod and the broker's REST surface. Same seam the orchestrator
// already uses for agent containers — spawn-container.js owns the libpod calls,
// the planners own the decisions, and this module is the thin adapter between
// them (docs/plugin-system-concept.md §4.3).
//
// What lives here and NOT in the planners: container create/start/remove,
// network connect/disconnect, the privileged host-socket bind, minting tokens
// against the on-disk signing secret, and the teardown call to a broker.
//
// Three invariants this module is responsible for:
//   1. A sidecar's privileges come ONLY from capabilityAttachments() over the
//      manifest's closed-enum capabilities. There is no other path to a mount.
//   2. Reachability follows the GRANT: a sidecar is on exactly the per-agent
//      networks of the agents that were granted the plugin, and no others.
//   3. Teardown reaps a scope's resources BEFORE its token is invalidated
//      (§4.9) — so it is called on the way into deletion, not after.

// Through the runtime seam, never require('./spawn-container') directly — see
// the seam-discipline note in container-runtime.js. Plugin sidecars are a
// PODMAN-ONLY capability (recorded as a deliberate difference in
// spawn-kubernetes-pod.js): on Kubernetes a broker would be a Deployment plus a
// NetworkPolicy, which is a different mechanism, not a port of this one. Every
// entry point below short-circuits when the runtime does not support them, so
// a hosted stack degrades to "no plugin sidecars" instead of half-working.
const {
  libpodRequest,
  perAgentNetworkName,
  AGENT_NETWORK,
  PLUGIN_SIDECARS_SUPPORTED,
} = require('./container-runtime');

// On Kubernetes a plugin broker is a Deployment + Service + PVC, a different
// mechanism from the Podman sibling container (concept §9, #1565). The k8s
// implementation lives in spawn-kubernetes-plugin.js; this module delegates the
// three runtime-divergent entry points to it when the stack runs on k8s. The
// rest of the surface — mintScopeToken, brokerBaseUrl, teardownScope — is
// runtime-agnostic (HMAC over the shared secret, an in-namespace HTTP call to a
// Service named identically to the Podman container), so it stays here and
// serves both. Detected the same way orchestrator.js / container-runtime.js do.
const AEE_RUNTIME = String(process.env.AEE_CONTAINER_RUNTIME || 'podman').toLowerCase();
const IS_K8S = AEE_RUNTIME === 'kubernetes' || AEE_RUNTIME === 'k8s';
const k8sPlugin = IS_K8S ? require('./spawn-kubernetes-plugin') : null;

const UNSUPPORTED = { supported: false, reason: 'plugin sidecars require the podman runtime' };

const {
  sidecarContainerName,
  sidecarLabels,
  reconcileSidecars,
  reconcileAttachments,
  capabilityAttachments,
  brokerEnvContract,
} = require('./plugin-sidecar');

const { PLUGIN_ID_LABEL } = require('./plugin-scope');
const { mint } = require('./plugin-scope-token');
const { installedManifests, readOrCreateSigningSecret, REGISTRY_DIR } = require('./plugin-registry');

const http = require('http');

// The host path of the rootless podman socket. Inside this container the socket
// is at PODMAN_SOCK_PATH, but a bind mount for a SIBLING container must name the
// path as the HOST sees it — the same distinction the context-mount feature
// makes. Compose passes it through as PODMAN_HOST_SOCKET.
const PODMAN_HOST_SOCKET = process.env.PODMAN_HOST_SOCKET || '/run/user/501/podman/podman.sock';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'agent-studio';

// Per-plugin audit volume (§4.7): a broker appends one JSONL line per call. It
// gets its OWN volume rather than a slice of /workspace — a sidecar has no
// business reading agent workspaces, and the manifest never declared it.
//
// ONE VOLUME PER PLUGIN, mounted whole — deliberately not one shared volume
// with a per-plugin SubPath. libpod resolves a SubPath against content that
// must already exist, and a freshly-created volume is empty, so the mount fails
// the container start with a bare "no such file or directory" (the other
// SubPath mounts in spawn-container.js work only because the orchestrator
// creates those directories on the shared volume first, and it has no way to
// write into a volume it does not itself mount). Separate volumes also keep one
// plugin's audit trail out of another's reach for free.
function auditVolumeName(pluginId) {
  return `${COMPOSE_PROJECT}_plugin-audit-${pluginId}`;
}
const AUDIT_MOUNT = '/audit';

// Per-plugin STATE volume (§4.8): a generic persistent mount beside the audit
// volume, where a UI-bearing plugin keeps its documents. It gets its own volume
// for the same reasons the audit trail does — a sidecar has no business reading
// agent workspaces, and separate volumes keep one plugin's state out of
// another's reach — but distinct from audit because that mount carries its own
// retention semantics; using it for documents would be an abuse of it. The
// mount path is exposed to the broker as AEE_PLUGIN_STATE_DIR, platform-set and
// never overridable from the manifest's own sidecar.env.
function stateVolumeName(pluginId) {
  return `${COMPOSE_PROJECT}_plugin-state-${pluginId}`;
}
const STATE_MOUNT = '/state';

const TEARDOWN_TIMEOUT_MS = Number(process.env.PLUGIN_TEARDOWN_TIMEOUT_MS) || 10000;

let secretCache = null;

// The shared scope-token signing secret, read once per process.
function signingSecret(dir = REGISTRY_DIR) {
  if (secretCache) return secretCache;
  secretCache = readOrCreateSigningSecret(dir);
  return secretCache;
}

function mintScopeToken(pluginId, scopeId, dir = REGISTRY_DIR) {
  if (!pluginId || !scopeId) return null;
  return mint(pluginId, scopeId, signingSecret(dir));
}

// The URL the ORCHESTRATOR reaches a broker on. Identical to the endpoint an
// agent gets (plugin-sync.sidecarEndpoint) — both resolve the sidecar's
// container name — but derived here so this module does not depend on the
// workspace-sync planner just for a string.
function brokerBaseUrl(manifest) {
  return `http://${sidecarContainerName(manifest.id)}:${manifest.sidecar.internalPort}`;
}

// ── sidecar lifecycle ───────────────────────────────────────────────────────

// Every container carrying the plugin label, RUNNING OR NOT. The distinction
// matters — see splitByRunning.
async function listSidecarContainers() {
  const filters = encodeURIComponent(JSON.stringify({ label: [PLUGIN_ID_LABEL] }));
  const r = await libpodRequest('GET', `/containers/json?all=true&filters=${filters}`);
  if (r.status >= 300 || !Array.isArray(r.body)) return [];
  return r.body;
}

// A container is only LIVE if it is actually running. Anything else — `created`
// (a create whose start never happened, e.g. the orchestrator was restarted
// between the two calls), `exited`, `dead` — is a corpse holding the plugin's
// deterministic container name.
//
// This distinction is the whole repair path: feeding corpses to
// reconcileSidecars as "live" makes it report nothing to start and no errors,
// so a plugin stays permanently down while the reconcile claims success. Found
// exactly that way on the first end-to-end run.
function splitByRunning(containers) {
  const running = [];
  const stale = [];
  for (const c of containers || []) {
    if (!c) continue;
    const state = String(c.State || '').toLowerCase();
    if (state === 'running') running.push(c);
    else stale.push(c);
  }
  return { running, stale };
}

// Back-compat name used by the /internal/plugins route: what is actually up.
async function listLiveSidecars() {
  if (IS_K8S) return k8sPlugin.listLiveSidecars();
  return splitByRunning(await listSidecarContainers()).running;
}

async function ensureAuditVolume(pluginId) {
  const name = auditVolumeName(pluginId);
  const r = await libpodRequest('POST', '/volumes/create', { name });
  // 201 created, 409 already exists — both fine.
  if (r.status >= 300 && r.status !== 409) {
    console.warn(`[plugin-runtime] audit volume ${name}: status=${r.status}`);
  }
  return name;
}

async function ensureStateVolume(pluginId) {
  const name = stateVolumeName(pluginId);
  const r = await libpodRequest('POST', '/volumes/create', { name });
  // 201 created, 409 already exists — both fine.
  if (r.status >= 300 && r.status !== 409) {
    console.warn(`[plugin-runtime] state volume ${name}: status=${r.status}`);
  }
  return name;
}

// Build the libpod create body for one plugin's broker sidecar. Exported for
// unit testing: this is where a capability turns into an actual privilege, so
// it is the one impure-module function worth asserting on directly.
function sidecarCreateBody(manifest, { signingSecret: secret, hostSocket = PODMAN_HOST_SOCKET } = {}) {
  const caps = capabilityAttachments(manifest.sidecar.capabilities);

  // The plugin-neutral env contract every broker reads through the SDK's
  // brokerConfig(), derived by the shared pure builder so this Podman create
  // body and the k8s Deployment (spawn-kubernetes-plugin.js) can never drift on
  // which AEE_PLUGIN_* variables the platform sets or how it defends them.
  const env = brokerEnvContract(manifest, {
    signingSecret: secret,
    auditDir: AUDIT_MOUNT,
    stateDir: STATE_MOUNT,
  });

  const mounts = [];
  if (caps.socket) {
    mounts.push({
      Type: 'bind',
      Source: hostSocket,
      Destination: '/var/run/podman.sock',
      Options: ['rw'],
    });
  }
  // A `host-mount:<path>` capability is reviewed at install time and mounted
  // READ-ONLY — a plugin declaring a host path gets to read it, never to write
  // the host filesystem through the platform's own privilege.
  for (const p of caps.hostMounts) {
    mounts.push({ Type: 'bind', Source: p, Destination: p, Options: ['ro'] });
  }

  return {
    image: manifest.sidecar.image,
    name: sidecarContainerName(manifest.id),
    env,
    mounts,
    // Two per-plugin volumes: the audit trail (§4.7) and the generic state
    // volume (§4.8). Both mounted WHOLE, never via SubPath — a fresh volume is
    // empty and a SubPath resolves against content that must already exist.
    volumes: [
      { Name: auditVolumeName(manifest.id), Dest: AUDIT_MOUNT },
      { Name: stateVolumeName(manifest.id), Dest: STATE_MOUNT },
    ],
    netns: { nsmode: 'bridge' },
    // Created on the compose network so the ORCHESTRATOR can reach it for
    // health/teardown; per-agent networks are connected on top, per grant.
    // NOTE: this also means the sidecar currently has whatever egress the
    // compose network has — the `egress` capability is validated but not yet
    // enforced as a restriction (no shipped plugin declares it).
    Networks: { [AGENT_NETWORK]: {} },
    labels: sidecarLabels(manifest.id),
    // SELinux relabelling must be off for the mounted host socket, exactly as
    // the orchestrator's own compose service does it (`security_opt:
    // label=disable`). The libpod create API spells this `selinux_opts`, NOT
    // the docker-compat `security_opt` — passing the latter is silently
    // ignored, which left the sidecar labelled and every socket call failing
    // with a bare "permission denied" despite running as root.
    selinux_opts: ['disable'],
    no_new_privileges: true,
    restart_policy: 'unless-stopped',
    remove: false,
  };
}

async function startSidecar(manifest, dir = REGISTRY_DIR) {
  await ensureAuditVolume(manifest.id);
  await ensureStateVolume(manifest.id);
  const body = sidecarCreateBody(manifest, { signingSecret: signingSecret(dir) });
  const cr = await libpodRequest('POST', '/containers/create', body);
  if (cr.status >= 300 || !cr.body || !cr.body.Id) {
    throw new Error(`sidecar create for ${manifest.id}: status=${cr.status} body=${JSON.stringify(cr.body)}`);
  }
  const sr = await libpodRequest('POST', `/containers/${cr.body.Id}/start`);
  if (sr.status >= 300) {
    throw new Error(`sidecar start for ${manifest.id}: status=${sr.status} body=${JSON.stringify(sr.body)}`);
  }
  console.log(`[plugin-runtime] started sidecar ${sidecarContainerName(manifest.id)}`);
  return cr.body.Id;
}

async function stopSidecar(pluginId) {
  const name = sidecarContainerName(pluginId);
  const r = await libpodRequest('DELETE', `/containers/${name}?force=true`);
  if (r.status >= 300 && r.status !== 404) {
    console.warn(`[plugin-runtime] sidecar remove ${name}: status=${r.status}`);
    return false;
  }
  console.log(`[plugin-runtime] stopped sidecar ${name}`);
  return true;
}

// Start sidecars for installed plugins, stop orphans of uninstalled ones.
// Best-effort per plugin: one broken image must not stop the others.
async function reconcilePluginSidecars(dir = REGISTRY_DIR) {
  if (IS_K8S) return k8sPlugin.reconcilePluginSidecars(dir);
  if (!PLUGIN_SIDECARS_SUPPORTED) return { started: [], stopped: [], errors: [], ...UNSUPPORTED };
  const manifests = installedManifests(dir);
  const { running, stale } = splitByRunning(await listSidecarContainers());
  const { toStart, toStop } = reconcileSidecars(Object.keys(manifests), running);

  const started = [];
  const stopped = [];
  const reaped = [];
  const errors = [];

  // Clear corpses first so the deterministic container name is free for the
  // create below. Without this a single failed start wedges the plugin forever.
  for (const c of stale) {
    const name = (Array.isArray(c.Names) && c.Names[0]) || c.Id;
    const r = await libpodRequest('DELETE', `/containers/${name}?force=true`);
    if (r.status < 300 || r.status === 404) reaped.push(name);
    else errors.push({ pluginId: c.Labels && c.Labels[PLUGIN_ID_LABEL], phase: 'reap', error: `status=${r.status}` });
  }

  for (const { pluginId } of toStop) {
    try {
      await stopSidecar(pluginId);
      stopped.push(pluginId);
    } catch (err) {
      errors.push({ pluginId, phase: 'stop', error: err.message });
    }
  }
  for (const pluginId of toStart) {
    try {
      // A previous run may have left a stopped-but-present container under the
      // same deterministic name; remove it before create so this is idempotent.
      await libpodRequest('DELETE', `/containers/${sidecarContainerName(pluginId)}?force=true`);
      await startSidecar(manifests[pluginId], dir);
      started.push(pluginId);
    } catch (err) {
      console.warn(`[plugin-runtime] sidecar start failed for ${pluginId}: ${err.message}`);
      errors.push({ pluginId, phase: 'start', error: err.message });
    }
  }
  return { started, stopped, reaped, errors };
}

// ── grant-driven network attachment ─────────────────────────────────────────

// Which per-agent networks a sidecar is currently connected to. Only per-agent
// networks are considered: the compose network is infrastructure, never a
// grant-derived attachment, so reconcileAttachments must not see it and try to
// disconnect it.
async function sidecarAttachedNetworks(pluginId) {
  const name = sidecarContainerName(pluginId);
  const r = await libpodRequest('GET', `/containers/${name}/json`);
  if (r.status >= 300 || !r.body) return [];
  const nets = (r.body.NetworkSettings && r.body.NetworkSettings.Networks) || {};
  return Object.keys(nets).filter((n) => n !== AGENT_NETWORK);
}

async function connectSidecar(pluginId, network) {
  const r = await libpodRequest('POST', `/networks/${network}/connect`, {
    Container: sidecarContainerName(pluginId),
  });
  // 409 = already connected; libpod reports this inconsistently, so treat any
  // "already" as success rather than string-matching exhaustively.
  if (r.status >= 300 && r.status !== 409) {
    const msg = r.body && r.body.message ? String(r.body.message) : '';
    if (!/already/i.test(msg)) {
      throw new Error(`connect ${pluginId} -> ${network}: status=${r.status} ${msg}`);
    }
  }
}

async function disconnectSidecar(pluginId, network) {
  const r = await libpodRequest('POST', `/networks/${network}/disconnect`, {
    Container: sidecarContainerName(pluginId),
    Force: true,
  });
  if (r.status >= 300 && r.status !== 404 && r.status !== 409) {
    throw new Error(`disconnect ${pluginId} -> ${network}: status=${r.status}`);
  }
}

// Make network truth match grant truth for one plugin.
//   grantedAgentIds : ids of the agents whose resolved grant includes this plugin
async function reconcilePluginAttachments(pluginId, grantedAgentIds) {
  if (IS_K8S) return k8sPlugin.reconcilePluginAttachments(pluginId, grantedAgentIds);
  if (!PLUGIN_SIDECARS_SUPPORTED) return { connected: [], disconnected: [], errors: [], ...UNSUPPORTED };
  let attached;
  try {
    attached = await sidecarAttachedNetworks(pluginId);
  } catch {
    return { connected: [], disconnected: [], errors: [{ error: 'sidecar not inspectable' }] };
  }
  const { connect, disconnect } = reconcileAttachments(grantedAgentIds, attached, perAgentNetworkName);

  const connected = [];
  const disconnected = [];
  const errors = [];
  for (const network of connect) {
    try { await connectSidecar(pluginId, network); connected.push(network); }
    catch (err) { errors.push({ network, error: err.message }); }
  }
  for (const network of disconnect) {
    try { await disconnectSidecar(pluginId, network); disconnected.push(network); }
    catch (err) { errors.push({ network, error: err.message }); }
  }
  return { connected, disconnected, errors };
}

// ── broker teardown (§4.9) ──────────────────────────────────────────────────

function postJson(url, body, token, timeoutMs = TEARDOWN_TIMEOUT_MS, method = 'POST') {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ ok: false, error: 'bad url' }); return; }
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ ok: res.statusCode < 300, status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

// Ask a plugin's broker to reap everything owned by one scope. Called BEFORE the
// scope's token stops being minted (§4.9): a broker that reaps after
// invalidation can no longer authenticate the request that tells it to.
//
// Best-effort by design — an unreachable broker must never block deleting an
// agent. The resources it holds stay labelled with the scopeId and are reaped by
// the plugin's own TTL.
async function teardownScope(manifest, scopeId, dir = REGISTRY_DIR) {
  if (!PLUGIN_SIDECARS_SUPPORTED) return { pluginId: manifest.id, scopeId, ok: false, ...UNSUPPORTED };
  const token = mintScopeToken(manifest.id, scopeId, dir);
  if (!token) return { pluginId: manifest.id, scopeId, ok: false, error: 'no token' };
  const res = await postJson(`${brokerBaseUrl(manifest)}/internal/teardown-scope`, { scopeId }, token);
  if (!res.ok) {
    console.warn(`[plugin-runtime] teardown ${manifest.id}/${scopeId} failed: ${res.error || res.status}`);
  }
  return { pluginId: manifest.id, scopeId, ok: !!res.ok, error: res.error, body: res.body };
}

// Push a per-scope credential + context map to a plugin's broker over a
// bearer-authed internal route (the same wire shape as teardown-scope: a minted
// scope token in the Authorization header). Used by the github-issues plugin to
// hand each granted team its Working-Environment GitHub token + repository list
// (orchestrator/plugin-github-creds.js resolves the map), so the token stays
// server-side — it never touches the browser or an agent container. Generic and
// best-effort: an unreachable broker never blocks a reconcile.
async function pushScopeCredentials(manifest, scopesMap, dir = REGISTRY_DIR) {
  if (!PLUGIN_SIDECARS_SUPPORTED) return { pluginId: manifest.id, ok: false, ...UNSUPPORTED };
  // Any valid scope token authenticates the internal push (the broker checks the
  // signature only, like PUT /internal/scope-registry). Mint one under a fixed
  // internal scope id.
  const token = mintScopeToken(manifest.id, '_internal', dir);
  if (!token) return { pluginId: manifest.id, ok: false, error: 'no token' };
  const res = await postJson(
    `${brokerBaseUrl(manifest)}/internal/scope-credentials`,
    { scopes: scopesMap || {} },
    token,
    TEARDOWN_TIMEOUT_MS,
    'PUT', // broker matches PUT /internal/scope-credentials (server.js); POST 404s
  );
  if (!res.ok) {
    console.warn(`[plugin-runtime] scope-credentials push to ${manifest.id} failed: ${res.error || res.status}`);
  }
  return { pluginId: manifest.id, ok: !!res.ok, error: res.error, body: res.body };
}

module.exports = {
  auditVolumeName,
  AUDIT_MOUNT,
  stateVolumeName,
  STATE_MOUNT,
  PODMAN_HOST_SOCKET,
  signingSecret,
  mintScopeToken,
  brokerBaseUrl,
  sidecarCreateBody,
  listSidecarContainers,
  splitByRunning,
  listLiveSidecars,
  startSidecar,
  stopSidecar,
  reconcilePluginSidecars,
  sidecarAttachedNetworks,
  connectSidecar,
  disconnectSidecar,
  reconcilePluginAttachments,
  teardownScope,
  pushScopeCredentials,
};
