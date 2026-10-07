'use strict';

// #2875: a pool instance is never a direct GitHub wake listener — on any path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDirectWakeListener, wakeTargetAgentId } = require('./pool-wake-target');
const { computePollPlan } = require('./github-poller');
const { matchPollerListeners } = require('./github-label-fastpath');

const REPO = 'org/repo';
const reviewTrigger = { id: 'rev-ready', type: 'github-event', enabled: true, repo: REPO, events: ['pull_request.labeled'], labelFilter: 'ready-for-review' };
const pooledTemplate = { environmentId: 'env', parentTeamId: 'team', pool: { enabled: true, maxInstances: 3 } };
const instanceOf = (item) => ({ environmentId: 'env', parentTeamId: 'team', poolInstance: true, poolOf: 'team-code-reviewer', poolItem: item, poolRepo: REPO });

// The 2026-10-06 shape: the Code Reviewer template, its live instance for #2859,
// its instance for #2819, and an unpooled Security Reviewer on the same label.
const AGENTS = [
  { id: 'team-code-reviewer', config: pooledTemplate, triggers: [reviewTrigger] },
  { id: 'team-code-reviewer-i2859', config: instanceOf(2859), triggers: [reviewTrigger] },
  { id: 'team-code-reviewer-i2819', config: instanceOf(2819), triggers: [reviewTrigger] },
  { id: 'team-security', config: { environmentId: 'env' }, triggers: [{ ...reviewTrigger, id: 'sec-ready' }] },
];

test('isDirectWakeListener: a pool instance never is; templates, agents and stubs are', () => {
  assert.equal(isDirectWakeListener(instanceOf(2859)), false);
  assert.equal(isDirectWakeListener(pooledTemplate), true);
  assert.equal(isDirectWakeListener({}), true);
  assert.equal(isDirectWakeListener(null), true); // a stub: unchanged behaviour
});

test('wakeTargetAgentId: an instance resolves to its role template, everything else to itself', () => {
  assert.equal(wakeTargetAgentId('team-code-reviewer-i2859', instanceOf(2859)), 'team-code-reviewer');
  assert.equal(wakeTargetAgentId('team-code-reviewer', pooledTemplate), 'team-code-reviewer');
  assert.equal(wakeTargetAgentId('x', null), 'x');
  assert.equal(wakeTargetAgentId('x', { poolInstance: true }), 'x'); // no template to route to
});

test('parity: the poller plan and the label fast-path wake the same listeners — templates only', () => {
  const plan = computePollPlan({
    environments: [{ id: 'env', githubTokenId: 'tok', repositories: [{ url: 'git@github.com:org/repo.git' }] }],
    agents: AGENTS.map((a) => ({ ...a, triggersMtime: null })),
  });
  const polled = (plan.get(REPO)?.subscribers || []).map((s) => [s.agentId, s.triggerId]);
  const fast = matchPollerListeners(
    { repo: REPO, label: 'ready-for-review', kind: 'pr' },
    AGENTS.map((a) => ({ agentId: a.id, enabled: a.config.enabled !== false, config: a.config, triggers: a.triggers })),
  ).map((l) => [l.agentId, l.triggerId]);
  const expected = [['team-code-reviewer', 'rev-ready'], ['team-security', 'sec-ready']];
  assert.deepEqual(polled, expected);
  assert.deepEqual(fast, expected);
});

test('the fast-path with a live instance for item X and a wake for item Y wakes only the template (#2875 AC1)', () => {
  // Only the instance for #2859 is live; the wake is for #2820 (ticket #2819).
  const agents = AGENTS.filter((a) => a.id !== 'team-code-reviewer-i2819')
    .map((a) => ({ agentId: a.id, enabled: true, config: a.config, triggers: a.triggers }));
  const woken = matchPollerListeners({ repo: REPO, label: 'ready-for-review', kind: 'pr' }, agents).map((l) => l.agentId);
  assert.deepEqual(woken, ['team-code-reviewer', 'team-security']);
  assert.ok(!woken.includes('team-code-reviewer-i2859'));
});

test('every delivery path routes an instance through the one helper (source guard)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert.match(read('github-poller.js'), /if \(!isDirectWakeListener\(agent\?\.config\)\) continue;/);
  assert.match(read('github-label-fastpath.js'), /if \(!isDirectWakeListener\(a\.config\)\) continue;/);
  const orch = read('orchestrator.js');
  // The fast-path hands the matcher each agent's config…
  assert.match(orch, /return \{ agentId: aid, enabled: config\?\.enabled !== false, config, triggers: loadTriggers\(aid\) \};/);
  // …and Fire again enqueues on the template, logging it as the outcome's agent.
  const refire = orch.slice(orch.indexOf('async function refireGithubEvent('), orch.indexOf('function _flowLiftEmits('));
  assert.match(refire, /const target = poolWakeTarget\.wakeTargetAgentId\(agentId, loadAgentConfig\(agentId\)\);/);
  assert.match(refire, /enqueuePending\(target, githubRefire\.buildRefirePendingEntry\(/);
  assert.match(refire, /\{ agentId: target, triggerId, status: "delivered"/);
  assert.doesNotMatch(refire, /enqueuePending\(agentId,/);
});
