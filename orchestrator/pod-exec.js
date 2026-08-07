'use strict';

// pod-exec.js — Kubernetes counterpart of container-exec.js (#1319): run ONE
// short command inside a running agent pod's as-agent container and collect
// its output. Selected by container-exec-runtime.js; backs the context-mount
// browse/write endpoints on the k8s runtime exactly as container-exec.js does
// on podman.
//
// Transport: the pods/exec subresource requires a protocol upgrade — a plain
// HTTPS POST is refused — so this module carries a minimal WebSocket client
// (handshake over https.request + the 'upgrade' event, masked client frames,
// incremental frame parsing). Hand-rolled on purpose: the orchestrator is
// dependency-free apart from matrix-bot-sdk (same discipline as tar-single.js),
// and the subset needed here is small. Subprotocols v5/v4.channel.k8s.io are
// offered; nothing v5-specific (stream half-close) is relied on — the upload
// path bounds stdin with `head -c N` instead, so tar always sees EOF.
//
// Channel layout (both protocol versions): every data message's first byte is
// the stream id — 0 stdin (outbound), 1 stdout, 2 stderr, 3 error/status. The
// channel-3 payload is a metav1.Status JSON that carries the exit code.
//
// Deliberately narrow, mirroring container-exec.js: no TTY, no detach, no
// long-running streams, hard timeout, hard output cap. Requires
// pods/exec [create] on the orchestrator's Role (10-rbac.yaml).

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { listAgentPods } = require('./spawn-kubernetes-pod');

const NAMESPACE = process.env.AEE_K8S_NAMESPACE || readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'default').trim();
const API_HOST = process.env.KUBERNETES_SERVICE_HOST;
const API_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';
const CA = readFileBuffer('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
const AGENT_CONTAINER = 'as-agent';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STDIN_CHUNK = 64 * 1024;

class ContainerExecError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ContainerExecError';
    this.code = code || 'exec-failed';
  }
}

function readFile(path, fallback) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return fallback; }
}

function readFileBuffer(path) {
  try { return fs.readFileSync(path); } catch { return undefined; }
}

// Fresh on each use — projected SA tokens rotate (~hourly); see the identical
// note in spawn-kubernetes-pod.js.
function serviceAccountToken() {
  return readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', '').trim();
}

