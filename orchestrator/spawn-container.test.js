'use strict';

// spawn-container.js does real libpod HTTP calls end-to-end. This file covers
// its pure `_internal` helpers (the #2282 Band 1 memory sizing, the #2601
// container name), the same way spawn-kubernetes-pod.test.js does, plus the
// #2601 create calls against a fake libpod on a unix socket (below).

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('./spawn-container');
const { parseBytes, resolveMemLimitBytes, AGENT_MEM_LIMIT_BYTES, sanitizeName, agentContainerName } = _internal;

test('parseBytes accepts a human suffix and falls back to 0 on junk', () => {
  assert.equal(parseBytes('2g'), 2 * 1024 ** 3);
  assert.equal(parseBytes('512m'), 512 * 1024 ** 2);
  assert.equal(parseBytes('4gb'), 4 * 1024 ** 3);
  assert.equal(parseBytes('1073741824'), 1073741824);
  assert.equal(parseBytes(''), 0);
  assert.equal(parseBytes('nope'), 0);
});

test('resolveMemLimitBytes falls back to the fleet default when the toolchain has no resources override (AC2)', () => {
  assert.equal(resolveMemLimitBytes(null), AGENT_MEM_LIMIT_BYTES);
  assert.equal(resolveMemLimitBytes({ toolchainId: 'jvm' }), AGENT_MEM_LIMIT_BYTES);
  assert.equal(resolveMemLimitBytes({ toolchainId: 'jvm', resources: null }), AGENT_MEM_LIMIT_BYTES);
  assert.equal(resolveMemLimitBytes({ toolchainId: 'jvm', resources: {} }), AGENT_MEM_LIMIT_BYTES);
});

test('resolveMemLimitBytes uses the toolchain\'s memoryLimit override when present (AC1)', () => {
  assert.equal(
    resolveMemLimitBytes({ toolchainId: 'jvm', resources: { memoryLimit: '4g' } }),
    4 * 1024 ** 3,
  );
});

test('resolveMemLimitBytes falls back to the fleet default on an override that fails to parse', () => {
  assert.equal(
    resolveMemLimitBytes({ toolchainId: 'jvm', resources: { memoryLimit: 'not-a-quantity' } }),
    AGENT_MEM_LIMIT_BYTES,
  );
});

// #2601 — predictable container names
test('sanitizeName replaces characters outside [a-zA-Z0-9_.-] with underscores (AC2)', () => {
  assert.equal(sanitizeName('abc123'), 'abc123');
  assert.equal(sanitizeName('agent-studio-314092'), 'agent-studio-314092');
  assert.equal(sanitizeName('my/instance:tag'), 'my_instance_tag');
  assert.equal(sanitizeName('hello world'), 'hello_world');
  assert.equal(sanitizeName('abc.def_ghi-jkl'), 'abc.def_ghi-jkl');
});

test('agentContainerName produces aee-<sanitizedInstanceId>-<sanitizedAgentId> (AC1, AC2)', () => {
  assert.equal(agentContainerName('my-instance', 'abc123'), 'aee-my-instance-abc123');
  assert.equal(agentContainerName('inst/with:special', 'agent@id'), 'aee-inst_with_special-agent_id');
  assert.equal(agentContainerName('agent-studio-314092', 'a1b2c3d4'), 'aee-agent-studio-314092-a1b2c3d4');
});

// #2601 — the libpod create calls, against a fake libpod on a unix socket. The
// module reads its env at load time, so it is re-required under a test env.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

async function withFakeLibpod(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libpod-'));
  const sock = path.join(dir, 'podman.sock');
  const calls = [];
  // The agent's old container is still listed on the first poll only.
  let oldListed = true;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const url = req.url.replace('/v4.0.0/libpod', '');
      const body = data ? JSON.parse(data) : null;
      calls.push({ method: req.method, url, body });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      if (url.startsWith('/containers/json')) {
        const list = oldListed ? [{ Id: 'old-container' }] : [];
        oldListed = false;
        return send(200, list);
      }
      if (url === '/containers/create') return send(201, { Id: `c${calls.length}` });
      if (/\/start$/.test(url)) return send(204);
      if (/\/wait/.test(url)) return send(200, { StatusCode: 0 });
      if (/\/logs/.test(url)) return send(200);
      return send(200, {});
    });
  });
  await new Promise((r) => server.listen(sock, r));
  const saved = {};
  const env = {
    PODMAN_SOCK_PATH: sock, AEE_INSTANCE_ID: 'test-inst',
    AEE_PER_AGENT_NETWORK: '0', AEE_PER_AGENT_VOLUME: '1',
  };
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const modPath = require.resolve('./spawn-container');
  delete require.cache[modPath];
  try {
    return await fn(require(modPath), calls);
  } finally {
    delete require.cache[modPath];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('spawnContainer names the agent container, leaves the seed helper unnamed, and creates only once the old container is gone (AC3, AC4)', async () => {
  await withFakeLibpod(async (mod, calls) => {
    const handle = mod.spawnContainer({ id: 'agent1', env: {}, image: 'as-agent:test' });
    const code = await new Promise((r) => handle.on('exit', (c) => r(c)));
    assert.equal(code, 0);

    const creates = calls.filter((c) => c.url === '/containers/create');
    assert.equal(creates.length, 2, 'seed helper + agent container');
    const [seed, main] = creates;
    assert.equal(seed.body.labels['aee.agent.id'], 'seed-agent1');
    assert.equal('name' in seed.body, false, 'seed helper must stay unnamed');
    assert.equal(main.body.name, mod._internal.agentContainerName('test-inst', 'agent1'));

    // The old container was listed (scoped to this instance) and the create
    // waited for the poll that saw it gone.
    const lists = calls.map((c, i) => ({ ...c, i })).filter((c) => c.url.startsWith('/containers/json'));
    assert.equal(lists.length, 2);
    const filter = JSON.parse(decodeURIComponent(lists[0].url.split('filters=')[1]));
    assert.deepEqual(filter.label, ['aee.agent.id=agent1', 'aee.instance=test-inst']);
    assert.ok(calls.indexOf(main) > lists[1].i, 'create must come after the old container is cleared');
  });
});

test('reseedPerAgentVolume leaves its helper container unnamed (AC3)', async () => {
  await withFakeLibpod(async (mod, calls) => {
    await mod.reseedPerAgentVolume('agent1', ['CLAUDE.md']);
    const creates = calls.filter((c) => c.url === '/containers/create');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].body.labels['aee.agent.id'], 'reseed-agent1');
    assert.equal('name' in creates[0].body, false);
  });
});
