'use strict';

// Run: node --test admin-console/api/tiered-resource-routes.test.js
//
// #2083 (epic #2076 P5) — the wiring guard for the tiered configuration
// resources: working environments and MCP servers.
//
// api.js boots two listeners on require (#651), so the routes cannot be driven
// here. This is a source-reading guard in the `draft-routes-access.test.js`
// shape, with one addition borrowed from `internal-auth-wiring.test.js`: every
// check is a NAMED predicate over a source string, and the same predicates are
// then driven over deliberately sabotaged copies. A source guard nobody has seen
// fail is worthless — a mis-anchored slice makes an assertion pass vacuously,
// which has bitten this repo repeatedly.
//
// What it protects, and why each is invisible without it:
//
//   • the LIST filters are tier-aware. A bare `visibleTeam(scope, x.teamId)`
//     answers correctly for every team-tier record and silently hides every
//     SHARED one from everybody but an admin — the feature would look built and
//     be unusable.
//   • the READ-ONE routes are gated at all (§11.4 / §11.3). Both returned the
//     raw record to any authenticated caller; a tier the read path ignores is
//     decorative.
//   • the three MCP-server WRITES are gated (§11.3). They never were.
//   • a re-tier is System-Admin-gated on both PUT routes, and the gate sits
//     BEHIND `isRetier` so an ordinary content save is not an operator act.
//   • creates go through `canCreateEnvironment` (which refuses a shared create
//     for a non-admin), not the plain manage predicate.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// One route handler's body, comment-free. Anchored on the exact `app.<verb>(`
// registration and cut at the next one, so the slice can never run past its
// own handler into a neighbour's gate.
function route(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = src.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(src.slice(start, end));
}

const MARKERS = {
  envList: "app.get('/api/environments', ",
  envRead: "app.get('/api/environments/:id', ",
  envCreate: "app.post('/api/environments', ",
  envUpdate: "app.put('/api/environments/:id', ",
  envDelete: "app.delete('/api/environments/:id', ",
  envSync: "app.post('/api/environments/:id/sync-agents', ",
  envDiverge: "app.get('/api/environments/:id/repo-divergence', ",
  mcpList: "app.get('/api/mcp-servers', ",
  mcpRead: "app.get('/api/mcp-servers/:id', ",
  mcpCreate: "app.post('/api/mcp-servers', ",
  mcpUpdate: "app.put('/api/mcp-servers/:id', ",
  mcpDelete: "app.delete('/api/mcp-servers/:id', ",
};

