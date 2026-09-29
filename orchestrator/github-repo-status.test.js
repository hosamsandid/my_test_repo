'use strict';

// #2537: the repository status view and the poll plan are built from ONE
// fixture here, and must agree: a row is Listening exactly when the plan holds
// the repo and it is not in backoff (AC3), for every exclusion case of the
// status model.

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubPoller, computePollPlan, describePollError } = require('./github-poller');
const { buildRepoStatusView, STATUS, repoHost } = require('./github-repo-status');

const trig = (over = {}) => ({ id: 't1', type: 'github-event', enabled: true, events: ['issues.labeled'], ...over });

function fixture() {
  return {
    allowNonGithubHost: false,
    environments: [
      {
        id: 'env-a', name: 'Env A', githubTokenId: 'tok-a',
        repositories: [
          { url: 'git@github.com:acme/listening.git' },
          { url: 'git@github.com:acme/failing.git' },
          { url: 'git@github.com:acme/no-trigger.git' },
          { url: 'git@github.com:acme/waiting.git' },
          { url: 'https://github.com/acme/shared.git' },
          { url: 'git@github.com:acme/unreadable.git' },
          { url: 'git@git.example.com:acme/elsewhere.git' },
        ],
      },
      { id: 'env-b', name: 'Env B', githubTokenId: null, repositories: [{ url: 'git@github.com:acme/no-token.git' }, { url: 'git@github.com:acme/shared.git' }] },
      { id: 'env-c', name: 'Env C', githubTokenId: '../../etc/passwd', repositories: [{ url: 'git@github.com:acme/bad-token-id.git' }] },
      { id: 'env-d', name: 'Env D', githubTokenId: 'tok-missing', repositories: [{ url: 'git@github.com:acme/token-file-missing.git' }] },
    ],
    agents: [
      {
        id: 'dev', config: { name: 'Developer', environmentId: 'env-a' }, triggersMtime: null,
        triggers: [
          trig({ id: 'l', repo: 'acme/listening' }),
          trig({ id: 'f', repo: 'acme/failing' }),
          trig({ id: 'w', repo: 'acme/waiting' }),
          trig({ id: 's', repo: 'acme/shared' }),
          trig({ id: 'u', repo: 'acme/unreadable' }),
          trig({ id: 'nt', repo: 'acme/no-token' }),
          trig({ id: 'bt', repo: 'acme/bad-token-id' }),
          trig({ id: 'tm', repo: 'acme/token-file-missing' }),
          trig({ id: 'orphan', repo: 'acme/only-trigger' }),
          trig({ id: 'typo', repo: 'not a repo' }),
          // Not counted — each for its own reason.
          trig({ id: 'off', repo: 'acme/no-trigger', enabled: false }),
          trig({ id: 'int', repo: 'acme/no-trigger', transport: 'internal' }),
          trig({ id: 'noev', repo: 'acme/no-trigger', events: [] }),
        ],
      },
      {
        id: 'sleepy', config: { name: 'Sleepy', enabled: false, environmentId: 'env-a' },
        triggers: [trig({ id: 'z', repo: 'acme/no-trigger' })],
      },
      {
        id: 'reader', config: { name: 'Reader', agentRepositories: [{ url: 'git@github.com:acme/agent-only.git' }] },
        triggers: null,
      },
    ],
  };
}

const future = new Date(Date.now() + 5 * 60_000).toISOString();
const state = {
  'acme/listening': { lastPolledAt: '2026-09-29T10:00:00.000Z', lastEventAt: '2026-09-29T09:59:00.000Z' },
  'acme/shared': { lastPolledAt: '2026-09-29T10:00:00.000Z' },
  'acme/failing': {
    lastPolledAt: '2026-09-29T09:00:00.000Z', consecutiveFailures: 3, skipUntil: future,
    lastError: { status: 401, message: 'Bad credentials', rateLimited: false },
    lastErrorAt: '2026-09-29T09:50:00.000Z', failingSince: '2026-09-29T09:40:00.000Z',
  },
  'acme/unreadable': { lastPolledAt: '2026-09-29T10:00:00.000Z' },
  'acme/gone': { lastPolledAt: '2026-09-29T10:00:00.000Z' },
};

const readable = (id) => id === 'tok-a';

