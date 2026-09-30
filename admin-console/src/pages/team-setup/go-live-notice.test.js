import test from 'node:test';
import assert from 'node:assert/strict';

import { goLiveNotice, bundleUsesGithub } from './go-live-notice.js';

const text = (n) => `${n.before}${n.code || ''}${n.after}`;

test('live + repository: agents go live and watch the named repository', () => {
  const n = goLiveNotice({ agentCount: 4, repoLabel: 'acme/widgets', materializeNow: true, usesGithub: true });
  assert.equal(n.tone, 'warning');
  assert.equal(n.code, 'acme/widgets');
  assert.equal(text(n), 'Creating the team provisions 4 agents that go live immediately and begin watching acme/widgets for issues and pull requests, acting autonomously from that moment.');
  assert.equal(n.repoWarning, null);
});

test('stub mode: nothing goes live, whatever the repository', () => {
  for (const repoLabel of ['acme/widgets', '']) {
    const n = goLiveNotice({ agentCount: 1, repoLabel, materializeNow: false, usesGithub: false });
    assert.equal(n.tone, 'info');
    assert.equal(n.code, null);
    assert.match(text(n), /^Creating the team writes 1 agent as stubs — nothing goes live yet/);
    assert.doesNotMatch(text(n), /go live immediately|watching/);
  }
});

test('repo-less live team: no "watching the bound repository"', () => {
  const n = goLiveNotice({ agentCount: 2, repoLabel: '', materializeNow: true, usesGithub: false });
  assert.equal(n.tone, 'warning');
  assert.equal(n.code, null);
  assert.match(text(n), /go live immediately\. The team has no repository, so nothing watches GitHub/);
  assert.doesNotMatch(text(n), /bound repository/);
  assert.equal(n.repoWarning, null);
});

test('repo-less team on a GitHub-based process gets the hand-off warning (live and stub)', () => {
  for (const materializeNow of [true, false]) {
    const n = goLiveNotice({ agentCount: 2, repoLabel: '', materializeNow, usesGithub: true });
    assert.match(n.repoWarning, /hand-offs cannot work/);
  }
  // A bound repository never warns.
  assert.equal(goLiveNotice({ agentCount: 2, repoLabel: 'a/b', materializeNow: true, usesGithub: true }).repoWarning, null);
});

test('agent count falls back to "the team’s agents"', () => {
  assert.match(text(goLiveNotice({ agentCount: 0, repoLabel: 'a/b', materializeNow: true })), /provisions the team’s agents that/);
});

test('bundleUsesGithub detects each GitHub hand-off signal on its own', () => {
  const role = (extra) => ({ roles: [{ id: 'r', triggers: [], ...extra }] });
  assert.equal(bundleUsesGithub(null), false);
  assert.equal(bundleUsesGithub(role({})), false);
  assert.equal(bundleUsesGithub(role({ triggers: [{ type: 'cron' }] })), false);
  assert.equal(bundleUsesGithub(role({ outcomes: { options: [{ actions: [{ type: 'none' }] }] } })), false);
  assert.equal(bundleUsesGithub({ roles: [], labels: [{ name: 'ready' }] }), true);
  assert.equal(bundleUsesGithub(role({ channels: [{ artifact: 'issue', from: 'x' }] })), true);
  assert.equal(bundleUsesGithub(role({ channels: [{ artifact: 'pr', from: 'x' }] })), true);
  assert.equal(bundleUsesGithub(role({ channels: [{ artifact: 'spec', from: 'x', label: 'go' }] })), true);
  assert.equal(bundleUsesGithub(role({ github: { producesPr: true } })), true);
  assert.equal(bundleUsesGithub(role({ github: { producesIssue: true } })), true);
  assert.equal(bundleUsesGithub(role({ triggers: [{ type: 'github-event' }] })), true);
  for (const type of ['openIssue', 'openPr', 'setLabel']) {
    assert.equal(bundleUsesGithub(role({ outcomes: { options: [{ actions: [{ type }] }] } })), true, type);
  }
});
