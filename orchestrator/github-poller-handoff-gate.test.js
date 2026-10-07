'use strict';

// #2795: the per-hand-off CI / merge-conflict gate in the poller — a gated PR
// hand-off is held, then released / failed / timed out / cancelled on the
// readiness pass, against a fake GitHub (GraphQL reads + REST label/comment
// writes), with the GitHub Event Log record of each step.
// Run: node --test orchestrator/github-poller-handoff-gate.test.js

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { GitHubPoller } = require('./github-poller');
const githubEventLog = require('./github-event-log');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPO = 'acme/widgets';
const WAKE = 'ready-for-review';

// The fake GitHub. `openPrs` answers the open-PR query, `checksBySha` the
// checks query; every REST write is recorded in `writes`. `failWrite` makes
// the matching write answer 500 once.
let openPrs = [];
let checksBySha = {};
let writes = [];
let failWrite = null;
let server;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (req.url === '/graphql') {
        const { query, variables } = JSON.parse(raw);
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
        return;
      }
      const w = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null };
      if (failWrite && failWrite(w)) {
        failWrite = null;
        res.writeHead(500);
        res.end('{}');
        return;
      }
      writes.push(w);
      res.writeHead(req.method === 'DELETE' ? 200 : 201, { 'Content-Type': 'application/json' });
      res.end('{}');
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
beforeEach(() => {
  openPrs = [];
  checksBySha = {};
  writes = [];
  failWrite = null;
  recorded = [];
});

const prNode = (number, sha, { mergeable = 'MERGEABLE', labels = [WAKE] } = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/${REPO}/pull/${number}`,
  headRefName: `feat/${number}`, headRefOid: sha, baseRefName: 'main', mergeable, isCrossRepository: false,
  labels: { nodes: labels.map((name) => ({ name })) },
});
const ok = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const bad = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' });
const running = (name) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: null });

const GATE = { ci: true, conflict: true, failureLabel: 'revisions-required', timeoutMinutes: 60 };

const reviewer = (gate = GATE, extra = {}) => ({
  agentId: 'team-code-reviewer', triggerId: 'team-code-reviewer-on-pr-ready-for-review',
  events: new Set(['pull_request.labeled']), labelFilter: WAKE, horizon: null,
  claimAdd: `${WAKE}:wip`, readinessGate: gate, ...extra,
});
const reworker = () => ({
  agentId: 'team-reworker', triggerId: 'rework-on-revisions-required',
  events: new Set(['pull_request.labeled']), labelFilter: 'revisions-required', horizon: null,
  claimAdd: 'revisions-required:wip', readinessGate: null,
});

let seq = 0;
function labeledEvent(number, label, { sha = SHA_A, labels = [label] } = {}) {
  seq += 1;
  return {
    id: `evt-${seq}`,
    type: 'PullRequestEvent',
    actor: { login: 'dev-bot' },
    repo: { name: REPO },
    created_at: new Date().toISOString(),
    payload: {
      action: 'labeled',
      number,
      label: { name: label },
      labels: labels.map((name) => ({ name })),
      pull_request: {
        number, title: `PR ${number}`, html_url: `https://github.com/${REPO}/pull/${number}`,
        head: { ref: `feat/${number}`, sha }, base: { ref: 'main' },
      },
    },
  };
}

function makePoller() {
  const poller = new GitHubPoller({ listEnvironmentIds: () => [], ciGraceMs: 0 });
  poller.state = {};
  poller._saveState = () => {};
  poller._saveThrottleState = () => {};
  poller._readToken = () => 'ghp_fake';
  const enqueued = [];
  poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });
  return { poller, enqueued };
}

// The wake label arriving through the Events API (phase 1 + 2 of the fan-out).
async function handOff(poller, subs, ev) {
  await poller._fanOutBatch(REPO, [ev], subs, 'ghp_fake', null, []);
}

// One readiness pass (the poller runs it every tick after the events poll).
async function pass(poller, subs) {
  await poller._pollReadiness(REPO, { tokenId: 'tok', subscribers: subs });
}

function outcomesWith(reason) {
  return recorded.flatMap((e) => e.outcomes.map((o) => ({ ...o, eventId: e.eventId }))).filter((o) => o.reason === reason);
}

function withLog(fn) {
  return async () => {
    const orig = githubEventLog.record;
    githubEventLog.record = (e) => recorded.push(e);
    try { await fn(); } finally { githubEventLog.record = orig; }
  };
}

