'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fb = require('./flow-board');
const rel = require('./flow-claim-release');

const CLAIM = { repo: 'o/r', number: 20, kind: 'issue', claim: 'ready:wip', wake: 'ready' };
const stuckRow = (extra = {}) => ({
  id: 'o/r#20',
  needsHuman: { reason: fb.REASONS.needsHelp, since: '2026-01-01T00:00:00.000Z', release: [CLAIM] },
  ...extra,
});

test('planClaimRelease: a fresh needs-help row with claims is releasable', () => {
  const p = rel.planClaimRelease({ rows: [stuckRow()] }, 'o/r#20');
  assert.equal(p.ok, true);
  assert.deepEqual(p.claims, [CLAIM]);
});

test('planClaimRelease: refuses stale data, unknown rows, other flags and rows without claims', () => {
  assert.equal(rel.planClaimRelease({ stale: true, rows: [stuckRow()] }, 'o/r#20').status, 503);
  assert.equal(rel.planClaimRelease(null, 'o/r#20').status, 503);
  assert.equal(rel.planClaimRelease({ rows: [stuckRow()] }, 'o/r#99').status, 404);
  const flagged = stuckRow({ needsHuman: { reason: fb.REASONS.flagged, since: 'x', release: [CLAIM] } });
  assert.equal(rel.planClaimRelease({ rows: [flagged] }, 'o/r#20').status, 409);
  const dead = stuckRow({ needsHuman: { reason: fb.REASONS.noConsumer, since: 'x' } });
  assert.equal(rel.planClaimRelease({ rows: [dead] }, 'o/r#20').status, 409);
  const healthy = stuckRow({ needsHuman: null });
  assert.equal(rel.planClaimRelease({ rows: [healthy] }, 'o/r#20').status, 409);
  const noClaims = stuckRow({ needsHuman: { reason: fb.REASONS.needsHelp, since: 'x' } });
  assert.equal(rel.planClaimRelease({ rows: [noClaims] }, 'o/r#20').status, 409);
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next };
  };
  fn.calls = calls;
  return fn;
}

const swap = (fetchImpl) => rel.swapClaimLabel({ fetchImpl, base: 'https://api', token: 'tok', ...CLAIM });

test('swapClaimLabel: removes the claim FIRST, then re-applies the wake', async () => {
  const f = fakeFetch([200, 200]);
  const r = await swap(f);
  assert.deepEqual(r, { ok: true, removed: true, applied: true });
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]), [
    ['DELETE', 'https://api/repos/o/r/issues/20/labels/ready%3Awip'],
    ['POST', 'https://api/repos/o/r/issues/20/labels'],
  ]);
  assert.deepEqual(f.calls[1].body, { labels: ['ready'] });
  assert.equal(f.calls[0].auth, 'Bearer tok');
});

test('swapClaimLabel: a claim already gone (404) still re-applies the wake', async () => {
  const f = fakeFetch([404, 200]);
  assert.equal((await swap(f)).ok, true);
});

test('swapClaimLabel: a failed delete stops before touching the wake', async () => {
  const f = fakeFetch([403]);
  const r = await swap(f);
  assert.equal(r.ok, false);
  assert.equal(r.removed, false);
  assert.match(r.warning, /could not remove ready:wip/);
  assert.equal(f.calls.length, 1);
  const thrown = fakeFetch([new Error('boom')]);
  assert.match((await swap(thrown)).warning, /boom/);
});

test('swapClaimLabel: a failed add creates the label and retries once; a second failure says what to do by hand', async () => {
  const ok = fakeFetch([200, 422, 201, 200]);
  assert.equal((await swap(ok)).ok, true);
  assert.deepEqual(ok.calls.map((c) => c.method), ['DELETE', 'POST', 'POST', 'POST']);
  assert.equal(ok.calls[2].url, 'https://api/repos/o/r/labels');
  const bad = fakeFetch([200, 500, 500, 500]);
  const r = await swap(bad);
  assert.equal(r.ok, false);
  assert.equal(r.removed, true);
  assert.match(r.warning, /add ready by hand/);
});

test('buildClaimReleaseLogEntry: a repo-scoped, attributed Event Log line with no outcomes', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const e = rel.buildClaimReleaseLogEntry({ teamId: 't', rowId: 'o/r#20', actor: 'alice', claim: CLAIM, result: { ok: true }, now });
  assert.equal(e.event, rel.CLAIM_RELEASED_EVENT);
  assert.equal(e.event, 'flow-control.claim-released');
  assert.equal(e.repo, 'o/r');
  assert.equal(e.actor, 'alice');
  assert.equal(e.label, 'ready');
  assert.equal(e.ts, now.toISOString());
  assert.deepEqual(e.workItem, { kind: 'issue', number: 20, title: null, url: null });
  assert.deepEqual(e.outcomes, []);
  assert.equal(e.noMatchingTrigger, false);
  assert.equal(e.source, 'flow-control');
  assert.deepEqual(e.claimRelease, { teamId: 't', rowId: 'o/r#20', claim: 'ready:wip', wake: 'ready', ok: true });
  const failed = rel.buildClaimReleaseLogEntry({ teamId: 't', rowId: 'o/r#20', actor: null, claim: CLAIM, result: { ok: false, warning: 'w' }, now });
  assert.equal(failed.actor, null);
  assert.deepEqual(failed.claimRelease, { teamId: 't', rowId: 'o/r#20', claim: 'ready:wip', wake: 'ready', ok: false, warning: 'w' });
});
