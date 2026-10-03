'use strict';

// #2794: the poller's PR-readiness pass — GraphQL reads against a fake GitHub,
// synthetic pull_request.checks_passed / checks_failed / merge_conflict events
// through the normal fan-out, and the GitHub Event Log record.
// Run: node --test orchestrator/github-poller-readiness.test.js

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { GitHubPoller } = require('./github-poller');
const githubEventLog = require('./github-event-log');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPO = 'acme/widgets';

// The fake GitHub: `openPrs` answers the open-PR query, `checksBySha` the
// checks query (by the commit SHA each alias asks for). `down` = 502.
let openPrs = [];
let checksBySha = {};
let down = false;
let calls = [];
let server;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ path: req.url, query, variables });
      if (down) { res.writeHead(502); res.end('{}'); return; }
      let data;
      if (/pullRequests\(states:OPEN/.test(query)) {
        data = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: openPrs } } };
      } else {
        const repository = {};
        for (const [k, sha] of Object.entries(variables)) {
          const m = /^o(\d+)$/.exec(k);
          if (!m) continue;
          const nodes = checksBySha[sha];
          repository[`c${m[1]}`] = nodes
            ? { oid: sha, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes } } }
            : { oid: sha, statusCheckRollup: null };
        }
        data = { repository };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  delete process.env.GITHUB_API_BASE;
  server.close();
});

let recorded;
let origRecord;
beforeEach(() => {
  openPrs = [];
  checksBySha = {};
  down = false;
  calls = [];
  recorded = [];
});

const prNode = (number, sha, mergeable = 'MERGEABLE') => ({
  number, title: `PR ${number}`, url: `https://github.com/${REPO}/pull/${number}`,
  headRefName: `feat/${number}`, headRefOid: sha, baseRefName: 'main', mergeable, isCrossRepository: false,
});
const ok = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const bad = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' });
const running = (name) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: null });

const subscriber = (events) => ({
  agentId: 'reviewer', triggerId: 't-ready', events: new Set(events), labelFilter: null, horizon: null,
});

function makePoller() {
  const poller = new GitHubPoller({ listEnvironmentIds: () => [] });
  poller.state = {};
  poller._saveState = () => {};
  poller._saveThrottleState = () => {};
  poller._readToken = () => 'ghp_fake';
  const enqueued = [];
  poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });
  return { poller, enqueued };
}

// One poll cycle, but with a live (non-baseline) readiness state so verdicts
// reached on this cycle are delivered.
async function cycle(poller, subscribers) {
  await poller._pollReadiness(REPO, { tokenId: 'tok', subscribers });
}

function withLog(fn) {
  return async () => {
    origRecord = githubEventLog.record;
    githubEventLog.record = (e) => recorded.push(e);
    try { await fn(); } finally { githubEventLog.record = origRecord; }
  };
}

test('no subscriber to a readiness key → no GraphQL call at all (AC9)', withLog(async () => {
  const { poller } = makePoller();
  openPrs = [prNode(1, SHA_A)];
  await cycle(poller, [subscriber(['pull_request.opened'])]);
  assert.equal(calls.length, 0);
}));

test('first cycle baselines: already-final verdicts are recorded, nobody is woken', withLog(async () => {
  const { poller, enqueued } = makePoller();
  openPrs = [prNode(1, SHA_A, 'CONFLICTING')];
  checksBySha = { [SHA_A]: [ok('build')] };
  await cycle(poller, [subscriber(['pull_request.checks_passed', 'pull_request.merge_conflict'])]);
  assert.equal(enqueued.length, 0);
  assert.ok(poller.state[REPO].readiness.prs[1]);
  // A later cycle on the same head stays silent too.
  await cycle(poller, [subscriber(['pull_request.checks_passed', 'pull_request.merge_conflict'])]);
  assert.equal(enqueued.length, 0);
}));

test('a backoff gap of more than 15 min does not swallow a tracked verdict: checks_passed is delivered once', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [subscriber(['pull_request.checks_passed'])];
  openPrs = [prNode(5, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await cycle(poller, subs); // baseline: pending, nothing final
  assert.equal(enqueued.length, 0);

  // The events poll backs off (1 → 2 → 4 → 8 → 16 min): readiness is skipped meanwhile.
  checksBySha = { [SHA_A]: [ok('build')] };
  poller.state[REPO].skipUntil = new Date(Date.now() + 60_000).toISOString();
  calls = [];
  await cycle(poller, subs);
  assert.equal(calls.length, 0, 'nothing read while backing off');
  assert.equal(enqueued.length, 0);

  // GitHub is back, the last evaluation is now more than 15 minutes old.
  delete poller.state[REPO].skipUntil;
  poller.state[REPO].readiness.lastEvaluatedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  await cycle(poller, subs);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.github.event, 'pull_request.checks_passed');
  await cycle(poller, subs);
  assert.equal(enqueued.length, 1, 'exactly once');
}));

