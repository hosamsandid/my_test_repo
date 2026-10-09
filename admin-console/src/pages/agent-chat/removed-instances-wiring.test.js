import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2944 removed-instance archive wiring (the #651
 * convention): the decisions live in `removed-instance-view.js` and
 * `chat-event-message.js` (unit-tested), the wiring in the JSX, which
 * `node --test` cannot load.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = rel => fs.readFileSync(path.join(HERE, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const chat = code('../AgentChat.jsx');
const list = code('AgentList.jsx');
const view = code('ArchivedInstanceView.jsx');
const panel = code('ChatPanel.jsx');
const log = code('SessionLogPanel.jsx');

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found — re-point this guard`);
  const b = src.indexOf(to, a + from.length);
  return src.slice(a, b === -1 ? undefined : b);
}

test('AC3: the group is collapsed by default, persisted, and only for a role with archives', () => {
  assert.match(list, /archive: true,/);
  assert.match(list, /onOpenArchive && showRemovedInstances\(agent\) && \(\s*<RemovedInstancesSection/);
  assert.match(list, /isEntityCollapsed\(\{ kind: 'archive', id: agent\.id \}\)/);
});

test('AC3: a removed entry wears a badge, never a faded row', () => {
  const section = slice(list, 'function RemovedInstancesSection(', 'function CollapsibleHeader(');
  assert.doesNotMatch(section, /opacity:/);
  assert.match(section, />Removed</);
  assert.doesNotMatch(view, /opacity:/);
});

test('AC4: the archive replaces chat + right rail under the role route, read-only', () => {
  assert.match(chat, /const archiveKey = searchParams\.get\('archive'\);/);
  assert.match(chat, /\) : showArchive \? \(\s*<ArchivedInstanceView/);
  assert.match(chat, /onOpenArchive=\{handleOpenArchive\}/);
  assert.doesNotMatch(view, /MessageInput|AgentSettingsPanel|onResumeSession|onAnswerQuestion|onRelaunchLoop/);
  assert.match(view, /<SessionLogPanel[\s\S]*?backfillUrl=\{sessionUrl\}[\s\S]*?staticOnly/);
});

test('AC4: live and archived chat share one event mapping', () => {
  assert.match(panel, /const seed = chatMessagesFromEvents\(chunk\);/);
  assert.match(panel, /const older = chatMessagesFromEvents\(chunk\);/);
  assert.match(view, /chatMessagesFromEvents\(page\?\.chunk\)/);
  assert.match(log, /fetch\(backfillUrl \|\| `\/api\/agents\//);
});

test('AC10: the no-chat notice comes from the view model', () => {
  assert.match(view, /const notice = archivedChatNotice\(entry\);/);
});
