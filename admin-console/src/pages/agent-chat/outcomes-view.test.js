import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authoredOutcomes,
  describeAction,
  describeActions,
  resolveOutcomeView,
  modeSummary,
  flowEditorRoutingHref,
  hasTeamContext,
} from './outcomes-view.js';

const peers = [
  { id: 'dev', displayName: 'Developer' },
  { id: 'reviewer', displayName: 'Code Reviewer', triggers: [{ labelFilter: 'ready-for-review' }] },
  { id: 'qa', displayName: 'QA', channels: [{ artifact: 'pr', from: 'dev' }] },
];

/* ── authoredOutcomes ─────────────────────────────────────────────────── */

test('authoredOutcomes needs a valid mode and at least one option', () => {
  assert.equal(authoredOutcomes({ mode: 'anyOf', options: [{ id: 'a' }] }), true);
  assert.equal(authoredOutcomes({ mode: 'exactlyOne', options: [{ id: 'a' }] }), true);
  assert.equal(authoredOutcomes({ mode: 'anyOf', options: [] }), false);
  assert.equal(authoredOutcomes({ mode: 'nonsense', options: [{ id: 'a' }] }), false);
  assert.equal(authoredOutcomes({ options: [{ id: 'a' }] }), false);
  assert.equal(authoredOutcomes(null), false);
  assert.equal(authoredOutcomes('anyOf'), false);
});

/* ── action wording ───────────────────────────────────────────────────── */

test('describeAction renders each action type', () => {
  assert.deepEqual(describeAction({ type: 'setLabel', label: 'ready-for-review' }), { type: 'setLabel', text: 'apply label', label: 'ready-for-review' });
  assert.deepEqual(describeAction({ type: 'openPr' }), { type: 'openPr', text: 'open a pull request', label: '' });
  assert.deepEqual(describeAction({ type: 'openIssue' }), { type: 'openIssue', text: 'open a GitHub issue', label: '' });
  assert.deepEqual(describeAction({ type: 'none' }), { type: 'none', text: 'set no signal', label: '' });
});

test('describeAction trims a label and flags a blank one', () => {
  assert.deepEqual(describeAction({ type: 'setLabel', label: '  spaced  ' }), { type: 'setLabel', text: 'apply label', label: 'spaced' });
  assert.deepEqual(describeAction({ type: 'setLabel', label: '   ' }), { type: 'setLabel', text: 'apply label (none set)', label: '' });
  assert.deepEqual(describeAction({ type: 'setLabel' }), { type: 'setLabel', text: 'apply label (none set)', label: '' });
});

test('describeAction carries the type so the icon never sniffs the wording', () => {
  // An unknown/forward-compatible action still lands on a renderable shape.
  assert.deepEqual(describeAction({ type: 'somethingNew' }), { type: 'somethingNew', text: 'somethingNew', label: '' });
  assert.deepEqual(describeAction({}), { type: 'none', text: 'set no signal', label: '' });
  assert.deepEqual(describeAction(null), { type: 'none', text: 'set no signal', label: '' });
});

test('describeActions normalises an empty actions port to the terminal none', () => {
  assert.deepEqual(describeActions({ actions: [] }), [{ type: 'none', text: 'set no signal', label: '' }]);
  assert.deepEqual(describeActions({}), [{ type: 'none', text: 'set no signal', label: '' }]);
});

test('describeActions preserves port order', () => {
  const out = describeActions({ actions: [{ type: 'openPr' }, { type: 'setLabel', label: 'x' }] });
  assert.deepEqual(out.map(a => a.text), ['open a pull request', 'apply label']);
});

/* ── structured outcomes (AC2) ────────────────────────────────────────── */

test('a structured port yields one row per option with derived consumers', () => {
  const agent = {
    id: 'dev',
    outcomes: {
      mode: 'exactlyOne',
      options: [
        { id: 'accepted', title: 'Accepted', when: 'tests pass', actions: [{ type: 'setLabel', label: 'ready-for-review' }] },
        { id: 'shipped', title: 'Shipped', actions: [{ type: 'openPr' }] },
      ],
    },
  };
  const view = resolveOutcomeView(agent, peers);
  assert.equal(view.kind, 'structured');
  assert.equal(view.mode, 'exactlyOne');
  assert.equal(view.consumersResolved, true);
  assert.equal(view.rows.length, 2);
  assert.deepEqual(view.rows[0], {
    key: 'accepted',
    title: 'Accepted',
    when: 'tests pass',
    actions: [{ type: 'setLabel', text: 'apply label', label: 'ready-for-review' }],
    notifyDm: false,
    terminal: false,
    consumers: ['Code Reviewer'],
  });
  assert.deepEqual(view.rows[1].consumers, ['QA']);
  assert.equal(view.rows[1].when, '');
});

test('an untitled option falls back to its id, then to a positional title', () => {
  const view = resolveOutcomeView({ id: 'dev', outcomes: { mode: 'anyOf', options: [{ id: 'done' }, {}] } }, peers);
  assert.equal(view.rows[0].title, 'done');
  assert.equal(view.rows[0].key, 'done');
  assert.equal(view.rows[1].title, 'Outcome 2');
  assert.equal(view.rows[1].key, 'outcome-2');
});

