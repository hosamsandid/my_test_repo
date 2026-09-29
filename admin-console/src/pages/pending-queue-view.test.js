import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kindLabel, kindTooltip, entryDetail, entryHoverDetail, labelChip, totalPending, totalHeld,
  pendingRowMenu, reassignPickerState, reassignTargetLabel, pendingReassignError, pendingReassignSuccess,
} from './pending-queue-view.js';

test('totalHeld reads heldTotal, falls back to summing held groups, and is 0 for an old payload', () => {
  assert.equal(totalHeld({ heldTotal: 4 }), 4);
  assert.equal(totalHeld({ held: [{ entries: [1, 2] }, { entries: [3] }] }), 3);
  // An older orchestrator with no `held` field must read as zero, never NaN/throw.
  assert.equal(totalHeld({ agents: [], total: 0 }), 0);
  assert.equal(totalHeld(null), 0);
});

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

test('#2101 — the two remaining live kinds no longer read as unrecognised', () => {
  // Both have producers in the tree (admin-console/api/api.js writes
  // `handover-dm`, agent-entrypoint.py writes `loop-verify`), so before this
  // they rendered as a raw token with the tooltip "An unrecognised queue entry".
  assert.equal(kindLabel('handover-dm'), 'Hand-over message');
  assert.equal(kindLabel('loop-verify'), 'Loop verification');
  const fallback = kindTooltip('unknown');
  assert.notEqual(kindTooltip('handover-dm'), fallback);
  assert.notEqual(kindTooltip('loop-verify'), fallback);
});

test('#2277 — the bg-orphan-correction self-wake no longer reads as unrecognised', () => {
  // agent-entrypoint.py's own drain dispatches on this kind; before this it
  // rendered as a raw token with the tooltip "An unrecognised queue entry"
  // (the same drift the #2101 test above guards against for its two kinds).
  assert.equal(kindLabel('bg-orphan-correction'), 'Self-correction (background task)');
  assert.notEqual(kindTooltip('bg-orphan-correction'), kindTooltip('unknown'));
});

// ── the GitHub detail string (#2101) ────────────────────────────────────────
// Three fragments left this string: the repository (the same long value on
// every row), the GitHub event id (whose `#` sigil made an internal id read as
// a ticket number) and the carried label (now a chip). The event key is
// rendered through the shared friendly-name map.

test('entryDetail names the event in plain language and the actor, and nothing else (AC5/AC6)', () => {
  const d = entryDetail({ kind: 'github', event: 'pull_request.opened', repo: 'o/r', actor: 'alice', eventId: '42' });
  assert.equal(d, 'PR opened · @alice');
});

test('entryDetail no longer prints the repository or the GitHub event id (AC6)', () => {
  const d = entryDetail({
    kind: 'github', event: 'pull_request.labeled', label: 'revisions-required:completed',
    repo: 'AccentureCodeFoundry/314092_agent-execution-environment',
    actor: 'thorsten-a-maier_accent', eventId: '14629937419',
  });
  assert.equal(d, 'PR labeled · @thorsten-a-maier_accent');
  // The specific regression: an internal event id must not appear anywhere in
  // the row prefixed with GitHub's work-item reference sigil.
  assert.ok(!d.includes('14629937419'));
  assert.ok(!d.includes('#'));
  assert.ok(!d.includes('AccentureCodeFoundry'));
});

test('entryDetail renders an unknown event key raw rather than blank (AC5)', () => {
  // eventLabel already falls back to the key itself, so a hand-edited or
  // newly-added GitHub event type still says something.
  assert.equal(entryDetail({ kind: 'github', event: 'deployment_status.created' }), 'deployment_status.created');
});

test('entryDetail tolerates missing GitHub fields', () => {
  assert.equal(entryDetail({ kind: 'github', event: 'push' }), 'Push');
  assert.equal(entryDetail({ kind: 'github' }), '');
  assert.equal(entryDetail({ kind: 'github', actor: 'alice' }), '@alice');
});

test('entryDetail carries no label fragment at all — the label is a chip now (AC7)', () => {
  const d = entryDetail({ kind: 'github', event: 'issues.labeled', actor: 'alice', label: 'ready-2' });
  assert.equal(d, 'Issue labeled · @alice');
});

// ── the Details hover (#2101 AC6) ───────────────────────────────────────────

test('entryHoverDetail keeps the repository, the raw key and the event id reachable', () => {
  const h = entryHoverDetail({
    kind: 'github', event: 'issues.labeled', repo: 'o/r', actor: 'alice', eventId: '9',
  });
  assert.match(h, /Repository: o\/r/);
  assert.match(h, /Event key: issues\.labeled/);
  assert.match(h, /GitHub event id: 9/);
});

test('entryHoverDetail spells out what the event id is and never sigils it (AC6)', () => {
  const h = entryHoverDetail({ kind: 'github', eventId: '14629937419' });
  assert.match(h, /not a PR or issue number/);
  assert.ok(!h.includes('#14629937419'));
});

test('entryHoverDetail is empty for a non-github kind and for junk', () => {
  assert.equal(entryHoverDetail({ kind: 'wake-agent', from: 'a' }), '');
  assert.equal(entryHoverDetail({ kind: 'github' }), '');
  assert.equal(entryHoverDetail(null), '');
});

