'use strict';

// Unit tests for the pure agent-pool core (#2246, epic #2251 Phase 1).

const { test } = require('node:test');
const assert = require('node:assert');

const pool = require('./agent-pool');

// ─── normalizePoolConfig ──────────────────────────────────────────────────────

test('normalizePoolConfig: absent/disabled pool reads as not pooled', () => {
  assert.equal(pool.normalizePoolConfig(undefined), null);
  assert.equal(pool.normalizePoolConfig(null), null);
  assert.equal(pool.normalizePoolConfig({}), null);
  assert.equal(pool.normalizePoolConfig({ enabled: false }), null);
  assert.equal(pool.normalizePoolConfig({ enabled: 'true' }), null); // must be the literal boolean
});

test('normalizePoolConfig: minimal enabled config gets full defaults, including sensible non-null teardown (#2301)', () => {
  assert.deepEqual(pool.normalizePoolConfig({ enabled: true }), {
    enabled: true,
    maxInstances: null,
    workspace: 'git-clean-base',
    baseBranch: null,
    workSource: null,
    teardown: { ...pool.TEARDOWN_DEFAULTS },
  });
});

test('normalizePoolConfig: carries through valid teardown fields, falls back to the default on invalid ones (#2301)', () => {
  assert.deepEqual(pool.normalizePoolConfig({
    enabled: true,
    maxInstances: 3,
    workspace: 'input-copy',
    baseBranch: 'develop',
    teardown: { idleTimeoutMs: 60_000, maxRuntimeMs: -5, retainLogsMs: 'nope' },
  }), {
    enabled: true,
    maxInstances: 3,
    workspace: 'input-copy',
    baseBranch: 'develop',
    workSource: null,
    teardown: {
      idleTimeoutMs: 60_000,
      maxRuntimeMs: pool.TEARDOWN_DEFAULTS.maxRuntimeMs,
      retainLogsMs: pool.TEARDOWN_DEFAULTS.retainLogsMs,
    },
  });
});

test('normalizePoolConfig: carries through a valid recurring-analysis workSource (#2248 Phase 3)', () => {
  const cfg = pool.normalizePoolConfig({
    enabled: true,
    workspace: 'input-copy',
    workSource: { items: ['ds-002', 'ds-001', 'ds-002'], outputDir: '/out', inputDir: '/in' },
  });
  assert.deepEqual(cfg.workSource, { items: ['ds-002', 'ds-001'], outputDir: '/out', inputDir: '/in' });
});

test('normalizePoolConfig: a malformed workSource (no items, no outputDir) reads as null, not a guess', () => {
  assert.equal(pool.normalizePoolConfig({ enabled: true, workSource: {} }).workSource, null);
  assert.equal(pool.normalizePoolConfig({ enabled: true, workSource: { items: [] } }).workSource, null);
  assert.equal(pool.normalizePoolConfig({ enabled: true, workSource: { items: ['a'] } }).workSource, null);
});

test('normalizePoolConfig: an unrecognised workspace binding falls back to git-clean-base', () => {
  assert.equal(pool.normalizePoolConfig({ enabled: true, workspace: 'teleport' }).workspace, 'git-clean-base');
});

test('normalizePoolConfig: a non-positive-integer maxInstances is null (unbounded, wipLimit governs)', () => {
  assert.equal(pool.normalizePoolConfig({ enabled: true, maxInstances: 0 }).maxInstances, null);
  assert.equal(pool.normalizePoolConfig({ enabled: true, maxInstances: -1 }).maxInstances, null);
  assert.equal(pool.normalizePoolConfig({ enabled: true, maxInstances: 1.5 }).maxInstances, null);
});

// ─── isPooledRole ──────────────────────────────────────────────────────────────

test('isPooledRole: true only for a template with pool.enabled, never for an instance', () => {
  assert.equal(pool.isPooledRole({ pool: { enabled: true } }), true);
  assert.equal(pool.isPooledRole({ pool: { enabled: false } }), false);
  assert.equal(pool.isPooledRole({}), false);
  assert.equal(pool.isPooledRole(null), false);
  // An already-spawned instance never re-pools, even if it somehow carried the
  // field forward — no nested spawning.
  assert.equal(pool.isPooledRole({ pool: { enabled: true }, poolInstance: true }), false);
});