test('an all-none option is terminal, not merely unconsumed', () => {
  const view = resolveOutcomeView({ id: 'dev', outcomes: { mode: 'anyOf', options: [{ id: 'stop', actions: [{ type: 'none' }] }] } }, peers);
  assert.equal(view.rows[0].terminal, true);
  assert.deepEqual(view.rows[0].consumers, []);
});

test('a signalling option with nobody listening is NOT terminal', () => {
  const view = resolveOutcomeView({ id: 'dev', outcomes: { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'setLabel', label: 'nobody-listens' }] }] } }, peers);
  assert.equal(view.rows[0].terminal, false);
  assert.deepEqual(view.rows[0].consumers, []);
});

test('notify: dm is surfaced as a flag', () => {
  const view = resolveOutcomeView({ id: 'dev', outcomes: { mode: 'anyOf', options: [{ id: 'x', notify: 'dm', actions: [{ type: 'none' }] }] } }, peers);
  assert.equal(view.rows[0].notifyDm, true);
});

test('an unknown mode falls back to anyOf', () => {
  // authoredOutcomes rejects the port outright, so this can only be reached via
  // a mode the client mirror accepts — assert the normalisation regardless.
  const view = resolveOutcomeView({ id: 'dev', outcomes: { mode: 'anyOf', options: [{ id: 'x' }] } }, peers);
  assert.equal(view.mode, 'anyOf');
});

/* ── legacy flat emits (AC3) ──────────────────────────────────────────── */

test('a flat emits array falls back to legacy rows', () => {
  const view = resolveOutcomeView({ id: 'dev', emits: ['ready-for-review', 'blocked'] }, peers);
  assert.equal(view.kind, 'legacy');
  assert.equal(view.rows.length, 2);
  assert.deepEqual(view.rows[0].actions, [{ type: 'setLabel', text: 'apply label', label: 'ready-for-review' }]);
  assert.deepEqual(view.rows[0].consumers, ['Code Reviewer']);
  assert.deepEqual(view.rows[1].consumers, []);
});

test('legacy emits are de-duplicated, trimmed and filtered', () => {
  const view = resolveOutcomeView({ id: 'dev', emits: ['a', ' a ', '', null, 42, 'b'] }, peers);
  assert.deepEqual(view.rows.map(r => r.title), ['a', 'b']);
});

test('a structured port wins over a flat emits array', () => {
  const agent = { id: 'dev', emits: ['legacy-label'], outcomes: { mode: 'anyOf', options: [{ id: 'x', title: 'X' }] } };
  const view = resolveOutcomeView(agent, peers);
  assert.equal(view.kind, 'structured');
  assert.deepEqual(view.rows.map(r => r.title), ['X']);
});

/* ── empty state (AC4) ────────────────────────────────────────────────── */

test('no outcomes and no emits is the empty state', () => {
  for (const agent of [{ id: 'dev' }, { id: 'dev', emits: [] }, { id: 'dev', outcomes: { mode: 'anyOf', options: [] } }, null]) {
    const view = resolveOutcomeView(agent, peers);
    assert.equal(view.kind, 'empty');
    assert.deepEqual(view.rows, []);
  }
});

/* ── degraded consumer derivation ─────────────────────────────────────── */

test('without peers the rows still render, flagged as unresolved consumers', () => {
  const agent = { id: 'dev', outcomes: { mode: 'anyOf', options: [{ id: 'x', title: 'X', actions: [{ type: 'setLabel', label: 'ready-for-review' }] }] } };
  for (const p of [null, undefined, []]) {
    const view = resolveOutcomeView(agent, p);
    assert.equal(view.kind, 'structured');
    assert.equal(view.rows.length, 1);
    assert.deepEqual(view.rows[0].consumers, []);
    assert.equal(view.consumersResolved, false);
  }
});

/* ── copy + linking ──────────────────────────────────────────────────── */

test('modeSummary states the per-run contract', () => {
  assert.match(modeSummary('exactlyOne'), /exactly one/);
  assert.match(modeSummary('anyOf'), /all that apply/);
  assert.match(modeSummary(undefined), /all that apply/);
});

test('flowEditorRoutingHref deep-links team + node + routing tab', () => {
  assert.equal(
    flowEditorRoutingHref({ id: 'team-dev', parentTeamId: 'team' }),
    '/flows?proc=team&node=team-dev&tab=routing',
  );
});

test('flowEditorRoutingHref encodes its params', () => {
  assert.equal(
    flowEditorRoutingHref({ id: 'a b', parentTeamId: 'c/d' }),
    '/flows?proc=c%2Fd&node=a%20b&tab=routing',
  );
});

test('flowEditorRoutingHref is null without a team', () => {
  assert.equal(flowEditorRoutingHref({ id: 'solo' }), null);
  assert.equal(flowEditorRoutingHref({ id: 'solo', parentTeamId: '  ' }), null);
  assert.equal(flowEditorRoutingHref({ parentTeamId: 'team' }), null);
  assert.equal(flowEditorRoutingHref(null), null);
});

test('hasTeamContext gates the tab on team membership', () => {
  assert.equal(hasTeamContext({ parentTeamId: 'team' }), true);
  assert.equal(hasTeamContext({ parentTeamId: '' }), false);
  assert.equal(hasTeamContext({ parentTeamId: '   ' }), false);
  assert.equal(hasTeamContext({}), false);
  assert.equal(hasTeamContext(null), false);
});