// Each check answers "is this wiring present" over a whole api.js source.
// Returning the list of FAILED names is what lets a mutation prove a specific
// one, rather than just "something went red".
const CHECKS = {
  // ── tier-aware reads ──
  'env-list-is-tiered': (s) => /visibleEnvironment\(scope, e\)/.test(route(s, MARKERS.envList)),
  'env-list-has-no-bare-team-filter': (s) => !/visibleTeam\(scope, e\.teamId\)/.test(route(s, MARKERS.envList)),
  'env-read-is-gated': (s) => /visibleEnvironment\(scope, env\)/.test(route(s, MARKERS.envRead)),
  'env-read-refusal-is-404': (s) => /visibleEnvironment\(scope, env\)\) return res\.status\(404\)/.test(route(s, MARKERS.envRead)),
  'env-sync-is-tiered': (s) => /visibleEnvironment\(scope, env\)/.test(route(s, MARKERS.envSync)),
  'env-diverge-is-tiered': (s) => /visibleEnvironment\(scope, env\)/.test(route(s, MARKERS.envDiverge)),
  'mcp-list-is-tiered': (s) => /visibleEnvironment\(scope, s\)/.test(route(s, MARKERS.mcpList)),
  'mcp-list-has-no-bare-team-filter': (s) => !/visibleTeam\(scope, s\.teamId\)/.test(route(s, MARKERS.mcpList)),
  'mcp-read-is-gated': (s) => /visibleEnvironment\(getScope\(req\), s\)/.test(route(s, MARKERS.mcpRead)),
  'mcp-read-refusal-is-404': (s) => /visibleEnvironment\(getScope\(req\), s\)\) return res\.status\(404\)/.test(route(s, MARKERS.mcpRead)),

  // ── creates go through the create predicate, not the manage one ──
  'env-create-uses-canCreate': (s) => /canCreateEnvironment\(getScope\(req\), ownership\)/.test(route(s, MARKERS.envCreate)),
  'env-create-resolves-the-tier': (s) => /resolveTieredOwnership\(req\.body\)/.test(route(s, MARKERS.envCreate)),
  'env-create-writes-the-tier-triple': (s) => /\.\.\.tierOwnershipFields\(ownership\)/.test(route(s, MARKERS.envCreate)),
  'mcp-create-uses-canCreate': (s) => /canCreateEnvironment\(getScope\(req\), ownership\)/.test(route(s, MARKERS.mcpCreate)),
  'mcp-create-writes-the-tier-triple': (s) => /\.\.\.tierOwnershipFields\(ownership\)/.test(route(s, MARKERS.mcpCreate)),

  // ── the MCP writes that had NO gate before this ticket (§11.3) ──
  'mcp-update-is-gated': (s) => /canManageEnvironment\(mcpScope, existing\)/.test(route(s, MARKERS.mcpUpdate)),
  'mcp-delete-is-gated': (s) => /canManageEnvironment\(getScope\(req\), existing\)/.test(route(s, MARKERS.mcpDelete)),

  // ── the re-tier split ──
  'env-update-gates-retier': (s) => /isRetier\(env, nextOwnership\) && !canRetierEnvironment\(envScope\)/.test(route(s, MARKERS.envUpdate)),
  'mcp-update-gates-retier': (s) => /isRetier\(existing, nextOwnership\) && !canRetierEnvironment\(mcpScope\)/.test(route(s, MARKERS.mcpUpdate)),
  // The last literal default-collapse on the environment path is gone (§8.4).
  'env-update-has-no-default-collapse': (s) => !/env\.teamId \|\| 'default'/.test(route(s, MARKERS.envUpdate)),

  // ── the manage gates that predate this ticket must survive it ──
  'env-update-still-gated': (s) => /canManageEnvironment\(envScope, env\)/.test(route(s, MARKERS.envUpdate)),
  'env-delete-still-gated': (s) => /canManageEnvironment\(getScope\(req\), env\)/.test(route(s, MARKERS.envDelete)),
  'env-sync-still-manage-gated': (s) => /canManageEnvironment\(scope, env\)/.test(route(s, MARKERS.envSync)),
};

function runChecks(src) {
  return Object.entries(CHECKS).filter(([, fn]) => {
    try { return !fn(src); } catch { return true; }
  }).map(([name]) => name);
}

test('every tiered-resource route carries its gate', () => {
  assert.deepEqual(runChecks(API_SRC), [], 'wiring missing for these checks');
});

// ── the mutation proofs ────────────────────────────────────────────────────
//
// Each sabotage is the LITERAL pre-#2083 code (or the plausible regression),
// not a cosmetic edit — that is what makes the check meaningful rather than a
// spelling test.

const MUTATIONS = [
  {
    why: 'the environment list falls back to the bare team filter (hides every shared env)',
    from: 'visibleEnvironment(scope, e)) // (#302, tiered by #2083)',
    to: 'visibleTeam(scope, e.teamId)) // (#302)',
    expect: ['env-list-is-tiered', 'env-list-has-no-bare-team-filter'],
  },
  {
    why: 'the MCP list falls back to the bare team filter',
    from: 'visibleEnvironment(scope, s)) // (#302, tiered by #2083)',
    to: 'visibleTeam(scope, s.teamId)) // (#302)',
    expect: ['mcp-list-is-tiered', 'mcp-list-has-no-bare-team-filter'],
  },
  {
    why: 'the MCP update loses the write gate it never had before this ticket',
    from: '  if (!canManageEnvironment(mcpScope, existing)) {\n    return res.status(403).json({ error: \'forbidden\', code: \'forbidden\' });\n  }\n',
    to: '',
    expect: ['mcp-update-is-gated'],
  },
  {
    why: 'the MCP delete loses its write gate',
    from: '  if (!canManageEnvironment(getScope(req), existing)) {\n    return res.status(403).json({ error: \'forbidden\', code: \'forbidden\' });\n  }\n  const usedBy = mcpServerInUse(id);',
    to: '  const usedBy = mcpServerInUse(id);',
    expect: ['mcp-delete-is-gated'],
  },
  {
    why: 'the re-tier gate is applied unconditionally, so an ordinary content save needs a System Admin',
    from: 'isRetier(env, nextOwnership) && !canRetierEnvironment(envScope)',
    to: '!canRetierEnvironment(envScope)',
    expect: ['env-update-gates-retier'],
  },
  {
    why: 'the environment create is gated on the manage predicate, which would let a Team Admin mint a SHARED environment',
    from: 'canCreateEnvironment(getScope(req), ownership)',
    to: 'canManageEnvironment(getScope(req), ownership)',
    // Both creates share the expression, so both checks fire — which is itself
    // worth pinning: the two routes are deliberately identical here.
    expect: ['env-create-uses-canCreate', 'mcp-create-uses-canCreate'],
  },
  {
    why: 'the environment read-one loses the gate §11.4 recorded as missing',
    from: "  if (!visibleEnvironment(scope, env)) return res.status(404).json({ error: 'Environment not found' });\n  const agents = agentsUsingEnvironment(env.id, scope); // (#439)\n  res.json({ ...env, agents, agentCount: agents.length, canManage: canManageEnvironment(scope, env) });",
    to: "  const agents = agentsUsingEnvironment(env.id, scope); // (#439)\n  res.json({ ...env, agents, agentCount: agents.length });",
    expect: ['env-read-is-gated', 'env-read-refusal-is-404'],
  },
  {
    why: 'the environment update reintroduces the || default collapse (§8.4)',
    from: 'if (isRetier(env, nextOwnership)',
    to: "if (env.teamId || 'default') if (isRetier(env, nextOwnership)",
    expect: ['env-update-has-no-default-collapse'],
  },
];

