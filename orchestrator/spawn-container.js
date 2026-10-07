'use strict';

// Podman implementation of the container-runtime seam (see
// container-runtime.js, including the seam discipline note). Its Kubernetes
// twin is spawn-kubernetes-pod.js, whose header records the deliberate
// runtime differences — new spawn-path features land on both or get listed
// there.

const http = require('http');
const os = require('os');
const { EventEmitter, PassThrough } = require('stream');
const { buildContextMountSpecs } = require('./context-mount');
const {
  DEFAULT_AGENT_IMAGE: BUILTIN_AGENT_IMAGE,
  missingImageMessage,
  isMissingImageFailure,
} = require('./toolchain-registry');

const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
// Installation-wide default agent image (#1940 AC9). Since #1940 this is only
// the DEFAULT — the image an agent container is actually spawned from arrives
// through the seam as `spawnContainer({ image })`, resolved per Working
// Environment by orchestrator/toolchain-registry.js. This constant is exported
// so the resolver has one place to read the default from, and is deliberately
// NOT consulted when building the agent's create body: a toolchain that
// silently degraded to `as-agent:latest` would start a build agent without its
// toolchain (#1940 AC2/AC7).
const DEFAULT_AGENT_IMAGE = process.env.AGENT_IMAGE || BUILTIN_AGENT_IMAGE;
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'agent-studio-314092';
const WORKSPACE_VOLUME = process.env.AGENT_WORKSPACE_VOLUME ||
  `${COMPOSE_PROJECT}_agent-pool-workspace`;

// Seam #3 — per-agent filesystem isolation. By default each agent container
// mounts ONLY its own subdirectory of the shared pool volume
// (SubPath `agents/<id>` -> `/workspace/agents/<id>`), so it can no longer read
// sibling agents' workspaces or the secret stores that also live on the pool
// volume (`environments/_keys`, `mcp-credentials/_keys`, github tokens).
// Set AEE_WORKSPACE_ISOLATION=0 to restore the legacy whole-volume mount for
// debugging — DANGER: that re-exposes every agent + all secrets to each agent.
//
// Deferred hardening (not yet implemented): move the secret stores onto a
// control-plane-only volume mounted just by orchestrator + admin-console, and
// give each agent a dedicated data volume instead of a shared-volume subpath.
const WORKSPACE_ISOLATION = process.env.AEE_WORKSPACE_ISOLATION !== '0';
// Persistent per-agent Claude home (SubPath `homes/<id>` of the claude-home
// volume the orchestrator already declares). Without this, `--resume` session
// snapshots under /root/.claude/projects are lost on every container restart.
const CLAUDE_HOME_VOLUME = process.env.AGENT_CLAUDE_HOME_VOLUME ||
  `${COMPOSE_PROJECT}_claude-home`;
