'use strict';

// Run: node --test admin-console/api/tiered-resource-routes.test.js
//
// #2083 (epic #2076 P5) — the wiring guard for the tiered configuration
// resources: working environments and MCP servers. Extended by #2158 for the
// GLOBAL reach these two resource kinds gained on top of the shared tier.
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
//   • #2158: every one of the six read/visibility call sites also admits a
//     GLOBAL record (`isGlobalEnvironment`), and the four write routes resolve
//     `resolveEnvGlobalFlag` — a System-Admin-only gate independent of
//     `canManageEnvironment` — before writing the tier triple.

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

// A whitespace-insensitive "does this handler body contain this snippet"
// check — deliberately not a multi-line regex, so a harmless re-indent or an
// inserted intermediate statement cannot silently defeat the guard.
function has(body, snippet) {
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  return norm(body).includes(norm(snippet));
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
  'env-read-templates-bypass-tier-gate': (s) => has(route(s, MARKERS.envRead), 'if (!isTemplateEnvironment(env)) {'),
  'env-read-is-gated': (s) => /visibleEnvironment\(scope, env\)/.test(route(s, MARKERS.envRead)),
  'env-read-refusal-is-404': (s) => has(route(s, MARKERS.envRead), "!visibleEnvironment(scope, env)") && /res\.status\(404\)/.test(route(s, MARKERS.envRead)),
  'env-sync-is-tiered': (s) => /visibleEnvironment\(scope, env\)/.test(route(s, MARKERS.envSync)),
  'env-diverge-is-tiered': (s) => /visibleEnvironment\(scope, env\)/.test(route(s, MARKERS.envDiverge)),
  'mcp-list-is-tiered': (s) => /visibleEnvironment\(scope, s\)/.test(route(s, MARKERS.mcpList)),
  'mcp-list-has-no-bare-team-filter': (s) => !/visibleTeam\(scope, s\.teamId\)/.test(route(s, MARKERS.mcpList)),
  'mcp-read-is-gated': (s) => /visibleEnvironment\(getScope\(req\), s\)/.test(route(s, MARKERS.mcpRead)),
  'mcp-read-refusal-is-404': (s) => has(route(s, MARKERS.mcpRead), "!visibleEnvironment(getScope(req), s)") && /res\.status\(404\)/.test(route(s, MARKERS.mcpRead)),

  // ── creates go through the create predicate, not the manage one ──
  'env-create-uses-canCreate': (s) => /canCreateEnvironment\([\w.()]+, ownership\)/.test(route(s, MARKERS.envCreate)),
  'env-create-resolves-the-tier': (s) => /resolveTieredOwnership\(req\.body\)/.test(route(s, MARKERS.envCreate)),
  'env-create-writes-the-tier-triple': (s) => /\.\.\.tierOwnershipFields\(ownership\)/.test(route(s, MARKERS.envCreate)),
  'mcp-create-uses-canCreate': (s) => /canCreateEnvironment\([\w.()]+, ownership\)/.test(route(s, MARKERS.mcpCreate)),
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

  // ── #2170: a template is a copy source, never a live-shared binding — the
  //     ordinary list must exclude it regardless of tier, and the dedicated
  //     `?isTemplate=true` catalog view must select it by the SAME predicate ──
  'env-list-excludes-templates': (s) => has(route(s, MARKERS.envList), '!isTemplateEnvironment(e) && (visibleEnvironment(scope, e)'),
  'env-list-templates-view-uses-isTemplateEnvironment': (s) => has(route(s, MARKERS.envList), '? isTemplateEnvironment(e)'),

  // ── #2158: global reachability composed at exactly the six read/visibility
  //     call sites, on top of (never instead of) the #2083 tier check ──
  'env-list-is-global-aware': (s) => has(route(s, MARKERS.envList), 'visibleEnvironment(scope, e) || isGlobalEnvironment(e)'),
  'env-read-is-global-aware': (s) => has(route(s, MARKERS.envRead), '!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)'),
  'env-sync-is-global-aware': (s) => has(route(s, MARKERS.envSync), '!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)'),
  'env-diverge-is-global-aware': (s) => has(route(s, MARKERS.envDiverge), '!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)'),
  'mcp-list-is-global-aware': (s) => has(route(s, MARKERS.mcpList), 'visibleEnvironment(scope, s) || isGlobalEnvironment(s)'),
  'mcp-read-is-global-aware': (s) => has(route(s, MARKERS.mcpRead), '!visibleEnvironment(getScope(req), s) && !isGlobalEnvironment(s)'),
  // The MCP list projection derives the badge rather than echoing a raw flag
  // (AC8) — mirrors `publicEndpointView`'s `global: isGlobalProvider(ep)`.
  'mcp-list-derives-global-field': (s) => has(route(s, MARKERS.mcpList), 'global: isGlobalEnvironment(s)'),

  // ── #2158: publish/retract is resolved through `resolveEnvGlobalFlag` on
  //     every write route, and a global record is forced to the
  //     system-with-no-teams shape rather than trusting the body's own tier
  //     fields (AC1/AC4/AC6) ──
  'env-create-resolves-global-flag': (s) => /resolveEnvGlobalFlag\(\{/.test(route(s, MARKERS.envCreate)),
  'env-create-forces-system-tier-when-global': (s) => has(route(s, MARKERS.envCreate), "if (globalFlag.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };"),
  'env-update-resolves-global-flag': (s) => /resolveEnvGlobalFlag\(\{/.test(route(s, MARKERS.envUpdate)),
  'env-update-forces-system-tier-when-global': (s) => has(route(s, MARKERS.envUpdate), "const nextOwnership = { scope: 'system', teamId: null, assignedTeamIds: [] };"),
  'env-update-clears-global-when-not-global': (s) => has(route(s, MARKERS.envUpdate), 'else delete env.global;'),
  'mcp-create-resolves-global-flag': (s) => /resolveEnvGlobalFlag\(\{/.test(route(s, MARKERS.mcpCreate)),
  'mcp-create-forces-system-tier-when-global': (s) => has(route(s, MARKERS.mcpCreate), "if (globalFlag.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };"),
  // #2158 AC3a: PUT honours the flag (both directions) even though the MCP
  // *form* is create-only (decision 6) — retraction must never require
  // delete-and-recreate.
  'mcp-update-resolves-global-flag': (s) => /resolveEnvGlobalFlag\(\{/.test(route(s, MARKERS.mcpUpdate)),
  'mcp-update-clears-global-when-not-global': (s) => has(route(s, MARKERS.mcpUpdate), 'else delete merged.global;'),

  // ── #2158 AC9: a publish TRANSITION refuses an unusable bound provider ──
  'env-create-refuses-unusable-provider-on-publish': (s) => has(route(s, MARKERS.envCreate),
    'if (globalFlag.global) {\n    const providerRefusal = refuseGlobalEnvironmentUnusableProvider(llm.llmEndpointId);'),
  'env-update-refuses-unusable-provider-on-publish-transition': (s) =>
    has(route(s, MARKERS.envUpdate), 'globalFlag.global && env.global !== true')
    && has(route(s, MARKERS.envUpdate), 'refuseGlobalEnvironmentUnusableProvider(env.llmEndpointId)'),
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
// Each sabotage is the LITERAL pre-#2083/#2158 code (or the plausible
// regression), not a cosmetic edit — that is what makes the check meaningful
// rather than a spelling test.

const MUTATIONS = [
  {
    why: 'the environment list falls back to the bare team filter (hides every shared AND every global env, and stops excluding templates)',
    from: ': !isTemplateEnvironment(e) && (visibleEnvironment(scope, e) || isGlobalEnvironment(e)))',
    to: ': visibleTeam(scope, e.teamId))',
    expect: ['env-list-is-tiered', 'env-list-has-no-bare-team-filter', 'env-list-is-global-aware', 'env-list-excludes-templates'],
  },
  {
    why: 'the environment list forgets the global OR-clause (shared-but-tiered stays visible, global stops being reachable with no assignment)',
    from: ': !isTemplateEnvironment(e) && (visibleEnvironment(scope, e) || isGlobalEnvironment(e)))',
    to: ': !isTemplateEnvironment(e) && (visibleEnvironment(scope, e)))',
    expect: ['env-list-is-global-aware'],
  },
  {
    why: 'the environment list stops excluding templates (a curated copy source leaks into every team/agent picker)',
    from: ': !isTemplateEnvironment(e) && (visibleEnvironment(scope, e) || isGlobalEnvironment(e)))',
    to: ': (visibleEnvironment(scope, e) || isGlobalEnvironment(e)))',
    expect: ['env-list-excludes-templates'],
  },
  {
    why: 'the ?isTemplate=true catalog view stops actually filtering to templates (returns every environment to any authenticated caller)',
    from: '.filter(e => wantTemplates\n      ? isTemplateEnvironment(e)',
    to: '.filter(e => wantTemplates\n      ? true',
    expect: ['env-list-templates-view-uses-isTemplateEnvironment'],
  },
  {
    why: 'the MCP list falls back to the bare team filter',
    from: '.filter(s => visibleEnvironment(scope, s) || isGlobalEnvironment(s))',
    to: '.filter(s => visibleTeam(scope, s.teamId))',
    expect: ['mcp-list-is-tiered', 'mcp-list-has-no-bare-team-filter', 'mcp-list-is-global-aware'],
  },
  {
    why: 'the MCP list forgets the global OR-clause',
    from: '.filter(s => visibleEnvironment(scope, s) || isGlobalEnvironment(s))',
    to: '.filter(s => visibleEnvironment(scope, s))',
    expect: ['mcp-list-is-global-aware'],
  },
  {
    why: 'the MCP list projection echoes the raw flag instead of deriving it (AC8)',
    from: 'global: isGlobalEnvironment(s),',
    to: 'global: s.global === true,',
    expect: ['mcp-list-derives-global-field'],
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
    from: 'canCreateEnvironment(createScope, ownership)',
    to: 'canManageEnvironment(createScope, ownership)',
    expect: ['env-create-uses-canCreate'],
  },
  {
    why: 'the MCP create is gated on the manage predicate, which would let a Team Admin mint a SHARED MCP server',
    from: 'canCreateEnvironment(mcpCreateScope, ownership)',
    to: 'canManageEnvironment(mcpCreateScope, ownership)',
    expect: ['mcp-create-uses-canCreate'],
  },
  {
    why: 'the environment read-one loses the gate §11.4 recorded as missing',
    from: "if (!isTemplateEnvironment(env)) {\n    // #2083: this read was ungated (concept §11.4) — any authenticated caller\n    // could fetch any environment by id and read its repositories, its\n    // `githubTokenId` and its MCP references. A tier the read-one path ignores is\n    // decorative, so the gate lands with the tier. 404 rather than 403, matching\n    // `GET /api/llm-endpoints/:id`, so the route is not an existence oracle.\n    if (!visibleEnvironment(scope, env) && !isGlobalEnvironment(env)) {\n      return res.status(404).json({ error: 'Environment not found' });\n    }\n  }\n  const agents = agentsUsingEnvironment(env.id, scope); // (#439)\n  res.json({ ...env, agents, agentCount: agents.length, canManage: canManageEnvironment(scope, env) });",
    to: "const agents = agentsUsingEnvironment(env.id, scope); // (#439)\n  res.json({ ...env, agents, agentCount: agents.length });",
    expect: ['env-read-is-gated', 'env-read-refusal-is-404', 'env-read-is-global-aware', 'env-read-templates-bypass-tier-gate'],
  },
  {
    why: 'the environment read-one stops admitting a template regardless of tier (a curated catalog entry becomes unreadable by an ordinary team-creation picker)',
    from: 'if (!isTemplateEnvironment(env)) {',
    to: 'if (false) {',
    expect: ['env-read-templates-bypass-tier-gate'],
  },
  {
    why: 'the environment update reintroduces the || default collapse (§8.4)',
    from: 'if (globalFlag.global) {',
    to: "if (env.teamId || 'default') if (globalFlag.global) {",
    expect: ['env-update-has-no-default-collapse'],
  },
  {
    why: 'a global environment create no longer forces the system-with-no-teams shape, so a client-sent team tier survives alongside global:true',
    from: "if (globalFlag.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };\n\n  // #2170: the `isTemplate` flag",
    to: '  // #2170: the `isTemplate` flag',
    expect: ['env-create-forces-system-tier-when-global'],
  },
  {
    why: 'an MCP server create no longer forces the system-with-no-teams shape when global',
    from: "if (globalFlag.global) ownership = { scope: 'system', teamId: null, assignedTeamIds: [] };\n\n  if (!canCreateEnvironment(mcpCreateScope, ownership)) {",
    to: '  if (!canCreateEnvironment(mcpCreateScope, ownership)) {',
    expect: ['mcp-create-forces-system-tier-when-global'],
  },
  {
    why: 'an environment update no longer clears a retracted global flag, leaving a dangling global:false-shaped write path',
    from: 'if (globalFlag.global) env.global = true;\n  else delete env.global;',
    to: 'env.global = globalFlag.global;',
    expect: ['env-update-clears-global-when-not-global'],
  },
  {
    why: 'an MCP server update no longer clears a retracted global flag',
    from: 'if (mcpGlobalFlag.global) merged.global = true;\n  else delete merged.global;',
    to: 'merged.global = mcpGlobalFlag.global;',
    expect: ['mcp-update-clears-global-when-not-global'],
  },
  {
    why: 'publishing a global environment on create no longer refuses an unusable bound provider (AC9)',
    from: "if (globalFlag.global) {\n    const providerRefusal = refuseGlobalEnvironmentUnusableProvider(llm.llmEndpointId);",
    to: "if (false) {\n    const providerRefusal = refuseGlobalEnvironmentUnusableProvider(llm.llmEndpointId);",
    expect: ['env-create-refuses-unusable-provider-on-publish'],
  },
  {
    why: 'publishing a global environment via PUT no longer refuses an unusable bound provider on the transition',
    from: 'if (globalFlag.global && env.global !== true) {',
    to: 'if (false) {',
    expect: ['env-update-refuses-unusable-provider-on-publish-transition'],
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
  // The survival checks (the gates that predate #2083/#2158) are proven by the
  // pre-existing suites that exercise them and are here to catch a REMOVAL, so
  // they need no sabotage of their own — named explicitly rather than silently
  // skipped, so the exemption is a decision and not an oversight.
  const survivalOnly = new Set([
    'env-update-still-gated', 'env-delete-still-gated', 'env-sync-still-manage-gated',
    'env-sync-is-tiered', 'env-diverge-is-tiered',
    'mcp-read-is-gated', 'mcp-read-refusal-is-404',
    'env-create-resolves-the-tier', 'env-create-writes-the-tier-triple',
    'mcp-create-writes-the-tier-triple', 'mcp-update-gates-retier',
    'env-sync-is-global-aware', 'env-diverge-is-global-aware', 'mcp-read-is-global-aware',
    'env-create-resolves-global-flag', 'env-update-resolves-global-flag',
    'mcp-create-resolves-global-flag', 'mcp-update-resolves-global-flag',
    'env-update-forces-system-tier-when-global',
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

// ── #2169: an omitted ownership does not default to a picked team ──────────

test('an ownership-less create body resolves to an unassigned system tier, not the default-team fallback', () => {
  const src = stripComments(API_SRC);
  const at = src.indexOf('function resolveTieredOwnership(');
  assert.ok(at > 0, 'resolveTieredOwnership must exist');
  const body = src.slice(at, src.indexOf('\nfunction ', at + 1));
  // The environment/MCP-server forms no longer send scope/teamId/assignedTeamIds
  // at all (the CredentialOwnership picker is gone) — a body missing all three
  // must NOT fall through to resolveCredentialOwnership's bare-credential
  // default (resolveOwnerTeamId's implicit 'default' team).
  assert.match(body, /scope === undefined && b\.teamId === undefined && b\.assignedTeamIds === undefined/);
  assert.match(body, /scope: 'system', teamId: null, assignedTeamIds: \[\] \};/);
  // That early return must come BEFORE the fall-through call, not after.
  const guardAt = body.search(/scope === undefined && b\.teamId === undefined/);
  const fallThroughAt = body.search(/return resolveCredentialOwnership\(b\);/);
  assert.ok(guardAt > 0 && fallThroughAt > guardAt, 'the no-ownership guard must be checked before the generic resolver');
});

// ── #2158: the global rule lives ONLY in global-resource.js, composed at the
//    api.js call sites above — never inside resource-tier.js / scope.js's
//    generic credential predicates (AC4) ──

test('the global flag is not reintroduced into the generic tiered/credential modules', () => {
  const resourceTierSrc = fs.readFileSync(path.join(__dirname, 'resource-tier.js'), 'utf8');
  const scopeSrc = fs.readFileSync(path.join(__dirname, 'scope.js'), 'utf8');
  assert.doesNotMatch(stripComments(resourceTierSrc), /isGlobalEnvironment|global-resource/);
  // scope.js's `isGlobalProvider` import for the assist selector is the ONE
  // deliberate exception (#2136, provider-only) — the environment/MCP global
  // predicate must not appear there at all.
  assert.doesNotMatch(stripComments(scopeSrc), /isGlobalEnvironment|global-resource/);
});