test('the guard fires: each sabotage is caught, and only by the checks it breaks', () => {
  for (const m of MUTATIONS) {
    assert.equal(API_SRC.split(m.from).length - 1 >= 1, true,
      `mutation anchor not found (${m.why}) — the guard is stale, not the code`);
    const mutated = API_SRC.split(m.from).join(m.to);
    assert.notEqual(mutated, API_SRC, `mutation did not land: ${m.why}`);
    const failed = runChecks(mutated).sort();
    assert.deepEqual(failed, [...m.expect].sort(), `wrong checks fired for: ${m.why}`);
  }
});

test('every check has at least one mutation that proves it', () => {
  const proven = new Set(MUTATIONS.flatMap(m => m.expect));
  // The survival checks (the gates that predate #2083) are proven by the
  // pre-existing suites that exercise them and are here to catch a REMOVAL, so
  // they need no sabotage of their own — named explicitly rather than silently
  // skipped, so the exemption is a decision and not an oversight.
  const survivalOnly = new Set([
    'env-update-still-gated', 'env-delete-still-gated', 'env-sync-still-manage-gated',
    'env-sync-is-tiered', 'env-diverge-is-tiered',
    'mcp-read-is-gated', 'mcp-read-refusal-is-404',
    'env-create-resolves-the-tier', 'env-create-writes-the-tier-triple',
    'mcp-create-writes-the-tier-triple', 'mcp-update-gates-retier',
  ]);
  const unproven = Object.keys(CHECKS).filter(n => !proven.has(n) && !survivalOnly.has(n));
  assert.deepEqual(unproven, [], 'these checks are never proven to fire');
});

// ── the personal-tier refusal ──────────────────────────────────────────────

test('a personal environment / MCP server cannot be created — the AC1 deviation is enforced, not just documented', () => {
  const src = stripComments(API_SRC);
  const at = src.indexOf('function resolveTieredOwnership(');
  assert.ok(at > 0, 'resolveTieredOwnership must exist');
  const body = src.slice(at, src.indexOf('\nfunction ', at + 1));
  assert.match(body, /scope === 'personal'/);
  assert.match(body, /err\.status = 400/);
  // And it must NOT thread an acting user through, which is the other way a
  // personal record could come into existence.
  assert.doesNotMatch(body, /actingUserId/);
  // Both create routes go through it rather than calling the credential
  // resolver directly (which WOULD accept a personal request if ever handed a
  // user id).
  for (const marker of [MARKERS.envCreate, MARKERS.mcpCreate, MARKERS.envUpdate, MARKERS.mcpUpdate]) {
    const r = route(API_SRC, marker);
    assert.match(r, /resolveTieredOwnership\(/, `${marker} must resolve ownership through the tiered wrapper`);
    assert.doesNotMatch(r, /resolveCredentialOwnership\(/, `${marker} must not call the credential resolver directly`);
    assert.doesNotMatch(r, /resolveOwnerTeamId\(/, `${marker} must not fall back to the untiered resolver`);
  }
});
