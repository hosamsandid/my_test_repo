'use strict';

// spawn-container.js does real libpod HTTP calls end-to-end, so it has no
// broader unit-test harness — this file covers only the pure #2282 Band 1
// memory-sizing helper, the same way spawn-kubernetes-pod.test.js covers its
// pure `_internal` helpers.

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
