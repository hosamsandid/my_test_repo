'use strict';

// Unit tests for the live `pool` write on `PUT /api/agents/:memberId` (#2270,
// epic #2251 Phase 1 follow-up). `poolConfigError` is the SAME shape check the
// bundle validator (process-template.js's `validateProcessTemplate`) runs over
// a role's `pool` field — parity cases here mirror the bundle's own pool tests
// in process-template.test.js. api.js cannot be `require`d in a unit test (it
// boots Express and reaches for the orchestrator), so the route-wiring half
// reads the route's source — the same technique member-materialize.test.js
// (#1958) uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { poolConfigError, normalizePool, POOL_WORKSPACES } = require('./process-template');

// ------------------------------------------------------- poolConfigError

test('absent/null pool is not an error (the "clear" case is handled by the caller)', () => {
  assert.equal(poolConfigError(undefined, { wipLimitSet: false }), null);
  assert.equal(poolConfigError(null, { wipLimitSet: false }), null);
});

test('a non-object pool is refused', () => {
  assert.ok(poolConfigError('nope', { wipLimitSet: true }));
  assert.ok(poolConfigError(['nope'], { wipLimitSet: true }));
});

test('pool.enabled must be a boolean', () => {
  assert.ok(poolConfigError({ enabled: 'yes' }, { wipLimitSet: true }));
});

test('pool.maxInstances must be a positive integer, or absent', () => {
  assert.ok(poolConfigError({ enabled: true, maxInstances: 0 }, { wipLimitSet: true }));
  assert.ok(poolConfigError({ enabled: true, maxInstances: -1 }, { wipLimitSet: true }));
  assert.ok(poolConfigError({ enabled: true, maxInstances: 1.5 }, { wipLimitSet: true }));
  assert.equal(poolConfigError({ enabled: true, maxInstances: 3 }, { wipLimitSet: true }), null);
  assert.equal(poolConfigError({ enabled: true, maxInstances: null }, { wipLimitSet: true }), null);
});

test('pool.workspace is a closed enum', () => {
  for (const w of POOL_WORKSPACES) {
    assert.equal(poolConfigError({ enabled: true, workspace: w }, { wipLimitSet: true }), null);
  }
  assert.ok(poolConfigError({ enabled: true, workspace: 'teleport' }, { wipLimitSet: true }));
});

test('pool.baseBranch must be a string, or absent/null', () => {
  assert.equal(poolConfigError({ enabled: true, baseBranch: 'main' }, { wipLimitSet: true }), null);
  assert.equal(poolConfigError({ enabled: true, baseBranch: null }, { wipLimitSet: true }), null);
  assert.ok(poolConfigError({ enabled: true, baseBranch: 42 }, { wipLimitSet: true }));
});

test('pool.teardown ms fields must be positive, or absent/null', () => {
  assert.equal(poolConfigError({ enabled: true, teardown: { maxRuntimeMs: 1000 } }, { wipLimitSet: true }), null);
  assert.equal(poolConfigError({ enabled: true, teardown: { maxRuntimeMs: null } }, { wipLimitSet: true }), null);
  assert.ok(poolConfigError({ enabled: true, teardown: { maxRuntimeMs: -1 } }, { wipLimitSet: true }));
  assert.ok(poolConfigError({ enabled: true, teardown: 'nope' }, { wipLimitSet: true }));
});

test('pool.workSource requires an input-copy/none workspace, not git-clean-base', () => {
  const workSource = { items: ['a'], outputDir: '/out' };
  assert.ok(poolConfigError({ enabled: true, workspace: 'git-clean-base', workSource }, { wipLimitSet: true }));
  assert.equal(poolConfigError({ enabled: true, workspace: 'input-copy', workSource }, { wipLimitSet: true }), null);
});

test('pool.workSource.items/outputDir are required and validated', () => {
  assert.ok(poolConfigError({ enabled: true, workspace: 'input-copy', workSource: { items: [], outputDir: '/out' } }, { wipLimitSet: true }));
  assert.ok(poolConfigError({ enabled: true, workspace: 'input-copy', workSource: { items: ['a'] } }, { wipLimitSet: true }));
  assert.equal(poolConfigError({ enabled: true, workspace: 'input-copy', workSource: { items: ['a'], outputDir: '/out' } }, { wipLimitSet: true }), null);
});

test('pool.enabled requires the governing wipLimit to be set — parity with the bundle rule', () => {
  assert.ok(poolConfigError({ enabled: true }, { wipLimitSet: false }));
  assert.equal(poolConfigError({ enabled: true }, { wipLimitSet: true }), null);
  // enabled:false never needs a wipLimit — same as the bundle's own rule.
  assert.equal(poolConfigError({ enabled: false }, { wipLimitSet: false }), null);
});

test('normalizePool round-trips a valid config and drops enabled:false', () => {
  assert.deepEqual(normalizePool({ enabled: true, maxInstances: 2, workspace: 'input-copy' }),
    { enabled: true, maxInstances: 2, workspace: 'input-copy' });
  assert.equal(normalizePool({ enabled: false }), null);
  assert.equal(normalizePool(null), null);
});