// ─── poolInstanceId / roleIdFromMemberId ───────────────────────────────────────

test('poolInstanceId: deterministic, item-keyed (D11)', () => {
  assert.equal(pool.poolInstanceId('team1', 'developer', 42), 'team1-developer-i42');
  // Same inputs, same output — the whole idempotency property.
  assert.equal(pool.poolInstanceId('team1', 'developer', 42), pool.poolInstanceId('team1', 'developer', 42));
});

test('roleIdFromMemberId: inverse of the `${teamId}-${roleId}` naming convention', () => {
  assert.equal(pool.roleIdFromMemberId('team1-developer', 'team1'), 'developer');
  // A role id that itself contains a hyphen survives (only the team prefix is stripped).
  assert.equal(pool.roleIdFromMemberId('team1-code-reviewer', 'team1'), 'code-reviewer');
});

test('roleIdFromMemberId: falls back to the bare id when it carries no team prefix', () => {
  assert.equal(pool.roleIdFromMemberId('some-hand-authored-id', 'team1'), 'some-hand-authored-id');
});

// ─── planPoolDispatch ───────────────────────────────────────────────────────────

const POOL = pool.normalizePoolConfig({ enabled: true });

test('planPoolDispatch: no item key → unpooled (dispatch the template itself)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: null }),
    { action: 'unpooled' },
  );
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: undefined }),
    { action: 'unpooled' },
  );
});

test('planPoolDispatch: a brand-new item spawns a fresh, deterministically-named instance', () => {
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7, existingInstanceIds: [] }),
    { action: 'spawn', instanceId: 't-developer-i7' },
  );
});

test('planPoolDispatch: a redelivered item for an instance that already exists is reused, not re-spawned (D11)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7,
      existingInstanceIds: ['t-developer-i7'],
    }),
    { action: 'reuse', instanceId: 't-developer-i7' },
  );
});

test('planPoolDispatch: maxInstances refuses a new item once the per-role cap is reached', () => {
  const capped = pool.normalizePoolConfig({ enabled: true, maxInstances: 2 });
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: capped, itemKey: 9,
      existingInstanceIds: ['t-developer-i7', 't-developer-i8'],
    }),
    { action: 'refuse', reason: 'max-instances', instanceId: 't-developer-i9' },
  );
});

test('planPoolDispatch: maxInstances never refuses a REUSE of an already-existing instance', () => {
  const capped = pool.normalizePoolConfig({ enabled: true, maxInstances: 1 });
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: capped, itemKey: 7,
      existingInstanceIds: ['t-developer-i7'],
    }),
    { action: 'reuse', instanceId: 't-developer-i7' },
  );
});

test('planPoolDispatch: an unset maxInstances (null) is unbounded — only wipLimit governs (D5)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: POOL, itemKey: 100,
      existingInstanceIds: Array.from({ length: 50 }, (_, i) => `t-developer-i${i}`),
    }),
    { action: 'spawn', instanceId: 't-developer-i100' },
  );
});

// ─── pool runtime control: pause/drain (#2250 Phase 5) ──────────────────────────

test('normalizePoolControl: an absent/empty/malformed record is the empty map (default running)', () => {
  assert.deepEqual(pool.normalizePoolControl(undefined), {});
  assert.deepEqual(pool.normalizePoolControl(null), {});
  assert.deepEqual(pool.normalizePoolControl([]), {});
  assert.deepEqual(pool.normalizePoolControl({}), {});
});

test('normalizePoolControl: keeps a valid paused/draining record, drops an invalid state', () => {
  assert.deepEqual(
    pool.normalizePoolControl({
      developer: { state: 'paused', changedAt: '2026-09-14T09:00:00.000Z' },
      reviewer: { state: 'bogus' },
      merger: { state: 'running' }, // the implicit default is never itself stored
    }),
    { developer: { state: 'paused', changedAt: '2026-09-14T09:00:00.000Z' } },
  );
});

test('poolControlState: running for anything not recorded; the recorded state otherwise', () => {
  const control = pool.normalizePoolControl({ developer: { state: 'draining' } });
  assert.equal(pool.poolControlState(control, 'developer'), 'draining');
  assert.equal(pool.poolControlState(control, 'reviewer'), 'running');
  assert.equal(pool.poolControlState({}, 'developer'), 'running');
  assert.equal(pool.poolControlState(null, 'developer'), 'running');
});

