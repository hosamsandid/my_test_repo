'use strict';

// Source-drift guard for the unified-access lifecycle sweep wiring inside
// `orchestrator.js` (epic #2361 PR5 #2358). The pure pieces are unit-tested
// (membership-sweep.test.js, credential-resolution.test.js); what neither can
// see is whether orchestrator.js actually (a) deletes personal MODEL PROVIDERS
// on offboarding (E2), (b) reconciles orphaned personal providers, and (c) runs
// the membership-removal binding sweep — gated behind the flag — on removal
// (E1). orchestrator.js boots HTTP listeners on require, so it cannot be
// imported; this reads its source (the acting-sender-wiring.test.js technique).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function region(openingLine, endNeedle, maxSpan = 4000) {
  const start = SRC.indexOf(openingLine);
  assert.ok(start > 0, `'${openingLine}' not found — re-point this guard`);
  const end = SRC.indexOf(endNeedle, start + openingLine.length);
  assert.ok(end > start, `end of '${openingLine}' not found`);
  const span = end - start;
  assert.ok(span <= maxSpan, `region '${openingLine}' is ${span} chars (> ${maxSpan})`);
  return SRC.slice(start, end);
}

// ── E2: offboarding deletes personal model providers ────────────────────────

test('offboardOwner deletes personal MODEL PROVIDERS as a third store (E2)', () => {
  const body = region('async offboardOwner(ownerId)', '\n  }\n', 2500);
  assert.match(body, /_deletePersonalCredentials\(loadSshKeyIndex\(\)/, 'still deletes personal SSH keys');
  assert.match(body, /_deletePersonalCredentials\(loadGithubTokenIndex\(\)/, 'still deletes personal GitHub tokens');
  // The new store: the provider index, keyed by authTokenId (NOT the endpoint id).
  assert.match(
    body,
    /_deletePersonalCredentials\(loadLlmEndpointsIndex\(\), LLM_ENDPOINTS_INDEX, LLM_KEYS_DIR, target, 'model-provider', \(e\) => e\.authTokenId\)/,
    'must delete personal model providers, unlinking by authTokenId',
  );
});

test('_deletePersonalCredentials takes a secret-name override (provider token file != id)', () => {
  const body = region('_deletePersonalCredentials(index, indexPath, secretDir, ownerId, kind, secretNameOf)', '\n  }\n', 1600);
  assert.match(body, /const nameOf = typeof secretNameOf === 'function' \? secretNameOf : \(e\) => e && e\.id;/);
  assert.match(body, /path\.basename\(String\(secretName\)\)/);
});

test('reconcileOrphanedOffboardings includes the provider index in detection and assessment', () => {
  const body = region('async reconcileOrphanedOffboardings(', 'if (dryRun) return', 2600);
  assert.match(body, /const llmEndpoints = loadLlmEndpointsIndex\(\);/);
  assert.match(body, /credentialIndexes: \[sshKeys, ghTokens, llmEndpoints\]/);
  assert.match(body, /\[llmEndpoints, 'model-provider'\]/);
});

// ── E1: membership-removal binding sweep, gated ─────────────────────────────

test('the memberships DELETE arm runs the sweep ONLY behind AEE_RESOURCE_ACCESS_V2, best-effort', () => {
  // maxSpan bumped 2200 → 2500 for #2360: the personal-oauth lend-block guard
  // (`personalOauthLendBlockOnMembershipAdd`) added to the sibling POST arm grew
  // this whole-route region to 2383 chars. The growth is legitimate and lives in
  // the POST arm, not the DELETE-arm sweep this guard asserts; 2500 matches the
  // offboardOwner region's budget. Refactor the route block if it grows further.
  const body = region("if (collection === 'memberships' && !resourceId)", 'sendJson(res, 404', 2500);
  // The removal happens first and unconditionally…
  assert.match(body, /const removed = teamsStore\.removeMembership\(/);
  // …then the sweep, gated by the flag AND the live singleton, in a try/catch so
  // a sweep failure never fails the (already-succeeded) removal.
  assert.match(body, /if \(RESOURCE_ACCESS_V2 && orchestratorSingleton\) \{/);
  assert.match(body, /sweep = await orchestratorSingleton\.sweepMembershipBindings\(memberTeamId, memberUserId\);/);
  assert.match(body, /\.\.\.\(sweep \? \{ sweep \} : \{\}\)/, 'the sweep summary rides along in the response when it ran');
});

test('sweepMembershipBindings resets bindings, respawns, keeps the resource, and logs', () => {
  const body = region('async sweepMembershipBindings(teamId, departedUserId)', '\n  _rawEnvPath(', 5000);
  // Enumerates the team's agents by the AGENT TEAM (squad) id — the membership space.
  assert.match(body, /resolveAgentTeam\(cfg\) !== team/);
  // Uses the pure planner + the personal-owner lookup + a CURRENT membership gate.
  assert.match(body, /membershipSweep\.planMembershipRemovalSweep\(/);
  assert.match(body, /membershipSweep\.buildPersonalOwnerLookup\(/);
  assert.match(body, /teamsStore\.listMemberships\(\{ teamId: tid, userId \}\)\.length > 0/);
  // Respawns the affected agents and records the sweep on the timeline.
  assert.match(body, /respawnAgentsForEnvironment\(envId, \{ reason: 'membership-removal-sweep' \}\)/);
  assert.match(body, /recordMembershipSweep\(team, departedUserId, envResets, agentResets\)/);
});

test('recordMembershipSweep is repo-less with empty outcomes (the null-agentId Event-Log hazard)', () => {
  const body = region('function recordMembershipSweep(', '\n}', 1600);
  assert.match(body, /repo: null,/);
  assert.match(body, /outcomes: \[\],/);
  assert.match(body, /source: 'internal',/);
  assert.match(body, /event: 'membership\.lend-sweep',/);
});
