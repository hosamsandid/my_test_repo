import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_WAKE_EVENT,
  isHandoffRow,
  handoffPair,
  handoffNote,
  handoffTitleHint,
} from './github-event-handoff-view.js';

const row = (over = {}) => ({
  ts: '2026-09-07T10:00:00.000Z',
  eventId: 'wake:abc123',
  repo: null,
  event: HANDOFF_WAKE_EVENT,
  actor: 'agent:team-developer',
  label: null,
  ref: null,
  workItem: null,
  source: 'internal',
  emittedBy: 'team-developer',
  handoff: { from: 'team-developer', to: 'team-code-reviewer', note: 'Check step 3.' },
  outcomes: [{ agentId: 'team-code-reviewer', triggerId: null, status: 'delivered' }],
  noMatchingTrigger: false,
  ...over,
});

test('the event key matches the writer', () => {
  // Kept byte-identical to WAKE_EVENT_KEY in orchestrator/wake-agent.js — a
  // drift here silently drops every hand-off row back to the dashes it used to
  // render as, with no error anywhere.
  assert.equal(HANDOFF_WAKE_EVENT, 'handoff.wake');
});

test('isHandoffRow keys on the event, not on source: internal', () => {
  assert.equal(isHandoffRow(row()), true);
  // An `aee-emit` internal label channel (#1173) carries the SAME source and is
  // an ordinary labelled row with a repo and a work item.
  assert.equal(isHandoffRow(row({
    event: 'issues.labeled', source: 'internal', repo: 'o/r', handoff: undefined,
  })), false);
  assert.equal(isHandoffRow(row({ event: 'pull_request.opened' })), false);
});

test('isHandoffRow is safe on junk', () => {
  for (const v of [null, undefined, 'handoff.wake', 42, []]) {
    assert.equal(isHandoffRow(v), false, String(v));
  }
});

test('handoffPair reads the writer block, not the actor prefix', () => {
  assert.deepEqual(handoffPair(row()), { from: 'team-developer', to: 'team-code-reviewer' });
  // A legacy row (written before the block existed) has no pair to show —
  // null, not a pair reconstructed by stripping `agent:` off `actor`, which is
  // a consequence of synthesizing a GitHub-shaped event, not a contract.
  assert.equal(handoffPair(row({ handoff: undefined })), null);
  assert.equal(handoffPair(row({ handoff: {} })), null);
  assert.equal(handoffPair(row({ handoff: 'developer → reviewer' })), null);
  assert.equal(handoffPair(row({ handoff: [] })), null);
});

test('handoffPair reports a partial pair rather than dropping it', () => {
  assert.deepEqual(handoffPair(row({ handoff: { from: 'a' } })), { from: 'a', to: null });
  assert.deepEqual(handoffPair(row({ handoff: { to: 'b' } })), { from: null, to: 'b' });
});

test('handoffNote returns the note, or the empty string', () => {
  assert.equal(handoffNote(row()), 'Check step 3.');
  assert.equal(handoffNote(row({ handoff: { from: 'a', to: 'b' } })), '');
  assert.equal(handoffNote(row({ handoff: { from: 'a', to: 'b', note: '  ' } })), '');
  assert.equal(handoffNote(row({ handoff: undefined })), '');
  assert.equal(handoffNote(row({ event: 'issues.labeled' })), '');
  assert.equal(handoffNote(null), '');
});

test("handoffNote's empty string is what makes the Title column filter", () => {
  // The page flattens this onto the row's `workItemTitle` key, because
  // DataTable filters and sorts by key rather than by rendered cell. A `null`
  // return would be equally falsy for rendering but would have to be
  // special-cased at that call site.
  assert.equal(typeof handoffNote(row({ handoff: { from: 'a', to: 'b' } })), 'string');
});

test('handoffTitleHint names the producer so a note is not read as a PR title', () => {
  assert.equal(handoffTitleHint(row()), 'Note handed over by team-developer');
  assert.equal(
    handoffTitleHint(row({ handoff: { to: 'b', note: 'x' } })),
    'Note handed over by the producer',
    'an unknown producer still explains what the cell holds',
  );
});

test('handoffTitleHint is null for every non-hand-off row', () => {
  // Null, not a string: the Title cell must keep its existing hover behaviour
  // (the full work-item title) on the rows that have one.
  assert.equal(handoffTitleHint(row({ event: 'issues.labeled' })), null);
  assert.equal(handoffTitleHint(null), null);
});
