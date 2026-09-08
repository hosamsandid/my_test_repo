import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading guard for the #2065 attribution wiring.
 *
 * The decision logic is pure and covered by `message-author.test.js`; what this
 * file pins is the glue that JSX tests cannot reach (#651) — that `Message.jsx`
 * actually asks the pure module instead of re-deriving sides, that the badge is
 * reachable by keyboard, and that `ChatPanel.jsx` carries the author field on
 * every one of its four message-building sites. A dropped site would silently
 * un-attribute a whole class of messages (e.g. everything loaded on scroll-up)
 * with no visible error.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGE = fs.readFileSync(path.join(HERE, 'Message.jsx'), 'utf8');
const CHAT_PANEL = fs.readFileSync(path.join(HERE, 'ChatPanel.jsx'), 'utf8');

function at(src, needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `expected source to contain: ${needle}`);
  return i;
}

/* ── Message.jsx ─────────────────────────────────────────────────────────── */

test('the bubble asks the pure module for side and badge', () => {
  assert.match(MESSAGE, /import \{[\s\S]*describeMessageAuthor[\s\S]*\} from '\.\/message-author\.js'/);
  assert.match(MESSAGE, /const \{ isAgent, side, badge \} = describeMessageAuthor\(/);
});

test('the bubble no longer decides the side from "sender is not the agent"', () => {
  // The old rule was `const isAgent = message.sender === agentUserId` feeding
  // both alignment and the badge — the very conflation #2065 removes.
  assert.doesNotMatch(MESSAGE, /const isAgent = message\.sender === agentUserId/);
  assert.doesNotMatch(MESSAGE, /'YOU'/);
});

test('alignment and flex direction are both driven by the resolved side', () => {
  assert.match(MESSAGE, /const onRight = side === 'right';/);
  assert.match(MESSAGE, /const align = onRight \? 'flex-end' : 'flex-start';/);
  assert.match(MESSAGE, /flexDirection: onRight \? 'row-reverse' : 'row',/);
});

test('the human bubble colour is keyed on isAgent, not on the side (D9)', () => {
  // A human message that moved to the left must keep the human bubble colour.
  const decl = at(MESSAGE, 'const bubbleColor = isAgent');
  const region = MESSAGE.slice(decl, decl + 220);
  assert.match(region, /--eb-bg-surface/);
  assert.match(region, /--eb-bg-selected/);
  assert.doesNotMatch(region, /onRight|side/);
});

test('the avatar takes the whole badge, so no caller can pass letters directly', () => {
  assert.match(MESSAGE, /<Avatar badge=\{badge\} \/>/);
  assert.match(MESSAGE, /function Avatar\(\{ badge \}\)/);
});

test('the un-attributed avatar is a neutral person glyph, never the old ? placeholder', () => {
  const avatar = at(MESSAGE, 'function Avatar({ badge })');
  const region = MESSAGE.slice(avatar, avatar + 1600);
  assert.match(region, /<User size=\{16\}/, 'a person icon renders for the anonymous badge');
  assert.doesNotMatch(region, /initials \|\| '\?'/, "the '?' fallback is gone");
  assert.match(MESSAGE, /import \{ Bot, User, Zap \} from 'lucide-react';/);
});

test('the full name is reachable by pointer AND by keyboard (AC8)', () => {
  const avatar = at(MESSAGE, 'function Avatar({ badge })');
  const region = MESSAGE.slice(avatar, avatar + 1600);
  assert.match(region, /tabIndex=\{0\}/, 'the named badge is focusable');
  assert.match(region, /title=\{badge\.name\}/, 'pointer reveal via the chat title convention');
  assert.match(region, /aria-label=\{`Sent by \$\{badge\.name\}`\}/);
  assert.match(region, /className=\{AUTHOR_NAME_CLASS\}/, 'the focus-visible reveal element exists');
});

test('only a named badge is focusable — the bot and the neutral icon are not', () => {
  const avatar = at(MESSAGE, 'function Avatar({ badge })');
  const region = MESSAGE.slice(avatar, avatar + 1600);
  const earlyReturn = region.indexOf('if (!named) return');
  const tabIndex = region.indexOf('tabIndex={0}');
  assert.ok(earlyReturn > 0 && tabIndex > earlyReturn,
    'the non-named badge returns before the focusable branch');
});

test('the circle is geometry-locked so no glyph can reflow the row (AC9)', () => {
  const avatar = at(MESSAGE, 'function Avatar({ badge })');
  const region = MESSAGE.slice(avatar, avatar + 1600);
  assert.match(region, /width: 28, height: 28,/);
  assert.match(region, /overflow: 'hidden',/);
  assert.match(region, /flexShrink: 0,/);
});

test('the badge stylesheet is injected once at the document level, not per bubble', () => {
  assert.match(MESSAGE, /document\.getElementById\('agent-chat-author-badge-css'\)/);
  assert.match(MESSAGE, /el\.textContent = authorBadgeCss\(\);/);
  assert.match(MESSAGE, /let authorBadgeCssInjected = false;/);
});

/* ── ChatPanel.jsx ───────────────────────────────────────────────────────── */

test('every message-building site carries the author field', () => {
  // Backfill, scroll-up pagination, the live SSE handler and the reload path.
  const authored = CHAT_PANEL.match(/\[AUTHOR_FIELD\]:\s+ev\.content\?\.\[AUTHOR_FIELD\] \|\| null,/g) || [];
  const askAnswers = CHAT_PANEL.match(/\[ASK_ANSWER_FIELD\]:\s+ev\.content\?\.\[ASK_ANSWER_FIELD\] \|\| null,/g) || [];
  assert.equal(askAnswers.length, 4, 'there are still four message-building sites');
  assert.equal(authored.length, askAnswers.length,
    'the author field is read on every site that builds a message');
});

test('the optimistic stub mirrors the viewer stamp, after the caller payload (AC18)', () => {
  const stub = at(CHAT_PANEL, 'const optimistic = {');
  const region = CHAT_PANEL.slice(stub, CHAT_PANEL.indexOf('};', stub));
  const spread = region.indexOf('...(extraContent');
  const stamp = region.indexOf('[AUTHOR_FIELD]: authorStampFor(viewer)');
  assert.ok(spread > 0 && stamp > spread,
    'the stamp is applied after the caller payload, so extraContent cannot override it');
});

test('viewer and directory are stable memos, so React.memo on Message holds (AC20)', () => {
  assert.match(CHAT_PANEL, /const viewer = useMemo\(/);
  assert.match(CHAT_PANEL, /\[user\?\.userId, username\],/);
  assert.match(CHAT_PANEL, /const authorDirectory = useMemo\(\(\) => buildAuthorDirectory\(directoryUsers\), \[directoryUsers\]\);/);
});

test('the directory is fetched once per transcript, not per row (AC20)', () => {
  const fetches = CHAT_PANEL.match(/useApi\('\/api\/admin\/users'\)/g) || [];
  assert.equal(fetches.length, 1);
});

test('both attribution props reach the rendered bubble', () => {
  const render = at(CHAT_PANEL, '<Message\n          message={msg}');
  const region = CHAT_PANEL.slice(render, render + 500);
  assert.match(region, /viewer=\{viewer\}/);
  assert.match(region, /authorDirectory=\{authorDirectory\}/);
});

test('the hover-correlation pairing still keys on the agent alone (non-regression)', () => {
  // "not the agent ⇒ user-sent" stays correct now that the human side has
  // identities — a left-aligned human message must still correlate.
  const corr = at(CHAT_PANEL, 'const correlationByEvent = useMemo(');
  const region = CHAT_PANEL.slice(corr, corr + 700);
  assert.match(region, /const isAgent = m\.sender === agent\.userId;/);
  assert.doesNotMatch(region, /AUTHOR_FIELD/);
});
