import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAT_READ_ONLY_HINT, CHAT_READ_ONLY_PLACEHOLDER,
  isChatReadOnly, chatShareTeamId, chatShareHref, chatReadOnlyHint,
} from './chat-read-only.js';
import { decideComposerAction } from './composer-action.js';

/**
 * Read-only agent chat for a System Admin outside the team (#2713): the pure
 * module, plus a drift guard for the ChatPanel/MessageInput wiring that
 * `node --test` cannot load (#651).
 */

// ── chat-read-only.js ────────────────────────────────────────────────────

test('isChatReadOnly: only an explicit canChat:false locks the composer (AC8, AC11)', () => {
  assert.equal(isChatReadOnly({ id: 'a', canChat: false }), true);
  assert.equal(isChatReadOnly({ id: 'a', canChat: true }), false);
  assert.equal(isChatReadOnly({ id: 'a' }), false, 'a row from an older server stays writable');
  assert.equal(isChatReadOnly(null), false);
});

test('chatShareTeamId: the team itself, a member\'s parent team, none for a standalone agent', () => {
  assert.equal(chatShareTeamId({ id: 'team-a', role: 'team' }), 'team-a');
  assert.equal(chatShareTeamId({ id: 'dev', role: 'team-member', parentTeamId: 'team-a' }), 'team-a');
  assert.equal(chatShareTeamId({ id: 'eph', role: 'agent' }), null);
  assert.equal(chatShareTeamId({ id: 'orphan', role: 'team-member' }), null);
  assert.equal(chatShareTeamId(null), null);
});

test('chatShareHref: the team\'s Sharing tab, id encoded', () => {
  assert.equal(chatShareHref('team-a'), '/chats/team-a?tab=sharing');
  assert.equal(chatShareHref('a b'), '/chats/a%20b?tab=sharing');
  assert.equal(chatShareHref(null), null);
});

test('chatReadOnlyHint: the hint text plus the share link, or text only without a team (AC3)', () => {
  assert.deepEqual(
    chatReadOnlyHint({ id: 'dev', role: 'team-member', parentTeamId: 'team-a', canChat: false }),
    { text: CHAT_READ_ONLY_HINT, shareHref: '/chats/team-a?tab=sharing' },
  );
  assert.deepEqual(chatReadOnlyHint({ id: 'eph', role: 'agent', canChat: false }), { text: CHAT_READ_ONLY_HINT, shareHref: null });
  assert.equal(chatReadOnlyHint({ id: 'dev', role: 'team-member', parentTeamId: 'team-a', canChat: true }), null);
  assert.equal(CHAT_READ_ONLY_HINT, "You're viewing this chat as a System Admin. To write here, add yourself to the team.");
  assert.match(CHAT_READ_ONLY_PLACEHOLDER, /Read-only/);
});

test('the hint matches the server\'s 403 message word for word', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const server = fs.readFileSync(path.join(here, '../../../api/chat-write-access.js'), 'utf8');
  assert.ok(server.includes(JSON.stringify(CHAT_READ_ONLY_HINT)), 'chat-write-access.js carries the same text');
});

test('Stop still works on a disabled (read-only) composer while a turn runs (AC4)', () => {
  assert.deepEqual(decideComposerAction({ busy: true, canStop: true, hasText: false, disabled: true }), { mode: 'stop', enabled: true });
  assert.deepEqual(decideComposerAction({ busy: false, canStop: true, hasText: true, disabled: true }), { mode: 'send', enabled: false });
});

// ── wiring drift guard ───────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = rel => fs.readFileSync(path.join(HERE, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const panel = code('ChatPanel.jsx');
const input = code('MessageInput.jsx');

test('ChatPanel reads the flag through chatReadOnlyHint, never re-deriving the rule', () => {
  assert.match(panel, /const readOnlyHint = chatReadOnlyHint\(agent\);/);
  assert.match(panel, /const readOnly = !!readOnlyHint;/);
  assert.doesNotMatch(panel, /systemAdmin/);
});

test('AC2/AC7 — composer and quick-reply cards share one gate that includes readOnly', () => {
  assert.match(panel, /const composerDisabled = disabled \|\| readOnly \|\| !roomId \|\| sending \|\| maintenance\.active;/);
  assert.match(panel, /disabled: composerDisabled,/);
  assert.match(panel, /<MessageInput[\s\S]{0,80}disabled=\{composerDisabled\}\s*readOnly=\{readOnly\}/);
});

test('AC2 — every write handler refuses while read-only (keyboard send, upload, loop launch)', () => {
  assert.match(panel, /async function handleSend\(text, extraContent = null\) \{\s*if \(!roomId \|\| readOnly\) return false;/);
  assert.match(panel, /async function handleUpload\(files\) \{[\s\S]{0,120}\|\| readOnly\) return \[\];/);
  assert.match(panel, /function handleLoopClick\(\) \{\s*if \(readOnly\) return;/);
  assert.match(panel, /async function handleLaunchLoop\(body\) \{\s*if \(!agent\?\.id \|\| readOnly\) return;/);
  assert.match(panel, /const handleRelaunchLoop = useCallback\(\(values\) => \{\s*if \(readOnly\) \{/);
});

test('AC3 — the hint renders with a Share control that opens the team Sharing tab', () => {
  assert.match(panel, /\{readOnlyHint && \(\s*<div\s+role="note"\s+data-testid="chat-read-only-hint"/);
  assert.match(panel, /\{readOnlyHint\.shareHref && \(\s*<button[\s\S]{0,80}onClick=\{\(\) => navigate\(readOnlyHint\.shareHref\)\}/);
});

test('AC2 — MessageInput locks the meeting menu and swaps the placeholder when read-only', () => {
  assert.match(input, /insertRefRequest = null, readOnly = false \}\)/);
  assert.match(input, /const placeholder = readOnly\s*\? CHAT_READ_ONLY_PLACEHOLDER/);
  assert.match(input, /onClick=\{\(\) => !readOnly && setMeetingMenuOpen\(o => !o\)\}\s*disabled=\{readOnly\}/);
  assert.match(input, /\{meetingMenuOpen && onStartMeeting && !readOnly && \(/);
  // Attach, loop and mic already honour `disabled`, which ChatPanel sets.
  assert.match(input, /const canAttach = !!onUpload && !disabled && !uploading;/);
  assert.match(input, /const canLoop = !!onLoopClick && !loopBusy && !busy && !disabled;/);
  assert.match(input, /disabled=\{disabled \|\| voiceState === 'transcribing' \|\| meetingActive\}/);
});