// Code-review finding (#2280 review): a well-formed, non-null `pool` payload
// that isn't `enabled: true` — exactly what a config-UI toggle sends when a
// user unchecks "enable pooling" while leaving the other fields in place —
// must read the same as `poolConfigError` already does: no error, not a 400.
test('a valid-but-not-enabled pool payload (e.g. enabled:false + other fields) is not an error', () => {
  const payload = { enabled: false, workspace: 'git-clean-base' };
  assert.equal(poolConfigError(payload, { wipLimitSet: false }), null, 'poolConfigError accepts the shape');
  assert.equal(normalizePool(payload), null, 'normalizePool omits the field — this is NOT the error case');
});

// ------------------------------------------------------- the route's wiring

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The body of the PUT /api/agents/:id route, so a match elsewhere can't fool us. */
function putAgentRoute() {
  const start = API_SRC.indexOf("app.put('/api/agents/:id'");
  assert.ok(start > 0, 'PUT /api/agents/:id route not found — this guard needs re-pointing');
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, 'could not find the end of the route');
  return API_SRC.slice(start, end);
}

/** Source with comments stripped, so the prose explaining the feature can't
 *  make an assertion pass vacuously. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the route destructures pool from the body and gates it to team-member', () => {
  const route = code(putAgentRoute());
  assert.match(route, /\{[^}]*\bpool\b[^}]*\}\s*=\s*req\.body/);
  assert.ok(
    /if \(pool !== undefined && fresh\.role === 'team-member'\)/.test(route),
    'pool must only apply to a team-member role, mirroring wipLimit/autoDispatch\'s team-only gates',
  );
});

test('null clears the field; anything else runs the shared shape check before writing', () => {
  const route = code(putAgentRoute());
  assert.ok(route.includes('delete fresh.pool'), 'null must clear pool.enabled\'s previous value');
  assert.ok(route.includes('poolConfigError(pool'), 'the route must reuse the shared shape check');
  assert.ok(
    /poolConfigError\(pool[\s\S]{0,200}?if \(perr\) return res\.status\(400\)/.test(route),
    'a shape error must short-circuit with a 400 before any write',
  );
  assert.ok(route.includes('fresh.pool = norm'), 'a valid pool must be normalized before assignment');
});

// Code-review finding (#2280): a valid-but-not-enabled `normalizePool` result
// (null) must be treated as clearing the field, matching the bundle path's own
// "omit the field" behavior for the identical input — never a second 400 after
// `poolConfigError` already found no error.
test('a valid-but-not-enabled pool clears the field rather than 400ing', () => {
  const route = code(putAgentRoute());
  assert.ok(
    !route.includes('pool.enabled must be true, or null to remove it'),
    'normalizePool()===null must no longer be treated as a distinct error case',
  );
  assert.ok(
    /const norm = normalizePool\(pool\);\s*\n\s*if \(!norm\) delete fresh\.pool;\s*\n\s*else fresh\.pool = norm;/.test(route),
    'normalizePool()===null must delete fresh.pool, mirroring the null-clear branch above',
  );
});

test('mutation-proved: reverting to the pre-fix 400 would fail the check above', () => {
  const route = code(putAgentRoute());
  const buggy = route.replace(
    "if (!norm) delete fresh.pool;\n      else fresh.pool = norm;",
    "if (!norm) return res.status(400).json({ error: 'pool.enabled must be true, or null to remove it' });\n      fresh.pool = norm;",
  );
  assert.ok(buggy.includes('pool.enabled must be true, or null to remove it'));
});

test('pool.enabled is checked against the PARENT TEAM\'s wipLimit, not the member\'s own', () => {
  const route = code(putAgentRoute());
  assert.ok(
    /readJsonFile\(path\.join\(AGENTS_DIR, fresh\.parentTeamId, 'config\.json'\), null\)/.test(route),
    'must look up the parent team config to answer wipLimitSet',
  );
  assert.ok(
    /wipLimitSet:\s*!!normalizeWipLimit\(teamCfg\?\.wipLimit\)/.test(route),
    'wipLimitSet must come from the parent team\'s own wipLimit',
  );
});

test('the pool write happens before the config is persisted (writeJsonAtomic)', () => {
  const route = code(putAgentRoute());
  const poolAt = route.indexOf("fresh.role === 'team-member'");
  const persistAt = route.indexOf('writeJsonAtomic(cfgPath, fresh)');
  assert.ok(poolAt > 0 && persistAt > poolAt, 'the pool field must be applied before the config is written to disk');
});

// Additive-effect (AC5): the route must not touch the orchestrator for a pool
// change — no respawn, an instance only spawns on the next dispatch.
test('a pool change is a pure config write — no orchestrator call in the same branch', () => {
  const route = code(putAgentRoute());
  const start = route.indexOf("if (pool !== undefined && fresh.role === 'team-member')");
  const end = route.indexOf('\n  }\n', start) + 5;
  const block = route.slice(start, end);
  assert.ok(!/ORCHESTRATOR_URL|fetch\(/.test(block), 'the pool write must not call the orchestrator');
});