// Seam #3+ (#185): TRUE per-agent volume isolation. When AEE_PER_AGENT_VOLUME=1
// each agent gets a DEDICATED podman volume (`<project>_agent-<id>`) mounted at
// /workspace/agents/<id> with NO SubPath, instead of a subpath of the shared
// pool volume. Default OFF (explicit opt-in, opposite polarity to
// AEE_WORKSPACE_ISOLATION) — the remaining control-plane readers (triggers,
// pending-triggers, config) must move to push first (Phase 2). The orchestrator
// still seeds the pool subpath `agents/<id>` as today; on first spawn we copy
// that into the fresh dedicated volume (the seed helper below).
const PER_AGENT_VOLUME = process.env.AEE_PER_AGENT_VOLUME === '1';
function perAgentVolumeName(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${COMPOSE_PROJECT}_agent-${safe}`;
}
// Container hardening (conservative slice). Memory accepts a human suffix
// (e.g. "2g", "512m"); 0/empty disables that limit.
function parseBytes(s) {
  const m = String(s || '').trim().match(/^(\d+)\s*([kKmMgG]?)[bB]?$/);
  if (!m) return 0;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
const AGENT_MEM_LIMIT_BYTES = parseBytes(process.env.AEE_AGENT_MEM_LIMIT || '2g');
const AGENT_PIDS_LIMIT = Number(process.env.AEE_AGENT_PIDS_LIMIT || 512);
// #2282 Band 1: a toolchain may declare `resources.memoryLimit` to raise the
// fleet-wide default for agents bound to it (e.g. a JVM/Gradle build that would
// otherwise OOM at AEE_AGENT_MEM_LIMIT). No override, or one that fails to
// parse -> AGENT_MEM_LIMIT_BYTES, byte-identical to before this field existed.
// An operator who disabled the fleet limit (AEE_AGENT_MEM_LIMIT=0, e.g. on a
// WSL host whose cgroup delegation cannot write memory.max) stays disabled:
// the override only raises a limit, it never re-imposes one.
function resolveMemLimitBytes(toolchain, fleetBytes = AGENT_MEM_LIMIT_BYTES) {
  if (!fleetBytes) return 0;
  const override = toolchain && toolchain.resources && toolchain.resources.memoryLimit;
  if (!override) return fleetBytes;
  return parseBytes(override) || fleetBytes;
}
// Label stamped on every agent container so the orchestrator can reconcile
// live container state against its in-memory process map (source of truth).
const AGENT_LABEL_KEY = 'aee.agent.id';
// Instance identity — stamped on every agent/helper container (`aee.instance`
// label) so eviction & reconcile can scope to THIS stack's own containers.
// Without it, two stacks sharing one Podman store (parallel instances on the
// same socket) would evict each other's agent containers on boot.
// Configured via AEE_INSTANCE_ID in .env; defaults to COMPOSE_PROJECT_NAME
// (which already namespaces the per-agent volumes/networks) so single-instance
// setups need no config change. The label KEY is a fixed schema constant.
const INSTANCE_LABEL_KEY = 'aee.instance';
const INSTANCE_ID = process.env.AEE_INSTANCE_ID || COMPOSE_PROJECT;
// Legacy: the compose stack creates the bridge network as ${project}_default.
// Used as a fallback when per-agent network isolation is disabled. Override
// with AGENT_NETWORK if the compose project renames the network.
const AGENT_NETWORK = process.env.AGENT_NETWORK || `${COMPOSE_PROJECT}_default`;

// Seam #2 — per-agent network isolation. Each agent runs on a dedicated
// podman network (`aee-agent-net-<agentId>`); conduwuit and the orchestrator
// are connected to that network at spawn time so the agent can reach them
// by service name, but no two agents share a network so direct TCP between
// agents is blocked. Matrix (via conduwuit) is the only cross-agent path.
//
// Disable by setting AEE_PER_AGENT_NETWORK=0 — the spawn then falls back to
// the legacy shared compose-default network.
const PER_AGENT_NETWORK_ENABLED = process.env.AEE_PER_AGENT_NETWORK !== '0';
const PER_AGENT_NETWORK_PREFIX = process.env.AEE_PER_AGENT_NETWORK_PREFIX || 'aee-agent-net-';
// Containers connected to every per-agent network so the agent can reach them.
// Default to the compose-generated container names (`<project>-<service>`),
// which is how libpod looks them up. Earlier defaults used the bare service
// name (`conduwuit`) and the container short hostname (`os.hostname()`) —
// both returned 404 from /networks/{name}/connect because libpod resolves
// containers by full name or full ID, not by short hostname or service alias.
//
// Override with AEE_PER_AGENT_NETWORK_SERVICES (comma-separated) if your
// compose project uses non-default container names.
const SERVICE_CONTAINERS = (
  process.env.AEE_PER_AGENT_NETWORK_SERVICES
  || `${COMPOSE_PROJECT}-orchestrator,${COMPOSE_PROJECT}-conduwuit`
).split(',').map(s => s.trim()).filter(Boolean);

function libpodRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      socketPath: PODMAN_SOCK,
      path: `/v4.0.0/libpod${urlPath}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function streamLogs(cid, stdout, stderr) {
  const opts = {
    socketPath: PODMAN_SOCK,
    path: `/v4.0.0/libpod/containers/${cid}/logs?follow=true&stdout=true&stderr=true&tail=0`,
    method: 'GET',
  };
  const req = http.request(opts, (res) => {
    let buf = Buffer.alloc(0);
    res.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const stream = buf[0];
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) break;
        const payload = buf.slice(8, 8 + size);
        if (stream === 2) stderr.write(payload);
        else stdout.write(payload);
        buf = buf.slice(8 + size);
      }
    });
    res.on('end', () => { stdout.end(); stderr.end(); });
    res.on('error', () => { stdout.end(); stderr.end(); });
  });
  req.on('error', () => { stdout.end(); stderr.end(); });
  req.end();
  return req;
}

function waitForExit(cid) {
  return libpodRequest('POST', `/containers/${cid}/wait?condition=stopped`)
    .then(r => (r.body && typeof r.body === 'object' && 'StatusCode' in r.body) ? r.body.StatusCode : r.body);
}

// ── Seam #2 helpers ─────────────────────────────────────────────────────────

function sanitizeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function perAgentNetworkName(agentId) {
  // Sanitize: podman network names are alnum + _-. Keep agent IDs short
  // (8-char hex from the orchestrator), so this rarely matters in practice.
  return `${PER_AGENT_NETWORK_PREFIX}${sanitizeName(agentId)}`;
}

function agentContainerName(instanceId, agentId) {
  return `aee-${sanitizeName(instanceId)}-${sanitizeName(agentId)}`;
}

// Connecting a service container into a per-agent network races the service's
// own boot at stack startup: until conduwuit is running, the libpod connect
// call returns 500 ("no container with that name / not running"). Earlier code
// swallowed that 500 and carried on, leaving every agent stranded on a network
// with no route to the homeserver. We now retry until the connect succeeds.
const NETWORK_CONNECT_RETRIES = Number(process.env.AEE_NETWORK_CONNECT_RETRIES || 10);
const NETWORK_CONNECT_DELAY_MS = Number(process.env.AEE_NETWORK_CONNECT_DELAY_MS || 1500);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// libpod reports "service already on this network" inconsistently: a clean
// 409, or — as observed on agent respawn, when the orchestrator is still
// attached to the persistent per-agent network from the previous spawn — a
// 500 whose body carries `cause: "network is already connected"`. Either way
// the service IS connected, which is exactly the desired end state, so both
// must be treated as success. Without this, respawns burned all retries and
// fell back to the shared network, breaking per-agent isolation.
function isAlreadyConnected(cr) {
  if (cr.status === 409) return true;
  const blob = typeof cr.body === 'string' ? cr.body : JSON.stringify(cr.body || '');
  return /already connected/i.test(blob);
}

