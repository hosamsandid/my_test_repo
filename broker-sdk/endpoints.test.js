'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mint } = require('./scope-token');
const { healthEndpoint, teardownScopeEndpoint } = require('./endpoints');

const SECRET = 'test-signing-secret';

// Minimal fake res capturing status + parsed JSON body.
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
}

const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

const NO_BUILD = { commit: 'unknown', dirty: '', commitTime: '' };

test('health: answers ok with no auth', async () => {
  const res = fakeRes();
  await healthEndpoint(null, { env: {} })({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, build: NO_BUILD });
});

test('health: merges extra detail, degrades to bare ok on failure', async () => {
  const okRes = fakeRes();
  await healthEndpoint(() => ({ backend: 'reachable' }), { env: {} })({}, okRes);
  assert.deepEqual(okRes.body, { ok: true, build: NO_BUILD, backend: 'reachable' });

  const failRes = fakeRes();
  await healthEndpoint(() => { throw new Error('probe blew up'); }, { env: {} })({}, failRes);
  assert.deepEqual(failRes.body, { ok: true, build: NO_BUILD });
});

// #2646 AC2: the running sidecar reports the build it was started from — read
// from its own environment (baked into the image), not from the image store.
test('health: reports the image build identity from the environment', async () => {
  const env = { AEE_BUILD_COMMIT: 'abc1234', AEE_BUILD_DIRTY: 'dirty', AEE_BUILD_COMMIT_TIME: '2026-09-30T21:08:25+02:00' };
  const res = fakeRes();
  await healthEndpoint(() => ({ backend: 'reachable' }), { env })({}, res);
  assert.deepEqual(res.body.build, { commit: 'abc1234', dirty: 'dirty', commitTime: '2026-09-30T21:08:25+02:00' });
  assert.equal(res.body.backend, 'reachable');
});

test('teardown: 401 on a forged/missing token, reap never runs', async () => {
  let reaped = false;
  const handler = teardownScopeEndpoint(() => { reaped = true; }, { secret: SECRET });

  const noAuth = fakeRes();
  await handler(reqWith(null), noAuth);
  assert.equal(noAuth.statusCode, 401);

  const forged = fakeRes();
  await handler(reqWith('podman-sandbox.team-abc.deadbeef'), forged);
  assert.equal(forged.statusCode, 401);

  assert.equal(reaped, false);
});

// Acceptance: teardown ordering — resources reaped BEFORE token invalidation —
// for a TEAM scope as well as a SINGLE-AGENT scope, one implementation for both.
for (const scopeId of ['team-abc', 'agent-aaaa']) {
  test(`teardown: reaps ${scopeId} resources, then the caller may invalidate the token`, async () => {
    const events = [];
    const reap = async (sid) => {
      events.push(`reap:${sid}`);
      return { removed: [`c1@${sid}`, `c2@${sid}`], errors: [] };
    };
    const handler = teardownScopeEndpoint(reap, { secret: SECRET });

    const res = fakeRes();
    await handler(reqWith(mint('podman-sandbox', scopeId, SECRET)), res);

    // The endpoint reaps and returns the summary...
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, removed: [`c1@${scopeId}`, `c2@${scopeId}`], errors: [] });
    // ...and only NOW does the orchestrator invalidate the token.
    events.push('invalidate-token');

    assert.deepEqual(events, [`reap:${scopeId}`, 'invalidate-token']);
  });
}

test('teardown: reap failure is best-effort (200 ok:false), never a hard error', async () => {
  const handler = teardownScopeEndpoint(() => { throw new Error('podman unreachable'); }, { secret: SECRET });
  const res = fakeRes();
  await handler(reqWith(mint('p', 'team-abc', SECRET)), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.errors[0].error, 'podman unreachable');
});

test('teardown: a scope only ever reaps ITS OWN scopeId (token-derived, not arg-derived)', async () => {
  const seen = [];
  const handler = teardownScopeEndpoint((sid) => { seen.push(sid); return { removed: [], errors: [] }; }, { secret: SECRET });
  await handler(reqWith(mint('p', 'agent-aaaa', SECRET)), fakeRes());
  await handler(reqWith(mint('p', 'agent-bbbb', SECRET)), fakeRes());
  assert.deepEqual(seen, ['agent-aaaa', 'agent-bbbb']); // each reaps exactly the token's scope
});

test('teardownScopeEndpoint requires a reap handler', () => {
  assert.throws(() => teardownScopeEndpoint(null, { secret: SECRET }), /requires a reap/);
});

// ── internalPushEndpoint: the orchestrator→broker push is `_internal`-only ──

const { internalPushEndpoint, INTERNAL_SCOPE_ID } = require('./endpoints');
const INTERNAL = mint('jira', INTERNAL_SCOPE_ID, SECRET);
const TEAM = mint('jira', 'team-a', SECRET);

test('internal push: the reserved scope id is `_internal`', () => {
  assert.equal(INTERNAL_SCOPE_ID, '_internal');
});

test('internal push: a granted TEAM token is refused — the handler never runs', async () => {
  let ran = 0;
  const h = internalPushEndpoint(async () => { ran += 1; }, { secret: SECRET, pluginId: 'jira' });
  for (const token of [TEAM, undefined, 'garbage', mint('jira', 'team-a', 'other-secret')]) {
    const res = fakeRes();
    await h(reqWith(token), res);
    assert.equal(res.statusCode, 401, `token=${token}`);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  }
  assert.equal(ran, 0);
});

test('internal push: an `_internal` token of ANOTHER plugin is refused', async () => {
  let ran = 0;
  const h = internalPushEndpoint(async () => { ran += 1; }, { secret: SECRET, pluginId: 'jira' });
  const res = fakeRes();
  await h(reqWith(mint('github-issues', INTERNAL_SCOPE_ID, SECRET)), res);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, 0);
});

test('internal push: the `_internal` token of this plugin reaches the handler with the verified identity', async () => {
  let seen = null;
  const h = internalPushEndpoint(async (req, res, v) => { seen = v; res.writeHead(200, {}); res.end('{"ok":true}'); },
    { secret: SECRET, pluginId: 'jira' });
  const res = fakeRes();
  await h(reqWith(INTERNAL), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, { pluginId: 'jira', scopeId: INTERNAL_SCOPE_ID });
});

test('internal push: a throwing handler is a 500, not a crash', async () => {
  const h = internalPushEndpoint(async () => { throw new Error('boom'); }, { secret: SECRET, pluginId: 'jira' });
  const res = fakeRes();
  await h(reqWith(INTERNAL), res);
  assert.equal(res.statusCode, 500);
});

test('internalPushEndpoint requires a handler, a secret and a pluginId', () => {
  assert.throws(() => internalPushEndpoint(null, { secret: SECRET, pluginId: 'jira' }));
  assert.throws(() => internalPushEndpoint(async () => {}, { pluginId: 'jira' }));
  assert.throws(() => internalPushEndpoint(async () => {}, { secret: SECRET }));
});
