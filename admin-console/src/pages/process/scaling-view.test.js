import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POOL_WORKSPACE_OPTIONS,
  workspaceValue,
  scalingPrerequisite,
  parseMaxInstancesInput,
  parseMinutesInput,
  msToMinutesText,
  poolBadgeText,
  buildPoolPayload,
  scalingDraftFromPool,
  scalingSaveDecision,
  scalingDraftDirty,
} from './scaling-view.js';

test('POOL_WORKSPACE_OPTIONS: exactly the three normalizePool workspaces, each with a label', () => {
  assert.deepEqual(POOL_WORKSPACE_OPTIONS.map((o) => o.value), ['git-clean-base', 'input-copy', 'none']);
  for (const o of POOL_WORKSPACE_OPTIONS) {
    assert.ok(o.label && o.label.length > 0, `${o.value} missing label`);
  }
});

test('workspaceValue defaults unset/unknown to git-clean-base (normalizePool parity)', () => {
  assert.equal(workspaceValue(null), 'git-clean-base');
  assert.equal(workspaceValue(undefined), 'git-clean-base');
  assert.equal(workspaceValue({}), 'git-clean-base');
  assert.equal(workspaceValue({ workspace: 'made-up' }), 'git-clean-base');
  assert.equal(workspaceValue({ workspace: 'input-copy' }), 'input-copy');
  assert.equal(workspaceValue({ workspace: 'none' }), 'none');
});

test('scalingPrerequisite mirrors PUT /api/agents/:memberId\'s one gate: the PARENT team\'s wipLimit', () => {
  assert.deepEqual(scalingPrerequisite({ parentWipLimit: null }), {
    ok: false,
    reason: 'The parent team has no ticket limit set — set "Up to N tickets at once" in the team\'s Parallelism panel first.',
  });
  assert.equal(scalingPrerequisite({ parentWipLimit: 0 }).ok, false);
  assert.equal(scalingPrerequisite({ parentWipLimit: undefined }).ok, false);
  assert.deepEqual(scalingPrerequisite({ parentWipLimit: 3 }), { ok: true, reason: null });
});

test('parseMaxInstancesInput accepts positive integers and blank, rejects everything else', () => {
  assert.deepEqual(parseMaxInstancesInput(''), { value: null, error: null });
  assert.deepEqual(parseMaxInstancesInput('   '), { value: null, error: null });
  assert.deepEqual(parseMaxInstancesInput(null), { value: null, error: null });
  assert.deepEqual(parseMaxInstancesInput(undefined), { value: null, error: null });
  assert.deepEqual(parseMaxInstancesInput('4'), { value: 4, error: null });
  assert.deepEqual(parseMaxInstancesInput('  4  '), { value: 4, error: null });
  assert.equal(parseMaxInstancesInput('0').value, null);
  assert.ok(parseMaxInstancesInput('0').error);
  assert.ok(parseMaxInstancesInput('-1').error);
  assert.ok(parseMaxInstancesInput('1.5').error);
  assert.ok(parseMaxInstancesInput('abc').error);
});

test('parseMinutesInput accepts positive numbers and blank, converts to milliseconds', () => {
  assert.deepEqual(parseMinutesInput(''), { value: null, error: null });
  assert.deepEqual(parseMinutesInput(null), { value: null, error: null });
  assert.deepEqual(parseMinutesInput('30'), { value: 1800000, error: null });
  assert.deepEqual(parseMinutesInput('120'), { value: 7200000, error: null });
  assert.deepEqual(parseMinutesInput('0.5'), { value: 30000, error: null });
  assert.equal(parseMinutesInput('0').value, null);
  assert.ok(parseMinutesInput('0').error);
  assert.ok(parseMinutesInput('-5').error);
  assert.ok(parseMinutesInput('abc').error);
});

test('msToMinutesText is the inverse of parseMinutesInput for whole-minute values', () => {
  assert.equal(msToMinutesText(1800000), '30');
  assert.equal(msToMinutesText(7200000), '120');
  assert.equal(msToMinutesText(null), '');
  assert.equal(msToMinutesText(undefined), '');
  assert.equal(msToMinutesText(0), '');
  assert.equal(msToMinutesText(-5), '');
});

