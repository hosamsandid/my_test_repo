import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLLOUT_CLASS,
  classifyMemberState,
  classifyMemberStatus,
  tallyRollout,
  healthSentence,
  healthTone,
  rolloutStatus,
} from './skill-rollout-view.js';
import { summarizeActivation } from './knowledge-activation-view.js';

// ── classifiers ───────────────────────────────────────────────────────────────

test('classifyMemberState maps the graph overlay states', () => {
  assert.equal(classifyMemberState('active'), ROLLOUT_CLASS.INSTALLED);
  assert.equal(classifyMemberState('pending'), ROLLOUT_CLASS.PENDING);
  assert.equal(classifyMemberState('excluded-override'), ROLLOUT_CLASS.OVERRIDE);
  assert.equal(classifyMemberState('stub'), ROLLOUT_CLASS.STUB);
  assert.equal(classifyMemberState('inactive'), ROLLOUT_CLASS.INACTIVE);
  assert.equal(classifyMemberState(undefined), ROLLOUT_CLASS.INACTIVE);
});

test('classifyMemberStatus maps the fan-out sync results', () => {
  assert.equal(classifyMemberStatus({ status: 'seeded' }), ROLLOUT_CLASS.INSTALLED);
  assert.equal(classifyMemberStatus({ status: 'removed' }), ROLLOUT_CLASS.INSTALLED);
  assert.equal(classifyMemberStatus({ status: 'stub' }), ROLLOUT_CLASS.STUB);
  assert.equal(classifyMemberStatus({ status: 'skipped-override' }), ROLLOUT_CLASS.OVERRIDE);
  assert.equal(classifyMemberStatus({ status: 'error' }), ROLLOUT_CLASS.FAILED);
});

// ── tallyRollout: the single counting basis ────────────────────────────────────

test('target excludes stubs and override members (materialized, non-override)', () => {
  const t = tallyRollout([
    ROLLOUT_CLASS.INSTALLED, ROLLOUT_CLASS.INSTALLED, ROLLOUT_CLASS.INSTALLED, ROLLOUT_CLASS.INSTALLED,
    ROLLOUT_CLASS.STUB, ROLLOUT_CLASS.OVERRIDE,
  ]);
  assert.equal(t.installed, 4);
  assert.equal(t.target, 4);
  assert.equal(t.stubs, 1);
  assert.equal(t.overrides, 1);
  assert.equal(t.total, 6);
});

// ── #774 AC4: the badge and the flash report the SAME numbers ──────────────────
//
// The core bug: the same situation showed "4/4" in the flash and "4/6" in the
// badge. Feed the SAME situation through both entry points and assert the
// installed/target numbers agree, because both now go through tallyRollout.

test('AC4: badge (state overlay) and flash (fan-out result) agree on installed/target for one situation', () => {
  // 4 installed + 2 stubs — the historical 4/4-vs-4/6 case.
  const overlayMembers = [
    { state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'active' },
    { state: 'stub' }, { state: 'stub' },
  ];
  const fanoutMembers = [
    { status: 'seeded' }, { status: 'seeded' }, { status: 'seeded' }, { status: 'seeded' },
    { status: 'stub' }, { status: 'stub' },
  ];

  const badge = tallyRollout(overlayMembers.map(m => classifyMemberState(m.state)));
  const flash = summarizeActivation(fanoutMembers);

  assert.equal(badge.installed, 4);
  assert.equal(badge.target, 4);
  assert.equal(flash.synced, 4);
  assert.equal(flash.syncable, 4);
  // Same numbers, same denominator basis — no more 4/4 vs 4/6.
  assert.equal(badge.installed, flash.synced);
  assert.equal(badge.target, flash.syncable);
  assert.equal(flash.text, 'active for 4/4 members');
});

// ── rolloutStatus: pill + health sentence (#774 AC4) ───────────────────────────

test('promoted-but-not-activated → Ready pill', () => {
  const s = rolloutStatus({ active: false });
  assert.equal(s.pill, 'Ready');
  assert.equal(s.tone, 'muted');
  assert.match(s.sentence, /not in use yet/);
});

test('fully installed → In use, success, "Installed on all N agents"', () => {
  const s = rolloutStatus({ active: true, members: [{ state: 'active' }, { state: 'active' }] });
  assert.equal(s.pill, 'In use');
  assert.equal(s.tone, 'success');
  assert.equal(s.sentence, 'Installed on all 2 agents');
});

test('partly installed → warning, "Installing — X of N, Y pending"', () => {
  const s = rolloutStatus({ active: true, members: [{ state: 'active' }, { state: 'pending' }, { state: 'pending' }] });
  assert.equal(s.tone, 'warning');
  assert.equal(s.sentence, 'Installing — 1 of 3, 2 pending');
});

test('override members are annotated, not counted as failures', () => {
  const s = rolloutStatus({ active: true, members: [{ state: 'active' }, { state: 'excluded-override' }] });
  assert.equal(s.tone, 'success');
  assert.equal(s.sentence, 'Installed on all 1 agent · 1 agent keeps its own skill list');
});

test('stubs are annotated, not counted as failures', () => {
  const s = rolloutStatus({ active: true, members: [{ state: 'active' }, { state: 'stub' }] });
  assert.equal(s.sentence, 'Installed on all 1 agent · 1 not materialized yet');
});

test('source-missing is a red error sentence regardless of member counts', () => {
  const s = rolloutStatus({ active: true, sourceMissing: true, members: [{ state: 'pending' }] });
  assert.equal(s.tone, 'error');
  assert.match(s.sentence, /Source file missing/);
});

test('single-agent health sentence uses the singular', () => {
  assert.equal(
    healthSentence(tallyRollout([ROLLOUT_CLASS.INSTALLED]), { active: true }),
    'Installed on all 1 agent',
  );
});

test('healthTone: no target members reads muted', () => {
  assert.equal(healthTone(tallyRollout([ROLLOUT_CLASS.STUB]), { active: true }), 'muted');
});
