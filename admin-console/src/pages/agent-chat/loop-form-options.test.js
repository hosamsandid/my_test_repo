import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STOP_CONDITIONS,
  TOKEN_BUDGET_PRESETS,
  GAP_PRESETS,
  deriveStopCondition,
  deriveTokenBudget,
  deriveGap,
  resolveTokenBudget,
  resolveGapSeconds,
  loopVerifierCopy,
} from './loop-form-options.js';

// ── Option catalogues (#1083 AC2/AC3/AC4) ───────────────────────────────────

test('stop condition offers two predefined options plus a custom escape hatch', () => {
  const values = STOP_CONDITIONS.map(o => o.value);
  assert.ok(values.includes('verifier'));
  assert.ok(values.includes('iterations'));
  assert.ok(values.includes('custom'));
  // At least two NON-custom (predefined) options.
  assert.ok(values.filter(v => v !== 'custom').length >= 2);
});

test('stop condition labels carry no CLI terminology (AC5 spirit)', () => {
  for (const o of STOP_CONDITIONS) {
    assert.doesNotMatch(o.label, /until|exit code|backstop|\bexit\b/i, `label leaks jargon: ${o.label}`);
  }
});

test('token budget offers at least three labelled presets plus custom', () => {
  const labelled = TOKEN_BUDGET_PRESETS.filter(p => p.value !== 'custom');
  assert.ok(labelled.length >= 3);
  for (const p of labelled) assert.ok(p.label && p.label.length > 0);
  assert.ok(TOKEN_BUDGET_PRESETS.some(p => p.value === 'custom'));
});

test('gap presets provide the human-readable labels from the AC', () => {
  const byLabel = Object.fromEntries(GAP_PRESETS.map(p => [p.label, p.seconds]));
  assert.equal(byLabel['Immediately'], 0);
  assert.equal(byLabel['1 minute'], 60);
  assert.equal(byLabel['5 minutes'], 300);
  assert.equal(byLabel['15 minutes'], 900);
  assert.ok(GAP_PRESETS.some(p => p.value === 'custom'));
});

// ── Stop-condition derivation ───────────────────────────────────────────────

test('deriveStopCondition: a stored until command is always custom', () => {
  assert.equal(deriveStopCondition({ command: 'npm test' }, false), 'custom');
  assert.equal(deriveStopCondition({ command: 'npm test' }, true), 'custom');
});

test('deriveStopCondition: no command falls back to verifier presence', () => {
  assert.equal(deriveStopCondition(undefined, true), 'verifier');
  assert.equal(deriveStopCondition(undefined, false), 'iterations');
  assert.equal(deriveStopCondition({ command: '   ' }, true), 'verifier');
});

// ── Token budget round-trip ─────────────────────────────────────────────────

test('deriveTokenBudget: null/absent → no limit', () => {
  assert.deepEqual(deriveTokenBudget(null), { preset: 'none', raw: '' });
  assert.deepEqual(deriveTokenBudget(undefined), { preset: 'none', raw: '' });
});

test('deriveTokenBudget: an exact preset value selects that preset', () => {
  assert.deepEqual(deriveTokenBudget(2000000), { preset: 'medium', raw: '' });
  assert.deepEqual(deriveTokenBudget(500000), { preset: 'small', raw: '' });
});

test('deriveTokenBudget: a non-preset value is custom with the raw string', () => {
  assert.deepEqual(deriveTokenBudget(1234567), { preset: 'custom', raw: '1234567' });
});

test('resolveTokenBudget: presets map to their token count; none omits', () => {
  assert.equal(resolveTokenBudget('none', ''), undefined);
  assert.equal(resolveTokenBudget('medium', ''), 2000000);
  assert.equal(resolveTokenBudget('large', ''), 8000000);
});

test('resolveTokenBudget: custom validates a positive number', () => {
  assert.equal(resolveTokenBudget('custom', '3000000'), 3000000);
  assert.equal(resolveTokenBudget('custom', ''), undefined);
  assert.equal(resolveTokenBudget('custom', '0'), undefined);
  assert.equal(resolveTokenBudget('custom', '-5'), undefined);
  assert.equal(resolveTokenBudget('custom', 'abc'), undefined);
});

test('token budget survives a full round-trip', () => {
  for (const stored of [null, 500000, 2000000, 8000000, 1234567]) {
    const { preset, raw } = deriveTokenBudget(stored);
    const back = resolveTokenBudget(preset, raw);
    assert.equal(back ?? null, stored ?? null, `round-trip failed for ${stored}`);
  }
});

// ── Gap round-trip ──────────────────────────────────────────────────────────

test('deriveGap: null/absent → immediately', () => {
  assert.deepEqual(deriveGap(null), { preset: 'immediate', raw: '' });
  assert.deepEqual(deriveGap(undefined), { preset: 'immediate', raw: '' });
});

test('deriveGap: preset seconds select the labelled option', () => {
  assert.deepEqual(deriveGap(300), { preset: '5min', raw: '' });
  assert.deepEqual(deriveGap(0), { preset: 'immediate', raw: '' });
});

test('deriveGap: an off-preset value is custom', () => {
  assert.deepEqual(deriveGap(42), { preset: 'custom', raw: '42' });
});

test('resolveGapSeconds: immediate omits, presets pass through', () => {
  assert.equal(resolveGapSeconds('immediate', ''), undefined);
  assert.equal(resolveGapSeconds('1min', ''), 60);
  assert.equal(resolveGapSeconds('15min', ''), 900);
});

test('resolveGapSeconds: custom validates a non-negative number, zero omits', () => {
  assert.equal(resolveGapSeconds('custom', '120'), 120);
  assert.equal(resolveGapSeconds('custom', '0'), undefined);
  assert.equal(resolveGapSeconds('custom', ''), undefined);
  assert.equal(resolveGapSeconds('custom', '-1'), undefined);
});

// ── #2682: verifier copy never promises a teammate that does not exist ──────
test('loopVerifierCopy: a team agent without siblings is told it checks its own work', () => {
  const c = loopVerifierCopy({ isTeamAgent: true, siblings: [] });
  assert.match(c.noneLabel, /no teammate available/i);
  assert.doesNotMatch(c.noneLabel, /assigned automatically/);
  assert.match(c.notice, /No teammate available/);
  assert.match(c.notice, /checks its own work/);
  assert.match(c.notice, /command/);
  assert.doesNotMatch(c.notice, /assigned automatically/);
  assert.equal(c.enforced, false);
  // A malformed roster reads like an empty one.
  assert.deepEqual(loopVerifierCopy({ isTeamAgent: true }), c);
});

test('loopVerifierCopy: a team agent with a sibling keeps the auto-assign promise', () => {
  const c = loopVerifierCopy({ isTeamAgent: true, siblings: [{ id: 't-reviewer', displayName: 'Reviewer' }] });
  assert.match(c.noneLabel, /a teammate is assigned automatically/);
  assert.match(c.notice, /must not grade their own work/);
  assert.equal(c.noticeTone, 'warning');
  assert.equal(c.enforced, true);
});

test('loopVerifierCopy: a standalone agent (or roster still loading) has no notice', () => {
  for (const roster of [null, undefined, { isTeamAgent: false, siblings: [] }]) {
    const c = loopVerifierCopy(roster);
    assert.equal(c.noneLabel, 'No one (the agent judges itself)');
    assert.equal(c.notice, null);
    assert.equal(c.enforced, false);
  }
});
