'use strict';

const http = require('http');
const { EventEmitter, PassThrough } = require('stream');

const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const AGENT_IMAGE = process.env.AGENT_IMAGE || 'ace-agent:latest';
const WORKSPACE_VOLUME = process.env.AGENT_WORKSPACE_VOLUME ||
  `${process.env.COMPOSE_PROJECT_NAME || 'vgh-claw-314092'}_agent-pool-workspace`;

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
  const createBody = {
    image: AGENT_IMAGE,
    env: envMap,
    volumes: [{ Name: WORKSPACE_VOLUME, Dest: '/workspace' }],
    remove: true,
  };

  libpodRequest('POST', '/containers/create', createBody)
    .then((r) => {
      if (r.status >= 300 || !r.body || !r.body.Id) {
        throw new Error(`create failed: status=${r.status} body=${JSON.stringify(r.body)}`);
      }
      containerId = r.body.Id;
      handle.pid = containerId.slice(0, 12);
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

module.exports = { spawnContainer };
