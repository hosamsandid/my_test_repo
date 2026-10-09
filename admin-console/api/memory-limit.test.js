'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_MEMORY_CEILING,
  parseMemoryLimit,
  normalizeMemoryLimit,
  formatMemoryBytes,
  memoryCeiling,
  memoryLimitError,
  resolveEffectiveMemory,
} = require('./memory-limit');

const G = 1024 ** 3;

test('parse/normalize accept podman and k8s spellings, require a unit (#2813)', () => {
  assert.equal(parseMemoryLimit('4g'), 4 * G);
  assert.equal(parseMemoryLimit('4Gi'), 4 * G);
  assert.equal(parseMemoryLimit('512m'), 512 * 1024 ** 2);
  assert.equal(parseMemoryLimit('4'), 0);
  assert.equal(parseMemoryLimit('lots'), 0);
  assert.equal(normalizeMemoryLimit(' 4GB '), '4g');
  assert.equal(normalizeMemoryLimit('512Mi'), '512m');
  assert.equal(normalizeMemoryLimit('0g'), null);
  assert.equal(normalizeMemoryLimit(''), null);
  assert.equal(formatMemoryBytes(4 * G), '4g');
  assert.equal(formatMemoryBytes(1536 * 1024 ** 2), '1536m');
});

test('memoryLimitError: empty is the platform default, invalid values name the role (AC4)', () => {
  assert.equal(memoryLimitError(''), null);
  assert.equal(memoryLimitError(undefined), null);
  assert.equal(memoryLimitError('4g', { role: 'dev' }), null);
  assert.match(memoryLimitError('huge', { role: 'dev' }), /^role dev: memory limit "huge" is not a size/);
  assert.match(memoryLimitError('0g', { role: 'dev' }), /^role dev: .*greater than zero/);
  assert.match(memoryLimitError('-2g', { role: 'dev' }), /^role dev: .*greater than zero/);
});

test('memoryLimitError: the ceiling defaults to 8g and is operator-configurable (AC5)', () => {
  assert.equal(DEFAULT_MEMORY_CEILING, '8g');
  assert.equal(memoryLimitError('8g', { role: 'dev' }), null);
  assert.match(memoryLimitError('9g', { role: 'dev' }), /exceeds the platform ceiling of 8g/);
  assert.equal(memoryLimitError('12g', { role: 'dev', ceiling: '16g' }), null);
  assert.equal(memoryCeiling({}), '8g');
  assert.equal(memoryCeiling({ AEE_AGENT_MEM_CEILING: '16G' }), '16g');
  assert.equal(memoryCeiling({ AEE_AGENT_MEM_CEILING: 'nonsense' }), '8g');
});

test('resolveEffectiveMemory: role → toolchain → platform (AC3/AC6)', () => {
  assert.deepEqual(
    pick(resolveEffectiveMemory({ role: '4g', toolchain: '6g', platform: '2g' })),
    { limit: '4g', source: 'role', clamped: false, toolchain: '6g' },
    'a role value beats a larger toolchain value, and both stay visible',
  );
  assert.deepEqual(pick(resolveEffectiveMemory({ toolchain: '6g', platform: '2g' })), { limit: '6g', source: 'toolchain', clamped: false, toolchain: '6g' });
  assert.deepEqual(pick(resolveEffectiveMemory({ platform: '2g' })), { limit: '2g', source: 'platform', clamped: false, toolchain: null });
  assert.deepEqual(pick(resolveEffectiveMemory({ role: 'bad', platform: '3g' })), { limit: '3g', source: 'platform', clamped: false, toolchain: null });
  const clamped = resolveEffectiveMemory({ role: '32g', ceiling: '8g' });
  assert.equal(clamped.limit, '8g');
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.bytes, 8 * G);
});

function pick(e) {
  return { limit: e.limit, source: e.source, clamped: e.clamped, toolchain: e.toolchain };
}

test('the orchestrator twin is byte-identical to the admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'memory-limit.js'), 'utf8');
  const twin = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'memory-limit.js'), 'utf8');
  assert.equal(twin, here, 'orchestrator/memory-limit.js must be byte-identical to admin-console/api/memory-limit.js');
});