async function connectServiceWithRetry(networkName, svc, body) {
  let last = 'no attempt';
  for (let attempt = 1; attempt <= NETWORK_CONNECT_RETRIES; attempt++) {
    let cr;
    try {
      cr = await libpodRequest('POST', `/networks/${networkName}/connect`, body);
    } catch (err) {
      last = `request error: ${err.message}`;
      await sleep(NETWORK_CONNECT_DELAY_MS);
      continue;
    }
    // 2xx = freshly connected; "already connected" (409 or a 500 with that
    // cause) means the service is on the network already. Both are success.
    if (cr.status < 300 || isAlreadyConnected(cr)) return;
    last = `status=${cr.status} body=${JSON.stringify(cr.body)}`;
    // A 500 here is typically "service not ready yet" during startup — retry.
    console.warn(
      `[spawn-container] connect ${svc} -> ${networkName} ` +
      `attempt ${attempt}/${NETWORK_CONNECT_RETRIES}: ${last}`,
    );
    await sleep(NETWORK_CONNECT_DELAY_MS);
  }
  throw new Error(
    `connect ${svc} -> ${networkName} failed after ${NETWORK_CONNECT_RETRIES} attempts: ${last}`,
  );
}

async function ensurePerAgentNetwork(agentId) {
  const name = perAgentNetworkName(agentId);
  // `dns_enabled: true` is critical — without it, containers attached to this
  // network cannot resolve each other by name (DNS lookups silently return
  // empty). Compose-created networks default to dns_enabled=true, but the
  // direct libpod /networks/create call defaults to false.
  const r = await libpodRequest('POST', '/networks/create', { name, dns_enabled: true });
  // libpod returns 201 on create, 409 when the network already exists. Both
  // are fine — we just need the network to exist. Anything else is a real
  // failure (do not swallow it).
  if (r.status >= 400 && r.status !== 409) {
    throw new Error(`per-agent network create ${name}: status=${r.status} body=${JSON.stringify(r.body)}`);
  }
  // Connect the service containers (orchestrator + conduwuit) so the agent can
  // resolve them inside the isolated network. This is load-bearing: if conduwuit
  // isn't reachable here, the agent can never sync Matrix. We register the short
  // compose service-name (e.g. `conduwuit`) as a DNS alias as well — once
  // connected, the full container name resolves via aardvark-dns, but the alias
  // keeps the short name working too. Failure throws so the caller can fall back
  // to the shared network instead of stranding the agent.
  const projectPrefix = `${COMPOSE_PROJECT}-`;
  for (const svc of SERVICE_CONTAINERS) {
    const alias = svc.startsWith(projectPrefix) ? svc.slice(projectPrefix.length) : null;
    const body = { Container: svc };
    if (alias) body.Aliases = [alias];
    await connectServiceWithRetry(name, svc, body);
  }
  // Best-effort verification: only fail if the inspect clearly shows a service
  // missing (catches the original "connect reported OK but didn't attach" bug).
  // If the inspect call itself errors or returns an unexpected shape, trust the
  // connect result above rather than forcing an unnecessary fallback.
  try {
    const insp = await libpodRequest('GET', `/networks/${name}`);
    if (insp.status < 300 && insp.body && insp.body.containers) {
      const members = Object.values(insp.body.containers)
        .map((c) => c && c.name)
        .filter(Boolean);
      for (const svc of SERVICE_CONTAINERS) {
        if (!members.includes(svc)) {
          throw new Error(
            `per-agent network ${name}: ${svc} missing after connect (members=${JSON.stringify(members)})`,
          );
        }
      }
    }
  } catch (err) {
    if (/missing after connect/.test(err.message)) throw err;
    console.warn(`[spawn-container] verify ${name} membership skipped: ${err.message}`);
  }
  return name;
}

// ── Seam #3+ helpers — per-agent volume (#185) ──────────────────────────────

// Idempotent: create the dedicated volume; "already exists" is success.
async function ensurePerAgentVolume(id) {
  const name = perAgentVolumeName(id);
  const r = await libpodRequest('POST', '/volumes/create', { name });
  if (r.status >= 300 && r.status !== 409) {
    const blob = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
    if (!/exists/i.test(blob)) {
      throw new Error(`per-agent volume create ${name}: status=${r.status} body=${blob}`);
    }
  }
  return name;
}