test('AC2: CI pending → held, nobody woken; woken on the pass after CI passed — once', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(7, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };

  await handOff(poller, subs, labeledEvent(7, WAKE));
  assert.equal(enqueued.length, 0, 'the wake is held, not delivered');
  const held = outcomesWith('readiness-gate');
  assert.equal(held.length, 1);
  assert.equal(held[0].status, 'held');
  assert.deepEqual(held[0].gates, ['ci', 'conflict']);
  assert.ok(poller.state[REPO].holds['team-code-reviewer-on-pr-ready-for-review#7']);

  await pass(poller, subs);
  assert.equal(enqueued.length, 0, 'CI still running');
  assert.deepEqual(poller.gateHolds().map((h) => h.waitingFor), [['ci']]);

  checksBySha = { [SHA_A]: [ok('build')] };
  await pass(poller, subs);
  assert.equal(enqueued.length, 1, 'released on the first pass that sees passed');
  assert.equal(enqueued[0].agentId, 'team-code-reviewer');
  assert.equal(enqueued[0].entry.triggerId, 'team-code-reviewer-on-pr-ready-for-review');
  assert.equal(enqueued[0].entry.github.event, 'pull_request.labeled');
  assert.equal(enqueued[0].entry.wakeLabel, WAKE);
  const released = outcomesWith('gate-released');
  assert.equal(released.length, 1);
  assert.equal(released[0].status, 'delivered');
  assert.equal(writes.length, 0, 'a release writes nothing to GitHub');

  await pass(poller, subs);
  assert.equal(enqueued.length, 1, 'never delivered twice');
  assert.deepEqual(poller.gateHolds(), []);
}));

test('AC3: CI failed → not woken, wake label removed, failure label set, comment lists the failing checks; the failure label wakes its listener', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer(), reworker()];
  openPrs = [prNode(8, SHA_A)];
  checksBySha = { [SHA_A]: [ok('lint'), bad('build'), bad('e2e')] };

  await handOff(poller, subs, labeledEvent(8, WAKE));
  await pass(poller, subs);
  assert.equal(enqueued.length, 0, 'the consumer is not woken');
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [
    `DELETE /repos/${REPO}/issues/8/labels/${WAKE}`,
    `POST /repos/${REPO}/issues/8/labels`,
    `POST /repos/${REPO}/issues/8/comments`,
  ]);
  assert.deepEqual(writes[1].body, { labels: ['revisions-required'] });
  assert.match(writes[2].body.body, /CI failed/);
  assert.match(writes[2].body.body, /`build`/);
  assert.match(writes[2].body.body, /`e2e`/);
  assert.doesNotMatch(writes[2].body.body, /`lint`/);
  const failed = outcomesWith('gate-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'dropped');
  assert.deepEqual(failed[0].gates, ['ci']);
  assert.deepEqual(poller.gateHolds(), []);

  // The failure label is a normal label hand-off: GitHub reports it as a
  // labeled event, which wakes the reworker (ungated) at once.
  await handOff(poller, subs, labeledEvent(8, 'revisions-required'));
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].agentId, 'team-reworker');
}));

test('AC4: merge conflict → not woken, same label swap, comment names the conflict with the base', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(9, SHA_A, { mergeable: 'CONFLICTING' })];
  checksBySha = { [SHA_A]: [ok('build')] };

  await handOff(poller, subs, labeledEvent(9, WAKE));
  await pass(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.equal(writes.length, 3);
  assert.equal(writes[0].method, 'DELETE');
  assert.deepEqual(writes[1].body, { labels: ['revisions-required'] });
  assert.match(writes[2].body.body, /merge conflict with `main`/);
  assert.deepEqual(outcomesWith('gate-failed')[0].gates, ['conflict']);
}));

test('AC3/AC4: the configured failure label is the one set', withLog(async () => {
  const { poller } = makePoller();
  const subs = [reviewer({ ...GATE, failureLabel: 'ci-red' })];
  openPrs = [prNode(10, SHA_A)];
  checksBySha = { [SHA_A]: [bad('build')] };
  await handOff(poller, subs, labeledEvent(10, WAKE));
  await pass(poller, subs);
  assert.deepEqual(writes[1].body, { labels: ['ci-red'] });
}));