function buildExecPath(namespace, podName, argv, { stdin = false } = {}) {
  const params = [
    `container=${encodeURIComponent(AGENT_CONTAINER)}`,
    'stdout=true',
    'stderr=true',
    `stdin=${stdin ? 'true' : 'false'}`,
    'tty=false',
    ...argv.map((a) => `command=${encodeURIComponent(String(a))}`),
  ];
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/exec?${params.join('&')}`;
}

// One WebSocket frame, client-side (masked unless told otherwise — RFC 6455
// requires every client→server frame to be masked).
function encodeFrame(opcode, payload, mask = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

// Incremental WebSocket frame parser: push() raw socket bytes, get one
// callback per COMPLETE message (fragments reassembled — the channel byte
// appears once per message, not per fragment) and one per control frame.
class FrameParser {
  constructor(onMessage, onControl) {
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.onMessage = onMessage;
    this.onControl = onControl || (() => {});
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this._parseOne();
      if (!f) return;
      if (f.opcode >= 0x8) {
        // Control frames may interleave with fragments and are never fragmented.
        this.onControl(f.opcode, f.payload);
        continue;
      }
      if (f.opcode === 0x0) {
        if (this.frag) this.frag.chunks.push(f.payload);
      } else {
        this.frag = { opcode: f.opcode, chunks: [f.payload] };
      }
      if (f.fin && this.frag) {
        const m = this.frag;
        this.frag = null;
        this.onMessage(m.opcode, Buffer.concat(m.chunks));
      }
    }
  }

  _parseOne() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80);
    const opcode = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContainerExecError('frame too large', 'too-large');
      len = Number(big);
      off = 10;
    }
    let key = null;
    if (masked) {
      if (b.length < off + 4) return null;
      key = b.slice(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.slice(off, off + len);
    if (key) {
      const un = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ key[i & 3];
      payload = un;
    }
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }
}

// metav1.Status (channel 3) → exit code. Success → 0; Failure with reason
// NonZeroExitCode carries the code in details.causes[reason=ExitCode].message;
// any other Failure (container gone, command not found on the exec level)
// means the run itself failed, not the command.
function parseExecStatus(raw) {
  let st;
  try { st = JSON.parse(String(raw)); } catch { st = null; }
  if (!st || typeof st !== 'object') return { ok: false, message: 'unparseable exec status' };
  if (st.status === 'Success') return { ok: true, exitCode: 0 };
  if (st.reason === 'NonZeroExitCode') {
    const causes = (st.details && Array.isArray(st.details.causes)) ? st.details.causes : [];
    const cause = causes.find((c) => c && c.reason === 'ExitCode');
    const code = cause ? Number(cause.message) : NaN;
    return { ok: true, exitCode: Number.isFinite(code) ? code : 1 };
  }
  return { ok: false, message: st.message || st.reason || 'exec failed' };
}

// The upload command: bound stdin to exactly the archive's size so tar sees
// EOF without any WebSocket half-close protocol dependency, then extract into
// the (pre-validated) target directory. $1 keeps the path out of the shell
// string — nothing here interpolates caller input into a command line.
function buildUploadArgv(byteLength, containerPath) {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new ContainerExecError('invalid archive length', 'bad-argv');
  }
  return ['sh', '-c', `head -c ${byteLength} | tar -xf - -C "$1"`, 'sh', String(containerPath)];
}

// Run argv in the pod over pods/exec; resolve { exitCode, stdout, stderr }
// (Buffers). `stdinData` (a Buffer) is streamed as channel-0 frames when set.
function wsExec(podName, argv, { timeoutMs, maxBytes, stdinData = null } = {}) {
  return new Promise((resolve, reject) => {
    const token = serviceAccountToken();
    if (!API_HOST || !token) {
      return reject(new ContainerExecError('Kubernetes service-account environment/token not available', 'exec-failed'));
    }
    const wsKey = crypto.randomBytes(16).toString('base64');
    const stdout = [];
    const stderr = [];
    let total = 0;
    let statusRaw = null;
    let settled = false;
    let sock = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sock) sock.destroy();
      req.destroy();
      fn(value);
    };
    const fail = (err) => finish(reject, err);
    const done = () => {
      if (settled) return;
      if (statusRaw === null) return fail(new ContainerExecError('exec stream closed without a status', 'exec-failed'));
      const st = parseExecStatus(statusRaw);
      if (!st.ok) return fail(new ContainerExecError(st.message, 'exec-failed'));
      finish(resolve, { exitCode: st.exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };

    const req = https.request({
      host: API_HOST,
      port: API_PORT,
      path: buildExecPath(NAMESPACE, podName, argv, { stdin: !!stdinData }),
      method: 'GET',
      ca: CA,
      headers: {
        Authorization: `Bearer ${token}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Protocol': 'v5.channel.k8s.io, v4.channel.k8s.io',
      },
    });

    const timer = setTimeout(() => fail(new ContainerExecError('timed out', 'timeout')), timeoutMs);

    // A plain response instead of an upgrade means the apiserver refused the
    // exec (RBAC, pod gone, bad container) — surface its message.
    req.on('response', (res) => {
      let data = '';
      res.on('data', (c) => { if (data.length < 2048) data += c; });
      res.on('end', () => fail(new ContainerExecError(
        `exec upgrade refused (status ${res.statusCode})${data ? `: ${data.slice(0, 300)}` : ''}`, 'exec-failed')));
      res.on('error', (err) => fail(new ContainerExecError(err.message, 'exec-failed')));
    });

    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(wsKey + WS_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        return fail(new ContainerExecError('websocket handshake mismatch', 'exec-failed'));
      }
      sock = socket;
      const parser = new FrameParser(
        (opcode, payload) => {
          if (!payload.length) return;
          const channel = payload[0];
          const data = payload.slice(1);
          if (channel === 1 || channel === 2) {
            total += data.length;
            if (total > maxBytes) return fail(new ContainerExecError('output too large', 'too-large'));
            (channel === 1 ? stdout : stderr).push(data);
          } else if (channel === 3) {
            statusRaw = data.toString('utf8');
          }
        },
        (opcode, payload) => {
          if (opcode === 0x9) socket.write(encodeFrame(0xA, payload)); // ping → pong
          else if (opcode === 0x8) socket.end(); // close → 'close' fires done()
        },
      );
      socket.on('data', (chunk) => {
        try { parser.push(chunk); } catch (err) {
          fail(err instanceof ContainerExecError ? err : new ContainerExecError(err.message, 'exec-failed'));
        }
      });
      socket.on('end', done);
      socket.on('close', done);
      socket.on('error', (err) => fail(new ContainerExecError(err.message, 'exec-failed')));
      if (head && head.length) {
        try { parser.push(head); } catch (err) {
          return fail(err instanceof ContainerExecError ? err : new ContainerExecError(err.message, 'exec-failed'));
        }
      }
      if (stdinData) {
        for (let off = 0; off < stdinData.length; off += STDIN_CHUNK) {
          const chunk = stdinData.slice(off, off + STDIN_CHUNK);
          socket.write(encodeFrame(0x2, Buffer.concat([Buffer.from([0]), chunk])));
        }
      }
    });

    req.on('error', (err) => fail(new ContainerExecError(err.message, 'exec-failed')));
    req.end();
  });
}

