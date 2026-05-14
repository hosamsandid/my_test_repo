'use strict';

const http = require('http');
const os = require('os');
const { EventEmitter, PassThrough } = require('stream');

const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const AGENT_IMAGE = process.env.AGENT_IMAGE || 'ace-agent:latest';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'vgh-claw-314092';
const WORKSPACE_VOLUME = process.env.AGENT_WORKSPACE_VOLUME ||
  `${COMPOSE_PROJECT}_agent-pool-workspace`;
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
// Defaults to compose service names. The orchestrator's own hostname falls
// back to the container short ID (os.hostname()), which compose sets up
// automatically.
const SERVICE_CONTAINERS = (
  process.env.AEE_PER_AGENT_NETWORK_SERVICES
  || `${process.env.ORCH_CONTAINER_NAME || os.hostname()},conduwuit`
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

async function ensurePerAgentNetwork(agentId) {
  const name = perAgentNetworkName(agentId);
  const r = await libpodRequest('POST', '/networks/create', { name });
  // libpod returns 201 on create, 409 when the network already exists. Both
  // are fine — we just need the network to exist.
  if (r.status >= 400 && r.status !== 409 && r.status !== 500) {
    throw new Error(`per-agent network create ${name}: status=${r.status} body=${JSON.stringify(r.body)}`);
  }
  // Connect the service containers (orchestrator + conduwuit) so the agent
  // can resolve them by hostname inside the isolated network. Best-effort:
  // an "already connected" 409/500 is acceptable.
  for (const svc of SERVICE_CONTAINERS) {
    try {
      const cr = await libpodRequest('POST', `/networks/${name}/connect`, { Container: svc });
      if (cr.status >= 400 && cr.status !== 409 && cr.status !== 500) {
        console.warn(`[spawn-container] connect ${svc} to ${name}: status=${cr.status}`);
      }
    } catch (err) {
      console.warn(`[spawn-container] connect ${svc} to ${name} failed: ${err.message}`);
    }
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
      const createBody = {
        image: AGENT_IMAGE,
        env: envMap,
        volumes: [{ Name: WORKSPACE_VOLUME, Dest: '/workspace' }],
        Networks: { [networkName]: {} },
        remove: true,
      };
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
