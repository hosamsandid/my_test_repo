'use strict';

// #2971 — a team member's seeded copy of a team-tier skill must anchor its
// drift on the AGENT team's pool (parentTeamId), not on its human access-scope
// teamId. The helper is exercised against real dirs + the real drift resolver;
// api.js boots listeners on require (#651), so its wiring into the three
// Skills Registry routes (and the #750 graph overlay) is asserted on its source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { skillSourceTeamIdOf, seededCopyOrigin } = require('./skill-copy-origin');
const skillDrift = require('./skill-drift');
const skillManifest = require('./skill-manifest');

const SKILL = 'python-prefix-predicates';
const MEMBER = { id: 'uitest-speckit-lean-converger', role: 'team-member', teamId: 'default', parentTeamId: 'uitest-speckit-lean' };

test('skillSourceTeamIdOf: agent team (parentTeamId) first, else teamId', () => {
  assert.equal(skillSourceTeamIdOf(MEMBER), 'uitest-speckit-lean');
  assert.equal(skillSourceTeamIdOf({ teamId: 'acme' }), 'acme');
  assert.equal(skillSourceTeamIdOf({ teamId: 'acme', parentTeamId: '  ' }), 'acme');
  assert.equal(skillSourceTeamIdOf({}), undefined);
  assert.equal(skillSourceTeamIdOf(null), undefined);
});

test('seededCopyOrigin: team tier → agent team; global tier → no teamId; unseeded → null', () => {
  assert.deepEqual(seededCopyOrigin(MEMBER, { tier: 'team', contentHash: 'abc' }),
    { tier: 'team', teamId: 'uitest-speckit-lean', sourceHash: 'abc' });
  assert.deepEqual(seededCopyOrigin(MEMBER, { tier: 'global', contentHash: 'abc' }),
    { tier: 'global', teamId: undefined, sourceHash: 'abc' });
  assert.equal(seededCopyOrigin(MEMBER, undefined), null);
  assert.equal(seededCopyOrigin(MEMBER, {}), null);
});

// Mirrors api.js resolveSkillSourceDir for the team tier: /workspace/teams/<teamId>/skills/<name>.
function driftFor(workspace, cfg, seeded, copyDir) {
  const origin = seededCopyOrigin(cfg, seeded);
  const sourceDir = path.join(workspace, 'teams', String(origin.teamId), 'skills', SKILL);
  const { state } = skillDrift.copyDriftState({ copyDir, sourceHash: origin.sourceHash, sourceDir });
  return { state, resyncable: skillManifest.isResyncable(state) };
}

test('member whose teamId differs from parentTeamId: copy is in-sync (not orphaned), then outdated + resyncable after a source edit', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-copy-origin-'));
  try {
    const src = path.join(ws, 'teams', 'uitest-speckit-lean', 'skills', SKILL);
    const copy = path.join(ws, 'agents', MEMBER.id, 'skills', SKILL);
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(copy, { recursive: true });
    const body = `---\nname: ${SKILL}\n---\nbody\n`;
    fs.writeFileSync(path.join(src, 'SKILL.md'), body);
    fs.writeFileSync(path.join(copy, 'SKILL.md'), body);
    const seeded = { tier: 'team', contentHash: skillManifest.hashSkillDir(src) };

    // The pre-fix lookup (human tenant) found no source → orphaned.
    const legacy = { tier: 'team', teamId: MEMBER.teamId, sourceHash: seeded.contentHash };
    const legacyDir = path.join(ws, 'teams', legacy.teamId, 'skills', SKILL);
    assert.equal(skillDrift.copyDriftState({ copyDir: copy, sourceHash: legacy.sourceHash, sourceDir: legacyDir }).state, 'orphaned');

    assert.deepEqual(driftFor(ws, MEMBER, seeded, copy), { state: 'in-sync', resyncable: false });

    fs.writeFileSync(path.join(src, 'SKILL.md'), body + 'edited\n');
    const after = driftFor(ws, MEMBER, seeded, copy);
    assert.equal(after.state, 'outdated');
    assert.equal(after.resyncable, true);
    assert.equal(skillDrift.resyncDecision(after.state), 'resync');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── api.js wiring ───────────────────────────────────────────────────────────
const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function block(marker, endMarker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf(endMarker, start + 1);
  assert.ok(end > start, `could not find the end of ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

test('all three Skills Registry routes + the graph overlay build the seeded origin with the shared helper', () => {
  const sites = {
    'GET /api/skills': block("app.get('/api/skills', ", '\napp.'),
    gatherSkillCopies: block('\nfunction gatherSkillCopies(', '\n}\n'),
    'GET /api/agents/:id/private-skills': block("app.get('/api/agents/:id/private-skills'", '\n});\n'),
  };
  for (const [label, src] of Object.entries(sites)) {
    assert.match(src, /seededCopyOrigin\(cfg, seeded\)/, `${label} must use seededCopyOrigin`);
  }
  assert.match(stripComments(API_SRC), /seededCopyOrigin\(m, seededEntry\)/, 'graph overlay must use the same helper');
  assert.doesNotMatch(stripComments(API_SRC), /tier === 'team' \? cfg\.teamId/, 'no team-tier origin may be keyed on the human teamId');
});

test('GET /api/skills: team-row downstream is bucketed and read under the same (agent team) key', () => {
  const src = block("app.get('/api/skills', ", '\napp.');
  assert.match(src, /pushDrift\(agentDriftByNameTeam\.get\(name\), skillSourceTeamIdOf\(cfg\), /);
  assert.match(src, /agentDriftByNameTeam\.get\(row\.name\)\?\.get\(row\.teamId\)/);
});