test('AC6/AC8: checks_passed wakes the subscriber exactly once, with PR, head SHA and verdict, and is logged', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [subscriber(['pull_request.checks_passed'])];
  openPrs = [prNode(7, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await cycle(poller, subs); // baseline: pending, nothing final
  assert.equal(calls.length, 2, 'open PRs + checks');
  assert.equal(calls[0].path, '/graphql');

  checksBySha = { [SHA_A]: [ok('build'), ok('CodeQL')] };
  await cycle(poller, subs);
  assert.equal(enqueued.length, 1);
  const { agentId, entry } = enqueued[0];
  assert.equal(agentId, 'reviewer');
  assert.equal(entry.github.event, 'pull_request.checks_passed');
  assert.equal(entry.github.payload.pull_request.number, 7);
  assert.equal(entry.github.payload.pull_request.head.sha, SHA_A);
  assert.equal(entry.github.payload.readiness.verdict, 'passed');
  assert.deepEqual(entry.github.payload.readiness.failingChecks, []);

  const logged = recorded.filter((r) => r.event === 'pull_request.checks_passed');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].repo, REPO);
  assert.equal(logged[0].workItem && logged[0].workItem.number, 7);
  assert.equal(logged[0].outcomes[0].status, 'delivered');

  // Settled: the next cycle reads only the open-PR list and wakes nobody.
  calls = [];
  await cycle(poller, subs);
  assert.equal(calls.length, 1, 'a passed head is no longer read');
  assert.equal(enqueued.length, 1);
}));

test('AC2/AC6: checks_failed carries the failing check names; merge_conflict fires for CONFLICTING', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [subscriber(['pull_request.checks_failed', 'pull_request.merge_conflict'])];
  openPrs = [prNode(3, SHA_A, 'UNKNOWN')];
  checksBySha = { [SHA_A]: [running('e2e')] };
  await cycle(poller, subs);
  checksBySha = { [SHA_A]: [running('e2e'), bad('unit')] };
  openPrs = [prNode(3, SHA_A, 'CONFLICTING')];
  await cycle(poller, subs);
  const keys = enqueued.map((e) => e.entry.github.event).sort();
  assert.deepEqual(keys, ['pull_request.checks_failed', 'pull_request.merge_conflict']);
  const failed = enqueued.find((e) => e.entry.github.event === 'pull_request.checks_failed');
  assert.deepEqual(failed.entry.github.payload.readiness.failingChecks, ['unit']);
  await cycle(poller, subs);
  assert.equal(enqueued.length, 2, 'never twice for the same (PR, head, verdict)');
}));

test('AC7: after a new push the old head never fires; the new head does', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [subscriber(['pull_request.checks_passed'])];
  openPrs = [prNode(5, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await cycle(poller, subs);
  // New push before SHA_A finished; SHA_A's checks then go green.
  openPrs = [prNode(5, SHA_B)];
  checksBySha = { [SHA_A]: [ok('build')], [SHA_B]: [running('build')] };
  await cycle(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.ok(calls.at(-1).query && Object.values(calls.at(-1).variables).includes(SHA_B));
  assert.ok(!Object.values(calls.at(-1).variables).includes(SHA_A), 'the old head is not even read');
  checksBySha = { [SHA_A]: [ok('build')], [SHA_B]: [ok('build')] };
  await cycle(poller, subs);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.github.payload.readiness.headSha, SHA_B);
}));

test('GitHub unreachable: verdicts stay pending, nothing fires, then resumes', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [subscriber(['pull_request.checks_passed'])];
  openPrs = [prNode(9, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await cycle(poller, subs);
  down = true;
  checksBySha = { [SHA_A]: [ok('build')] };
  await cycle(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.equal(poller.state[REPO].readiness.prs[9].ci, 'pending');
  down = false;
  await cycle(poller, subs);
  assert.equal(enqueued.length, 1);
}));

test('a repo whose events poll is backing off is not evaluated either', withLog(async () => {
  const { poller } = makePoller();
  poller.state[REPO] = { skipUntil: new Date(Date.now() + 60_000).toISOString() };
  openPrs = [prNode(1, SHA_A)];
  await cycle(poller, [subscriber(['pull_request.checks_passed'])]);
  assert.equal(calls.length, 0);
}));

test('the last subscriber leaving forgets the readiness state', withLog(async () => {
  const { poller } = makePoller();
  openPrs = [prNode(1, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await cycle(poller, [subscriber(['pull_request.checks_passed'])]);
  assert.ok(poller.state[REPO].readiness);
  await cycle(poller, []);
  assert.equal(poller.state[REPO].readiness, undefined);
}));
