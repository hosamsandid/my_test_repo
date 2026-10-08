import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import * as view from './memory-limit-view.js';

const require = createRequire(import.meta.url);
const cjs = require('../../api/memory-limit.js');

const SAMPLES = ['', '4g', '4Gi', '512m', ' 8GB ', '0g', '-1g', '4', 'huge', '9g', '16t', null, undefined];

test('ESM copy behaves exactly like the CJS twin (#2813)', () => {
  for (const s of SAMPLES) {
    assert.equal(view.parseMemoryLimit(s), cjs.parseMemoryLimit(s), `parse ${s}`);
    assert.equal(view.normalizeMemoryLimit(s), cjs.normalizeMemoryLimit(s), `normalize ${s}`);
    assert.equal(view.memoryLimitError(s, { role: 'r' }), cjs.memoryLimitError(s, { role: 'r' }), `error ${s}`);
    assert.deepEqual(
      view.resolveEffectiveMemory({ role: s, toolchain: '6g', platform: '2g' }),
      cjs.resolveEffectiveMemory({ role: s, toolchain: '6g', platform: '2g' }),
      `resolve ${s}`,
    );
  }
  assert.equal(view.DEFAULT_MEMORY_CEILING, cjs.DEFAULT_MEMORY_CEILING);
  assert.equal(view.memoryCeiling({ AEE_AGENT_MEM_CEILING: '12g' }), cjs.memoryCeiling({ AEE_AGENT_MEM_CEILING: '12g' }));
});

test('effectiveMemoryText shows the effective limit and its source (AC6)', () => {
  assert.equal(view.effectiveMemoryText('', { platform: '2g' }), 'Effective limit: 2g (platform default)');
  assert.equal(
    view.effectiveMemoryText('', { toolchain: '6g', platform: '2g' }),
    'Effective limit: 6g (toolchain) · platform default: 2g',
  );
  // edge case: the role value beats a larger toolchain value, and the UI shows both
  assert.equal(
    view.effectiveMemoryText('4g', { toolchain: '6g', platform: '2g' }),
    'Effective limit: 4g (role setting) · toolchain: 6g · platform default: 2g',
  );
  assert.match(view.effectiveMemoryText('32g', { platform: '2g', ceiling: '8g' }), /^Effective limit: 8g \(role setting\) — capped at the platform ceiling 8g/);
});

test('the next-start note states running containers keep their limit (AC7)', () => {
  assert.match(view.MEMORY_NEXT_START_NOTE, /next container start/);
  assert.match(view.MEMORY_NEXT_START_NOTE, /pool instances\) keep their current limit/);
});
