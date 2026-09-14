import test from 'node:test';
import assert from 'node:assert/strict';

import {
  settingsSubject, savedNoticeText, restartNoticeText, unsavedDraftNotice,
  putDraft, getDraft, dropDraft,
} from './agent-settings-view.js';

/* ── settingsSubject ─────────────────────────────────────────────── */

test('the tab normally follows the open chat', () => {
  assert.deepEqual(
    settingsSubject({ chatAgentId: 'a1' }),
    { agentId: 'a1', visible: true, override: false },
  );
});

test('no chat selection means no tab', () => {
  assert.deepEqual(
    settingsSubject({ chatAgentId: null }),
    { agentId: null, visible: false, override: false },
  );
  assert.equal(settingsSubject().visible, false);
});

test('a caller who may not manage the agent gets no tab at all (AC8)', () => {
  const s = settingsSubject({ chatAgentId: 'a1', chatCanManage: false });
  assert.equal(s.visible, false);
  assert.equal(s.agentId, null, 'nothing is fetched for a tab that does not exist');
});

test('a list entry from before canManage shipped keeps its tab', () => {
  // `/api/matrix/agents` only started carrying the flag in #1928; treating a
  // missing one as "no rights" would take the tab away from everybody on a
  // stale payload.
  assert.equal(settingsSubject({ chatAgentId: 'a1', chatCanManage: undefined }).visible, true);
});

test('an override points the tab at another agent and marks itself as such', () => {
  assert.deepEqual(
    settingsSubject({ chatAgentId: 'a1', overrideId: 'team1' }),
    { agentId: 'team1', visible: true, override: true },
  );
});

test('an override wins over a missing chat selection (a disabled agent, AC10)', () => {
  // A disabled agent is never resolved as the open chat, so without the
  // override there would be no subject and no tab to edit it in.
  const s = settingsSubject({ chatAgentId: null, overrideId: 'off-agent' });
  assert.equal(s.agentId, 'off-agent');
  assert.equal(s.visible, true);
});

test('an override wins over a canManage:false chat agent', () => {
  // The override only ever comes from a menu entry that is itself gated, and
  // the PUT re-checks — so the tab must not swallow it.
  assert.equal(settingsSubject({ chatAgentId: 'a1', chatCanManage: false, overrideId: 'a2' }).visible, true);
});

test('pointing the override at the open chat is not an override', () => {
  // Otherwise the panel would offer a "back to the agent you are already on".
  assert.equal(settingsSubject({ chatAgentId: 'a1', overrideId: 'a1' }).override, false);
});

/* ── notices ─────────────────────────────────────────────────────── */

test('the save notice names the next run, and a team names its members', () => {
  assert.match(savedNoticeText({ role: 'agent' }), /next run/);
  assert.match(savedNoticeText({ role: 'team' }), /member/);
  assert.notEqual(savedNoticeText({ role: 'team' }), savedNoticeText({ role: 'agent' }));
  assert.ok(savedNoticeText(null).length > 0, 'never blank');
});

test('a re-provision says the run ended; a deferred one does not claim it did', () => {
  assert.match(restartNoticeText({ respawned: true }), /re-provisioned/);
  assert.match(restartNoticeText({ respawned: true }), /fresh session/);
  assert.doesNotMatch(restartNoticeText({ respawned: false }), /re-provisioned/);
  assert.doesNotMatch(restartNoticeText(null), /re-provisioned/);
});

test('#2067: a repository change never claims a restart the conversation did not have', () => {
  const notice = restartNoticeText({ kind: 'agent-repositories' });
  assert.doesNotMatch(notice, /re-provisioned|fresh session|context folder/i);
  assert.match(notice, /immediately/);
  assert.match(notice, /next run/);
  assert.match(notice, /conversation above is unaffected/);
  // `respawned` is meaningless on this path and must not flip the wording.
  assert.equal(notice, restartNoticeText({ kind: 'agent-repositories', respawned: true }));
});

test('#2271 code-review finding: a Scaling save never claims a context-folder change', () => {
  const notice = restartNoticeText({ kind: 'pool' });
  assert.doesNotMatch(notice, /context folder|re-provisioned|fresh session/i);
  assert.match(notice, /Scaling settings saved/);
  assert.match(notice, /conversation above is unaffected/);
  // `respawned` is meaningless on this path and must not flip the wording.
  assert.equal(notice, restartNoticeText({ kind: 'pool', respawned: true }));
});

test('the unsaved banner only speaks when there is something unsaved', () => {
  assert.equal(unsavedDraftNotice(false), '');
  assert.match(unsavedDraftNotice(true), /Unsaved changes/);
});

/* ── draft store (AC6) ───────────────────────────────────────────── */

test('a draft survives being put and read back', () => {
  const store = putDraft({}, 'a1', { displayName: 'X' });
  assert.deepEqual(getDraft(store, 'a1'), { displayName: 'X' });
});

test('drafts are per agent — switching away and back finds only your own', () => {
  let store = putDraft({}, 'a1', { displayName: 'One' });
  store = putDraft(store, 'a2', { displayName: 'Two' });
  assert.deepEqual(getDraft(store, 'a1'), { displayName: 'One' });
  assert.deepEqual(getDraft(store, 'a2'), { displayName: 'Two' });
  assert.equal(getDraft(store, 'a3'), null);
});

test('a later edit replaces the earlier draft rather than merging into it', () => {
  let store = putDraft({}, 'a1', { displayName: 'One', skills: ['a'] });
  store = putDraft(store, 'a1', { displayName: 'Two' });
  assert.deepEqual(getDraft(store, 'a1'), { displayName: 'Two' });
});

test('the store is replaced, never mutated', () => {
  const before = { a1: { displayName: 'One' } };
  const after = putDraft(before, 'a2', { displayName: 'Two' });
  assert.notEqual(after, before);
  assert.deepEqual(before, { a1: { displayName: 'One' } });
});

test('dropping a draft leaves the others alone and is idempotent', () => {
  let store = putDraft(putDraft({}, 'a1', { x: 1 }), 'a2', { x: 2 });
  store = dropDraft(store, 'a1');
  assert.equal(getDraft(store, 'a1'), null);
  assert.deepEqual(getDraft(store, 'a2'), { x: 2 });
  assert.deepEqual(dropDraft(store, 'a1'), store, 'dropping twice is a no-op');
});

test('a falsy or unknown key is handled without throwing', () => {
  assert.deepEqual(putDraft({}, null, { x: 1 }), {});
  assert.equal(getDraft(null, 'a1'), null);
  assert.equal(getDraft({}, null), null);
  assert.deepEqual(dropDraft(null, 'a1'), {});
});

test('a stored draft of null reads back as "no draft", not as a crash', () => {
  // `hasOwnProperty` rather than a truthiness check, so a deliberately empty
  // draft is still distinguishable from an absent one.
  const store = putDraft({}, 'a1', null);
  assert.equal(getDraft(store, 'a1'), null);
  assert.deepEqual(dropDraft(store, 'a1'), {});
});