function build(over = {}) {
  const inputs = fixture();
  const plan = computePollPlan(inputs);
  const rows = buildRepoStatusView({ ...inputs, plan, state, firstTickDone: true, tokenReadable: readable, ...over });
  return { plan, rows, byRepo: new Map(rows.map((r) => [r.repo, r])) };
}

test('AC3: Listening exactly when the poll plan holds the repo and it is not in backoff', () => {
  const { plan, rows } = build();
  for (const r of rows) {
    const inBackoff = (state[r.repo]?.consecutiveFailures || 0) > 0;
    const tokenOk = plan.has(r.repo) && readable(plan.get(r.repo).tokenId);
    assert.equal(r.status === STATUS.LISTENING, plan.has(r.repo) && tokenOk && !inBackoff, `${r.repo}: ${r.status}`);
  }
  // Every row outside the plan is in the not-listening group; every plan row is not.
  for (const r of rows) {
    if (!plan.has(r.repo)) assert.equal(r.group, 'not-listening', r.repo);
  }
});

test('every case of the status model is covered by the fixture', () => {
  const { byRepo } = build();
  const expect = {
    'acme/listening': STATUS.LISTENING,
    'acme/shared': STATUS.LISTENING,
    'acme/waiting': STATUS.LISTENING,
    'acme/failing': STATUS.FAILING,
    'acme/no-token': STATUS.NO_TOKEN,
    'acme/bad-token-id': STATUS.NO_TOKEN,
    'acme/token-file-missing': STATUS.NO_TOKEN, // in the plan, token file unreadable
    'acme/unreadable': STATUS.LISTENING,
    'acme/no-trigger': STATUS.NO_TRIGGER,
    'acme/agent-only': STATUS.NOT_IN_ENVIRONMENT,
    'acme/only-trigger': STATUS.NOT_IN_ENVIRONMENT,
    'git@git.example.com:acme/elsewhere.git': STATUS.UNSUPPORTED,
    'not a repo': STATUS.UNSUPPORTED,
  };
  for (const [repo, status] of Object.entries(expect)) {
    assert.ok(byRepo.has(repo), `missing row ${repo}`);
    assert.equal(byRepo.get(repo).status, status, repo);
  }
  assert.equal(byRepo.size, Object.keys(expect).length);
});

test('a token id that is valid but whose file is missing is never Listening', () => {
  const { plan, byRepo } = build();
  assert.ok(plan.has('acme/token-file-missing'), 'the poller would try it');
  const r = byRepo.get('acme/token-file-missing');
  assert.equal(r.status, STATUS.NO_TOKEN);
  assert.equal(r.tokenEnvironment.id, 'env-d');
  assert.equal(r.tokenEnvironment.tokenState, 'unreadable');
});

test('one row per repo; the token environment is the first with a valid token, others are noted', () => {
  const { rows, byRepo } = build();
  assert.equal(rows.filter((r) => r.repo === 'acme/shared').length, 1);
  const r = byRepo.get('acme/shared');
  assert.equal(r.tokenEnvironment.id, 'env-a');
  assert.deepEqual(r.environments.map((e) => e.id), ['env-a', 'env-b']);
});

test('ignored triggers say why they are not counted', () => {
  const { byRepo } = build();
  const r = byRepo.get('acme/no-trigger');
  const reasons = Object.fromEntries(r.triggers.map((t) => [t.triggerId, t.ignoredReason]));
  assert.deepEqual(reasons, { off: 'trigger-disabled', int: 'internal', noev: 'no-events', z: 'agent-disabled' });
  assert.ok(r.triggers.every((t) => t.counted === false));
  assert.equal(r.tokenEnvironment.id, 'env-a');
});

test('Failing rows carry the last error, its start, the failure count and the next retry', () => {
  const { byRepo } = build();
  const r = byRepo.get('acme/failing');
  assert.deepEqual(r.lastError, { status: 401, message: 'Bad credentials', rateLimited: false });
  assert.equal(r.failingSince, '2026-09-29T09:40:00.000Z');
  assert.equal(r.consecutiveFailures, 3);
  assert.equal(r.nextRetryAt, future);
  // A healthy row carries no failure fields even with an old lastError on file.
  assert.equal(byRepo.get('acme/listening').failingSince, null);
});

