import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kindLabel, kindTooltip, entryDetail, totalPending,
  pendingRowMenu, reassignPickerState, reassignTargetLabel,
  pendingReassignError, pendingReassignSuccess,
} from './pending-queue-view.js';

test('kindLabel maps known kinds and falls back gracefully', () => {
  assert.equal(kindLabel('github'), 'GitHub event');
  assert.equal(kindLabel('session-set'), 'Session resume');
  assert.equal(kindLabel('weird'), 'weird');
  assert.equal(kindLabel(undefined), 'Unknown');
});

test('#1964 — the retired bp-event-batch kind falls through to the raw string', () => {
  // Its producer went in #1962 and its label here in #1964; a leftover entry in
  // a pending queue written before the cut still renders identifiably rather
  // than as 'Unknown', because the fallback is the kind itself.
  assert.equal(kindLabel('bp-event-batch'), 'bp-event-batch');
  assert.equal(kindTooltip('bp-event-batch'), kindTooltip('unknown'));
});

test('kindTooltip explains known kinds and falls back to the unknown copy', () => {
  assert.match(kindTooltip('github'), /waiting to be delivered/);
  assert.match(kindTooltip('github-digest'), /lossless summary/);
  assert.match(kindTooltip('throttle-warning'), /rate cap/);
  const fallback = kindTooltip('unknown');
  assert.equal(kindTooltip('weird'), fallback);
  assert.equal(kindTooltip(undefined), fallback);
});

test('entryDetail summarises a GitHub entry with all fields', () => {
  const d = entryDetail({ kind: 'github', event: 'pull_request.opened', repo: 'o/r', actor: 'alice', eventId: '42' });
  assert.equal(d, 'pull_request.opened · o/r · @alice · #42');
});

test('entryDetail tolerates missing GitHub fields', () => {
  assert.equal(entryDetail({ kind: 'github', event: 'push' }), 'push');
  assert.equal(entryDetail({ kind: 'github' }), '');
});

test('entryDetail shows the carried label in event (label) form for a labeled event (#1649)', () => {
  const d = entryDetail({ kind: 'github', event: 'issues.labeled', repo: 'o/r', actor: 'alice', eventId: '9', label: 'ready-2' });
  assert.equal(d, 'issues.labeled (ready-2) · o/r · @alice · #9');
});

test('entryDetail shows no label artifact for a non-label github entry (AC2)', () => {
  assert.equal(entryDetail({ kind: 'github', event: 'pull_request.opened', eventId: '42' }), 'pull_request.opened · #42');
});

test('entryDetail summarises non-GitHub kinds', () => {
  assert.equal(entryDetail({ kind: 'github-digest', count: 5, convKey: 'pr:1' }), '5 events · pr:1');
  assert.equal(entryDetail({ kind: 'session-set', roomId: '!r:x' }), 'room !r:x');
  assert.equal(entryDetail({ kind: 'throttle-warning', convKey: 'push:main' }), 'conv push:main');
  assert.equal(entryDetail({ kind: 'session-reset' }), '');
});

test('entryDetail is safe on junk input', () => {
  assert.equal(entryDetail(null), '');
  assert.equal(entryDetail('nope'), '');
  assert.equal(entryDetail({ kind: 'unknown' }), '');
});

test('totalPending prefers the total field but falls back to summing groups', () => {
  assert.equal(totalPending({ total: 7, agents: [] }), 7);
  assert.equal(totalPending({ agents: [{ entries: [1, 2] }, { entries: [3] }] }), 3);
  assert.equal(totalPending({ agents: [] }), 0);
  assert.equal(totalPending(null), 0);
});

// ── direct agent-to-agent hand-off (#2032) ──────────────────────────────────

test('a wake-agent entry has its own label and tooltip, not the unknown fallback', () => {
  // Without these it reads "wake-agent — An unrecognised queue entry", which is
  // how `handover-dm` still reads today.
  assert.equal(kindLabel('wake-agent'), 'Direct hand-off');
  assert.notEqual(kindTooltip('wake-agent'), kindTooltip('unknown'));
  assert.match(kindTooltip('wake-agent'), /no label/);
});

test('entryDetail leads a hand-off with the producer, then the note', () => {
  assert.equal(
    entryDetail({ kind: 'wake-agent', from: 'team-developer', note: 'Check step 3.' }),
    'from team-developer · “Check step 3.”',
  );
});

test('entryDetail degrades a hand-off with a missing half', () => {
  assert.equal(entryDetail({ kind: 'wake-agent', from: 'team-developer' }), 'from team-developer');
  assert.equal(entryDetail({ kind: 'wake-agent', note: 'x' }), '“x”');
  assert.equal(entryDetail({ kind: 'wake-agent' }), '');
});

// ── pending-queue reassignment (#2102) ──────────────────────────────────────

test('AC7: the row offers both actions in one menu, cancel keeping its danger styling', () => {
  const menu = pendingRowMenu({ id: 'e1', kind: 'github', triggerId: 't1', reassignable: true });
  assert.deepEqual(menu.map(i => i.key), ['reassign', 'cancel']);
  assert.equal(menu[0].disabled, false);
  const cancel = menu.find(i => i.key === 'cancel');
  assert.equal(cancel.danger, true);
  assert.equal(cancel.disabled, false);
  // Cancel keeps its existing point-of-action tooltip verbatim.
  assert.match(cancel.title, /before it is delivered/);
});

