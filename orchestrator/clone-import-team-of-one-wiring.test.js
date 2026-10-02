'use strict';

// Drift guard for #2684: Clone and Import with no target team must land as a
// team of one, the same as every created agent (#2229/#2231) — a bare
// `role: 'agent'` never gets a rail row (#2234) and so no context menu.
//
// The decisions are unit-tested (`clone-target.test.js`, `team-conversion.test.js`);
// what those cannot see is the ORDER in the orchestrator: the `<id>-team`
// collision must be refused before anything is provisioned, and the fold must
// happen before the first container start so it boots as the member.
// `orchestrator.js` boots servers on require, so this reads its source (the
// same arrangement as `team-conversion-wiring.test.js`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** One method body, up to the next class member (or the class end). */
function method(name) {
  const start = SRC.indexOf(`  async ${name}(`);
  assert.ok(start > 0, `${name}() not found — this guard needs re-pointing`);
  const end = SRC.slice(start + 1).search(/\n  (async )?[a-zA-Z_]+\(|\n\}\n/);
  assert.ok(end > 0, `could not find the end of ${name}()`);
  return stripComments(SRC.slice(start, start + 1 + end));
}

function at(src, needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `expected to find ${JSON.stringify(needle)}`);
  return i;
}

test('the fold reuses the in-place conversion, forced, and never fails the import', () => {
  const src = method('_foldIntoTeamOfOne');
  assert.match(src, /await this\.convertAgentToTeam\(id, \{ force: true \}\)/);
  // A failed fold degrades to a warning, not a half-provisioned 500.
  assert.match(src, /catch \(err\)[\s\S]*return \{ teamId: null, warnings: \[/);
});

for (const [name, idVar, gate] of [
  ['importAgent', 'agentId', 'role === "agent"'],
  ['cloneAgent', 'newId', 'parentTeamId ? null :'],
]) {
  test(`${name}: a no-team target refuses a taken <id>-team before provisioning`, () => {
    const src = method(name);
    const clash = at(src, `teamOfOneIdConflict(${idVar}, isAgentIdTaken)`);
    assert.ok(clash < at(src, 'ensureMatrixUser('), 'the collision check must run before the Matrix user is minted');
    assert.ok(clash < at(src, 'fs.mkdirSync('), 'the collision check must run before the workspace is written');
  });

  test(`${name}: a no-team target is folded into a team of one before its first start`, () => {
    const src = method(name);
    const fold = at(src, `this._foldIntoTeamOfOne(${idVar})`);
    assert.match(src.slice(fold - 60, fold), new RegExp(gate.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&')));
    assert.ok(at(src, `saveAgentConfig(${idVar}, newConfig)`) < fold, 'the standalone config must exist before it is converted');
    assert.ok(fold < at(src, 'startAgentProcess(started)'), 'the first start must already see the member config');
    // Only one start — no standalone boot followed by a respawn.
    assert.equal((src.match(/startAgentProcess\(/g) || []).length, 1);
    // The response reports where the agent actually landed.
    assert.match(src, /parentTeamId: started\.parentTeamId \|\| null/);
    assert.match(src, /teamOfOne: !!\(fold && fold\.teamId\)/);
  });
}
