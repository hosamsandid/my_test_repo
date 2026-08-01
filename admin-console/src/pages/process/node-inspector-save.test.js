import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDetailsSave } from './node-inspector-save.js';

// A recording mock ops adapter: every call is appended to `calls` in order, so
// tests can assert both WHICH ops ran and their SEQUENCE (the order-sensitive
// rules are the whole point of this helper).
function mockOps(overrides = {}) {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(ret); };
  return {
    calls,
    renameRole: rec('renameRole'),
    setPrompt: rec('setPrompt'),
    addStage: rec('addStage'),
    setStage: rec('setStage'),
    renameRoleId: rec('renameRoleId', 'new-id'),
    ...overrides,
  };
}

// ── display name ──────────────────────────────────────────────────────────────
test('renames the display name when it changed (both modes)', async () => {
  for (const mode of ['draft', 'live']) {
    const ops = mockOps();
    await applyDetailsSave(ops, { id: 'a', displayName: 'Old' }, { name: 'New', id: 'a', stage: '' }, { mode });
    assert.deepEqual(ops.calls[0], ['renameRole', 'a', 'New']);
  }
});

test('does not rename when the name is unchanged (falls back to id)', async () => {
  const ops = mockOps();
  // displayName absent → current name is the id; keeping name = id must be a no-op.
  await applyDetailsSave(ops, { id: 'a' }, { name: 'a', id: 'a', stage: '' }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'renameRole').length, 0);
});

// ── prompt (draft only) ───────────────────────────────────────────────────────
test('saves the prompt in draft mode when changed', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', systemPrompt: 'old' },
    { name: 'a', id: 'a', prompt: 'new', stage: '' }, { mode: 'draft' });
  assert.deepEqual(ops.calls.find(c => c[0] === 'setPrompt'), ['setPrompt', 'a', 'new']);
});

test('never touches the prompt in live mode (its own editor owns it)', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a' },
    { name: 'a', id: 'a', prompt: 'whatever', stage: '' }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'setPrompt').length, 0);
});

// ── stage (new stage registered before assignment) ────────────────────────────
test('registers a brand-new stage before assigning it', async () => {
  const ops = mockOps();
  const res = await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '', newStage: '  Build ' }, { mode: 'live' });
  const seq = ops.calls.map(c => c[0]);
  assert.deepEqual(seq, ['addStage', 'setStage']);
  assert.deepEqual(ops.calls[0], ['addStage', 'Build']);
  assert.deepEqual(ops.calls[1], ['setStage', 'a', 'Build']);
  assert.equal(res.stage, 'Build');
});

test('a blank/whitespace new stage creates no phantom stage', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: 'Build' },
    { name: 'a', id: 'a', stage: 'Build', newStage: '   ' }, { mode: 'live' });
  assert.equal(ops.calls.length, 0); // stage unchanged, nothing typed
});

test('assigns a picked existing stage without addStage', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: 'Test' }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'addStage').length, 0);
  assert.deepEqual(ops.calls.find(c => c[0] === 'setStage'), ['setStage', 'a', 'Test']);
});

// ── id rename (draft only, last) ──────────────────────────────────────────────
test('renames the id LAST and returns the new id (draft)', async () => {
  const ops = mockOps();
  const res = await applyDetailsSave(ops, { id: 'a', displayName: 'Old', stage: '', systemPrompt: '' },
    { name: 'New', id: 'b', prompt: '', stage: 'Test' }, { mode: 'draft' });
  const seq = ops.calls.map(c => c[0]);
  assert.deepEqual(seq, ['renameRole', 'setStage', 'renameRoleId']);
  assert.equal(res.renamedId, 'new-id');
});

test('never renames the id in live mode even if fields.id differs', async () => {
  const ops = mockOps();
  const res = await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'totally-different', stage: '' }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'renameRoleId').length, 0);
  assert.equal(res.renamedId, null);
});