test('AC9: reassign is disabled with a stated reason, never omitted', () => {
  // A kind that carries no event to match a target against.
  const wake = pendingRowMenu({ id: 'e1', kind: 'wake-agent' });
  assert.equal(wake.length, 2, 'the entry must still be present so the reason can be read');
  assert.equal(wake[0].disabled, true);
  assert.match(wake[0].title, /Only queued GitHub events/);
  assert.match(wake[0].title, /direct hand-off/i);

  // A github entry with no trigger id.
  const noTrigger = pendingRowMenu({ id: 'e1', kind: 'github' });
  assert.equal(noTrigger[0].disabled, true);
  assert.match(noTrigger[0].title, /no trigger/);

  // The client obeys the SERVER's flag rather than re-deriving the kind list:
  // a github entry with a trigger but no `reassignable` stays disabled.
  const unflagged = pendingRowMenu({ id: 'e1', kind: 'github', triggerId: 't1' });
  assert.equal(unflagged[0].disabled, true);
});

test('a busy row disables both actions and says so on cancel', () => {
  const menu = pendingRowMenu({ id: 'e1', kind: 'github', triggerId: 't1', reassignable: true }, { busy: true });
  assert.equal(menu[0].disabled, true);
  assert.equal(menu[1].disabled, true);
  assert.equal(menu[1].label, 'Cancelling…');
});

test('AC10: an empty target list is an explanation, not an error', () => {
  const s = reassignPickerState({ ok: true, targets: [], refused: [] });
  assert.equal(s.loading, false);
  assert.deepEqual(s.targets, []);
  assert.match(s.notice, /No other agent on this team/);
  // It states WHY nothing is offered — the silently-evaporating move.
  assert.match(s.notice, /look successful and then do nothing/);
});

test('reassignPickerState passes through targets and refusals, and reports a refusal body', () => {
  const s = reassignPickerState({
    ok: true,
    targets: [{ agentId: 'r2', agentName: 'Reviewer 2', triggerId: 't2', labelFilter: 'ready-6' }],
    refused: [{ agentId: 'r3', agentName: 'Reviewer 3', reason: 'label-filter' }],
  });
  assert.equal(s.targets.length, 1);
  assert.equal(s.refused[0].reason, 'label-filter');
  assert.equal(s.notice, '');

  // A gone entry reaches the picker as a refusal body, not as targets.
  const gone = reassignPickerState({ ok: false, code: 'entry-gone' });
  assert.deepEqual(gone.targets, []);
  assert.match(gone.notice, /no longer in the queue/);

  assert.equal(reassignPickerState(null).loading, true);
});

test('reassignTargetLabel names the agent and the label that would take it', () => {
  assert.equal(
    reassignTargetLabel({ agentId: 'r2', agentName: 'Reviewer 2', labelFilter: 'ready-6' }),
    'Reviewer 2 — on “ready-6”');
  assert.equal(reassignTargetLabel({ agentId: 'r2', labelFilter: null }), 'r2 — any label');
  assert.equal(reassignTargetLabel(null), '');
});

test('AC2: an entry that already fired is a distinct, operator-readable outcome', () => {
  const text = pendingReassignError({ code: 'already-fired' });
  assert.match(text, /fired while you were choosing/);
  assert.match(text, /not moved/);
  // And it must not read as a generic failure.
  assert.notEqual(text, 'Reassign failed.');
});

test('AC4: a target with no matching trigger says the entry was left alone', () => {
  const text = pendingReassignError({ code: 'no-matching-trigger' });
  assert.match(text, /no enabled trigger/);
  assert.match(text, /left where it is/);
});

test('AC5/AC4: every refusal code the server can return has its own sentence', () => {
  // The codes reassignPendingEntry + resolveWakeTarget can produce. A new code
  // must land here rather than falling through to "Reassign failed."
  for (const code of [
    'entry-gone', 'already-fired', 'kind-not-reassignable', 'no-matching-trigger',
    'target-not-a-candidate', 'cross-team', 'self-target', 'unknown-target',
    'no-team', 'source-write-failed',
  ]) {
    const text = pendingReassignError({ code });
    assert.notEqual(text, 'Reassign failed.', `code '${code}' has no sentence of its own`);
    assert.ok(text.length > 20, `code '${code}' needs a real sentence`);
  }
});

test('AC8: a loss after removal names the work item and the label, and is never a success', () => {
  // The server composes the sentence (it holds the entry); the client prefers it.
  const fromServer = pendingReassignError({
    code: 'enqueue-failed',
    error: "The entry was removed from dev but could NOT be queued for rev — it is now in no queue. "
      + "Re-apply the 'ready-6' label on org/repo#2102 · label 'ready-6' · issues.labeled to run it again.",
  });
  assert.match(fromServer, /could NOT be queued/);
  assert.match(fromServer, /org\/repo#2102/);
  assert.match(fromServer, /ready-6/);

  // With no server sentence it is still reconstructed from the work item rather
  // than degrading to a bare failure.
  const rebuilt = pendingReassignError({
    code: 'enqueue-failed',
    workItem: { text: 'org/repo#2102', label: 'ready-6' },
  });
  assert.match(rebuilt, /in no queue/);
  assert.match(rebuilt, /Re-apply the “ready-6” label on org\/repo#2102/);
});

test('an unknown failure still says something rather than nothing', () => {
  assert.equal(pendingReassignError({ error: 'boom' }), 'Reassign failed: boom');
  assert.equal(pendingReassignError({}), 'Reassign failed.');
  assert.equal(pendingReassignError(null), 'Reassign failed.');
});

test('the success sentence names both the work item and the destination', () => {
  const text = pendingReassignSuccess({ ok: true, to: 'reviewer-2', workItem: { text: 'org/repo#2102' } });
  assert.match(text, /org\/repo#2102/);
  assert.match(text, /reviewer-2/);
  assert.equal(pendingReassignSuccess({ ok: false }), '');
});
