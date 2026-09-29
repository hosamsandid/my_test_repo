'use strict';

// Live-team Copilot history (#2556, AC11/AC16): the pure store + access rule,
// and a source-reading guard on the two routes (api.js cannot be imported in a
// unit test — same technique as pool-control-routes.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TEAM_COPILOT_HISTORY_FILE,
  copilotHistoryAccess,
  readTeamCopilotHistory,
  writeTeamCopilotHistory,
} = require('./team-copilot-history');
const { COPILOT_HISTORY_CAP } = require('./flow-copilot');

function tmpAgents() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hist-'));
  fs.mkdirSync(path.join(dir, 'acme'));
  return dir;
}
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

test('access: only a team agent, visible AND editable, gets the history (AC16)', () => {
  const team = { role: 'team' };
  assert.equal(copilotHistoryAccess({ teamCfg: team, visible: true, canEdit: true }), 'ok');
  assert.equal(copilotHistoryAccess({ teamCfg: team, visible: true, canEdit: false }), 'forbidden');
  assert.equal(copilotHistoryAccess({ teamCfg: team, visible: false, canEdit: false }), 'not-found');
  assert.equal(copilotHistoryAccess({ teamCfg: null, visible: true, canEdit: true }), 'not-found');
  assert.equal(copilotHistoryAccess({ teamCfg: { role: 'team-member' }, visible: true, canEdit: true }), 'not-found');
});

test('read: missing or malformed file reads as an empty history', () => {
  const dir = tmpAgents();
  assert.deepEqual(readTeamCopilotHistory(dir, 'acme'), []);
  fs.writeFileSync(path.join(dir, 'acme', TEAM_COPILOT_HISTORY_FILE), '{nope');
  assert.deepEqual(readTeamCopilotHistory(dir, 'acme'), []);
});

test('write → read round-trips through the #1071 sanitizer (whitelist, superseded, cap)', () => {
  const dir = tmpAgents();
  const messages = [];
  for (let i = 0; i < COPILOT_HISTORY_CAP + 5; i++) {
    messages.push({ role: 'user', content: `u${i}`, bundle: { secret: true } });
  }
  messages.push({ role: 'assistant', content: 'card', summary: 's', status: 'proposed', graph: {} });
  messages.push({ role: 'system', content: 'dropped' });
  const stored = writeTeamCopilotHistory(dir, 'acme', { messages }, writeJson);
  assert.equal(stored.length, COPILOT_HISTORY_CAP);
  const last = stored[stored.length - 1];
  assert.equal(last.status, 'superseded', 'an unreviewed card is never restored as live');
  assert.equal(last.graph, undefined, 'proposal payloads are not persisted');
  assert.ok(stored.every(m => m.bundle === undefined));
  assert.deepEqual(readTeamCopilotHistory(dir, 'acme'), stored);
});

test('write: a non-history body is refused and nothing is written', () => {
  const dir = tmpAgents();
  assert.equal(writeTeamCopilotHistory(dir, 'acme', { nope: 1 }, writeJson), null);
  assert.equal(fs.existsSync(path.join(dir, 'acme', TEAM_COPILOT_HISTORY_FILE)), false);
});

// ── route guard ──────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');

function slice(marker, len = 1500) {
  const start = SRC.indexOf(marker);
  assert.ok(start >= 0, `api.js should contain ${marker}`);
  return SRC.slice(start, start + len);
}

test('both history routes go through the gate; the gate uses the live-edit predicate', () => {
  const gate = slice('function teamCopilotHistoryGate(', 1200);
  assert.match(gate, /AGENT_ID_RE\.test\(teamId\)/);
  assert.match(gate, /canEdit: !!meta && canManageAgent\(scope, meta\)/);
  assert.match(gate, /visible: !!meta && visibleAgent\(scope, meta\)/);
  for (const verb of ['get', 'put']) {
    const body = slice(`app.${verb}('/api/teams/:teamId/copilot-history'`, 400);
    assert.match(body, /const teamId = teamCopilotHistoryGate\(req, res\);\s*if \(!teamId\) return;/);
  }
});

test('mutation-proved: a gate downgraded to visibility-only would fail the check above', () => {
  const gate = slice('function teamCopilotHistoryGate(', 1200);
  const buggy = gate.replace('canManageAgent(scope, meta)', 'visibleAgent(scope, meta)');
  assert.doesNotMatch(buggy, /canEdit: !!meta && canManageAgent\(scope, meta\)/);
});
