const test = require('node:test');
const assert = require('node:assert/strict');

const { GH_HEALTH, classifyGithubHealth, rollUpGithubHealth } = require('./github-health-view');

test('no token → no-token (regardless of anything else)', () => {
  assert.equal(classifyGithubHealth({ hasToken: false, probeStatus: 200 }).status, GH_HEALTH.NO_TOKEN);
  assert.equal(classifyGithubHealth({ hasToken: false }).ok, false);
});

const listening = { status: 'listening', tokenEnvironment: { id: 'env-a', name: 'Env A' } };

test('token + 200 + poller listening → ok', () => {
  const out = classifyGithubHealth({ hasToken: true, pollerStatus: listening, probeStatus: 200, envId: 'env-a' });
  assert.equal(out.status, GH_HEALTH.OK);
  assert.equal(out.ok, true);
  assert.match(out.detail, /events are polled/);
});

test('#2537 AC8: token + 200 but the poller has no subscriber → no-subscriber', () => {
  assert.equal(classifyGithubHealth({ hasToken: true, pollerStatus: { status: 'no-trigger' }, probeStatus: 200 }).status, GH_HEALTH.NO_SUBSCRIBER);
});

test('#2537 AC8: "events are polled" only when the poller is listening', () => {
  for (const status of ['no-trigger', 'no-token', 'failing', 'not-in-environment', 'unsupported']) {
    const out = classifyGithubHealth({ hasToken: true, pollerStatus: { status }, probeStatus: 200 });
    assert.equal(out.ok, false, status);
    assert.doesNotMatch(out.detail, /events are polled/, status);
  }
});

test('#2537 AC8: a poller in backoff shows failing with its last error, even when the live probe succeeds', () => {
  const out = classifyGithubHealth({
    hasToken: true, probeStatus: 200,
    pollerStatus: { status: 'failing', lastError: { status: 502, message: 'Bad Gateway', rateLimited: false } },
  });
  assert.equal(out.status, GH_HEALTH.POLL_FAILING);
  assert.match(out.detail, /HTTP 502 — Bad Gateway/);
  const rl = classifyGithubHealth({ hasToken: true, probeStatus: 200, pollerStatus: { status: 'failing', lastError: { status: 403, rateLimited: true } } });
  assert.equal(rl.status, GH_HEALTH.RATE_LIMITED);
});

test('#2537: waiting for the first poll, and another environment\'s token, are both said', () => {
  const out = classifyGithubHealth({
    hasToken: true, probeStatus: 200, envId: 'env-b',
    pollerStatus: { status: 'listening', waitingForFirstPoll: true, tokenEnvironment: { id: 'env-a', name: 'Env A' } },
  });
  assert.equal(out.ok, true);
  assert.match(out.detail, /waiting for the first poll/);
  assert.match(out.detail, /environment 'Env A'/);
});

test('#2537: poller status unavailable → unknown, never a guessed ok', () => {
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 200 }).status, GH_HEALTH.UNKNOWN);
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 200 }).ok, false);
});

test('401 → bad-credentials (the live incident)', () => {
  const out = classifyGithubHealth({ hasToken: true, probeStatus: 401 });
  assert.equal(out.status, GH_HEALTH.BAD_CREDENTIALS);
  assert.match(out.detail, /401/);
});

test('403 disambiguates rate-limit vs forbidden', () => {
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 403, rateLimited: true }).status, GH_HEALTH.RATE_LIMITED);
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 403, rateLimited: false }).status, GH_HEALTH.FORBIDDEN);
});

test('404 → not-found', () => {
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 404 }).status, GH_HEALTH.NOT_FOUND);
});

test('an unset / unexpected probe status (and no poller status) → unknown', () => {
  assert.equal(classifyGithubHealth({ hasToken: true }).status, GH_HEALTH.UNKNOWN);
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 500 }).status, GH_HEALTH.UNKNOWN);
});

test('rollUpGithubHealth picks the worst repo (bad-credentials beats ok)', () => {
  const worst = rollUpGithubHealth([
    { status: GH_HEALTH.OK },
    { status: GH_HEALTH.BAD_CREDENTIALS },
    { status: GH_HEALTH.NO_SUBSCRIBER },
  ]);
  assert.equal(worst.status, GH_HEALTH.BAD_CREDENTIALS);
});

test('rollUpGithubHealth on an empty list is ok (no repositories)', () => {
  assert.equal(rollUpGithubHealth([]).ok, true);
});
