'use strict';

// Drift guard for `Orchestrator.createTeamOfOneAgent()` and its `/internal/agents`
// dispatch (#2231, Phase B of #2229).
//
// The target-shape decisions (derived team id, legacy-exclusive prompt shape,
// member-shape grant) are the SAME pure core `convertAgentToTeam` uses
// (`team-conversion.js`, covered by `team-conversion.test.js` as real unit
// tests). What those cannot see is the orchestrator's own wiring: that the
// route actually dispatches here instead of `createAgent` for the three
// creation fast lanes, that both the team record and the member are written,
// and that a `<id>-team` collision surfaces as a named 409 rather than a
// generic 500.
//
// `orchestrator.js` boots two HTTP servers on require, so it cannot be loaded
// in a unit test (the `team-conversion-wiring.test.js` technique — these
// assertions read its source instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice out one class method's body, from its opening line to the next `  async ` sibling. */
function method(name, endNeedle) {
  const start = SRC.indexOf(`  async ${name}(`);
  assert.ok(start > 0, `${name}() not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endNeedle, start + 1);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return stripComments(SRC.slice(start, end));
}

const createTeamOfOne = () => method('createTeamOfOneAgent', '\n  // Update a team');

/** Index of a substring inside a slice, asserted to exist. */
function at(src, needle, label) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `expected to find ${JSON.stringify(needle)}${label ? ` (${label})` : ''}`);
  return i;
}

test('the target shape comes from the shared Phase-A core, not from inline logic', () => {
  assert.match(SRC, /require\("\.\/team-conversion"\)/);
  assert.match(SRC, /planTeamOfOneCreation/);
  const src = createTeamOfOne();
  assert.match(src, /planTeamOfOneCreation\(\{/);
  // No second copy of the derived-id convention.
  assert.doesNotMatch(src, /\$\{[^}]*\}-team/);
});

test('the base/autoId contract is honoured before the plan is built', () => {
  const src = createTeamOfOne();
  assert.match(src, /if \(extra\.autoId\) \{\s*\n\s*id = this\.resolveAndReserveAgentId\(baseId\);/);
  const autoId = at(src, 'extra.autoId');
  const plan = at(src, 'planTeamOfOneCreation({');
  assert.ok(autoId < plan, 'the id must be resolved before the plan derives the team id from it');
});

test('a derived team-id collision is a named, distinguishable error', () => {
  const src = createTeamOfOne();
  assert.match(src, /catch \(err\) \{[\s\S]{0,200}?err\.code = err\.code \|\| "team-id-taken";/);
});

test('the team record is written before the member is materialized', () => {
  const src = createTeamOfOne();
  const teamWrite = at(src, 'saveAgentConfig(plan.teamId, plan.teamConfig)');
  const matrixUser = at(src, 'ensureMatrixUser(this.adminClient, id, password)');
  const memberWrite = at(src, 'saveAgentConfig(id, memberConfig)');
  assert.ok(teamWrite < matrixUser, 'the team metadata record must exist before the member Matrix identity is minted');
  assert.ok(matrixUser < memberWrite);
});

test('the member config is built from the plan patch, never role:"agent"', () => {
  const src = createTeamOfOne();
  assert.match(src, /\.\.\.plan\.memberPatch,/);
  assert.doesNotMatch(src, /role:\s*["']agent["']/, 'createTeamOfOneAgent must never write a standalone agent role');
  assert.match(src, /saveAgentPrompt\(id, plan\.effectivePrompt, "team-member", env\)/);
});

test('the response names both the member id and its team id', () => {
  const src = createTeamOfOne();
  assert.match(src, /return \{\s*\n\s*id,\s*\n\s*teamId: plan\.teamId,/);
});

/* ── the internal route ─────────────────────────────────────────────────── */

test('mintTeamOfOne is in the destructured whitelist, alongside autoId', () => {
  const start = SRC.indexOf("if (req.method !== 'POST' || req.url !== '/internal/agents')");
  const end = SRC.indexOf('\n      } catch (err) {', start);
  const src = stripComments(SRC.slice(start, end));
  assert.match(src, /mintTeamOfOne,\s*\n\s*autoId,\s*\n\s*\} = JSON\.parse\(body\);/);
});

test('the route dispatches to createTeamOfOneAgent only for role:"agent" with mintTeamOfOne', () => {
  const start = SRC.indexOf("if (req.method !== 'POST' || req.url !== '/internal/agents')");
  const end = SRC.indexOf('\n      } catch (err) {', start);
  const src = stripComments(SRC.slice(start, end));
  assert.match(
    src,
    /const result = \(role === 'agent' && mintTeamOfOne === true\)\s*\n\s*\? await orchestrator\.createTeamOfOneAgent\(id, displayName, systemPrompt, environmentId, extra\)\s*\n\s*: await orchestrator\.createAgent\(id, displayName, role, systemPrompt, environmentId, extra\);/,
  );
});

test('team-id-taken is a named 409, checked before the generic 400/500 fallback', () => {
  const start = SRC.indexOf('Internal API create error');
  assert.ok(start > 0, 'the create-route catch block moved — re-point this guard');
  const body = SRC.slice(start, SRC.indexOf('res.end(JSON.stringify({ error: err.message }));', start) + 60);
  assert.match(body, /err\.code === 'team-id-taken'/);
  const idxTeamIdTaken = body.indexOf("err.code === 'team-id-taken'");
  const idxGenericFallback = body.indexOf('const isUserError');
  assert.ok(idxGenericFallback > idxTeamIdTaken, 'the named refusal must be checked before the generic 400/500 fallback');
});