test('conflict gate off: a conflicting PR with green CI is released', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer({ ci: true, conflict: false })];
  openPrs = [prNode(11, SHA_A, { mergeable: 'CONFLICTING' })];
  checksBySha = { [SHA_A]: [ok('build')] };
  await handOff(poller, subs, labeledEvent(11, WAKE));
  await pass(poller, subs);
  assert.equal(enqueued.length, 1);
  assert.equal(writes.length, 0);
}));

test('AC5: both gates off → the hand-off wakes immediately, as before', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer(null)];
  openPrs = [prNode(12, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, subs, labeledEvent(12, WAKE));
  assert.equal(enqueued.length, 1);
  assert.equal(outcomesWith('readiness-gate').length, 0);
  assert.equal(poller.state[REPO].holds, undefined);
}));

test('AC6: CI verdict none (no checks at all) passes the gate', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(13, SHA_A)];
  checksBySha = {}; // the head commit has no checks
  await handOff(poller, subs, labeledEvent(13, WAKE));
  await pass(poller, subs);
  assert.equal(poller.state[REPO].readiness.prs[13].ci, 'none');
  assert.equal(enqueued.length, 1);
}));

test('AC7: timeout → wake label removed, needs-human set, comment names the pending gate, not woken', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer({ ci: true, conflict: true, timeoutMinutes: 5 })];
  openPrs = [prNode(14, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, subs, labeledEvent(14, WAKE));
  await pass(poller, subs);
  assert.equal(writes.length, 0, 'not timed out yet');

  const hold = poller.state[REPO].holds['team-code-reviewer-on-pr-ready-for-review#14'];
  hold.heldAt = new Date(Date.now() - 5 * 60_000).toISOString();
  await pass(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.deepEqual(writes.map((w) => w.method), ['DELETE', 'POST', 'POST']);
  assert.equal(writes[0].path, `/repos/${REPO}/issues/14/labels/${WAKE}`);
  assert.deepEqual(writes[1].body, { labels: ['needs-human'] });
  assert.match(writes[2].body.body, /timed out after 5 min — still waiting for CI\b/);
  assert.doesNotMatch(writes[2].body.body, /conflict-free/, 'the merge verdict was clean');
  const t = outcomesWith('gate-timeout');
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].gates, ['ci']);
}));

test('AC8: a push during the hold — only the new head decides; the timeout keeps counting from the hold', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(15, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, subs, labeledEvent(15, WAKE));
  await pass(poller, subs);
  const hk = 'team-code-reviewer-on-pr-ready-for-review#15';
  const heldAt = poller.state[REPO].holds[hk].heldAt;

  // New push: head is SHA_B (still running) while the superseded SHA_A turns
  // red — the old commit's verdict neither fails the hold …
  openPrs = [prNode(15, SHA_B)];
  checksBySha = { [SHA_A]: [bad('build')], [SHA_B]: [running('build')] };
  await pass(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(poller.state[REPO].holds[hk].heldAt, heldAt, 'the timeout is not restarted');

  // … nor would a green old commit release it; the new head going green does.
  checksBySha = { [SHA_A]: [ok('build')], [SHA_B]: [ok('build')] };
  await pass(poller, subs);
  assert.equal(enqueued.length, 1);
  assert.equal(writes.length, 0);
}));

test('AC9: holds live in the persisted state — a restarted poller resumes them and delivers once', withLog(async () => {
  const first = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(16, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(first.poller, subs, labeledEvent(16, WAKE));
  await pass(first.poller, subs);

  // "Restart": a new poller loading what the old one saved to state.json.
  const second = makePoller();
  second.poller.state = JSON.parse(JSON.stringify(first.poller.state));
  checksBySha = { [SHA_A]: [ok('build')] };
  await pass(second.poller, subs);
  await pass(second.poller, subs);
  assert.equal(first.enqueued.length, 0);
  assert.equal(second.enqueued.length, 1);
}));

test('AC9: a failed GitHub write is retried on the next pass without repeating the steps already done', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(17, SHA_A)];
  checksBySha = { [SHA_A]: [bad('build')] };
  await handOff(poller, subs, labeledEvent(17, WAKE));
  failWrite = (w) => w.method === 'POST' && w.path.endsWith('/labels');
  await pass(poller, subs);
  assert.deepEqual(writes.map((w) => w.method), ['DELETE']);
  assert.equal(outcomesWith('gate-failed').length, 0, 'not resolved yet');

  // Even if the verdict changes meanwhile, the started resolution completes.
  checksBySha = {};
  await pass(poller, subs);
  assert.deepEqual(writes.map((w) => w.method), ['DELETE', 'POST', 'POST']);
  assert.equal(outcomesWith('gate-failed').length, 1);
  assert.equal(enqueued.length, 0);
}));