// Find THIS instance's running pod for an agent — the label-selector scoping
// lives in listAgentPods (spawn-kubernetes-pod.js); phase-filter here because
// exec against a Pending/Succeeded pod can only fail.
async function findAgentPodName(agentId) {
  const pods = await listAgentPods(agentId);
  const running = pods.find((p) => String(p?.status?.phase || '') === 'Running');
  return running ? running.metadata.name : null;
}

// Same surface as container-exec.js: resolve the pod from the agent id, throw
// `no-container` when the agent isn't running (the caller turns that into an
// honest 409/404 rather than a generic failure).
async function execInAgentContainer(agentId, argv, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ContainerExecError('argv must be a non-empty array', 'bad-argv');
  }
  let podName;
  try {
    podName = await findAgentPodName(agentId);
  } catch (err) {
    throw new ContainerExecError(err.message, 'exec-failed');
  }
  if (!podName) throw new ContainerExecError('agent container is not running', 'no-container');
  return wsExec(podName, argv.map(String), { timeoutMs, maxBytes });
}

// Byte-exact upload counterpart of container-exec.js's libpod archive PUT:
// stream the tar over exec stdin into `tar -x` at the pre-validated target
// directory. A read-only mount (kernel EROFS backstop) or permission problem
// surfaces in tar's stderr and maps to the same codes as the podman path.
async function putArchiveToAgentContainer(agentId, containerPath, tarBuffer, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let podName;
  try {
    podName = await findAgentPodName(agentId);
  } catch (err) {
    throw new ContainerExecError(err.message, 'exec-failed');
  }
  if (!podName) throw new ContainerExecError('agent container is not running', 'no-container');
  const argv = buildUploadArgv(tarBuffer.length, containerPath);
  const r = await wsExec(podName, argv, { timeoutMs, maxBytes: 256 * 1024, stdinData: tarBuffer });
  if (r.exitCode !== 0) {
    const msg = r.stderr.toString('utf8');
    const low = msg.toLowerCase();
    const code = /read-only|read only|erofs/.test(low) ? 'read-only'
               : /permission|eacces|eperm/.test(low) ? 'denied'
               : 'exec-failed';
    throw new ContainerExecError(`archive extract failed (exit ${r.exitCode}): ${msg.slice(0, 300)}`, code);
  }
  return { status: 200 };
}

module.exports = {
  ContainerExecError,
  execInAgentContainer,
  putArchiveToAgentContainer,
  // Pure helpers exposed for unit tests only.
  _internal: {
    buildExecPath,
    encodeFrame,
    FrameParser,
    parseExecStatus,
    buildUploadArgv,
  },
};