// ─── paused/draining hold queue (code-review finding on #2281) ─────────────

test('normalizePausedHold: an absent/empty/malformed record is the empty map', () => {
  assert.deepEqual(pool.normalizePausedHold(undefined), {});
  assert.deepEqual(pool.normalizePausedHold(null), {});
  assert.deepEqual(pool.normalizePausedHold([]), {});
  assert.deepEqual(pool.normalizePausedHold({}), {});
});

test('normalizePausedHold: keeps a valid held entry, drops one missing agentId/entry, drops an empty list', () => {
  assert.deepEqual(
    pool.normalizePausedHold({
      developer: [
        { agentId: 't-developer', entry: { github: {} }, heldAt: '2026-09-14T09:00:00.000Z' },
        { agentId: 't-developer' }, // no `entry` — dropped
        { entry: { github: {} } }, // no `agentId` — dropped
      ],
      reviewer: [], // empties to nothing — the key itself must not survive
    }),
    { developer: [{ agentId: 't-developer', entry: { github: {} }, heldAt: '2026-09-14T09:00:00.000Z' }] },
  );
});

test('planPoolDispatch: paused/draining refuses a NEW spawn but still reuses an existing instance (D4)', () => {
  for (const controlState of ['paused', 'draining']) {
    assert.deepEqual(
      pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7, controlState }),
      { action: 'refuse', reason: controlState, instanceId: 't-developer-i7' },
    );
    assert.deepEqual(
      pool.planPoolDispatch({
        teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7, controlState,
        existingInstanceIds: ['t-developer-i7'],
      }),
      { action: 'reuse', instanceId: 't-developer-i7' },
    );
  }
});

test('planPoolDispatch: off refuses even a reuse — nothing runs until switched on (#2573)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7, controlState: 'off',
      existingInstanceIds: ['t-developer-i7'],
    }),
    { action: 'refuse', reason: 'off', instanceId: 't-developer-i7' },
  );
});

test('normalizePoolControl keeps off; settleDrain turns a finished drain off (#2573)', () => {
  const control = pool.normalizePoolControl({ developer: { state: 'off' } });
  assert.equal(pool.poolControlState(control, 'developer'), 'off');
  assert.equal(pool.settleDrain('draining', 0), 'off');
  assert.equal(pool.settleDrain('draining', 2), 'draining');
  assert.equal(pool.settleDrain('draining', NaN), 'draining');
  assert.equal(pool.settleDrain('paused', 0), 'paused');
  assert.equal(pool.settleDrain('running', 0), 'running');
});

test('planPoolDispatch: an omitted controlState defaults to running (back-compat)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7 }),
    { action: 'spawn', instanceId: 't-developer-i7' },
  );
});

// ─── isInstanceTimedOut (D8 hard timeout) ───────────────────────────────────────

test('isInstanceTimedOut: no maxRuntimeMs configured → never times out', () => {
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: '2026-01-01T00:00:00.000Z', maxRuntimeMs: null }, Date.now()), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: '2026-01-01T00:00:00.000Z', maxRuntimeMs: undefined }, Date.now()), false);
});

test('isInstanceTimedOut: unresolvable spawnedAt never times out (fails closed, not stuck-forever-by-accident)', () => {
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: null, maxRuntimeMs: 1000 }, Date.now()), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: 'not-a-date', maxRuntimeMs: 1000 }, Date.now()), false);
});

test('isInstanceTimedOut: within budget → false, at/after the deadline → true', () => {
  const spawnedAt = '2026-01-01T00:00:00.000Z';
  const start = Date.parse(spawnedAt);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 3_600_000 }, start + 3_599_999), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 3_600_000 }, start + 3_600_000), true);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 3_600_000 }, start + 10_000_000), true);
});

// ─── isInstanceIdle (#2301 gap 3 — the idle reap) ──────────────────────────────

test('isInstanceIdle: no idleTimeoutMs configured → never idle-reaped', () => {
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt: '2026-01-01T00:00:00.000Z', idleTimeoutMs: null }, Date.now()), false);
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt: '2026-01-01T00:00:00.000Z', idleTimeoutMs: undefined }, Date.now()), false);
});

