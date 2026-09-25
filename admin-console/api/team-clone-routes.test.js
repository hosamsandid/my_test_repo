'use strict';

// Run: node --test admin-console/api/team-clone-routes.test.js
//
// #2171 (epic #2166 A5) — the wiring guard for the team-clone extension of
// `POST /api/environments`'s `copyFromTemplateId` mechanism (`copyFromTeamId`).
//
// api.js boots two listeners on require (#651), so the route cannot be driven
// with a real HTTP request here. This is the `tiered-resource-routes.test.js`
// source-reading shape: each check is a NAMED predicate over the route body,
// and every check is proven by a mutation that breaks exactly it — a guard
// nobody has seen fail is worthless.
//
// What it protects, and why each is invisible without it:
//
//   • the branch resolves the copy through `copyEnvironmentStructure` (the
//     same credential-stripping function #2170's template copy uses) rather
//     than spreading the source environment's own fields — the literal AC:
//     "no credential id from X appears on Y's environment".
//   • the source team must be `visibleAgent` to the caller before its
//     environment is read at all — otherwise a team you cannot even see
//     leaks its repository/MCP structure to you.
//   • an invalid clone source (missing, or not a `role: 'team'` agent) is
//     refused rather than silently producing an empty structure.
//   • the response tells the caller which credentials the clone still needs
//     (`describeClonedCredentialNeeds`), computed from the copied structure,
//     never from the source environment directly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function route(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = src.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(src.slice(start, end));
}

function has(body, snippet) {
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  return norm(body).includes(norm(snippet));
}

const MARKERS = {
  envCreate: "app.post('/api/environments', ",
};

const CHECKS = {
  'clone-branch-exists': (s) => has(route(s, MARKERS.envCreate), "req.body?.copyFromTeamId"),
  'clone-uses-copyEnvironmentStructure': (s) => has(route(s, MARKERS.envCreate), 'templateSeed = copyEnvironmentStructure(sourceEnv || {});'),
  'clone-checks-visibility-before-reading-env': (s) => {
    const body = route(s, MARKERS.envCreate);
    const visIdx = body.indexOf('visibleAgent(cloneScope, agentMetaForScope(sourceCfg))');
    const readIdx = body.indexOf('sourceCfg.environmentId ? loadEnvironment(sourceCfg.environmentId)');
    return visIdx > 0 && readIdx > visIdx;
  },
  'clone-validates-source-role': (s) => has(route(s, MARKERS.envCreate), "validateCloneSource(sourceCfg)"),
  'clone-response-carries-credentials-needed': (s) => has(route(s, MARKERS.envCreate), 'credentialsNeeded: describeClonedCredentialNeeds(templateSeed)'),
  // #2469: a clone is credential-stripped by design (#2171), so it can never
  // carry a GitHub token — the #2323 `checkGithubTokenRequirement` hard block
  // must NOT fire on the copyFromTeamId path. The guard call auto-acknowledges
  // a reference-only environment for a clone (`|| Boolean(clonedFromTeamId)`),
  // while leaving a genuine manual repo-backed create fully guarded.
  'clone-auto-acknowledges-github-token-requirement': (s) =>
    has(route(s, MARKERS.envCreate), 'acknowledgeNoToken: req.body?.acknowledgeNoToken || Boolean(clonedFromTeamId)'),
};

function runChecks(src) {
  return Object.entries(CHECKS).filter(([, fn]) => {
    try { return !fn(src); } catch { return true; }
  }).map(([name]) => name);
}

test('the team-clone extension of POST /api/environments carries every check', () => {
  assert.deepEqual(runChecks(API_SRC), [], 'wiring missing for these checks');
});

const MUTATIONS = [
  {
    why: 'the copyFromTeamId condition is silently renamed, so the branch never fires for the field the client actually sends',
    from: 'req.body?.copyFromTeamId',
    to: 'req.body?.copyFromTeamXId',
    expect: ['clone-branch-exists'],
  },
  {
    why: 'the clone spreads the raw source environment instead of stripping credentials through copyEnvironmentStructure',
    from: 'templateSeed = copyEnvironmentStructure(sourceEnv || {});',
    to: 'templateSeed = { ...(sourceEnv || {}) };',
    expect: ['clone-uses-copyEnvironmentStructure'],
  },
  {
    why: 'the visibility check is dropped, so a team the caller cannot see still leaks its environment structure',
    from: 'if (!sourceCfg || !visibleAgent(cloneScope, agentMetaForScope(sourceCfg))) {\n      return res.status(404).json({ error: `Team \'${sourceTeamId}\' not found` });\n    }',
    to: 'if (!sourceCfg) {\n      return res.status(404).json({ error: `Team \'${sourceTeamId}\' not found` });\n    }',
    expect: ['clone-checks-visibility-before-reading-env'],
  },
  {
    why: 'the source-role validation is dropped, so cloning from a standalone agent or a team-member silently produces a structure',
    from: 'const sourceValidity = validateCloneSource(sourceCfg);\n    if (sourceValidity.error === \'not-a-team\') {\n      return res.status(400).json({ error: `\'${sourceTeamId}\' is not an Agent Team`, code: \'not-a-team\' });\n    }',
    to: '',
    expect: ['clone-validates-source-role'],
  },
  {
    why: 'the response no longer tells the caller which credentials the clone still needs',
    from: 'res.status(201).json({ ...env, credentialsNeeded: describeClonedCredentialNeeds(templateSeed) });',
    to: 'res.status(201).json({ ...env });',
    expect: ['clone-response-carries-credentials-needed'],
  },
  {
    why: 'the clone-path auto-acknowledge is dropped, so #2323\'s github_token_required hard block fires on every credential-stripped clone (#2469)',
    from: 'acknowledgeNoToken: req.body?.acknowledgeNoToken || Boolean(clonedFromTeamId),',
    to: 'acknowledgeNoToken: req.body?.acknowledgeNoToken,',
    expect: ['clone-auto-acknowledges-github-token-requirement'],
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
  const unproven = Object.keys(CHECKS).filter(name => !proven.has(name));
  assert.deepEqual(unproven, [], 'checks with no mutation proof');
});
