'use strict';

// Source-reading wiring guard for #2286: PUT /api/agents/:id's bulk Skills-tab
// save must route a TEAM agent's `skills[]` edit through the orchestrator (so
// it gets eagerly pushed to already-materialized members, mirroring how the
// systemPromptTemplate branch above it works), and the local on-disk write
// further down must no longer also apply to a team agent. api.js cannot be
// `require`d in a unit test (it boots Express and reaches for the
// orchestrator), so this reads the route's source — the same drift-guard
// technique member-materialize.test.js uses (#651). The actual diff/no-op
// logic (planTeamSkillsUpdate) is unit-tested directly in skill-grants.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The body of PUT /api/agents/:id, so a match elsewhere in api.js can't fool us. */
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

test('a team agent\'s skills[] edit is routed through the orchestrator, not written locally', () => {
  const route = code(putAgentRoute());
  assert.match(
    route,
    /if \(cfg\.role === 'team' && Array\.isArray\(skills\)\)[\s\S]{0,400}?\/internal\/teams\/\$\{encodeURIComponent\(id\)\}\/skills/,
    'a team-role PUT with a skills array must POST to /internal/teams/:id/skills',
  );
  // The later local write must exclude team role — the orchestrator call above
  // already wrote skills[] canonically for a team.
  assert.match(
    route,
    /if \(skills !== undefined && fresh\.role !== 'team-member' && fresh\.role !== 'team'\)/,
    'the local skills[] write must skip both team-member and team roles',
  );
});

test('the orchestrator call precedes the local-write block, and re-reads the config after', () => {
  const route = code(putAgentRoute());
  const orchestratorCallAt = route.indexOf("/internal/teams/${encodeURIComponent(id)}/skills");
  const freshReadAt = route.indexOf('const fresh = readJsonFile(cfgPath, cfg);');
  assert.ok(orchestratorCallAt > 0 && freshReadAt > orchestratorCallAt,
    'fresh must be (re-)read from disk AFTER the orchestrator has persisted the team skills write');
});

test('a non-team agent (standalone) still gets a plain local skills[] write', () => {
  const route = code(putAgentRoute());
  // The gating condition on the orchestrator branch is role-specific, so a
  // standalone/team-member agent's request never calls the orchestrator...
  assert.match(route, /if \(cfg\.role === 'team' && Array\.isArray\(skills\)\)/);
  // ...and falls through to the local write, unaffected by this ticket beyond
  // the added `fresh.role !== 'team'` exclusion (already asserted above).
  assert.match(route, /fresh\.skills = Array\.isArray\(skills\)/);
});

test('an orchestrator failure/unreachability on the skills call short-circuits the request', () => {
  const route = code(putAgentRoute());
  const start = route.indexOf("/internal/teams/${encodeURIComponent(id)}/skills");
  assert.ok(start > 0);
  const nearby = route.slice(start, start + 500);
  assert.match(nearby, /if \(!resp\.ok\) return res\.status\(resp\.status\)\.json\(data\);/);
  assert.match(nearby, /catch \(err\) \{\s*return res\.status\(502\)/);
});