test('isInstanceIdle: a busy instance is never idle-reaped, however long it has run — that is maxRuntimeMs\'s job', () => {
  const lastResponseAt = '2026-01-01T00:00:00.000Z';
  assert.equal(
    pool.isInstanceIdle({ state: 'busy', lastResponseAt, idleTimeoutMs: 1000 }, Date.parse(lastResponseAt) + 10_000_000),
    false,
  );
});

test('isInstanceIdle: an unresolvable reference time never reaps (fails closed)', () => {
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt: null, spawnedAt: null, idleTimeoutMs: 1000 }, Date.now()), false);
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt: 'not-a-date', idleTimeoutMs: 1000 }, Date.now()), false);
  assert.equal(pool.isInstanceIdle({ state: undefined, lastResponseAt: '2026-01-01T00:00:00.000Z', idleTimeoutMs: 1000 }, Date.now()), false);
});

test('isInstanceIdle: idle within budget → false, at/after the deadline → true', () => {
  const lastResponseAt = '2026-01-01T00:00:00.000Z';
  const start = Date.parse(lastResponseAt);
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt, idleTimeoutMs: 1_800_000 }, start + 1_799_999), false);
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt, idleTimeoutMs: 1_800_000 }, start + 1_800_000), true);
});

test('isInstanceIdle: falls back to spawnedAt when an idle instance never recorded a lastResponseAt', () => {
  const spawnedAt = '2026-01-01T00:00:00.000Z';
  const start = Date.parse(spawnedAt);
  assert.equal(pool.isInstanceIdle({ state: 'idle', lastResponseAt: null, spawnedAt, idleTimeoutMs: 1_800_000 }, start + 1_800_000), true);
});

// ─── isArchiveExpired (#2301 gap 4 — retainLogsMs pruning) ─────────────────────

test('isArchiveExpired: no retainLogsMs configured → never expires', () => {
  assert.equal(pool.isArchiveExpired({ archivedAt: '2026-01-01T00:00:00.000Z', retainLogsMs: null }, Date.now()), false);
});

test('isArchiveExpired: unresolvable archivedAt never expires (never guess)', () => {
  assert.equal(pool.isArchiveExpired({ archivedAt: null, retainLogsMs: 1000 }, Date.now()), false);
  assert.equal(pool.isArchiveExpired({ archivedAt: 'not-a-date', retainLogsMs: 1000 }, Date.now()), false);
});

test('isArchiveExpired: within retention → false, at/after the window → true', () => {
  const archivedAt = '2026-01-01T00:00:00.000Z';
  const start = Date.parse(archivedAt);
  const day = 24 * 60 * 60 * 1000;
  assert.equal(pool.isArchiveExpired({ archivedAt, retainLogsMs: 7 * day }, start + 7 * day - 1), false);
  assert.equal(pool.isArchiveExpired({ archivedAt, retainLogsMs: 7 * day }, start + 7 * day), true);
});

// ─── reworkRefFromPayload (D3 — rework resolves to the PR head branch) ─────────

test('reworkRefFromPayload: a pull_request event yields its own head branch + repo', () => {
  assert.deepEqual(
    pool.reworkRefFromPayload({
      pull_request: { head: { ref: 'fix/123-thing', repo: { full_name: 'acme/widgets' } } },
    }),
    { branch: 'fix/123-thing', repo: 'acme/widgets' },
  );
});

test('reworkRefFromPayload: repo is null when the payload does not carry one (still usable — branch alone is the signal)', () => {
  assert.deepEqual(
    pool.reworkRefFromPayload({ pull_request: { head: { ref: 'fix/123-thing' } } }),
    { branch: 'fix/123-thing', repo: null },
  );
});

test('reworkRefFromPayload: an issue-shaped event (no pull_request) is not rework — null, not a guess', () => {
  assert.equal(pool.reworkRefFromPayload({ issue: { number: 7 } }), null);
  assert.equal(pool.reworkRefFromPayload({}), null);
  assert.equal(pool.reworkRefFromPayload(null), null);
  assert.equal(pool.reworkRefFromPayload(undefined), null);
});