test('wake label removed while held → hold cancelled, nobody woken, nothing written', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(18, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, subs, labeledEvent(18, WAKE));
  openPrs = [prNode(18, SHA_A, { labels: [] })];
  checksBySha = { [SHA_A]: [ok('build')] };
  await pass(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.equal(writes.length, 0);
  const c = outcomesWith('gate-cancelled');
  assert.equal(c.length, 1);
  assert.equal(c[0].cancelReason, 'label-removed');
}));

test('PR closed or merged while held → hold cancelled, nobody woken', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(19, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, subs, labeledEvent(19, WAKE));
  openPrs = [];
  await pass(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.equal(outcomesWith('gate-cancelled')[0].cancelReason, 'closed');
  assert.deepEqual(poller.gateHolds(), []);
}));

test('several gated hand-offs on one PR fail together → one comment, each logged', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [
    reviewer(),
    reviewer(GATE, { agentId: 'team-security-reviewer', triggerId: 'team-security-reviewer-on-pr-ready-for-review' }),
  ];
  openPrs = [prNode(20, SHA_A)];
  checksBySha = { [SHA_A]: [bad('build')] };
  await handOff(poller, subs, labeledEvent(20, WAKE));
  assert.equal(outcomesWith('readiness-gate').length, 2);
  await pass(poller, subs);
  assert.equal(enqueued.length, 0);
  assert.equal(writes.filter((w) => w.path.endsWith('/comments')).length, 1);
  assert.equal(outcomesWith('gate-failed').length, 2);
}));

test('label churn while held does not open a second hold or deliver', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(21, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, subs, labeledEvent(21, WAKE));
  await handOff(poller, subs, labeledEvent(21, 'docs', { labels: [WAKE, 'docs'] }));
  assert.equal(Object.keys(poller.state[REPO].holds).length, 1);
  assert.equal(enqueued.length, 0);
}));

test('a gate switched off while held cancels the hold', withLog(async () => {
  const { poller, enqueued } = makePoller();
  openPrs = [prNode(22, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await handOff(poller, [reviewer()], labeledEvent(22, WAKE));
  await pass(poller, [reviewer(null)]);
  assert.equal(enqueued.length, 0);
  assert.equal(outcomesWith('gate-cancelled')[0].cancelReason, 'trigger-removed');
}));

test('gated subscribers alone drive the readiness read; no readiness events are logged without a listener', withLog(async () => {
  const { poller } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(23, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  await pass(poller, subs); // baseline
  checksBySha = { [SHA_A]: [ok('build')] };
  await pass(poller, subs);
  assert.equal(poller.state[REPO].readiness.prs[23].ci, 'passed');
  assert.equal(recorded.length, 0, 'no checks_passed row for nobody');
}));

test('review B2: a hold opened by the internal label fast-path (holdWake) is decided like any other and never delivered twice', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const subs = [reviewer()];
  openPrs = [prNode(30, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };
  const synthetic = {
    id: 'intlbl:abc', actor: { login: 'alice' }, repo: { name: REPO }, created_at: new Date().toISOString(),
    payload: { action: 'labeled', label: { name: WAKE }, pull_request: { number: 30 } },
  };
  const gates = poller.holdWake({
    repo: REPO, agentId: 'team-code-reviewer', triggerId: 'team-code-reviewer-on-pr-ready-for-review',
    readinessGate: GATE, key: 'pull_request.labeled', ghEvent: synthetic, number: 30, label: WAKE,
  });
  assert.deepEqual(gates, ['ci', 'conflict']);
  assert.ok(poller.state[REPO].holds['team-code-reviewer-on-pr-ready-for-review#30']);
  assert.equal(enqueued.length, 0, 'held, not delivered');

  // The Events-API copy of the same label is the armed wake edge: no 2nd hold, no delivery.
  await handOff(poller, subs, labeledEvent(30, WAKE));
  assert.equal(outcomesWith('wake-already-armed').length, 1);
  assert.equal(Object.keys(poller.state[REPO].holds).length, 1);

  await pass(poller, subs);
  assert.equal(enqueued.length, 0, 'CI still running');
  checksBySha = { [SHA_A]: [ok('build')] };
  await pass(poller, subs);
  await pass(poller, subs);
  assert.equal(enqueued.length, 1, 'released once');
  assert.equal(enqueued[0].entry.wakeLabel, WAKE);

  // Not gated (no gate, or an issue key): nothing is held.
  assert.equal(poller.holdWake({ repo: REPO, agentId: 'a', triggerId: 't', readinessGate: null, key: 'pull_request.labeled', ghEvent: synthetic, number: 31, label: WAKE }), null);
  assert.equal(poller.holdWake({ repo: REPO, agentId: 'a', triggerId: 't', readinessGate: GATE, key: 'issues.labeled', ghEvent: synthetic, number: 31, label: WAKE }), null);
}));

test('review B3: a gate whose default failure label is its own wake label sets needs-human instead — no relabel loop', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const rework = { ...reworker(), readinessGate: { ci: true, conflict: true, failureLabel: 'revisions-required', timeoutMinutes: 60 } };
  const subs = [rework];
  openPrs = [prNode(31, SHA_A, { labels: ['revisions-required'] })];
  checksBySha = { [SHA_A]: [bad('build')] };
  await handOff(poller, subs, labeledEvent(31, 'revisions-required'));
  await pass(poller, subs);
  const labelled = writes.filter((w) => w.method === 'POST' && w.path.endsWith('/labels'));
  assert.deepEqual(labelled.map((w) => w.body.labels), [['needs-human']], 'never re-sets the wake label');
  assert.match(writes.find((w) => w.path.endsWith('/comments')).body.body, /needs-human/);
  assert.equal(enqueued.length, 0);
  assert.deepEqual(poller.gateHolds(), []);
}));

