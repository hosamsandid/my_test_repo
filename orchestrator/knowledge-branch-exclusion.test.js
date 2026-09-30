'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  knowledgeLocationOf,
  knowledgeBranchesByRepo,
  isKnowledgeBranchPush,
} = require('./knowledge-branch-exclusion');
const { parseRepoFullName } = require('./github-poller');

const inRepo = (extra = {}) => ({
  knowledgeStore: { mode: 'in-repo', path: 'docs/agent-knowledge/', repoRef: { url: 'git@github.com:acme/team.git', ...extra } },
});

test('knowledgeLocationOf (#2602): default branch, configured branch, separate KB repo', () => {
  assert.deepEqual(knowledgeLocationOf(inRepo()), { url: 'git@github.com:acme/team.git', branch: 'agent-knowledge' });
  assert.deepEqual(knowledgeLocationOf(inRepo({ branch: ' kb/team-one ' })), { url: 'git@github.com:acme/team.git', branch: 'kb/team-one' });
  const ownRepo = { knowledgeStore: { mode: 'own-repo', repoRef: { url: 'git@github.com:acme/kb-store.git', branch: 'main-kb' } } };
  assert.deepEqual(knowledgeLocationOf(ownRepo), { url: 'git@github.com:acme/kb-store.git', branch: 'main-kb' });
});

test('knowledgeLocationOf (#2602 edge case): a disabled or not git-backed KB contributes nothing', () => {
  assert.equal(knowledgeLocationOf({ ...inRepo(), knowledgeAutonomy: 0 }), null);
  assert.equal(knowledgeLocationOf({ knowledgeStore: { mode: 'in-repo', repoRef: null } }), null);
  assert.equal(knowledgeLocationOf({ knowledgeStore: { mode: 'own-repo', repoRef: { url: '  ' } } }), null);
  assert.equal(knowledgeLocationOf({}), null);
  assert.equal(knowledgeLocationOf(null), null);
});

test('knowledgeBranchesByRepo (#2602): groups every team per repo, de-duplicated and sorted', () => {
  const map = knowledgeBranchesByRepo([
    { url: 'git@github.com:acme/team.git', branch: 'agent-knowledge' },
    { url: 'https://github.com/acme/team', branch: 'agent-knowledge' },
    { url: 'git@github.com:acme/team.git', branch: 'b-kb' },
    { url: 'git@github.com:acme/kb-store.git', branch: 'agent-knowledge' },
    { url: 'not a url', branch: 'x' },
    { url: 'git@github.com:acme/team.git', branch: '' },
    null,
  ], (u) => parseRepoFullName(u));
  assert.deepEqual([...map.entries()], [
    ['acme/team', ['agent-knowledge', 'b-kb']],
    ['acme/kb-store', ['agent-knowledge']],
  ]);
  assert.equal(knowledgeBranchesByRepo(undefined, parseRepoFullName).size, 0);
});

test('isKnowledgeBranchPush (#2602): branch pushes only, exact name', () => {
  const push = (ref) => ({ payload: { ref } });
  assert.equal(isKnowledgeBranchPush(push('refs/heads/agent-knowledge'), ['agent-knowledge']), true);
  assert.equal(isKnowledgeBranchPush(push('refs/heads/kb/team'), ['agent-knowledge', 'kb/team']), true);
  assert.equal(isKnowledgeBranchPush(push('refs/tags/agent-knowledge'), ['agent-knowledge']), false);
  assert.equal(isKnowledgeBranchPush(push('refs/heads/agent-knowledge-2'), ['agent-knowledge']), false);
  assert.equal(isKnowledgeBranchPush(push('refs/heads/Agent-Knowledge'), ['agent-knowledge']), false);
  assert.equal(isKnowledgeBranchPush(push('refs/heads/agent-knowledge'), []), false);
  assert.equal(isKnowledgeBranchPush(push('refs/heads/agent-knowledge'), undefined), false);
});

test('wiring (#2602 AC7): the orchestrator hands every team\'s KB location to the poller — no per-trigger opt-in', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'orchestrator.js'), 'utf8');
  const fn = src.slice(src.indexOf('function listKnowledgeLocations()'));
  assert.match(fn.slice(0, 900), /for \(const id of listAgentIds\(\)\)/);
  assert.match(fn.slice(0, 900), /knowledgeLocationOf\(teamKnowledgeEnv\(teamId, loadEnvironment\(cfg\.environmentId\)\)\)/);
  const ctor = src.slice(src.indexOf('new GitHubPoller({'));
  assert.match(ctor.slice(0, ctor.indexOf('});')), /\blistKnowledgeLocations,/);
});
