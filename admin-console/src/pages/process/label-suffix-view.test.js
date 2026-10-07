import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  labelSuffixContextFor,
  isTeamLabel,
  splitTeamLabel,
  normaliseBase,
  joinTeamLabel,
  labelListToText,
  labelListFromText,
  suffixChangeSummary,
  suffixChangeError,
} from './label-suffix-view.js';

const ctx = labelSuffixContextFor({ labelSuffix: 'k3f9' });

test('a team without a (valid) suffix has no context — editors look unchanged (AC5)', () => {
  assert.equal(labelSuffixContextFor({}), null);
  assert.equal(labelSuffixContextFor({ labelSuffix: 'BAD--' }), null);
  assert.equal(labelSuffixContextFor(null), null);
  assert.deepEqual(labelSuffixContextFor({ labelSuffix: '1', labelSuffixExempt: ['team-1', 3] }), { suffix: '1', exempt: ['team-1'] });
});

test('splits a team label into base + suffix chip (AC1)', () => {
  assert.deepEqual(splitTeamLabel('ready-for-review-k3f9', ctx), { base: 'ready-for-review', suffix: 'k3f9', tail: '', team: true });
});

test('a claim add splits into base, suffix chip and the :wip tail', () => {
  assert.deepEqual(splitTeamLabel('foo-k3f9:wip', ctx), { base: 'foo', suffix: 'k3f9', tail: ':wip', team: true });
  assert.equal(joinTeamLabel('foo', ctx, ':wip'), 'foo-k3f9:wip');
});

test('foreign labels come back whole, with no chip (AC4)', () => {
  assert.deepEqual(splitTeamLabel('external-qa', ctx), { base: 'external-qa', suffix: '', tail: '', team: false });
  assert.deepEqual(splitTeamLabel('req:refine', ctx).team, false);
  assert.equal(isTeamLabel('-k3f9', ctx), false);
});

test('an exempt label that merely looks suffixed is not mis-split (suffix 1, label team-1)', () => {
  const one = labelSuffixContextFor({ labelSuffix: '1', labelSuffixExempt: ['team-1'] });
  assert.equal(splitTeamLabel('team-1', one).team, false);
  assert.deepEqual(splitTeamLabel('done-1', one), { base: 'done', suffix: '1', tail: '', team: true });
});

test('typed or pasted base-suffix is normalised to the base (AC3)', () => {
  assert.equal(normaliseBase(' x-k3f9 ', ctx), 'x');
  assert.equal(normaliseBase('x-k3f9-k3f9', ctx), 'x');
  assert.equal(normaliseBase('x-k3f9x', ctx), 'x-k3f9x');
  assert.equal(normaliseBase('x-k3f9', null), 'x-k3f9');
});

test('saving stores <base>-<suffix>; empty stays empty (AC2)', () => {
  assert.equal(joinTeamLabel('foo', ctx), 'foo-k3f9');
  assert.equal(joinTeamLabel('foo-k3f9', ctx), 'foo-k3f9');
  assert.equal(joinTeamLabel('  ', ctx), '');
  assert.equal(joinTeamLabel('foo', null), 'foo');
});

test('comma lists show bases and keep foreign labels unstamped', () => {
  const original = ['approved-k3f9', 'external-qa'];
  assert.equal(labelListToText(original, ctx), 'approved, external-qa');
  assert.deepEqual(labelListFromText('approved, external-qa, rework, rework-k3f9', ctx, original),
    ['approved-k3f9', 'external-qa', 'rework-k3f9']);
  assert.deepEqual(labelListFromText('a, b', null, []), ['a', 'b']);
});

test('the confirmation names label and agent counts and warns about the GitHub rename (AC9)', () => {
  const s = suffixChangeSummary({ oldSuffix: 'k3f9', newSuffix: '', renames: [{}, {}, {}], agents: ['a'] });
  assert.equal(s.labels, 3);
  assert.equal(s.agents, 1);
  assert.match(s.headline, /from -k3f9 to no suffix/);
  assert.match(s.body, /3 labels across 1 agent\b/);
  assert.match(s.warning, /renamed in place on GitHub/);
  assert.match(s.warning, /next run/);
});

test('a collision reads as a clear message (AC10)', () => {
  const m = suffixChangeError(409, { collisions: [{ label: 'ready-x1', owner: 'other-team' }] });
  assert.match(m, /another team on the same repository: ready-x1/);
  assert.match(suffixChangeError(409, { collisions: [{ label: 'ready', owner: 'this-team' }] }), /labels of this team/);
  assert.equal(suffixChangeError(400, { error: 'nope' }), 'nope');
});