test('Waiting for first poll: before the first tick, or before the repo was ever polled', () => {
  assert.equal(build().byRepo.get('acme/waiting').waitingForFirstPoll, true);
  assert.equal(build().byRepo.get('acme/listening').waitingForFirstPoll, false);
  assert.equal(build({ firstTickDone: false }).byRepo.get('acme/listening').waitingForFirstPoll, true);
});

test('a repo removed from every source leaves no orphan row behind', () => {
  assert.equal(build().byRepo.has('acme/gone'), false);
});

test('unsupported hosts name the host; non-github hosts are allowed only off the default API base', () => {
  const { byRepo } = build();
  assert.equal(byRepo.get('git@git.example.com:acme/elsewhere.git').host, 'git.example.com');
  const inputs = fixture();
  inputs.allowNonGithubHost = true;
  inputs.environments[0].repositories.push({ url: 'http://git-remote:8080/acme/fixture.git' });
  inputs.agents[0].triggers.push(trig({ id: 'fx', repo: 'acme/fixture' }));
  const plan = computePollPlan(inputs);
  const rows = buildRepoStatusView({ ...inputs, plan, state: {}, firstTickDone: true, tokenReadable: readable });
  assert.equal(rows.find((r) => r.repo === 'acme/fixture').status, STATUS.LISTENING);
  assert.equal(repoHost('https://gitlab.com/a/b'), 'gitlab.com');
});

test('relatedAgentIds covers env users, agentRepositories and trigger owners (visibility input)', () => {
  const { byRepo } = build();
  assert.deepEqual(byRepo.get('acme/listening').relatedAgentIds, ['dev', 'sleepy']);
  assert.deepEqual(byRepo.get('acme/agent-only').relatedAgentIds, ['reader']);
  assert.deepEqual(byRepo.get('acme/no-token').relatedAgentIds, ['dev']);
});

test('the poller tick and the status snapshot read the same inputs', () => {
  const poller = new GitHubPoller({ loadEnvironment: () => null, listEnvironmentIds: () => [] });
  const inputs = fixture();
  poller._readPlanInputs = () => inputs;
  poller.state = state;
  poller.lastTickAt = '2026-09-29T10:00:00.000Z';
  const plan = poller._buildPollPlan();
  const snap = poller.repoStatusSnapshot();
  assert.equal(snap.lastTickAt, '2026-09-29T10:00:00.000Z');
  assert.ok(snap.pollIntervalMs > 0);
  for (const r of snap.repos) {
    if (r.status === STATUS.LISTENING || r.status === STATUS.FAILING) assert.ok(plan.has(r.repo), r.repo);
  }
  for (const repo of plan.keys()) assert.ok(snap.repos.some((r) => r.repo === repo), repo);
});

test('computePollPlan: first valid-token environment wins, disabled agents and invalid token ids are skipped', () => {
  const invalid = [];
  const plan = computePollPlan(fixture(), { onInvalidTokenId: (env) => invalid.push(env.id) });
  assert.deepEqual(invalid, ['env-c']);
  assert.equal(plan.get('acme/shared').envId, 'env-a');
  assert.equal(plan.get('acme/shared').tokenId, 'tok-a');
  assert.equal(plan.has('acme/no-trigger'), false);
  assert.equal(plan.has('acme/no-token'), false);
  assert.equal(plan.has('acme/bad-token-id'), false);
  assert.equal(plan.get('acme/listening').subscribers[0].agentId, 'dev');
});

test('describePollError: status, GitHub message, rate limiting', () => {
  assert.deepEqual(
    describePollError(Object.assign(new Error('HTTP 401: {...}'), { status: 401, githubMessage: 'Bad credentials' })),
    { status: 401, message: 'Bad credentials', rateLimited: false },
  );
  assert.equal(describePollError(Object.assign(new Error('x'), { status: 403, rateLimitRemaining: '0' })).rateLimited, true);
  assert.equal(describePollError(Object.assign(new Error('x'), { status: 403, githubMessage: 'You have exceeded a secondary rate limit' })).rateLimited, true);
  assert.equal(describePollError(Object.assign(new Error('x'), { status: 429 })).rateLimited, true);
  assert.equal(describePollError(Object.assign(new Error('x'), { status: 403, githubMessage: 'Resource not accessible' })).rateLimited, false);
  assert.deepEqual(describePollError(new Error('timeout')), { status: null, message: 'timeout', rateLimited: false });
});
