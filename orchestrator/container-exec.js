'use strict';

// container-exec.js — run ONE short command inside a running agent container
// over the libpod socket and collect its output (#1286).
//
// Why this exists: the read-only host-folder context mount (#1283) is visible
// only inside the agent's own container. The orchestrator already owns every
// libpod interaction (spawn-container.js), so it also owns this one — the admin
// console stays a proxy and never talks to the container engine about agents.
//
// Deliberately narrow: no stdin, no TTY, no detach, no long-running streams,
// a hard timeout and a hard output cap. It is a request/response call, not a
// shell. Callers pass argv as an ARRAY (never a shell string), so nothing here
// interpolates caller input into a command line.

const http = require('http');

const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'agent-studio';
const AGENT_LABEL_KEY = 'aee.agent.id';
const INSTANCE_LABEL_KEY = 'aee.instance';
const INSTANCE_ID = process.env.AEE_INSTANCE_ID || COMPOSE_PROJECT;

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

class ContainerExecError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ContainerExecError';
    this.code = code || 'exec-failed';
  }
}

// Minimal JSON request against the libpod API. Mirrors spawn-container.js's
// helper rather than importing it: that module spawns containers on require-time
// configuration, and this one must stay usable from a plain read path.
function libpodJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: PODMAN_SOCK,
      path: `/v4.0.0/libpod${urlPath}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
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

// Find THIS stack's running container for an agent. Looked up live by label
// rather than read from the in-memory process map: the map holds the spawn
// handle, and a container recreated behind its back (respawn, reconcile) would
// leave a stale id. A parallel stack sharing the podman store carries the same
// agent label, hence the instance filter (same rule as /processes reconcile).
async function findAgentContainerId(agentId) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${AGENT_LABEL_KEY}=${agentId}`] }));
  const r = await libpodJson('GET', `/containers/json?filters=${filters}`);
  if (r.status >= 300 || !Array.isArray(r.body)) return null;
  for (const c of r.body) {
    const labels = c.Labels || c.labels || {};
    if (labels[AGENT_LABEL_KEY] !== String(agentId)) continue;
    if (labels[INSTANCE_LABEL_KEY] !== INSTANCE_ID) continue;
    if (String(c.State || c.state || '').toLowerCase() !== 'running') continue;
    const id = String(c.Id || c.ID || '');
    if (id) return id;
  }
  return null;
}

// Split a docker/libpod multiplexed attach stream into stdout/stderr.
// Frame layout: [stream(1)][0,0,0][size(4, big endian)][payload]. When the
// first byte isn't a known stream id the stream is raw (TTY mode) — treat the
// whole thing as stdout rather than returning nothing.
function demuxAttachStream(buf) {
  const stdout = [];
  const stderr = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const stream = buf[off];
    if (stream > 2) return { stdout: buf, stderr: Buffer.alloc(0), raw: true };
    const size = buf.readUInt32BE(off + 4);
    const start = off + 8;
    const end = Math.min(start + size, buf.length);
    const payload = buf.slice(start, end);
    if (stream === 2) stderr.push(payload); else stdout.push(payload);
    off = start + size;
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), raw: false };
}

// Start an exec session and read its attached output to completion.
function readExecStream(execId, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: false });
    const chunks = [];
    let total = 0;
    let overflowed = false;
    let settled = false;

    const req = http.request({
      socketPath: PODMAN_SOCK,
      path: `/v4.0.0/libpod/exec/${execId}/start`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      if (res.statusCode >= 300) {
        res.resume();
        if (!settled) { settled = true; reject(new ContainerExecError(`exec start failed (status ${res.statusCode})`, 'exec-failed')); }
        return;
      }
      res.on('data', (c) => {
        if (overflowed) return;
        total += c.length;
        if (total > maxBytes) {
          overflowed = true;
          chunks.length = 0;
          req.destroy();
          if (!settled) { settled = true; reject(new ContainerExecError('output too large', 'too-large')); }
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (!settled) { settled = true; resolve(demuxAttachStream(Buffer.concat(chunks))); }
      });
      res.on('error', (err) => {
        if (!settled) { settled = true; reject(new ContainerExecError(err.message, 'exec-failed')); }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      if (!settled) { settled = true; reject(new ContainerExecError('timed out', 'timeout')); }
    });
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(new ContainerExecError(err.message, 'exec-failed')); }
    });
    req.write(payload);
    req.end();
  });
}

