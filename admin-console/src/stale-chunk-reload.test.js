import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELOAD_COOLDOWN_MS,
  isStaleChunkError,
  shouldReloadForChunkError,
} from './stale-chunk-reload.js';

test('isStaleChunkError matches the dynamic-import failure messages', () => {
  assert.equal(
    isStaleChunkError(new Error('Failed to fetch dynamically imported module: http://x/assets/AgentChat-abc.js')),
    true,
  );
  assert.equal(isStaleChunkError('error loading dynamically imported module'), true);
  assert.equal(isStaleChunkError({ message: 'Importing a module script failed' }), true);
});

test('isStaleChunkError ignores unrelated errors', () => {
  assert.equal(isStaleChunkError(new Error('Minified React error #185')), false);
  assert.equal(isStaleChunkError('NetworkError when attempting to fetch resource'), false);
  assert.equal(isStaleChunkError(null), false);
  assert.equal(isStaleChunkError(undefined), false);
});

test('shouldReloadForChunkError allows a first reload', () => {
  assert.equal(shouldReloadForChunkError({ now: 1000, lastReloadAt: 0 }), true);
  assert.equal(shouldReloadForChunkError({ now: 1000, lastReloadAt: null }), true);
  assert.equal(shouldReloadForChunkError({ now: 1000, lastReloadAt: NaN }), true);
});

test('shouldReloadForChunkError suppresses a reload loop within the cooldown', () => {
  const last = 100_000;
  assert.equal(
    shouldReloadForChunkError({ now: last + RELOAD_COOLDOWN_MS - 1, lastReloadAt: last }),
    false,
  );
  // Exactly at the cooldown boundary the next attempt is allowed again.
  assert.equal(
    shouldReloadForChunkError({ now: last + RELOAD_COOLDOWN_MS, lastReloadAt: last }),
    true,
  );
});
