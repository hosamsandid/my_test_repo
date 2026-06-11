'use strict';

const http = require('http');
const os = require('os');
const { EventEmitter, PassThrough } = require('stream');

const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const AGENT_IMAGE = process.env.AGENT_IMAGE || 'ace-agent:latest';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'vgh-claw-314092';
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
// Label stamped on every agent container so the orchestrator can reconcile
// live container state against its in-memory process map (source of truth).
const AGENT_LABEL_KEY = 'aee.agent.id';
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

function perAgentNetworkName(agentId) {
  // Sanitize: podman network names are alnum + _-. Keep agent IDs short
  // (8-char hex from the orchestrator), so this rarely matters in practice.
  const safe = String(agentId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${PER_AGENT_NETWORK_PREFIX}${safe}`;
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

function spawnContainer({ id, env }) {
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

  networkPromise
    .then((networkName) => {
      const isolated = PER_AGENT_NETWORK_ENABLED && networkName !== AGENT_NETWORK;
      console.log(
        `[spawn-container] ${id} -> network ${networkName} ` +
        `(${isolated ? 'isolated' : PER_AGENT_NETWORK_ENABLED ? 'shared-fallback' : 'shared'})`,
      );
      // Seam #3: isolate the agent to its own workspace subdir + give it a
      // persistent Claude home. The SubPath targets (`agents/<id>`,
      // `homes/<id>`) are pre-created by the orchestrator before spawn, so the
      // mount never has to create them. The destination path for the workspace
      // is kept identical to the legacy layout (`/workspace/agents/<id>`) so
      // cwd and absolute paths in seeded memory are unaffected.
      const volumes = WORKSPACE_ISOLATION
        ? [
            { Name: WORKSPACE_VOLUME, Dest: `/workspace/agents/${id}`, SubPath: `agents/${id}` },
            { Name: CLAUDE_HOME_VOLUME, Dest: '/root/.claude', SubPath: `homes/${id}` },
          ]
        : [{ Name: WORKSPACE_VOLUME, Dest: '/workspace' }];
      const resourceLimits = {};
      if (AGENT_MEM_LIMIT_BYTES) resourceLimits.memory = { limit: AGENT_MEM_LIMIT_BYTES };
      if (AGENT_PIDS_LIMIT) resourceLimits.pids = { limit: AGENT_PIDS_LIMIT };
      const createBody = {
        image: AGENT_IMAGE,
        env: envMap,
        volumes,
        Networks: { [networkName]: {} },
        labels: { [AGENT_LABEL_KEY]: String(id) },
        no_new_privileges: true,
        remove: true,
      };
      if (Object.keys(resourceLimits).length) createBody.resource_limits = resourceLimits;
      return libpodRequest('POST', '/containers/create', createBody);
    })
    .then((r) => {
      if (r.status >= 300 || !r.body || !r.body.Id) {
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

module.exports = { spawnContainer, libpodRequest };
