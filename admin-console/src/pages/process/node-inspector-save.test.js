import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDetailsSave, parseSaveError, savedSummary } from './node-inspector-save.js';

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
    setParent: rec('setParent'),
    setLivePrompt: rec('setLivePrompt'),
    setPool: rec('setPool'),
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

// ── parent (#2295 AC3: batched, no longer applied on selection) ──────────────
test('applies a parent change as part of the batched save', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '', parent: '' },
    { name: 'a', id: 'a', stage: '', parent: 'b' }, { mode: 'live' });
  assert.deepEqual(ops.calls.find(c => c[0] === 'setParent'), ['setParent', 'a', 'b']);
});

test('clears the parent with null, not an empty string', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '', parent: 'b' },
    { name: 'a', id: 'a', stage: '', parent: '' }, { mode: 'live' });
  assert.deepEqual(ops.calls.find(c => c[0] === 'setParent'), ['setParent', 'a', null]);
});

test('does not touch the parent when the field is absent (host has no Parent control)', async () => {
  const ops = mockOps();
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '' }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'setParent').length, 0);
});

test('a rejected parent change (cycle guard) names Parent in the error, parseable back out', async () => {
  const ops = mockOps({ setParent: async () => { throw new Error('that would create a parent cycle'); } });
  await assert.rejects(
    applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '', parent: '' },
      { name: 'a', id: 'a', stage: '', parent: 'b' }, { mode: 'live' }),
    (e) => {
      assert.equal(e.message, 'Parent: that would create a parent cycle');
      return true;
    },
  );
});

// ── live prompt (#2295: batched via ops.setLivePrompt, replaces its own Save) ─
test('saves the live prompt only when dirty relative to what was loaded', async () => {
  const ops = mockOps();
  const clean = { role: 'file', text: 'same', initialText: 'same' };
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '', livePrompt: clean }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'setLivePrompt').length, 0);

  const dirty = { role: 'file', text: 'edited', initialText: 'same' };
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '', livePrompt: dirty }, { mode: 'live' });
  assert.deepEqual(ops.calls.find(c => c[0] === 'setLivePrompt'), ['setLivePrompt', 'a', dirty]);
});

test('a member prompt is dirty on a promptMode change alone, even with the same text', async () => {
  const ops = mockOps();
  const lp = { role: 'member', promptMode: 'exclusive', initialPromptMode: 'inherit', text: 'x', initialText: 'x' };
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '', livePrompt: lp }, { mode: 'live' });
  assert.deepEqual(ops.calls.find(c => c[0] === 'setLivePrompt'), ['setLivePrompt', 'a', lp]);
});

test('never touches the live prompt in draft mode', async () => {
  const ops = mockOps();
  const lp = { role: 'file', text: 'edited', initialText: 'same' };
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', prompt: '', stage: '', livePrompt: lp }, { mode: 'draft' });
  assert.equal(ops.calls.filter(c => c[0] === 'setLivePrompt').length, 0);
});

// ── scaling (#2295 AC11: batched via ops.setPool, pre-flighted before anything writes) ─
test('applies a dirty, valid scaling draft (#2294: workspace forced to git-clean-base)', async () => {
  const ops = mockOps();
  const pool = {
    // A stale/rehydrated `workspace: 'none'` — there is no UI to set it (#2294),
    // so the save must not thread it back; it lands as git-clean-base.
    draft: { enabled: true, maxInstancesText: '4', workspace: 'none', idleText: '', hardText: '', retainText: '' },
    parentWipLimit: 3,
    initialPool: null,
  };
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '', pool }, { mode: 'live' });
  assert.deepEqual(ops.calls.find(c => c[0] === 'setPool'),
    ['setPool', 'a', { enabled: true, maxInstances: 4, workspace: 'git-clean-base' }]);
});

test('a clean scaling draft never calls setPool', async () => {
  const ops = mockOps();
  const pool = {
    draft: { enabled: false, maxInstancesText: '', workspace: 'git-clean-base', idleText: '', hardText: '', retainText: '' },
    parentWipLimit: null,
    initialPool: null,
  };
  await applyDetailsSave(ops, { id: 'a', displayName: 'a', stage: '' },
    { name: 'a', id: 'a', stage: '', pool }, { mode: 'live' });
  assert.equal(ops.calls.filter(c => c[0] === 'setPool').length, 0);
});

test('an invalid scaling draft blocks the WHOLE save — nothing applies, not even the name', async () => {
  const ops = mockOps();
  const pool = {
    draft: { enabled: true, maxInstancesText: '', workspace: 'git-clean-base', idleText: '', hardText: '', retainText: '' },
    parentWipLimit: null, // enabled with no parent wipLimit → blocked
    initialPool: null,
  };
  await assert.rejects(
    applyDetailsSave(ops, { id: 'a', displayName: 'Old', stage: '' },
      { name: 'New', id: 'a', stage: '', pool }, { mode: 'live' }),
    (e) => {
      assert.match(e.message, /^Scaling:/);
      return true;
    },
  );
  assert.equal(ops.calls.length, 0, 'nothing was written before the pre-flight check failed');
});

// ── error tagging (AC5: a failure names which part) ──────────────────────────
test('savedSummary names what actually changed, in order, and falls back to a plain "Saved."', () => {
  assert.equal(savedSummary([]), 'Saved.');
  assert.equal(savedSummary([{ label: 'Display name', dirty: false }]), 'Saved.');
  assert.equal(
    savedSummary([
      { label: 'Display name', dirty: true },
      { label: 'Stage', dirty: false },
      { label: 'Agent prompt', dirty: true },
    ]),
    'Saved: Display name, Agent prompt.',
  );
});

test('parseSaveError splits "<Label>: <message>" back into its parts', () => {
  assert.deepEqual(parseSaveError('Stage: could not add stage'), { label: 'Stage', message: 'could not add stage' });
  assert.deepEqual(parseSaveError('Display name: taken'), { label: 'Display name', message: 'taken' });
  assert.deepEqual(parseSaveError('nonsense'), { label: null, message: 'nonsense' });
  assert.deepEqual(parseSaveError(''), { label: null, message: '' });
});

test('every batched write tags its own label on failure', async () => {
  const failing = (label) => async () => { throw new Error('boom'); };
  const cases = [
    { ops: mockOps({ renameRole: failing() }), label: 'Display name' },
    { ops: mockOps({ setStage: failing() }), label: 'Stage', fields: { stage: 'Test' } },
    { ops: mockOps({ setParent: failing() }), label: 'Parent', fields: { parent: 'b' } },
  ];
  for (const c of cases) {
    await assert.rejects(
      applyDetailsSave(c.ops, { id: 'a', displayName: 'Old', stage: '', parent: '' },
        { name: 'New', id: 'a', stage: '', parent: '', ...(c.fields || {}) }, { mode: 'live' }),
      (e) => { assert.match(e.message, new RegExp(`^${c.label}:`)); return true; },
    );
  }
});
