'use strict';

// Drift guard for `Orchestrator.convertAgentToTeam()` and its internal route (#2052).
//
// The decisions are covered by `team-conversion.test.js` as real unit tests.
// What those cannot see is the ORDER the orchestrator applies them in, and the
// order is where every remaining failure mode lives: a plugin scope torn down
// after the flip is torn down under the wrong id, a prompt rebuilt before the
// config write reads the pre-conversion config, and a team record written
// without a rollback leaves the half-converted state AC9 forbids.
//
// `orchestrator.js` boots two HTTP servers on require, so it cannot be loaded in
// a unit test (the same reason `admin-console/api/api.js` is guarded this way).
// These assertions read its source instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

/** Slice out one method body, so a match elsewhere in the 14k-line file can't fool us. */
function method(name) {
  const start = SRC.indexOf(`  async ${name}(`);
  assert.ok(start > 0, `${name}() not found — this guard needs re-pointing`);
  const end = SRC.indexOf('\n  // =====', start + 1);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return SRC.slice(start, end);
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const convert = () => stripComments(method('convertAgentToTeam'));

/** Index of a substring inside the method, asserted to exist. */
function at(src, needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `expected to find ${JSON.stringify(needle)} in convertAgentToTeam()`);
  return i;
}

test('the decisions come from the pure module, not from inline logic', () => {
  assert.match(SRC, /require\("\.\/team-conversion"\)/);
  const src = convert();
  assert.match(src, /assessConversionEligibility\(cfg\)/);
  assert.match(src, /planTeamConversion\(cfg, \{/);
  // No second copy of the derived id or of the eligibility rule.
  assert.doesNotMatch(src, /\$\{[^}]*\}-team/);
  assert.doesNotMatch(src, /cfg\.role !== ['"]agent['"]/);
});

test('AC9 — nothing is written before eligibility and the busy check have passed', () => {
  const src = convert();
  const eligibility = at(src, 'assessConversionEligibility(cfg)');
  const busy = at(src, 'agentBusyState(id)');
  const firstWrite = at(src, 'saveAgentConfig(plan.teamId');
  assert.ok(eligibility < busy, 'eligibility must be decided before the busy probe');
  assert.ok(busy < firstWrite, 'the busy probe must precede every write');
});

test('a mid-run agent is refused with the two-phase warning, unless forced', () => {
  const src = convert();
  assert.match(src, /convertAgentToTeam\(id, \{ force = false \} = \{\}\)/);
  assert.match(src, /if \(!force\) \{[\s\S]{0,200}?agentBusyState\(id\)/);
  // Same payload shape `disableAgent` returns, so the console can reuse its
  // drain/abort branching idiom rather than learn a second contract.
  assert.match(src, /return \{ id, warning: true, busy, activeTriggers \}/);
});

test('AC7 — the old plugin scope is reaped BEFORE the config flip', () => {
  const src = convert();
  const teardown = at(src, 'teardownAgentPluginScopes(id, cfg)');
  const flip = at(src, 'saveAgentConfig(plan.teamId');
  assert.ok(teardown < flip,
    'teardownScope mints a token for the OLD scope id — after the flip that id is gone');
  // And it is handed the pre-conversion config, which is what still resolves to
  // the old scope id.
  assert.match(src, /teardownAgentPluginScopes\(id, cfg\)/);
});

test('AC5/AC6 — the squad pools are populated before the agent points at them', () => {
  const src = convert();
  const skills = at(src, 'plan.skillPoolCopies');
  const knowledge = at(src, 'writeTeamKnowledgeOverrides(plan.teamId');
  const flip = at(src, 'saveAgentConfig(plan.teamId');
  assert.ok(skills < flip && knowledge < flip);
  // The knowledge config is only carried when the tenant actually has one —
  // writing an empty overrides file would create a config where there was none.
  assert.match(src, /loadTeamKnowledgeOverrides\(fromPoolTeamId\)/);
  assert.match(src, /Object\.keys\(knowledgeOverrides\)\.length > 0/);
});

test('AC5 — the tenant tier is identified by resolution, not by assumption', () => {
  const src = convert();
  // A global-pool skill must NOT be copied: it resolves identically either way,
  // and copying it would fork content every other team still shares.
  assert.match(src, /resolveSkillSourceDir\(name, fromPoolTeamId, \{ agentId: id \}\)/);
  assert.match(src, /src === path\.join\(teamSkillsDir\(fromPoolTeamId\), name\)/);
});

test('AC9 — a failed member write undoes the team record it just created', () => {
  const src = convert();
  assert.match(
    src,
    /saveAgentConfig\(plan\.teamId[\s\S]{0,300}?try \{[\s\S]{0,300}?saveAgentConfig\(id, memberConfig\)[\s\S]{0,400}?catch \(err\) \{[\s\S]{0,300}?rmSync\(agentDir\(plan\.teamId\)/,
  );
});

test('the prompt is rebuilt AFTER the config write, and the agent is brought back', () => {
  const src = convert();
  const memberWrite = at(src, 'saveAgentConfig(id, memberConfig)');
  const prompt = at(src, 'saveAgentPrompt(id, plan.effectivePrompt');
  const reseed = at(src, 'reseedAgent(id, [AGENT_PROMPT_FILENAME');
  const respawn = at(src, 'respawnAgent(id, { reason: "converted-to-team" })');
  // saveAgentPrompt re-reads the config to compose CLAUDE.md (skills, knowledge
  // digest ref) — before the write it would compose the standalone agent's.
  assert.ok(memberWrite < prompt, 'saveAgentPrompt must follow the member config write');
  assert.ok(prompt < reseed && reseed < respawn);
  assert.match(src, /saveAgentPrompt\(id, plan\.effectivePrompt, "team-member", env\)/);
});

test('a converted agent is never left stopped, and never left silently broken', () => {
  const src = convert();
  // Each best-effort step reports rather than swallows: a skill that could not
  // be copied is exactly the AC5 failure mode nobody must be told "done" about.
  assert.match(src, /warnings\.push\(/);
  assert.match(src, /\.\.\.\(warnings\.length \? \{ warnings \} : \{\}\)/);
});

/* ── the internal route ─────────────────────────────────────────────────── */

test('the route is registered ABOVE the catch-all POST /internal/agents', () => {
  const convertRoute = SRC.indexOf("/^\\/internal\\/agents\\/([^/]+)\\/convert-to-team$/");
  assert.ok(convertRoute > 0, 'convert-to-team route not found — this guard needs re-pointing');
  // That branch 404s anything it does not match, so a route declared after it is
  // unreachable no matter how correct its handler is.
  const catchAll = SRC.lastIndexOf("req.url !== '/internal/agents'");
  assert.ok(catchAll > 0, 'the POST /internal/agents branch moved — re-point this guard');
  assert.ok(convertRoute < catchAll, 'convert-to-team must be declared before the catch-all');
});

test('the route maps each refusal onto a status the console can act on', () => {
  const start = SRC.indexOf('const convertMatch = req.method');
  const src = stripComments(SRC.slice(start, SRC.indexOf('const cloneMatch = req.method', start)));
  // A busy refusal is a question (409 + warning), not a 500.
  assert.match(src, /result && result\.warning \? 409 : 200/);
  assert.match(src, /already taken/);
  assert.match(src, /cannot be converted\|Cannot derive/);
  assert.match(src, /force: parsed\.force === true/);
});
