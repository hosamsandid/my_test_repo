import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENTION_OPTIONS,
  contentionPolicyValue,
  contentionOptionLabel,
  autoDispatchPrerequisite,
  parseWipLimitInput,
  hasPooledMember,
  parallelismSummary,
} from './parallelism-view.js';

test('CONTENTION_OPTIONS: exactly the three design-doc strategies, mockup order, only epic-serial selectable', () => {
  assert.deepEqual(CONTENTION_OPTIONS.map((o) => o.value), ['none', 'epic-serial', 'predicted-paths']);
  const byValue = Object.fromEntries(CONTENTION_OPTIONS.map((o) => [o.value, o]));
  assert.equal(byValue.none.disabled, true);
  assert.ok(byValue.none.disabledReason);
  assert.equal(byValue['epic-serial'].disabled, false);
  assert.equal(byValue['epic-serial'].disabledReason, null);
  assert.equal(byValue['predicted-paths'].disabled, true);
  assert.ok(byValue['predicted-paths'].disabledReason);
  // Every option carries a non-empty label and blurb — never a blank radio row.
  for (const o of CONTENTION_OPTIONS) {
    assert.ok(o.label && o.label.length > 0, `${o.value} missing label`);
    assert.ok(o.blurb && o.blurb.length > 0, `${o.value} missing blurb`);
  }
});

test('contentionPolicyValue defaults unset/unknown to epic-serial (Amendment 4 A4.1: byte-identical)', () => {
  assert.equal(contentionPolicyValue(null), 'epic-serial');
  assert.equal(contentionPolicyValue(undefined), 'epic-serial');
  assert.equal(contentionPolicyValue({}), 'epic-serial');
  assert.equal(contentionPolicyValue({ enabled: true }), 'epic-serial');
  assert.equal(contentionPolicyValue({ enabled: true, contentionPolicy: 'made-up' }), 'epic-serial');
  assert.equal(contentionPolicyValue({ enabled: true, contentionPolicy: 'predicted-paths' }), 'predicted-paths');
});

test('contentionOptionLabel resolves known values and falls back to the raw value for an unknown one', () => {
  assert.equal(contentionOptionLabel('epic-serial'), 'Serialize same epic');
  assert.equal(contentionOptionLabel('predicted-paths'), 'Smart: LLM predicts conflicts');
  assert.equal(contentionOptionLabel('none'), 'Full parallelism');
  assert.equal(contentionOptionLabel('some-future-value'), 'some-future-value');
});

test('autoDispatchPrerequisite mirrors PUT /api/agents/:teamId\'s two gates', () => {
  assert.deepEqual(autoDispatchPrerequisite({ wipLimit: null, hasPooledRole: true }), {
    ok: false,
    reason: 'Set "Up to N tickets at once" first — auto-dispatch piggybacks on the flow\'s own ticket limit.',
  });
  assert.deepEqual(autoDispatchPrerequisite({ wipLimit: 0, hasPooledRole: true }).ok, false);
  assert.deepEqual(autoDispatchPrerequisite({ wipLimit: 3, hasPooledRole: false }), {
    ok: false,
    reason: 'Add at least one pooled role (a team member with pooling enabled) — auto-dispatch only times pooled roles.',
  });
  assert.deepEqual(autoDispatchPrerequisite({ wipLimit: 3, hasPooledRole: true }), { ok: true, reason: null });
});

test('autoDispatchPrerequisite: wipLimit check takes precedence when both prerequisites are missing', () => {
  const r = autoDispatchPrerequisite({ wipLimit: null, hasPooledRole: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ticket limit/);
});

test('parseWipLimitInput accepts positive integers and blank, rejects everything else', () => {
  assert.deepEqual(parseWipLimitInput(''), { value: null, error: null });
  assert.deepEqual(parseWipLimitInput('   '), { value: null, error: null });
  assert.deepEqual(parseWipLimitInput(null), { value: null, error: null });
  assert.deepEqual(parseWipLimitInput(undefined), { value: null, error: null });
  assert.deepEqual(parseWipLimitInput('3'), { value: 3, error: null });
  assert.deepEqual(parseWipLimitInput('  3  '), { value: 3, error: null });
  assert.equal(parseWipLimitInput('0').value, null);
  assert.ok(parseWipLimitInput('0').error);
  assert.ok(parseWipLimitInput('-1').error);
  assert.ok(parseWipLimitInput('1.5').error);
  assert.ok(parseWipLimitInput('abc').error);
});

test('hasPooledMember checks parentTeamId + pool.enabled across the flat /api/agents list', () => {
  const agents = [
    { id: 'acme', role: 'team' },
    { id: 'acme-dev', parentTeamId: 'acme', pool: { enabled: false } },
    { id: 'acme-rev', parentTeamId: 'acme' },
    { id: 'other-dev', parentTeamId: 'other', pool: { enabled: true } },
  ];
  assert.equal(hasPooledMember(agents, 'acme'), false);
  assert.equal(hasPooledMember(agents, 'other'), true);
  assert.equal(hasPooledMember([], 'acme'), false);
  assert.equal(hasPooledMember(null, 'acme'), false);

  const withPooled = agents.concat([{ id: 'acme-qa', parentTeamId: 'acme', pool: { enabled: true } }]);
  assert.equal(hasPooledMember(withPooled, 'acme'), true);
});

test('parallelismSummary: unconfigured team reads as one plain line', () => {
  assert.deepEqual(parallelismSummary({ wipLimit: null, autoDispatch: null }), [
    'No ticket limit set — dispatch is unbounded',
    'Auto-dispatch: off',
  ]);
});

test('parallelismSummary: singular/plural ticket wording', () => {
  assert.equal(parallelismSummary({ wipLimit: 1, autoDispatch: null })[0], 'Up to 1 ticket at once');
  assert.equal(parallelismSummary({ wipLimit: 3, autoDispatch: null })[0], 'Up to 3 tickets at once');
});

test('parallelismSummary: auto-dispatch on surfaces the effective contention strategy', () => {
  assert.deepEqual(parallelismSummary({ wipLimit: 3, autoDispatch: { enabled: true } }), [
    'Up to 3 tickets at once',
    'Auto-dispatch: on · Serialize same epic',
  ]);
  assert.deepEqual(parallelismSummary({ wipLimit: 3, autoDispatch: { enabled: true, contentionPolicy: 'predicted-paths' } }), [
    'Up to 3 tickets at once',
    'Auto-dispatch: on · Smart: LLM predicts conflicts',
  ]);
});
