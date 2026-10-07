// Source-reading guards for the shared current team (#2850). The pages are
// JSX and stay uncovered per #651, so the wiring is read out of the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

test('Flow Control resolves its team through the shared helper, not teams[0]', () => {
  const src = read('FlowControl.jsx');
  assert.match(src, /resolveFlowControlTeam\(\{\s*urlTeam,\s*rememberedTeam:\s*readCurrentTeam\(username\),\s*teams\s*\}\)/);
  assert.match(src, /searchParams\.get\('team'\)/);
  assert.doesNotMatch(src, /setTeamId\(teams\[0\]\.id\)/);
});

test('a pick in Flow Control becomes the current team', () => {
  const src = read('FlowControl.jsx');
  assert.match(src, /writeCurrentTeam\(username, id\)/);
  assert.match(src, /<TeamPicker teams=\{teams\} value=\{teamId\} onChange=\{pickTeam\} \/>/);
});

test('Agent Chat records the routed subject\'s team as the current team', () => {
  const src = read('AgentChat.jsx');
  assert.match(src, /const routedTeamId = teamIdOfAgent\(routedAgent\);/);
  assert.match(src, /if \(routedTeamId\) writeCurrentTeam\(user\?\.username, routedTeamId\);/);
});
