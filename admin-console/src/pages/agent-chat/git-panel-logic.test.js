import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveGitControls, discardConfirmMessage, isAgentRunning } from './git-panel-logic.js';

// A healthy, clean repo on `main` with another local branch and an upstream.
const cleanRepo = {
  repoPath: '.',
  branch: 'main',
  currentBranch: 'main',
  branches: ['main', 'feature/x'],
  detached: false,
  hasRemote: true,
  hasUpstream: true,
  dirty: false,
};

test('clean repo: all three actions gated correctly (switch+update on, discard off)', () => {
  const c = deriveGitControls({ repoEntry: cleanRepo, running: false });
  assert.equal(c.canSwitch, true);
  assert.equal(c.canUpdate, true);
  assert.equal(c.canDiscard, false, 'nothing to discard when clean');
  assert.match(c.discardReason, /No uncommitted changes/);
  assert.deepEqual(c.otherBranches, ['feature/x']);
});

test('AC7: a running session disables everything with one clear reason', () => {
  const c = deriveGitControls({ repoEntry: cleanRepo, running: true });
  assert.equal(c.canSwitch, false);
  assert.equal(c.canUpdate, false);
  assert.equal(c.canDiscard, false);
  for (const r of [c.switchReason, c.updateReason, c.discardReason]) {
    assert.match(r, /running session/);
  }
});

test('AC4/AC5: dirty tree blocks switch + update but enables discard', () => {
  const c = deriveGitControls({ repoEntry: { ...cleanRepo, dirty: true }, running: false });
  assert.equal(c.canSwitch, false);
  assert.match(c.switchReason, /Uncommitted changes/);
  assert.equal(c.canUpdate, false);
  assert.match(c.updateReason, /Uncommitted changes/);
  assert.equal(c.canDiscard, true, 'discard is the way out of a dirty tree');
});

test('switch needs another local branch to move to', () => {
  const c = deriveGitControls({ repoEntry: { ...cleanRepo, branches: ['main'] }, running: false });
  assert.equal(c.canSwitch, false);
  assert.match(c.switchReason, /No other local branch/);
});

test('update requires a remote and an upstream', () => {
  const noRemote = deriveGitControls({ repoEntry: { ...cleanRepo, hasRemote: false, hasUpstream: false }, running: false });
  assert.equal(noRemote.canUpdate, false);
  assert.match(noRemote.updateReason, /No remote/);

  const noUpstream = deriveGitControls({ repoEntry: { ...cleanRepo, hasUpstream: false }, running: false });
  assert.equal(noUpstream.canUpdate, false);
  assert.match(noUpstream.updateReason, /no upstream/);
});

test('detached HEAD disables switch + update (edge case)', () => {
  const c = deriveGitControls({
    repoEntry: { ...cleanRepo, detached: true, currentBranch: null },
    running: false,
  });
  assert.equal(c.canSwitch, false);
  assert.match(c.switchReason, /Detached HEAD/);
  assert.equal(c.canUpdate, false);
  assert.match(c.updateReason, /Detached HEAD/);
});

test('not-a-repo / missing entry disables all actions', () => {
  const err = deriveGitControls({ repoEntry: { repoPath: '.', error: 'git-status-failed' }, running: false });
  assert.equal(err.isRepo, false);
  assert.equal(err.canSwitch, false);
  assert.equal(err.canUpdate, false);
  assert.equal(err.canDiscard, false);

  const none = deriveGitControls({ repoEntry: null, running: false });
  assert.equal(none.isRepo, false);
  assert.equal(none.canDiscard, false);
});

test('discardConfirmMessage names the repo and warns it is unrecoverable', () => {
  const root = discardConfirmMessage('.');
  assert.match(root, /workspace root/);
  assert.match(root, /cannot be undone/);
  const sub = discardConfirmMessage('service-a');
  assert.match(sub, /service-a/);
  assert.match(sub, /cannot be undone/);
});

test('isAgentRunning: non-empty session list means busy', () => {
  assert.equal(isAgentRunning([{ id: 's1' }]), true);
  assert.equal(isAgentRunning([]), false);
  assert.equal(isAgentRunning(undefined), false);
  assert.equal(isAgentRunning(null), false);
});