// Seed a fresh per-agent volume from the orchestrator-seeded pool subpath. The
// orchestrator cannot add a mount to its own running container, so we run a
// short-lived helper (the agent image is already present — no extra pull) that
// mounts BOTH the pool subpath (/src) and the dedicated volume (/dst) and
// copies once. Idempotent: only copies when /dst is empty, so a respawn never
// clobbers agent-written state. This is the libpod analogue of a K8s init
// container. Fatal on failure — we must not spawn an agent against an empty
// volume. `security_opt: label=disable` matches the compose services so an
// SELinux host doesn't deny the bind (no-op on macOS).
//
// IMAGE (#1940 AC3) — this helper runs on the installation-wide DEFAULT image,
// NOT the environment's toolchain image, and that is a decision rather than an
// oversight. Three reasons:
//   1. It uses nothing from a toolchain. The script is `ls`/`cp -a`/`test`
//      against two mounts; every toolchain variant derives `FROM as-agent:…`
//      (concept §4 "derive, never fork"), so the toolchain adds capability the
//      copy does not use.
//   2. One code path for every agent. Volume seeding is platform plumbing whose
//      behaviour must not depend on which team's toolchain the agent happens to
//      carry — a copy that worked on the default image and failed on a variant
//      would read as a seeding bug.
//   3. Failure attribution. If a toolchain image is missing or unpullable the
//      AGENT container is where that must surface, with the named AC7 error
//      (see resolveAgentImage / missingImageMessage) — not here, where it would
//      look like a broken volume. Using the default image keeps the toolchain's
//      one failure mode in one place.
// The cost is stated openly: on a stack that only ever runs variant images the
// default image must still be present locally. It always is — it is the base
// every variant is built FROM.
async function seedPerAgentVolume(id) {
  const volName = perAgentVolumeName(id);
  // Fail-closed sentinel (#185 item 7): after seeding, the dedicated volume MUST
  // carry config.json (written to the pool subpath by saveAgentConfig before
  // every spawn). If it's missing the copy produced an empty/corrupt volume —
  // exit nonzero so seedPerAgentVolume throws and aborts the spawn before the
  // agent container ever starts (never boot against an un-seeded volume).
  const seedScript =
    'if [ -z "$(ls -A /dst 2>/dev/null)" ]; then ' +
    'cp -a /src/. /dst/ && echo "[seed] populated /dst from pool subpath agents/' + id + '"; ' +
    'else echo "[seed] /dst already populated — skipping"; fi; ' +
    'if [ ! -f /dst/config.json ]; then echo "[seed] FATAL: /dst missing config.json after seed" >&2; exit 3; fi';
  const createBody = {
    image: DEFAULT_AGENT_IMAGE, // #1940 AC3 — see the rationale above.
    entrypoint: ['/bin/sh', '-c'],
    command: [seedScript],
    volumes: [
      { Name: WORKSPACE_VOLUME, Dest: '/src', SubPath: `agents/${id}` },
      { Name: volName, Dest: '/dst' },
    ],
    labels: { [AGENT_LABEL_KEY]: `seed-${id}`, [INSTANCE_LABEL_KEY]: INSTANCE_ID },
    security_opt: ['label=disable'],
    no_new_privileges: true,
    remove: true,
  };
  const cr = await libpodRequest('POST', '/containers/create', createBody);
  if (cr.status >= 300 || !cr.body || !cr.body.Id) {
    throw new Error(`seed helper create for ${id}: status=${cr.status} body=${JSON.stringify(cr.body)}`);
  }
  const cid = cr.body.Id;
  const sr = await libpodRequest('POST', `/containers/${cid}/start`);
  if (sr.status >= 300) {
    throw new Error(`seed helper start for ${id}: status=${sr.status} body=${JSON.stringify(sr.body)}`);
  }
  const code = await waitForExit(cid);
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`seed helper for ${id} exited ${code}`);
  }
  console.log(`[spawn-container] seeded dedicated volume ${volName}`);
}

// Idempotent teardown (#185 item 6): remove the agent's dedicated volume on
// delete / deactivate. 404 / "no such volume" is success (already gone). Without
// this the dedicated volume leaks, and — because seedPerAgentVolume only copies
// into an EMPTY /dst — a deactivated agent that keeps its volume would silently
// reactivate against stale state instead of re-seeding.
async function removePerAgentVolume(id) {
  const name = perAgentVolumeName(id);
  const r = await libpodRequest('DELETE', `/volumes/${name}?force=true`);
  if (r.status >= 300 && r.status !== 404) {
    const blob = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
    if (!/no such volume|no volume with/i.test(blob)) {
      throw new Error(`per-agent volume remove ${name}: status=${r.status} body=${blob}`);
    }
  }
  return name;
}

// Seam #2 teardown: remove the per-agent network on agent delete. A per-agent
// network can't be deleted while containers are attached, and two things keep
// it occupied after the agent is "stopped":
//   1. ensurePerAgentNetwork connects orchestrator + conduwuit and leaves them
//      attached for the agent's whole lifetime — these must stay alive, so we
//      DISCONNECT them (never force-delete the network, which would remove them).
//   2. The agent's OWN container only gets a kill SIGNAL on stop (handle.kill →
//      /containers/{id}/kill); actual removal is async via autoremove-on-exit.
//      We must let that container be REMOVED (not merely disconnected): force-
//      disconnecting a still-running agent strands it — it spins forever on
//      DNS-failed Matrix syncs, never exits, and its autoremove never fires,
//      leaking the container. So we give the earlier SIGTERM a brief grace
//      window to exit + autoremove, then force-remove any leftover.
// Order therefore matters: remove the agent container first, then disconnect the
// services, then delete the now-empty network.
// Idempotent and best-effort: a missing network/container (isolation disabled,
// or already reaped) is success, not an error.
const NETWORK_REMOVE_RETRIES = 5;
const NETWORK_REMOVE_DELAY_MS = 1000;
const AGENT_STOP_GRACE_POLLS = 8;      // ~8s for SIGTERM-driven autoremove
const AGENT_STOP_GRACE_DELAY_MS = 1000;

