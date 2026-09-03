'use strict';

// Guards the BriefingPack removal in the orchestrator service (#1962, epic #1961).
//
// Two of this phase's acceptance criteria are about code that cannot be
// `require`d in a unit test — orchestrator.js boots the service, reaches for
// Matrix and libpod, and exports nothing:
//
//   AC2 — `orchestrator` is no longer a valid role for agent creation, and
//         nothing in the server code creates a `bp-instance`.
//   AC3 — stub materialization for `team-member` is UNCHANGED and provably
//         still works. This is the single most dangerous line in the phase:
//         `enableAgent`'s stub gate accepted `bp-instance` AND `team-member`,
//         and only the first arm was allowed to go. Deferred team
//         materialization (#1955/#1957/#1958) depends on the second.
//   AC4 — a configuration with an unknown role is skipped at startup without
//         an error and without repeated log noise.
//
// So this reads the source, the same drift-guard technique the src-side
// `*-wiring.test.js` files use for JSX (#651). Two things it is careful about:
//
//   • Comments in orchestrator.js now discuss `bp-instance` / `orchestrator`
//     at length (naming what was removed and why is the point), so every
//     assertion runs on a COMMENT-STRIPPED slice — otherwise a removal guard
//     would fail on its own explanation.
//   • Assertions are anchored on the surrounding call SEQUENCE, not on a
//     statement in isolation, because this is a 14k-line file with several
//     sibling handlers of the same shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

/**
 * Comments name the very feature under test — strip them before asserting.
 *
 * Deliberately line-oriented rather than a general comment parser. A naive
 * `/\/\*[\s\S]*?\*\//` sweep is wrong on this file: it treats the `/*` inside a
 * route regex literal (`req.url.match(/^\/internal\/...\/*`-shaped patterns)
 * as the start of a block comment and swallows hundreds of lines of real code,
 * which silently makes every `doesNotMatch` assertion below pass for the wrong
 * reason. Only comments that OWN their line — plus a trailing `// …` after
 * whitespace, which can never be a URL because those are preceded by `:` —
 * are removed, and that is exactly where the BP prose lives.
 */
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')   // whole-line // comments
    .replace(/^[ \t]*\*[^\n]*$/gm, '')      // continuation lines of /* … */ blocks
    .replace(/^[ \t]*\/\*[^\n]*$/gm, '')    // opening line of a /* … */ block
    .replace(/[ \t]\/\/[^\n]*$/gm, '');     // trailing comments
}