test('poolBadgeText renders nothing for a non-pooled role, a per-role cap when set, else "team limit"', () => {
  assert.equal(poolBadgeText(null), null);
  assert.equal(poolBadgeText(undefined), null);
  assert.equal(poolBadgeText({ enabled: false }), null);
  assert.equal(poolBadgeText({ enabled: true }), 'pooled role · up to team limit');
  assert.equal(poolBadgeText({ enabled: true, maxInstances: 4 }), 'pooled role · up to 4');
});

test('buildPoolPayload: disabled clears the field (null), never a half-formed enabled:false object', () => {
  assert.equal(buildPoolPayload({ enabled: false, maxInstances: 4, workspace: 'input-copy' }), null);
});

test('buildPoolPayload: enabled with no extras is the minimal shape', () => {
  assert.deepEqual(buildPoolPayload({ enabled: true, maxInstances: null, workspace: undefined }), {
    enabled: true,
    workspace: 'git-clean-base',
  });
});

test('buildPoolPayload: carries maxInstances, workspace and every set teardown field', () => {
  assert.deepEqual(buildPoolPayload({
    enabled: true, maxInstances: 4, workspace: 'input-copy',
    idleTimeoutMs: 1800000, maxRuntimeMs: 7200000, retainLogsMs: 3600000,
  }), {
    enabled: true,
    maxInstances: 4,
    workspace: 'input-copy',
    teardown: { idleTimeoutMs: 1800000, maxRuntimeMs: 7200000, retainLogsMs: 3600000 },
  });
});

test('buildPoolPayload: omits teardown entirely when no timeout is set', () => {
  const p = buildPoolPayload({ enabled: true, maxInstances: null, workspace: 'none', idleTimeoutMs: null, maxRuntimeMs: null, retainLogsMs: null });
  assert.equal('teardown' in p, false);
});

/* ── #2295: controlled-draft helpers (no more section-local Save) ────── */

test('scalingDraftFromPool: an absent pool is the disabled/blank draft', () => {
  assert.deepEqual(scalingDraftFromPool(null), {
    enabled: false, maxInstancesText: '', workspace: 'git-clean-base',
    idleText: '', hardText: '', retainText: '',
  });
});

test('scalingDraftFromPool: round-trips a persisted pool into editable text fields', () => {
  const draft = scalingDraftFromPool({
    enabled: true, maxInstances: 4, workspace: 'input-copy',
    teardown: { idleTimeoutMs: 1800000, maxRuntimeMs: 7200000, retainLogsMs: 3600000 },
  });
  assert.deepEqual(draft, {
    enabled: true, maxInstancesText: '4', workspace: 'input-copy',
    idleText: '30', hardText: '120', retainText: '60',
  });
});

test('scalingSaveDecision: a parse error blocks the save with no payload', () => {
  const draft = scalingDraftFromPool(null);
  const decision = scalingSaveDecision({ ...draft, maxInstancesText: '-1' }, 3);
  assert.equal(decision.payload, undefined);
  assert.ok(decision.error);
});

test('scalingSaveDecision: enabling without a parent wipLimit is blocked with the prerequisite reason', () => {
  const decision = scalingSaveDecision({ ...scalingDraftFromPool(null), enabled: true }, null);
  assert.equal(decision.payload, undefined);
  assert.match(decision.error, /ticket limit/);
});

test('scalingSaveDecision: a disabled draft never needs the parent wipLimit and clears the field', () => {
  const decision = scalingSaveDecision(scalingDraftFromPool(null), null);
  assert.equal(decision.error, null);
  assert.equal(decision.payload, null);
});

test('scalingSaveDecision: a valid enabled draft produces buildPoolPayload\'s shape', () => {
  const draft = { enabled: true, maxInstancesText: '4', workspace: 'input-copy', idleText: '30', hardText: '', retainText: '' };
  const decision = scalingSaveDecision(draft, 3);
  assert.equal(decision.error, null);
  // #2294: the save forces git-clean-base — a rehydrated draft.workspace
  // (here 'input-copy') must never sneak back into the payload.
  assert.deepEqual(decision.payload, {
    enabled: true, maxInstances: 4, workspace: 'git-clean-base', teardown: { idleTimeoutMs: 1800000 },
  });
});

test('scalingDraftDirty: false right after deriving the draft from the pool, true after any edit', () => {
  const pool = { enabled: true, maxInstances: 4, workspace: 'none' };
  const draft = scalingDraftFromPool(pool);
  assert.equal(scalingDraftDirty(draft, pool), false);
  assert.equal(scalingDraftDirty({ ...draft, maxInstancesText: '5' }, pool), true);
});
