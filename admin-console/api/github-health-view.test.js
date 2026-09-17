const test = require('node:test');
const assert = require('node:assert/strict');

const { GH_HEALTH, classifyGithubHealth, rollUpGithubHealth } = require('./github-health-view');

test('no token → no-token (regardless of anything else)', () => {
  assert.equal(classifyGithubHealth({ hasToken: false, probeStatus: 200 }).status, GH_HEALTH.NO_TOKEN);
  assert.equal(classifyGithubHealth({ hasToken: false }).ok, false);
});

test('token + 200 + a subscriber → ok', () => {
  const out = classifyGithubHealth({ hasToken: true, hasSubscriber: true, probeStatus: 200 });
  assert.equal(out.status, GH_HEALTH.OK);
  assert.equal(out.ok, true);
});

test('token + 200 but NO subscriber → no-subscriber', () => {
  assert.equal(classifyGithubHealth({ hasToken: true, hasSubscriber: false, probeStatus: 200 }).status, GH_HEALTH.NO_SUBSCRIBER);
});

test('token + 200 with subscriber unknown (null) stays ok — an unevaluated scan never downgrades', () => {
  assert.equal(classifyGithubHealth({ hasToken: true, hasSubscriber: null, probeStatus: 200 }).status, GH_HEALTH.OK);
  assert.equal(classifyGithubHealth({ hasToken: true, probeStatus: 200 }).status, GH_HEALTH.OK);
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

test('an unset / unexpected probe status → unknown', () => {
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
