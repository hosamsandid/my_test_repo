import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2521 reveal-on-arrival wiring (the #651 convention):
 * the decisions live in `reveal-agent.js` (unit-tested), the wiring in
 * `AgentChat.jsx` / `AgentList.jsx`, which `node --test` cannot load.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = rel => fs.readFileSync(path.join(HERE, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const chat = code('../AgentChat.jsx');
const list = code('AgentList.jsx');

test('the reveal target comes from router state for the routed id only', () => {
  assert.match(chat, /const revealId = revealTargetFrom\(location\.state, agentId\);/);
});

test('edge case — a not-yet-listed new agent holds the unknown-id bounce, with bounded retries', () => {
  assert.match(chat, /const awaitingReveal = isAwaitingReveal\(revealId, agents, revealExpiredFor\);/);
  assert.match(chat, /if \(awaitingReveal\) return;\s*navigate\('\/chats', \{ replace: true \}\);/);
  assert.match(chat, /setInterval\(\(\) => \{ refetch\(\); \}, REVEAL_RETRY_MS\)/);
  assert.match(chat, /setTimeout\(\(\) => setRevealExpiredFor\(revealId\), REVEAL_WAIT_MS\)/);
});

test('AC2 — on arrival a hiding filter is dropped, the list is asked to reveal, the state is consumed', () => {
  assert.match(chat, /revealPlan\(routedAgent, listFilter\)/);
  assert.match(chat, /if \(resetFilter\) setListFilter\(\{ kind: 'all' \}\);/);
  assert.match(chat, /setRevealRequest\(\{ id: revealId, ts: Date\.now\(\) \}\);/);
  assert.match(chat, /navigate\(`\$\{location\.pathname\}\$\{location\.search\}`, \{ replace: true, state: null \}\);/);
  assert.match(chat, /revealRequest=\{revealRequest\}/);
});

test('AC6 — the chat pane explains a stub / a pending agent instead of "pick an agent"', () => {
  assert.match(chat, /waitingForNewAgent=\{awaitingReveal\}/);
  assert.match(chat, /stubAgent=\{routedAgent && agentState\(routedAgent\) === 'stub' \? routedAgent : null\}/);
  assert.match(chat, /revealEmptyStateCopy\(\{ waiting: waitingForNewAgent, stubAgent \}\)/);
});

test('AC2 — the list expands the team group, opens the stub section and scrolls the row', () => {
  assert.match(list, /revealRequest = null,/);
  assert.match(list, /setCollapsedMap\(prev => \(prev\[key\] === true \? \{ \.\.\.prev, \[key\]: false \} : prev\)\);/);
  assert.match(list, /revealId=\{group\.id === revealTeamId \? revealId : null\}/);
  assert.match(list, /const holdsReveal = !!revealId && stubs\.some\(s => s\.id === revealId\);/);
  assert.match(list, /if \(reveal\) rowRef\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);/);
  // Every row family that can be a first agent carries the flag.
  assert.equal((list.match(/reveal=\{agent\.id === revealId\}/g) || []).length, 3);
});