test('review S1: a release enriches before it forgets the hold, then forgets + saves + enqueues with no await between', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'github-poller.js'), 'utf8');
  const i = src.indexOf("if (decision.action === 'release') {");
  const block = src.slice(i, src.indexOf('_logHoldOutcome(', i));
  const enrich = block.indexOf('await this._enrichPullRequestPayload(');
  const del = block.indexOf('delete holds[hk];');
  const enq = block.indexOf('this._enqueue(');
  assert.ok(enrich > 0 && enrich < del && del < enq, 'enrich → delete → enqueue');
  assert.doesNotMatch(block.slice(del, enq), /await /);
});

test('review B2: the internal label fast-path holds a gated listener through the poller instead of enqueuing it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'orchestrator.js'), 'utf8');
  const i = src.indexOf('async function wakeGithubLabelListeners(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  const gated = body.indexOf('if (l.readinessGate) {');
  assert.ok(gated > 0, 'the loop branches on the listener gate');
  const branch = body.slice(gated, body.indexOf('enqueuePending(l.agentId', gated));
  assert.match(branch, /githubPollerRef\.holdWake\(\{/);
  assert.match(branch, /continue;\s*\}\s*\/\/ Enqueue first/, 'a gated listener never reaches enqueuePending');
  assert.match(body, /status: 'held', reason: 'readiness-gate'/, 'the Event Log row says held');
});

test('#2879: a PR that turns conflicting while its hand-off is held goes to the conflict solver via the failure label', withLog(async () => {
  const { poller, enqueued } = makePoller();
  const solver = {
    agentId: 'team-conflict-solver', triggerId: 'solve-on-needs-conflict-resolution',
    events: new Set(['pull_request.labeled']), labelFilter: 'needs-conflict-resolution', horizon: null,
    claimAdd: 'needs-conflict-resolution:wip', readinessGate: null,
  };
  const subs = [reviewer({ ...GATE, failureLabel: 'needs-conflict-resolution' }), reworker(), solver];
  openPrs = [prNode(30, SHA_A)];
  checksBySha = { [SHA_A]: [running('build')] };

  await handOff(poller, subs, labeledEvent(30, WAKE));
  await pass(poller, subs);
  assert.equal(enqueued.length, 0, 'held while CI runs');

  // main moves on: the same head now conflicts with the base.
  openPrs = [prNode(30, SHA_A, { mergeable: 'CONFLICTING' })];
  await pass(poller, subs);
  assert.equal(enqueued.length, 0, 'the reviewer is not woken into a conflicting PR');
  assert.deepEqual(writes[1].body, { labels: ['needs-conflict-resolution'] });
  assert.match(writes[2].body.body, /merge conflict with `main`/);

  await handOff(poller, subs, labeledEvent(30, 'needs-conflict-resolution'));
  assert.deepEqual(enqueued.map((e) => e.agentId), ['team-conflict-solver']);
}));
