import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2619 unknown-agent deep-link notice (the #651
 * convention): the copy and state shape live in `agent-not-found.js`
 * (unit-tested), the wiring in `AgentChat.jsx`, which `node --test` cannot load.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const chat = fs.readFileSync(path.join(HERE, '../AgentChat.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the unknown-id bounce carries the requested id to /chats', () => {
  assert.match(chat, /navigate\('\/chats', \{ replace: true, state: agentNotFoundState\(agentId\) \}\);/);
});

test('/chats reads it back only while no agent is routed', () => {
  assert.match(chat, /const notFoundAgentId = agentId \? null : agentNotFoundFrom\(location\.state\);/);
});

test('the last-agent restore does not hop away from the notice', () => {
  assert.match(chat, /if \(loading \|\| agentId\) return;[\s\S]{0,200}if \(notFoundAgentId\) return;/);
});

test('the empty state shows the not-found copy, after the reveal/stub copy', () => {
  assert.match(chat, /notFoundAgentId=\{notFoundAgentId\}/);
  assert.match(chat, /revealEmptyStateCopy\(\{ waiting: waitingForNewAgent, stubAgent, materializingAgent \}\)\s*\|\| \(notFoundAgentId \? agentNotFoundCopy\(notFoundAgentId\) : null\)/);
});
