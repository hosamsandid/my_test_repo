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

test('health: answers ok with no auth', async () => {
  const res = fakeRes();
  await healthEndpoint()({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('health: merges extra detail, degrades to bare ok on failure', async () => {
  const okRes = fakeRes();
  await healthEndpoint(() => ({ backend: 'reachable' }))({}, okRes);
  assert.deepEqual(okRes.body, { ok: true, backend: 'reachable' });

  const failRes = fakeRes();
  await healthEndpoint(() => { throw new Error('probe blew up'); })({}, failRes);
  assert.deepEqual(failRes.body, { ok: true });
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