test('reworkRefFromPayload: a pull_request with no resolvable head.ref is null, never a malformed branch name', () => {
  assert.equal(pool.reworkRefFromPayload({ pull_request: {} }), null);
  assert.equal(pool.reworkRefFromPayload({ pull_request: { head: {} } }), null);
  assert.equal(pool.reworkRefFromPayload({ pull_request: { head: { ref: '' } } }), null);
});

// ─── isSafeGitRef (CodeQL js/second-order-command-line-injection) ──────────────

test('isSafeGitRef: an ordinary branch name is safe', () => {
  assert.equal(pool.isSafeGitRef('fix/123-thing'), true);
  assert.equal(pool.isSafeGitRef('main'), true);
  assert.equal(pool.isSafeGitRef('feature/2246_pool'), true);
});

test('isSafeGitRef: a value beginning with "-" is refused — git parses it as an option, not a ref', () => {
  assert.equal(pool.isSafeGitRef('--upload-pack=touch /tmp/pwned'), false);
  assert.equal(pool.isSafeGitRef('-x'), false);
});

test('isSafeGitRef: empty/missing/non-string is refused, never coerced', () => {
  assert.equal(pool.isSafeGitRef(''), false);
  assert.equal(pool.isSafeGitRef(null), false);
  assert.equal(pool.isSafeGitRef(undefined), false);
  assert.equal(pool.isSafeGitRef(123), false);
});

test('reworkRefFromPayload: an unsafe-looking head.ref is refused, not merely passed through', () => {
  assert.equal(
    pool.reworkRefFromPayload({ pull_request: { head: { ref: '--upload-pack=x' } } }),
    null,
  );
});

// ─── isArchivableSessionPath (#2595 AC10) ────────────────────────────────────

test('isArchivableSessionPath: the transcript and its rotations are archived', () => {
  assert.equal(pool.isArchivableSessionPath('/s/sessions'), true);
  assert.equal(pool.isArchivableSessionPath('/s/sessions/!room:local.jsonl'), true);
  assert.equal(pool.isArchivableSessionPath('/s/sessions/!room:local.1.jsonl'), true);
});

test('isArchivableSessionPath: the resumable session pointer is never archived', () => {
  assert.equal(pool.isArchivableSessionPath('/s/sessions/!room:local.current.json'), false);
});

test('isArchivableSessionPath: the filter really drops the pointer from an fs.cpSync copy', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-archive-'));
  try {
    const src = path.join(root, 'sessions');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, '!r.jsonl'), '{}\n');
    fs.writeFileSync(path.join(src, '!r.current.json'), '{"sessionId":"s1"}');
    const dst = path.join(root, 'archive', 'sessions');
    fs.cpSync(src, dst, { recursive: true, filter: pool.isArchivableSessionPath });
    assert.deepEqual(fs.readdirSync(dst).sort(), ['!r.jsonl']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('itemKeyFromInstanceId inverts poolInstanceId for its own role only (#2760)', () => {
  const id = pool.poolInstanceId('t', 'developer', 42);
  assert.equal(pool.itemKeyFromInstanceId(id, 't-developer'), '42');
  assert.equal(pool.itemKeyFromInstanceId(id, 't-reviewer'), null);
  assert.equal(pool.itemKeyFromInstanceId('t-developer-i', 't-developer'), null);
  assert.equal(pool.itemKeyFromInstanceId(null, 't-developer'), null);
});

// ─── #2789: instances waiting on an open PR ───────────────────────────────────

const pr = (number, body = '', ref = 'feat/x', state = 'open') => ({ number, body, state, head: { ref } });

test('#2789 prItemKey: closes #N names the item, else the PR is its own item', () => {
  assert.equal(pool.prItemKey(pr(50, 'Closes #12')), 12);
  assert.equal(pool.prItemKey(pr(50, 'no link')), 50);
  assert.equal(pool.prItemKey(pr(50, '', 'issue-7')), 7);
});

test('#2789 linkedOpenPrs: PRs closing the item or the item itself; every open one, sorted; closed ones ignored', () => {
  const prs = [pr(60, 'Fixes #12'), pr(51, 'Closes #12'), pr(70, 'Closes #13'), pr(12), pr(80, 'Closes #12', 'x', 'closed')];
  assert.deepEqual(pool.linkedOpenPrs(prs, 12), [12, 51, 60]);
  assert.deepEqual(pool.linkedOpenPrs(prs, 99), []);
  assert.deepEqual(pool.linkedOpenPrs(null, 12), []);
});

test('#2789 nextWaitRecord: idle with an open linked PR waits; the wait clock starts', () => {
  const r = pool.nextWaitRecord(null, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [5] } }, 1000);
  assert.equal(r.waiting, true);
  assert.deepEqual(r.prs, [5]);
  assert.equal(r.waitingSince, new Date(1000).toISOString());
});

