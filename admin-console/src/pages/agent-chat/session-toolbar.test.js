import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * session-toolbar.test.js — source-reading drift guard for the Agent Chat
 * session toolbar (#1922). The toolbar is inline JSX with no pure module (per
 * the agent-chat "logic lives inline, no unit tests" convention), so what is
 * lockable is the *shape* of the markup.
 *
 * It locks in two things #1922 decided:
 *   1. **Save & Learn is gone** — button, prompt, state and effect. The manual
 *      button duplicated an instruction the runtime already gives the agent on
 *      every invocation (`_build_memory_hint()` / `buildMemoryHint()`,
 *      `build_harvest_hint()`, the #602 harvest block), so a re-added button
 *      would re-introduce the redundancy rather than a feature.
 *   2. **Reset Session is the primary, always-visible button** and the `…`
 *      overflow menu survives holding Clear History — the inverse of #1810.
 *
 * Comments are stripped before the "this is gone" assertions: the explanatory
 * comments #1922 added *name* what was removed, and would otherwise
 * false-positive the very guard they belong to.
 */
const read = (name) => readFileSync(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  'utf8',
);

/** Strip block + line comments so prose about the removal isn't matched as code. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const CHAT_PANEL = read('ChatPanel.jsx');
const CODE = stripComments(CHAT_PANEL);

test('the Save & Learn button is gone from the toolbar', () => {
  // The rendered label (JSX-escaped ampersand) and the plain form.
  assert.doesNotMatch(CODE, /Save\s*(?:&amp;|&)\s*Learn/);
});

test('all frontend code exclusive to Save & Learn is gone', () => {
  for (const symbol of ['LEARN_PROMPT', 'handleFullLearn', 'learnPending', 'learnTriggeredAtRef']) {
    assert.doesNotMatch(CODE, new RegExp(symbol), `${symbol} should be removed`);
  }
  // The canned prompt's distinctive instruction wording must not survive
  // anywhere — the automatic memory hint is the single source of it now.
  assert.doesNotMatch(CODE, /Before we end this conversation/);
  assert.doesNotMatch(CODE, /knowledge add fact\|entity\|convention/);
});

test('the dead onKnowledgeChanged wiring is gone (its only feeder was the learn reply)', () => {
  assert.doesNotMatch(CODE, /onKnowledgeChanged/);
  assert.doesNotMatch(stripComments(read('../AgentChat.jsx')), /onKnowledgeChanged|knowledgeRefreshKey/);
  assert.doesNotMatch(stripComments(read('RightRail.jsx')), /knowledgeRefreshKey/);
});

test('the GraduationCap icon import is dropped with its only user', () => {
  assert.doesNotMatch(CODE, /GraduationCap/);
});

test('Reset Session is a primary toolbar button, not a menu item', () => {
  // A real <button> carrying the label, wired to the unchanged handler and
  // styled with the shared session-button style.
  const button = CODE.match(/<button[^>]*[\s\S]{0,700}?Reset Session\s*<\/button>/);
  assert.ok(button, 'expected a <button> element labelled "Reset Session"');
  assert.match(button[0], /onClick=\{handleResetSession\}/);
  assert.match(button[0], /style=\{sessionBtnStyle\(/);
});

test("Reset Session keeps its guards, spinner and tooltip after promotion", () => {
  const button = CODE.match(/<button[^>]*[\s\S]{0,700}?Reset Session\s*<\/button>/)[0];
  // AC7: disabled with no session, while resetting, or while chat is disabled.
  assert.match(button, /disabled=\{!sessionId \|\| resetting \|\| disabled\}/);
  // AC5: busy spinner + the same explanatory tooltip it had inside the menu.
  assert.match(button, /resetting\s*\n?\s*\?\s*<Loader2/);
  assert.match(button, /title="This room keeps one running Claude session/);
});

test('the … overflow menu stays, holding Clear History', () => {
  assert.match(CODE, /<HeaderOverflowMenu/);
  // Close on a line-leading `/>` — an inline `<Trash2 … />` would end a plain
  // non-greedy `\/>` match after the first item's icon.
  const menu = CODE.match(/<HeaderOverflowMenu[\s\S]*?\n\s*\/>/)[0];
  assert.match(menu, /key: 'clear'/);
  assert.match(menu, /label: 'Clear History'/);
  assert.match(menu, /onClick: \(\) => setShowClearConfirm\(true\)/);
  // Reset Session must no longer be an item — it is the primary button now.
  assert.doesNotMatch(menu, /key: 'reset'/);
});

test('the rest of the toolbar is untouched (AC8)', () => {
  assert.match(CODE, /<ChatModelSelector/);      // runtime model selector
  assert.match(CODE, /<SessionInfoPopover/);     // "About this chat"
  assert.match(CODE, /<LearningBadge/);          // learning badge
  assert.match(CODE, /contextIndicator/);        // context usage indicator
});

test('#1964 AC3 — the hand-off button is gone and mounts nothing', () => {
  // Epic #1961 decision R4: the dialog stays in the tree (annotated, see the
  // header of HandoffDialog.jsx) but nothing renders it. The button was the
  // only mount point, so the assertion is on the toolbar's source rather than
  // on the dialog file — a re-added button is what would revive it.
  assert.doesNotMatch(CODE, /Hand-off/);
  assert.doesNotMatch(CODE, /HandoffDialog/);
  assert.doesNotMatch(CODE, /showHandoff/);
  assert.doesNotMatch(CODE, /bp-instance/);
});