// List the agent's own container(s) by the aee.agent.id label, in any state.
// `instanceId` narrows it to this stack's containers (the aee.instance label),
// for callers that must not touch a parallel instance sharing the socket.
async function listAgentContainers(id, { instanceId = null } = {}) {
  const label = [`aee.agent.id=${id}`];
  if (instanceId) label.push(`${INSTANCE_LABEL_KEY}=${instanceId}`);
  const filters = encodeURIComponent(JSON.stringify({ label }));
  try {
    const r = await libpodRequest('GET', `/containers/json?all=true&filters=${filters}`);
    if (r.status < 300 && Array.isArray(r.body)) {
      return r.body.map((c) => (c.Id || c.ID || (c.Names && c.Names[0]))).filter(Boolean);
    }
  } catch (err) {
    console.warn(`[spawn-container] list containers for ${id}: ${err.message}`);
  }
  return [];
}

// Ensure the agent's own container is gone before we touch the network. With
// `graceful`, prefer the graceful path: the SIGTERM sent by stopAgentProcess
// lets the agent commit partial work, exit and autoremove within the grace
// window; fall back to force-remove so teardown always makes progress. Agents
// with nothing to flush (`graceful: false`, #1791) skip the up-to-8s poll and
// force-remove immediately.
//
// `graceful` is decided by `isGracefulDeleteRole` in agent-delete-plan.js,
// which since #1962 (BriefingPack removal) is false for every supported role —
// `bp-instance` was the only one that flushed a bound repo on shutdown. The
// flag stays because it is the seam the next such role would use.
//
// `instanceId` scopes the wait/removal to this stack's containers — the spawn
// path (#2601) uses it so a respawn never removes a parallel instance's
// container that happens to carry the same agent id.
async function ensureAgentContainerGone(id, { graceful = true, instanceId = null } = {}) {
  if (graceful) {
    for (let attempt = 0; attempt < AGENT_STOP_GRACE_POLLS; attempt++) {
      if ((await listAgentContainers(id, { instanceId })).length === 0) return;
      await sleep(AGENT_STOP_GRACE_DELAY_MS);
    }
  }
  // Nothing left (graceful exit already autoremoved it) — done.
  // Otherwise force-remove whatever remains. This also detaches it from the
  // per-agent network.
  for (const cid of await listAgentContainers(id, { instanceId })) {
    const r = await libpodRequest('DELETE', `/containers/${cid}?force=true`);
    if (r.status >= 300 && r.status !== 404) {
      const blob = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      if (!/no such container|no container/i.test(blob)) {
        console.warn(`[spawn-container] force-remove container ${cid} (${id}): status=${r.status} body=${blob}`);
      }
    }
  }
}

async function removePerAgentNetwork(id, { graceful = true } = {}) {
  const name = perAgentNetworkName(id);
  // 1. Make sure the agent's own container is gone. `graceful` (#1791) allows
  //    the SIGTERM-driven commit + autoremove window before force-removing;
  //    agents with nothing to flush force-remove immediately.
  await ensureAgentContainerGone(id, { graceful });
  // 2. Disconnect the persistent service containers (orchestrator + conduwuit).
  //    Force so a half-attached service still comes off. 404 / "not connected"
  //    are benign.
  for (const svc of SERVICE_CONTAINERS) {
    try {
      const dr = await libpodRequest('POST', `/networks/${name}/disconnect`, { Container: svc, Force: true });
      if (dr.status >= 300 && dr.status !== 404) {
        const blob = typeof dr.body === 'string' ? dr.body : JSON.stringify(dr.body || '');
        if (!/not connected|no such network|network not found|no container|no such container/i.test(blob)) {
          console.warn(`[spawn-container] disconnect ${svc} <- ${name}: status=${dr.status} body=${blob}`);
        }
      }
    } catch (err) {
      console.warn(`[spawn-container] disconnect ${svc} <- ${name}: ${err.message}`);
    }
  }
  // 3. Delete the now-empty network (no force — see header). Retry briefly to
  //    absorb any lingering async detach.
  let last = '';
  for (let attempt = 1; attempt <= NETWORK_REMOVE_RETRIES; attempt++) {
    const r = await libpodRequest('DELETE', `/networks/${name}`);
    if (r.status < 300 || r.status === 404) return name;
    const blob = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
    if (/no such network|network not found/i.test(blob)) return name;
    last = `status=${r.status} body=${blob}`;
    if (attempt < NETWORK_REMOVE_RETRIES) await sleep(NETWORK_REMOVE_DELAY_MS);
  }
  throw new Error(`per-agent network remove ${name}: ${last}`);
}

