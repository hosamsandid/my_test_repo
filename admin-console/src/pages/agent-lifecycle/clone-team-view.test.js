import test from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestCloneTeamId,
  isValidCloneTeamId,
  suggestCloneTeamName,
  cloneTeamDialogCopy,
  credentialsNeededLines,
  cloneResultNotice,
} from './clone-team-view.js';

test('suggestCloneTeamId derives a lowercase slug with a -clone suffix', () => {
  assert.equal(suggestCloneTeamId('Payments-Team', new Set()), 'payments-team-clone');
});

test('suggestCloneTeamId dedupes against existing ids', () => {
  const existing = new Set(['payments-team-clone', 'payments-team-clone-2']);
  assert.equal(suggestCloneTeamId('payments-team', existing), 'payments-team-clone-3');
});

test('isValidCloneTeamId mirrors the server TEAM_ID_RE', () => {
  assert.equal(isValidCloneTeamId('payments-team-clone'), true);
  assert.equal(isValidCloneTeamId('Payments-Team'), false);
  assert.equal(isValidCloneTeamId(''), false);
  assert.equal(isValidCloneTeamId('-leading-hyphen'), false);
});

test('suggestCloneTeamName appends (Clone) and handles a blank name', () => {
  assert.equal(suggestCloneTeamName('Payments Team'), 'Payments Team (Clone)');
  assert.equal(suggestCloneTeamName('  '), '');
  assert.equal(suggestCloneTeamName(undefined), '');
});

test('cloneTeamDialogCopy falls back to a generic name', () => {
  assert.equal(cloneTeamDialogCopy(null).title, 'Clone "this team"');
  assert.equal(cloneTeamDialogCopy({ displayName: 'Payments Team' }).title, 'Clone "Payments Team"');
});

test('credentialsNeededLines never carries a credential id — only what is missing', () => {
  const lines = credentialsNeededLines({
    needsGithubToken: true,
    repositories: [{ url: 'git@github.com:acme/repo.git', branch: 'main' }],
    mcpServers: [{ serverId: 'wiki' }],
  });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('GitHub token'));
  assert.ok(lines[1].includes('git@github.com:acme/repo.git'));
  assert.ok(lines[2].includes('wiki'));
  assert.ok(!lines.some(l => /key-|cred-/.test(l)));
});

test('credentialsNeededLines is empty for a repo-less, mcp-less clone', () => {
  assert.deepEqual(credentialsNeededLines({ needsGithubToken: false, repositories: [], mcpServers: [] }), []);
  assert.deepEqual(credentialsNeededLines(undefined), []);
});

test('cloneResultNotice states what to add before materializing', () => {
  const notice = cloneResultNotice({
    teamId: 'payments-team-clone',
    teamName: 'Payments Team (Clone)',
    credentialsNeeded: { needsGithubToken: true, repositories: [], mcpServers: [] },
  });
  assert.ok(notice.includes('Payments Team (Clone)'));
  assert.ok(notice.includes('GitHub token'));
});

test('cloneResultNotice says no credentials are needed for a repo-less clone', () => {
  const notice = cloneResultNotice({
    teamId: 'payments-team-clone',
    teamName: 'Payments Team (Clone)',
    credentialsNeeded: { needsGithubToken: false, repositories: [], mcpServers: [] },
  });
  assert.ok(notice.includes('No credentials are needed'));
});

test('cloneResultNotice is null without a teamId', () => {
  assert.equal(cloneResultNotice(null), null);
  assert.equal(cloneResultNotice({}), null);
});