// Run argv in a container; resolve { exitCode, stdout, stderr } (Buffers).
// Throws ContainerExecError on anything that prevented the run itself.
async function execInContainer(containerId, argv, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ContainerExecError('argv must be a non-empty array', 'bad-argv');
  }
  const created = await libpodJson('POST', `/containers/${containerId}/exec`, {
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Privileged: false,
    Cmd: argv.map(String),
  });
  if (created.status >= 300 || !created.body || !created.body.Id) {
    throw new ContainerExecError(`exec create failed (status ${created.status})`, 'exec-failed');
  }
  const execId = created.body.Id;
  const streams = await readExecStream(execId, { timeoutMs, maxBytes });
  let exitCode = 0;
  try {
    const insp = await libpodJson('GET', `/exec/${execId}/json`);
    if (insp.status < 300 && insp.body && typeof insp.body.ExitCode === 'number') {
      exitCode = insp.body.ExitCode;
    }
  } catch { /* the output is what matters; a missing inspect isn't fatal */ }
  return { exitCode, stdout: streams.stdout, stderr: streams.stderr };
}

// Same, resolving the container from the agent id. Throws `no-container` when
// the agent isn't running — the caller turns that into an honest 409/404 rather
// than a generic failure.
async function execInAgentContainer(agentId, argv, opts = {}) {
  const cid = await findAgentContainerId(agentId);
  if (!cid) throw new ContainerExecError('agent container is not running', 'no-container');
  return execInContainer(cid, argv, opts);
}

// Extract a tar archive into a container directory over libpod
// (`PUT /containers/{id}/archive?path=<dir>`) — the `podman cp` mechanism. This
// is the ONLY write channel that bypasses ARG_MAX (argv) and this module's
// deliberate stdin-less exec, and it stays byte-exact (no base64 inflation).
//
// `containerPath` must be a directory that already exists in the container (the
// caller resolves + validates it first). Extraction refuses on a read-only bind
// mount (EROFS) — surfaced here as `read-only` — which is the kernel backstop
// under the control-plane's per-mount readWrite gate.
function putArchiveToContainer(containerId, containerPath, tarBuffer, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const q = `path=${encodeURIComponent(containerPath)}`;
    let settled = false;
    const req = http.request({
      socketPath: PODMAN_SOCK,
      path: `/v4.0.0/libpod/containers/${containerId}/archive?${q}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/x-tar',
        'Content-Length': Buffer.byteLength(tarBuffer),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode });
          return;
        }
        // Map the libpod error. A read-only mount / permission problem comes
        // back as a 4xx/5xx with a message mentioning read-only or permission.
        const msg = String(data || '').toLowerCase();
        const code = /read-only|read only|erofs/.test(msg) ? 'read-only'
                   : /permission|eacces|eperm/.test(msg) ? 'denied'
                   : res.statusCode === 404 ? 'not-found'
                   : 'exec-failed';
        reject(new ContainerExecError(`archive put failed (status ${res.statusCode})`, code));
      });
      res.on('error', (err) => {
        if (!settled) { settled = true; reject(new ContainerExecError(err.message, 'exec-failed')); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      if (!settled) { settled = true; reject(new ContainerExecError('timed out', 'timeout')); }
    });
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(new ContainerExecError(err.message, 'exec-failed')); }
    });
    req.write(tarBuffer);
    req.end();
  });
}

async function putArchiveToAgentContainer(agentId, containerPath, tarBuffer, opts = {}) {
  const cid = await findAgentContainerId(agentId);
  if (!cid) throw new ContainerExecError('agent container is not running', 'no-container');
  return putArchiveToContainer(cid, containerPath, tarBuffer, opts);
}

module.exports = {
  ContainerExecError,
  findAgentContainerId,
  execInContainer,
  execInAgentContainer,
  putArchiveToContainer,
  putArchiveToAgentContainer,
  demuxAttachStream,
};
