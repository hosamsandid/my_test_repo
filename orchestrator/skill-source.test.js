'use strict';

// Unit tests for two-tier skill resolution (#306).
// Run: node --test orchestrator/skill-source.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeSkillSourceResolver } = require('./skill-source');

const WS = '/workspace';
const TW = '/template-workspace';
const { agentSkillsDir, teamSkillsDir, resolveSkillSourceDir } = makeSkillSourceResolver({
  workspace: WS, templateWorkspace: TW, defaultTeamId: 'default',
});

// Fake existsSync over a set of present paths.
const fakeExists = (present) => (p) => present.has(p);

test('teamSkillsDir builds the per-team pool path', () => {
  assert.equal(teamSkillsDir('payments'), path.join(WS, 'teams', 'payments', 'skills'));
  assert.equal(teamSkillsDir(undefined), path.join(WS, 'teams', 'default', 'skills'));
});

test('team pool wins over global when both have the skill', () => {
  const teamPath = path.join(WS, 'teams', 'payments', 'skills', 'cobol');
  const globalPath = path.join(TW, 'skills', 'cobol');
  const r = resolveSkillSourceDir('cobol', 'payments', { existsSync: fakeExists(new Set([teamPath, globalPath])) });
  assert.equal(r, teamPath);
});

test('falls back to global when the team has no own copy (pre-#306 behaviour)', () => {
  const globalPath = path.join(TW, 'skills', 'jcl');
  const r = resolveSkillSourceDir('jcl', 'payments', { existsSync: fakeExists(new Set([globalPath])) });
  assert.equal(r, globalPath);
});

test('uses a team-only skill that has no global counterpart', () => {
  const teamPath = path.join(WS, 'teams', 'payments', 'skills', 'private-domain');
  const r = resolveSkillSourceDir('private-domain', 'payments', { existsSync: fakeExists(new Set([teamPath])) });
  assert.equal(r, teamPath);
});

test('another team does NOT see team-payments private skill — falls through to null', () => {
  const teamPath = path.join(WS, 'teams', 'payments', 'skills', 'private-domain');
  // Only the payments copy exists; resolving for team "risk" must not find it.
  const r = resolveSkillSourceDir('private-domain', 'risk', { existsSync: fakeExists(new Set([teamPath])) });
  assert.equal(r, null);
});

test('returns null when neither pool has the skill', () => {
  const r = resolveSkillSourceDir('nope', 'default', { existsSync: fakeExists(new Set()) });
  assert.equal(r, null);
});

test('default team resolves against /workspace/teams/default then global', () => {
  const globalPath = path.join(TW, 'skills', 'engineering');
  const r = resolveSkillSourceDir('engineering', 'default', { existsSync: fakeExists(new Set([globalPath])) });
  assert.equal(r, globalPath);
});

// --- Agent tier (Knowledge Flow, Phase 0) -----------------------------------

test('agentSkillsDir builds the per-agent pool path', () => {
  assert.equal(agentSkillsDir('cobol-agent'), path.join(WS, 'agents', 'cobol-agent', 'skills'));
});

test('agent pool wins over both team and global', () => {
  const agentPath = path.join(WS, 'agents', 'dev-1', 'skills', 'cobol');
  const teamPath = path.join(WS, 'teams', 'payments', 'skills', 'cobol');
  const globalPath = path.join(TW, 'skills', 'cobol');
  const r = resolveSkillSourceDir('cobol', 'payments', {
    agentId: 'dev-1',
    existsSync: fakeExists(new Set([agentPath, teamPath, globalPath])),
  });
  assert.equal(r, agentPath);
});

test('with agentId set but no agent copy, falls through to team then global', () => {
  const teamPath = path.join(WS, 'teams', 'payments', 'skills', 'cobol');
  const r = resolveSkillSourceDir('cobol', 'payments', {
    agentId: 'dev-1',
    existsSync: fakeExists(new Set([teamPath])),
  });
  assert.equal(r, teamPath);
});

test('an agent-private skill is invisible to another agent', () => {
  const agentPath = path.join(WS, 'agents', 'dev-1', 'skills', 'private');
  const r = resolveSkillSourceDir('private', 'payments', {
    agentId: 'dev-2',
    existsSync: fakeExists(new Set([agentPath])),
  });
  assert.equal(r, null);
});

test('omitting agentId reproduces the pre-Phase-0 two-tier behaviour', () => {
  const agentPath = path.join(WS, 'agents', 'dev-1', 'skills', 'cobol');
  const teamPath = path.join(WS, 'teams', 'payments', 'skills', 'cobol');
  // Even though an agent copy exists, without agentId it must not be considered.
  const r = resolveSkillSourceDir('cobol', 'payments', {
    existsSync: fakeExists(new Set([agentPath, teamPath])),
  });
  assert.equal(r, teamPath);
});