// ── the label chip (#2101 AC7) ──────────────────────────────────────────────

test('labelChip keeps the bare token visible and decodes the claim suffix', () => {
  assert.deepEqual(labelChip('revisions-required:completed'), {
    token: 'revisions-required', state: 'done', raw: 'revisions-required:completed',
  });
  assert.deepEqual(labelChip('ready-6:wip'), {
    token: 'ready-6', state: 'in progress', raw: 'ready-6:wip',
  });
});

test('labelChip leaves an unsuffixed label alone', () => {
  assert.deepEqual(labelChip('ready-for-review'), {
    token: 'ready-for-review', state: null, raw: 'ready-for-review',
  });
});

test('labelChip does not eat a label that IS a bare suffix, and rejects junk', () => {
  // `:wip` alone is not a claim on anything — decoding it would leave an empty
  // token, so it stays the whole label.
  assert.deepEqual(labelChip(':wip'), { token: ':wip', state: null, raw: ':wip' });
  assert.equal(labelChip(''), null);
  assert.equal(labelChip('   '), null);
  assert.equal(labelChip(undefined), null);
  assert.equal(labelChip(42), null);
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

// ── the five row shapes an operator meets (#2101 AC9) ───────────────────────
// One case per shape, each run through the whole pure surface, so "every
// existing kind still renders without error" (AC4) is an assertion rather than
// a hope. The work-item CELLS are JSX and are guarded by source-reading in
// pending-queue-wiring.test.js (#651); what is checked here is that the row's
// text half degrades rather than blanks for each shape.

test('a PR entry reads as a PR-labeled row with a decoded claim chip', () => {
  const entry = {
    id: 'e1', kind: 'github', event: 'pull_request.labeled', repo: 'o/r',
    actor: 'alice', eventId: '14629937419', label: 'revisions-required:completed',
    workItem: { kind: 'pr', number: 1907, title: 'Fix the drain', url: 'https://github.com/o/r/pull/1907' },
  };
  assert.equal(kindLabel(entry.kind), 'GitHub event');
  assert.equal(entryDetail(entry), 'PR labeled · @alice');
  assert.equal(labelChip(entry.label).state, 'done');
  assert.match(entryHoverDetail(entry), /GitHub event id: 14629937419/);
});

test('an issue entry reads the same way, with its own work item', () => {
  const entry = {
    id: 'e2', kind: 'github', event: 'issues.labeled', repo: 'o/r',
    actor: 'bob', eventId: '77', label: 'ready-6',
    workItem: { kind: 'issue', number: 2101, title: 'Pending queue', url: 'https://github.com/o/r/issues/2101' },
  };
  assert.equal(entryDetail(entry), 'Issue labeled · @bob');
  assert.equal(labelChip(entry.label).state, null);
});

test('a github entry with no work item still names its event and actor', () => {
  // `push` / `release.published` carry no PR or issue — extractWorkItem returns
  // null for them, the cells render `—`, and the text half is unaffected.
  const entry = { id: 'e3', kind: 'github', event: 'push', repo: 'o/r', actor: 'carol', eventId: '78', workItem: null };
  assert.equal(entryDetail(entry), 'Push · @carol');
  assert.equal(labelChip(entry.label), null);
});

test('a wake-agent entry is unaffected by the github rework', () => {
  const entry = { id: 'e4', kind: 'wake-agent', from: 'team-developer', note: 'Check step 3.' };
  assert.equal(kindLabel(entry.kind), 'Direct hand-off');
  assert.equal(entryDetail(entry), 'from team-developer · “Check step 3.”');
  // A hand-off has no repository and no GitHub event id, so it offers no hover.
  assert.equal(entryHoverDetail(entry), '');
});

test('an unknown kind renders identifiably rather than throwing', () => {
  const entry = { id: 'e5', kind: 'something-new', foo: 1 };
  assert.equal(kindLabel(entry.kind), 'something-new');
  assert.equal(kindTooltip(entry.kind), kindTooltip('unknown'));
  assert.equal(entryDetail(entry), '');
  assert.equal(entryHoverDetail(entry), '');
});

test('plugin-event — a queued plugin wake reads as a plugin event, not an unrecognised entry', () => {
  // The Jira plugin's broker queues `kind: 'plugin-event'` entries
  // (orchestrator/plugin-event.js); the AC8 ratchet in
  // pending-queue-wiring.test.js is what caught this kind unlabelled.
  assert.equal(kindLabel('plugin-event'), 'Plugin event');
  assert.notEqual(kindTooltip('plugin-event'), kindTooltip('unknown'));
  assert.equal(
    entryDetail({ kind: 'plugin-event', pluginId: 'jira', event: 'status_changed', summary: 'KAN-6 → Ready for Dev' }),
    'jira · status_changed · KAN-6 → Ready for Dev',
  );
  // Plugin first, then the event; a missing summary drops silently.
  assert.equal(entryDetail({ kind: 'plugin-event', pluginId: 'jira', event: 'status_changed' }), 'jira · status_changed');
  assert.equal(entryDetail({ kind: 'plugin-event' }), '');
});
