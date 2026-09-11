import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading drift guard over `PublishSkillAction.jsx` (#2180) — the
 * #651 convention (see `error-boundary-wiring.test.js`), used because this
 * repo has no jsdom / react-test-renderer, so a hook-based function
 * component's internal closures cannot be driven live under `node --test`.
 *
 * This pins the fix for the reviewed stale-closure bug: `start(id)` calls
 * `setPathId(id)` and, in the SAME tick, calls `runStep(...)` synchronously —
 * React batches the state update, so a `runStep` that read `pathId` back out
 * of component state would still see the PREVIOUS render's value (`null` on
 * the very first publish). The fix threads the path id through as an
 * explicit ARGUMENT the whole call chain carries, instead. Without this
 * guard, a future edit could silently reintroduce `setDone(pathId)` /
 * `runStep(steps[next], steps, next)` (no `id`) and every unit test of the
 * pure `skill-publish-view.js` module would stay green, because the bug is
 * entirely in the JSX component's own state plumbing.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SRC = stripComments(read('./PublishSkillAction.jsx'));

test('runStep takes the path id as an explicit 4th argument', () => {
  assert.match(SRC, /async function runStep\(step, steps, idx, id\)/);
});

test('the terminal setDone uses the threaded id, never the pathId state', () => {
  assert.match(SRC, /setDone\(id\);/);
  assert.doesNotMatch(SRC, /setDone\(pathId\)/, 'reading pathId state here is exactly the stale-closure bug');
});

test('the recursive continuation carries id forward, not just step/steps/idx', () => {
  assert.match(SRC, /await runStep\(steps\[next\], steps, next, id\);/);
});

test('start() passes the SAME id it just set into state as the explicit argument', () => {
  assert.match(SRC, /function start\(id\) \{[\s\S]{0,200}?runStep\(steps\[0\], steps, 0, id\);/);
});

test('a pending overwrite confirmation carries its own id, and confirmOverwrite threads it back through', () => {
  // The 409-collision path suspends mid-chain; `id` must ride along in
  // `pendingStep` so `confirmOverwrite` can resume with the SAME id rather
  // than falling back to (stale) component state.
  assert.match(SRC, /setPendingStep\(\{ step, steps, idx, id \}\);/);
  assert.match(SRC, /const \{ step, steps, idx, id \} = pendingStep;/);
  assert.match(SRC, /runStep\(\{ \.\.\.step, onCollision: 'overwrite' \}, steps, idx, id\);/);
});

test('the success indicator only reads state that setDone(id) actually reaches', () => {
  assert.match(SRC, /\{done && <div/, 'the "Published ✓" line must still be gated on the done state');
});
