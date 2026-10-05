import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionJumpRef } from './session-jump.js';

// Source-reading drift guard (#651) for the runner's CI-wait status note
// (#2841). status-note.js covers the decisions; this pins the JSX uses them.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('ChatPanel keeps the status-note payload at every message-mapping site', () => {
  const src = read('ChatPanel.jsx');
  const sites = src.match(/'io\.aee\.triggerFailure':\s+ev\.content/g).length;
  const notes = src.match(/\[STATUS_NOTE_FIELD\]:\s+ev\.content\?\.\[STATUS_NOTE_FIELD\]/g)?.length ?? 0;
  assert.equal(notes, sites);
});

test('the thinking indicator ignores status notes', () => {
  const src = read('ChatPanel.jsx');
  assert.match(src, /const lastMsg = lastTurnMessage\(messages\);/);
});

test('Message renders a status note as a notice card with a linked PR', () => {
  const src = read('Message.jsx');
  assert.match(src, /message\.msgtype === 'm\.notice' && \(message\['io\.aee\.trigger'\] \|\| isStatusNote\(message\)\)/);
  assert.match(src, /isStatusNote\(message\) \? statusNoteMarkdown\(message\)/);
});

test('a status note jumps to its run in the session log', () => {
  const msg = { event_id: '$n', msgtype: 'm.notice', 'io.aee.status-note': { correlationId: 'c1' } };
  assert.deepEqual(sessionJumpRef(msg, '@a:local'), { correlationId: 'c1' });
});