// Targeted re-seed (#185 item 5): copy NAMED control-plane files from the pool
// subpath (/src) into the agent's ALREADY-POPULATED dedicated volume (/dst),
// without clobbering agent-written state (memory/, the git tree, sessions/).
// Used when a prompt/skill edit rewrites the pool subpath after the one-time
// seedPerAgentVolume has already run. `paths` are workspace-relative
// (e.g. 'CLAUDE.md', 'AGENT-PROMPT.md', 'skills/foo'). No-op (skipped) when the
// dedicated volume doesn't exist yet — never resurrect a torn-down volume.
async function reseedPerAgentVolume(id, paths) {
  // Path safety is load-bearing — these become filesystem paths inside the
  // helper. Allowlist only; reject traversal and absolute paths. (Even so we
  // pass them as positional args below, not interpolated into the script.) The
  // ':' is allowed because namespaced skill names (e.g. skills/ace:brief — see
  // SKILL_NAME_RE) use it; it carries no shell-metachar risk since every $p is
  // quoted and rooted under /src or /dst.
  const SAFE = /^[A-Za-z0-9._:/-]+$/;
  const all = Array.isArray(paths) ? paths : [];
  const valid = all.filter(
    (p) => typeof p === 'string' && p.length > 0 && p.length <= 256 &&
      SAFE.test(p) && !p.includes('..') && !p.startsWith('/'),
  );
  // Surface anything we dropped so a silently-unmirrored file (e.g. a skill name
  // the allowlist doesn't cover) is observable rather than a success no-op.
  if (valid.length !== all.length) {
    const rejected = all.filter((p) => !valid.includes(p));
    console.warn(`[spawn-container] reseed ${id}: dropped unsafe path(s): ${JSON.stringify(rejected)}`);
  }
  if (valid.length === 0) return { skipped: 'no-paths' };

  const volName = perAgentVolumeName(id);
  // Inspect rather than create: a missing volume means the agent isn't
  // provisioned, so reseeding is a no-op (creating it here would resurrect a
  // volume that delete/deactivate just tore down).
  const insp = await libpodRequest('GET', `/volumes/${volName}/json`);
  if (insp.status === 404) return { skipped: 'no-volume' };
  if (insp.status >= 300) {
    throw new Error(`reseed inspect ${volName}: status=${insp.status} body=${JSON.stringify(insp.body)}`);
  }

  // Per path: skip if absent in /src; replace dirs wholesale (rm -rf + cp, a
  // sub-second non-atomic window matching the existing seed's risk); files via
  // cp-to-temp + intra-/dst rename (atomic). Paths arrive as "$@" positionals.
  const reseedScript =
    'set -e; for p in "$@"; do ' +
    'if [ ! -e "/src/$p" ]; then echo "[reseed] skip (absent in /src): $p"; continue; fi; ' +
    'mkdir -p "/dst/$(dirname "$p")"; ' +
    'if [ -d "/src/$p" ]; then rm -rf "/dst/$p" && cp -a "/src/$p" "/dst/$p" && echo "[reseed] dir $p"; ' +
    'else cp -a "/src/$p" "/dst/$p.tmp.$$" && mv -f "/dst/$p.tmp.$$" "/dst/$p" && echo "[reseed] file $p"; fi; ' +
    'done';
  const createBody = {
    // #1940 AC3 — the DEFAULT image, for the same three reasons as
    // seedPerAgentVolume above (the reseed script is the same kind of `cp -a`
    // plumbing and uses nothing a toolchain adds).
    image: DEFAULT_AGENT_IMAGE,
    entrypoint: ['/bin/sh', '-c'],
    command: [reseedScript, 'reseed', ...valid],
    volumes: [
      { Name: WORKSPACE_VOLUME, Dest: '/src', SubPath: `agents/${id}` },
      { Name: volName, Dest: '/dst' },
    ],
    labels: { [AGENT_LABEL_KEY]: `reseed-${id}`, [INSTANCE_LABEL_KEY]: INSTANCE_ID },
    security_opt: ['label=disable'],
    no_new_privileges: true,
    remove: true,
  };
  const cr = await libpodRequest('POST', '/containers/create', createBody);
  if (cr.status >= 300 || !cr.body || !cr.body.Id) {
    throw new Error(`reseed helper create for ${id}: status=${cr.status} body=${JSON.stringify(cr.body)}`);
  }
  const cid = cr.body.Id;
  const sr = await libpodRequest('POST', `/containers/${cid}/start`);
  if (sr.status >= 300) {
    throw new Error(`reseed helper start for ${id}: status=${sr.status} body=${JSON.stringify(sr.body)}`);
  }
  const code = await waitForExit(cid);
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`reseed helper for ${id} exited ${code}`);
  }
  console.log(`[spawn-container] reseeded ${valid.length} path(s) into ${volName}: ${valid.join(', ')}`);
  return { reseeded: valid };
}