/** Slice from `marker` to `endMarker` so a match elsewhere can't fool us. */
function slice(marker, endMarker) {
  const start = SRC.indexOf(marker);
  assert.ok(start > 0, `'${marker}' not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endMarker, start + marker.length);
  assert.ok(end > start, `end marker '${endMarker}' not found after '${marker}'`);
  return stripComments(SRC.slice(start, end));
}

const CODE = stripComments(SRC);

// ---- AC3: team-member stub materialization still works ----------------------

const enableAgent = () => slice('  async enableAgent(id) {', '\n  async disableAgent(');

test('AC3: enableAgent still accepts a team-member stub, and only that role', () => {
  const src = enableAgent();
  // The gate itself: exactly one role admitted.
  assert.match(src, /if \(cfg\.role !== "team-member"\) \{/);
  // …and the BP arm is gone from it. Narrow on purpose: a bare
  // /bp-instance/ check would also match the surrounding explanation if the
  // comment strip ever regressed, and a bare /!== "bp-instance"/ would not
  // catch it being re-added as an `||` alternative.
  assert.doesNotMatch(src, /bp-instance/);
});

test('AC3: the materialization sequence a deferred member depends on is intact', () => {
  const src = enableAgent();
  // Ordered: Matrix user → token → display name → workspace seed → save config
  // → prompt → in-memory config → spawn. Asserted as a sequence rather than as
  // individual statements, because losing the ORDER is the failure mode that
  // would leave a member half-built.
  const order = [
    /ensureMatrixUser\(this\.adminClient, id, password\)/,
    /loginMatrixUser\(id, password, this\.adminClient\)/,
    /setDisplayName\(token, userId, cfg\.displayName\)/,
    /seedAgentWorkspace\(id, env, \{/,
    /saveAgentConfig\(id, updated\)/,
    /saveAgentPrompt\(id, prompt, "team-member", env\)/,
    /this\.agentConfigs\.set\(id, \{ config: updated \}\)/,
    /startAgentProcess\(updated\)/,
  ];
  let cursor = 0;
  for (const re of order) {
    const rest = src.slice(cursor);
    const m = rest.match(re);
    assert.ok(m, `enableAgent lost (or reordered) ${re}`);
    cursor += m.index + m[0].length;
  }
});

test('AC3: the member prompt still resolves override-then-inherit, and the grant is still resolved', () => {
  const src = enableAgent();
  // #1958's contract: the member's own systemPrompt wins; absent, fall back to
  // the parent team's template (that absence IS the inherit signal).
  assert.match(src, /cfg\.systemPrompt === 'string' && cfg\.systemPrompt\.length > 0/);
  assert.match(src, /prompt = teamCfg\?\.systemPromptTemplate \|\| ""/);
  assert.match(src, /cfg\.parentTeamId \? loadAgentConfig\(cfg\.parentTeamId\) : null/);
  // The team-owned skill grant is still resolved through the shared helper
  // rather than read off the stub directly.
  assert.match(src, /skills: effectiveSkills\(cfg, loadAgentConfig\)/);
  // The already-materialized fast path (flip enabled + respawn) is untouched.
  assert.match(src, /if \(cfg\.token\) \{/);
  assert.match(src, /return \{ id, materialized: false, enabled: true \};/);
});

// ---- AC2: the role can no longer be created --------------------------------

test('AC2: the create role whitelist admits only agent and team', () => {
  const gate = slice("        if (!['agent', 'team'].includes(role)) {", 'systemPrompt required');
  assert.match(gate, /Must be one of: agent, team/);
  // The whole file: no role whitelist anywhere still lists orchestrator.
  assert.doesNotMatch(CODE, /\[['"]agent['"], ['"]orchestrator['"]/);
});

test('AC2: nothing in the service writes a bp-instance or an orchestrator role', () => {
  // A role assignment/comparison of either retired name would show up as a
  // quoted literal. `handoverCandidates` is the one deliberate exception —
  // retained-but-unreachable per epic decision R4 (#1968) — so it is excluded
  // by slicing it out rather than by loosening the pattern.
  const handoverStart = CODE.indexOf('  async handoverCandidates(id) {');
  assert.ok(handoverStart > 0, 'handoverCandidates is retained by R4 — it must still be here');
  const handoverEnd = CODE.indexOf('\n  _assertNotLockedByTeam(', handoverStart);
  assert.ok(handoverEnd > handoverStart);
  const withoutHandover = CODE.slice(0, handoverStart) + CODE.slice(handoverEnd);

  assert.doesNotMatch(withoutHandover, /["']bp-instance["']/);
  assert.doesNotMatch(withoutHandover, /["']orchestrator["']/);
});

test('AC2/AC6: no BriefingPack scanning, claim or event-routing helper survives', () => {
  for (const gone of [
    'syncBpStubs',
    'runClaimTick',
    'routeBpEvents',
    '_applyBpTriggerPolicy',
    'fetchBriefingPacks',
    'loadBriefingsGraphFromExplorer',
    'pullOrchestratorWorkspace',
    'materializeOrchestrator',
    'claimAgent',
    'patchBriefForClaim',
    'enqueueBpEventBatch',
    'ensureEngineeringSkill',
    'BP_EXPLORER_URL',
    'bpInstanceSystemPrompt',
    'defaultSystemPromptFor',
  ]) {
    assert.doesNotMatch(CODE, new RegExp(gone), `${gone} should be gone from orchestrator.js`);
  }
  // …and neither of the two deleted modules is required any more.
  assert.doesNotMatch(CODE, /require\("\.\/bp-event-router"\)/);
  assert.doesNotMatch(CODE, /require\("\.\/briefings-graph"\)/);
  for (const file of ['bp-event-router.js', 'briefings-graph.js', 'git-workspace.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, file)), false, `${file} should be deleted`);
  }
});

test('AC1: the BriefingPack routes are gone', () => {
  for (const route of ['sync-bps', 'claim-tick', '/internal/bp-events']) {
    assert.doesNotMatch(CODE, new RegExp(route.replace(/\//g, '\\/')), `route ${route} should be gone`);
  }
  // The BP claim endpoint. Anchored on the route matcher rather than on the
  // bare word "claim", which legitimately appears in the label-claim machinery.
  assert.doesNotMatch(CODE, /\\\/internal\\\/agents\\\/\(\[\^\/\]\+\)\\\/claim\$/);
});

// ---- AC4: an unknown role is skipped at startup, quietly -------------------

test('AC4: startAllEnabledAgents skips an unsupported role before spawning', () => {
  const src = slice('async function startAllEnabledAgents() {', '\n// =====');
  // The eviction still runs FIRST — that is what stops a leftover mission
  // container; the skip below is what stops it being recreated.
  const evictAt = src.indexOf('await evictStaleAgentContainers();');
  const gateAt = src.indexOf('if (!isSupportedAgentRole(config.role)) {');
  const spawnAt = src.indexOf('startAgentProcess(config);');
  assert.ok(evictAt > 0, 'the boot eviction must still run');
  assert.ok(gateAt > evictAt, 'the role gate must sit after the eviction');
  assert.ok(spawnAt > gateAt, 'the role gate must sit BEFORE the spawn');
  // One line, then `continue` — not a throw, and not a per-tick logger.
  assert.match(src, /const note = unsupportedRoleNote\(id, config\.role\);[\s\S]{0,80}continue;/);
  assert.doesNotMatch(src, /throw/);
});

test('AC4: the startup migration loop that materialized orchestrators is gone', () => {
  const init = slice('  async init() {', '\n  async deactivateMatrixUser(');
  assert.doesNotMatch(init, /Migration failed for/);
  // Configs are still all loaded into memory — R2 leaves them on disk and the
  // boot summary still lists them.
  assert.match(init, /this\.agentConfigs\.set\(id, \{ config \}\)/);
  assert.match(init, /isSupportedAgentRole\(config\.role\)/);
});