test('#2789 nextWaitRecord: AC7 — idle with no open PR does not wait; a busy instance never waits', () => {
  assert.equal(pool.nextWaitRecord(null, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [] } }, 0).waiting, false);
  assert.equal(pool.nextWaitRecord(null, { spawnedAt: 'S', idle: false, lookup: null }, 0).waiting, false,
    'edge case: a PR opened mid-run waits only once the run is over');
});

test('#2789 nextWaitRecord: AC10 — GitHub unreachable keeps the instance waiting, with the last PRs known', () => {
  const prev = pool.nextWaitRecord(null, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [5] } }, 0);
  const r = pool.nextWaitRecord(prev, { spawnedAt: 'S', idle: true, lookup: { ok: false } }, 1000);
  assert.equal(r.waiting, true);
  assert.equal(r.unknown, true);
  assert.deepEqual(r.prs, [5]);
  assert.equal(pool.waitJustEnded(prev, r, true), false);
  const fresh = pool.nextWaitRecord(null, { spawnedAt: 'S', idle: true, lookup: { ok: false } }, 0);
  assert.equal(fresh.waiting, true, 'unknown counts as waiting even before a first successful check');
});

test('#2789 waitJustEnded: AC6 — the last linked PR closed on an idle instance ends the wait for an immediate reap', () => {
  const prev = pool.nextWaitRecord(null, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [5, 6] } }, 0);
  const still = pool.nextWaitRecord(prev, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [6] } }, 1);
  assert.equal(still.waiting, true, 'edge case: several PRs — waits while any is open');
  assert.equal(pool.waitJustEnded(prev, still, true), false);
  const done = pool.nextWaitRecord(still, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [] } }, 2);
  assert.equal(pool.waitJustEnded(still, done, true), true);
  assert.equal(pool.waitJustEnded(null, done, true), false, 'never waited — the plain idle reap decides (AC7)');
});

test('#2789 AC2: waited time is taken off the hard timeout', () => {
  const prev = pool.nextWaitRecord(null, { spawnedAt: 'S', idle: true, lookup: { ok: true, prs: [5] } }, 1000);
  assert.equal(pool.waitedMsSoFar(prev, 6000), 5000, 'the open wait counts while it lasts');
  const working = pool.endWait(prev, 9000);
  assert.equal(working.waiting, false);
  assert.equal(working.waitedMs, 8000);
  assert.equal(pool.waitedMsSoFar(working, 20000), 8000, 'the clock stops once the instance works again');
  const spawnedAt = new Date(0).toISOString();
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 10000 }, 15000), true);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 10000, waitedMs: 8000 }, 15000), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 10000, waitedMs: 8000 }, 18000), true);
});

test('#2789 normalizeWaitRecord: a record from an earlier spawn of the same instance id is ignored', () => {
  assert.equal(pool.normalizeWaitRecord({ spawnedAt: 'OLD', waiting: true }, 'NEW'), null);
  assert.equal(pool.normalizeWaitRecord({ spawnedAt: 'NEW', waiting: true }, 'NEW').waiting, true);
  assert.deepEqual(pool.normalizePoolWaiting({ a: { waiting: true, prs: [1, 'x', -2] }, b: null }), {
    a: { spawnedAt: null, waiting: true, prs: [1], unknown: false, waitingSince: null, waitedMs: 0, checkedAt: null },
  });
  assert.deepEqual(pool.normalizePoolWaiting([1]), {});
});