// `image` (#1940) is the container image for THIS agent, resolved per Working
// Environment by the caller (orchestrator.js → resolveAgentImage). It is a
// required part of the seam: this file must not decide the image, or a
// per-environment toolchain could never take effect (AC2).
// `toolchain` is the {toolchainId, environmentId, environmentName, resources}
// context of a NON-default image: `resources` (#2282 Band 1) sizes the
// container's memory limit, the rest words the AC7 refusal; null for the
// default image.
function spawnContainer({ id, env, contextMounts, image, toolchain = null }) {
  const handle = new EventEmitter();
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.killed = false;
  handle.exitCode = null;
  handle.pid = null;
  handle.send = (msg) => {
    console.warn(`[spawn-container] IPC send dropped (P4 will redesign): ${JSON.stringify(msg)}`);
    return false;
  };

  let containerId = null;
  handle.kill = (signal = 'SIGTERM') => {
    handle.killed = true;
    if (!containerId) return;
    libpodRequest('POST', `/containers/${containerId}/kill?signal=${signal}`).catch(() => {});
  };

  const envMap = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null) envMap[k] = String(v);
  }

  // Seam #2: agents run on their own per-agent podman network, where
  // compose service-name aliases (e.g. `conduwuit`) don't always register
  // reliably. Rewrite known service-name hostnames to their full container
  // names — those are guaranteed to resolve on every network conduwuit is
  // attached to. Idempotent: skip the rewrite when the hostname already
  // points at the full container name (e.g. user-overridden via env).
  if (PER_AGENT_NETWORK_ENABLED) {
    const projectPrefix = `${COMPOSE_PROJECT}-`;
    const rewriteHostname = (url, shortName) => {
      if (!url) return url;
      const fullName = `${projectPrefix}${shortName}`;
      if (url.includes(`://${shortName}:`) || url.includes(`://${shortName}/`)) {
        return url.replace(`://${shortName}`, `://${fullName}`);
      }
      return url;
    };
    if (envMap.MATRIX_HOMESERVER) {
      envMap.MATRIX_HOMESERVER = rewriteHostname(envMap.MATRIX_HOMESERVER, 'conduwuit');
    }
    if (envMap.AEE_ORCHESTRATOR_URL) {
      envMap.AEE_ORCHESTRATOR_URL = rewriteHostname(envMap.AEE_ORCHESTRATOR_URL, 'orchestrator');
    }
    if (envMap.ORCHESTRATOR_INTERNAL_URL) {
      envMap.ORCHESTRATOR_INTERNAL_URL = rewriteHostname(envMap.ORCHESTRATOR_INTERNAL_URL, 'orchestrator');
    }
    // #711: the e2e stack points agents at the in-stack fake-github via
    // GITHUB_API_BASE=http://fake-github (spread from the orchestrator env). The
    // role playbooks curl it directly, so the short alias must resolve on the
    // isolated per-agent network — rewrite it to the guaranteed-resolvable full
    // container name, exactly as for conduwuit/orchestrator above. Production is
    // untouched: GITHUB_API_BASE is unset there (api.github.com), so `://fake-github`
    // never matches and this is a no-op.
    if (envMap.GITHUB_API_BASE) {
      envMap.GITHUB_API_BASE = rewriteHostname(envMap.GITHUB_API_BASE, 'fake-github');
    }
  }

  // Seam #2: provision the per-agent network up-front (with connected
  // services). On failure we log and fall back to the shared compose-default
  // network so the agent still starts — isolation is preferred but not
  // load-bearing. Set AEE_PER_AGENT_NETWORK=0 to opt out entirely.
  const networkPromise = PER_AGENT_NETWORK_ENABLED
    ? ensurePerAgentNetwork(id).catch((err) => {
        console.warn(
          `[spawn-container] per-agent network setup failed for ${id} ` +
          `(${err.message}) — falling back to ${AGENT_NETWORK}`,
        );
        return AGENT_NETWORK;
      })
    : Promise.resolve(AGENT_NETWORK);

  // The seam requires a resolved image (#1940 AC2) — a missing one is a contract
  // violation, not a podman error, so refuse before touching the socket rather
  // than sending `image: undefined` and reading a confusing libpod reply.
  const imagePromise = image
    ? Promise.resolve(image)
    : Promise.reject(new Error(
        `refusing to spawn ${id}: no container image was resolved. The container-runtime ` +
        'seam requires spawnContainer({ image }) (#1940) — see resolveAgentImage.',
      ));

  Promise.all([imagePromise, networkPromise])
    .then(async ([, networkName]) => {
      const isolated = PER_AGENT_NETWORK_ENABLED && networkName !== AGENT_NETWORK;
      console.log(
        `[spawn-container] ${id} -> network ${networkName} ` +
        `(${isolated ? 'isolated' : PER_AGENT_NETWORK_ENABLED ? 'shared-fallback' : 'shared'})`,
      );
      // Seam #3: isolate the agent to its own workspace + give it a persistent
      // Claude home. The destination path (`/workspace/agents/<id>`) is kept
      // identical across all modes so cwd and absolute paths in seeded memory
      // are unaffected.
      //   - PER_AGENT_VOLUME (#185): a DEDICATED volume, no SubPath. Provision +
      //     one-time seed from the pool subpath first (fatal on failure — never
      //     spawn against an empty volume).
      //   - WORKSPACE_ISOLATION (default): a SubPath of the shared pool volume,
      //     pre-created by the orchestrator before spawn.
      //   - neither: legacy whole-pool mount (debug only — re-exposes secrets).
      let workspaceMount;
      if (PER_AGENT_VOLUME) {
        const volName = await ensurePerAgentVolume(id);
        await seedPerAgentVolume(id);
        workspaceMount = { Name: volName, Dest: `/workspace/agents/${id}` };
        console.log(`[spawn-container] ${id} -> dedicated volume ${volName}`);
      } else if (WORKSPACE_ISOLATION) {
        workspaceMount = { Name: WORKSPACE_VOLUME, Dest: `/workspace/agents/${id}`, SubPath: `agents/${id}` };
      }
      const volumes = (WORKSPACE_ISOLATION || PER_AGENT_VOLUME)
        ? [
            workspaceMount,
            { Name: CLAUDE_HOME_VOLUME, Dest: '/root/.claude', SubPath: `homes/${id}` },
          ]
        : [{ Name: WORKSPACE_VOLUME, Dest: '/workspace' }];
      const resourceLimits = {};
      const memBytes = resolveMemLimitBytes(toolchain);
      if (memBytes) resourceLimits.memory = { limit: memBytes };
      if (AGENT_PIDS_LIMIT) resourceLimits.pids = { limit: AGENT_PIDS_LIMIT };
      // #2601 AC4: the container name is fixed per (instance, agent), so the
      // previous container must be gone before the create, or libpod answers
      // 409 "name already in use". A restart only SIGTERMs the old container
      // (stopAgentProcess, fire-and-forget) and spawns in the same tick, and
      // autoremove is async — wait out its graceful exit, then force-remove a
      // leftover (also one left by a crashed orchestrator). No old container
      // (the normal first spawn) returns after one list call.
      await ensureAgentContainerGone(id, { instanceId: INSTANCE_ID });
      const createBody = {
        // #1940 AC2: the RESOLVED image, never the module-level default — the
        // caller decided which toolchain (if any) this agent runs on.
        image,
        name: agentContainerName(INSTANCE_ID, id),
        env: envMap,
        netns: { nsmode: 'bridge' },
        volumes,
        Networks: { [networkName]: {} },
        labels: { [AGENT_LABEL_KEY]: String(id), [INSTANCE_LABEL_KEY]: INSTANCE_ID },
        no_new_privileges: true,
        remove: true,
      };
      // Host-folder context mount(s) (#1283, multiple folders #1290). An admin
      // may point this agent at one or more host directories, each bind-mounted
      // at a distinct target — a single legacy folder at the fixed `/context`,
      // additional folders at `/context/<slug>` — READ-ONLY by default or
      // READ-WRITE per folder (#1289). Paths are validated at the API layer AND
      // re-checked here (fail-closed): buildContextMountSpecs drops any entry
      // that doesn't pass, so one bad folder produces no mount rather than a
      // dangerous one and never blocks the others. Local/podman only — the API
      // gate keeps these off config in non-local (hosted) environments.
      // `mounts[]` is the libpod OCI bind array, distinct from the named-volume
      // `volumes[]` above.
      const contextSpecs = buildContextMountSpecs(contextMounts);
      if (contextSpecs.length) {
        createBody.mounts = contextSpecs;
        for (const spec of contextSpecs) {
          const mode = spec.options.includes('rw') ? 'read-write' : 'read-only';
          console.log(`[spawn-container] ${id} -> ${mode} context mount ${spec.source} at ${spec.destination}`);
        }
      }
      if (Object.keys(resourceLimits).length) createBody.resource_limits = resourceLimits;
      return libpodRequest('POST', '/containers/create', createBody);
    })
    .then((r) => {
      if (r.status >= 300 || !r.body || !r.body.Id) {
        // #1940 AC7: when the image that could not be found is a TOOLCHAIN
        // image, a bare libpod "no such image" names neither the environment
        // nor the toolchain — the two things an operator needs to fix it. Add
        // the sentence that does. (Note what does NOT happen here: we do not
        // retry on the default image. A build agent that came up without its
        // toolchain would look healthy and fail much later, at the first `mvn`.)
        if (toolchain && isMissingImageFailure(r.status, r.body)) {
          throw new Error(missingImageMessage({ ...toolchain, image, runtime: 'podman' }));
        }
        throw new Error(`create failed: status=${r.status} body=${JSON.stringify(r.body)}`);
      }
      containerId = r.body.Id;
      handle.pid = containerId.slice(0, 12);
      handle.emit('spawned', handle.pid);
      streamLogs(containerId, handle.stdout, handle.stderr);
      return libpodRequest('POST', `/containers/${containerId}/start`);
    })
    .then((r) => {
      if (r.status >= 300) {
        throw new Error(`start failed: status=${r.status} body=${JSON.stringify(r.body)}`);
      }
      return waitForExit(containerId);
    })
    .then((code) => {
      handle.exitCode = typeof code === 'number' ? code : 1;
      handle.emit('exit', handle.exitCode, null);
    })
    .catch((err) => {
      handle.stderr.write(Buffer.from(`[spawn-container] ${err.message}\n`));
      handle.stdout.end();
      handle.stderr.end();
      handle.exitCode = 1;
      handle.emit('exit', 1, null);
    });

  return handle;
}

module.exports = {
  spawnContainer,
  libpodRequest,
  removePerAgentVolume,
  removePerAgentNetwork,
  reseedPerAgentVolume,
  // Plugin sidecars attach to the granted agents' per-agent networks (#1547),
  // so the naming rule has to be shared rather than re-derived there.
  perAgentNetworkName,
  PER_AGENT_NETWORK_ENABLED,
  AGENT_NETWORK,
  // Installation-wide default image (#1940 AC9). The orchestrator reads it from
  // the seam so the fallback link of the resolution chain is the runtime's own
  // default, whichever runtime is selected.
  DEFAULT_AGENT_IMAGE,
  // Plugin broker sidecars are implemented on this runtime only (#1547) — see
  // the Deliberate differences block in spawn-kubernetes-pod.js.
  PLUGIN_SIDECARS_SUPPORTED: true,
  // Pure helpers exposed for unit tests only — not part of the runtime seam.
  _internal: {
    parseBytes,
    resolveMemLimitBytes,
    AGENT_MEM_LIMIT_BYTES,
    sanitizeName,
    agentContainerName,
  },
};