test('#2789 planPoolDispatch: AC4 — waiting instances do not count toward maxInstances', () => {
  const P = { enabled: true, maxInstances: 3 };
  const ids = ['t-developer-i1', 't-developer-i2', 't-developer-i3'];
  const blocked = pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: P, itemKey: 9, existingInstanceIds: ids });
  assert.notEqual(blocked.action, 'spawn');
  const spawned = pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: P, itemKey: 9, existingInstanceIds: ids, waitingInstanceIds: ids });
  assert.equal(spawned.action, 'spawn');
  // AC5: the item's own instance is reused even at the cap.
  const reuse = pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: P, itemKey: 2, existingInstanceIds: ids });
  assert.equal(reuse.instanceId, 't-developer-i2');
});

test('#569 sameWaitingMap: key order aside, equal maps are equal; any record change is not', () => {
  const rec = { spawnedAt: 's', waiting: true, prs: [3], unknown: false, waitingSince: 'w', waitedMs: 0, checkedAt: 'c' };
  assert.equal(pool.sameWaitingMap({}, {}), true);
  assert.equal(pool.sameWaitingMap(null, {}), true);
  assert.equal(pool.sameWaitingMap({ a: rec, b: { ...rec } }, { b: { ...rec }, a: { ...rec } }), true);
  const reordered = Object.fromEntries(Object.entries(rec).reverse());
  assert.equal(pool.sameWaitingMap({ a: rec }, { a: reordered }), true);
  assert.equal(pool.sameWaitingMap({ a: rec }, { a: { ...rec, checkedAt: 'c2' } }), false);
  assert.equal(pool.sameWaitingMap({ a: rec }, { a: { ...rec, prs: [3, 4] } }), false);
  assert.equal(pool.sameWaitingMap({ a: rec }, {}), false);
});

test('#569 parsePoolWaitingFile: a clean file is intact; torn, non-map or lossy content is not; no file is', () => {
  const rec = { spawnedAt: 's', waiting: true, prs: [3], unknown: false, waitingSince: 'w', waitedMs: 0, checkedAt: 'c' };
  assert.deepEqual(pool.parsePoolWaitingFile(null), { waiting: {}, intact: true });
  assert.deepEqual(pool.parsePoolWaitingFile('{}'), { waiting: {}, intact: true });
  const clean = pool.parsePoolWaitingFile(JSON.stringify({ a: rec }, null, 2));
  assert.equal(clean.intact, true);
  assert.deepEqual(clean.waiting, { a: rec });
  // Torn mid-write / garbage — normalizes to {} but must not read as intact.
  assert.deepEqual(pool.parsePoolWaitingFile('{"a": {"spawnedAt": "s", "wai'), { waiting: {}, intact: false });
  assert.deepEqual(pool.parsePoolWaitingFile(''), { waiting: {}, intact: false });
  assert.equal(pool.parsePoolWaitingFile('[]').intact, false);
  assert.equal(pool.parsePoolWaitingFile('null').intact, false);
  // A record the normalizer drops or reshapes leaves the raw file unclean.
  assert.equal(pool.parsePoolWaitingFile(JSON.stringify({ a: 'junk' })).intact, false);
  assert.equal(pool.parsePoolWaitingFile(JSON.stringify({ a: { ...rec, prs: [3, -1] } })).intact, false);
});

test('#569 poolWaitingNeedsWrite: skip only an unchanged map over a clean file', () => {
  const rec = { spawnedAt: 's', waiting: false, prs: [], unknown: false, waitingSince: null, waitedMs: 0, checkedAt: 'c' };
  assert.equal(pool.poolWaitingNeedsWrite({ intact: true, prev: {}, next: {} }), false);
  assert.equal(pool.poolWaitingNeedsWrite({ intact: false, prev: {}, next: {} }), true, 'a torn file is rewritten even with nothing to say');
  assert.equal(pool.poolWaitingNeedsWrite({ prev: {}, next: {} }), true, 'unknown cleanliness is not clean');
  assert.equal(pool.poolWaitingNeedsWrite({ intact: true, prev: {}, next: { a: rec } }), true);
  assert.equal(pool.poolWaitingNeedsWrite({ intact: true, prev: { a: rec }, next: { a: { ...rec } } }), false);
  // End to end: the torn file the review found reads as {} yet still rewrites.
  const torn = pool.parsePoolWaitingFile('{"a":');
  assert.equal(pool.poolWaitingNeedsWrite({ intact: torn.intact, prev: torn.waiting, next: {} }), true);
});
