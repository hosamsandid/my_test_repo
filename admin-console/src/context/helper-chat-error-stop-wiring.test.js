import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading drift guard over the JSX that `node --test` cannot load
 * (the #651 convention). helper-chat-model.test.js proves the pure helpers
 * (errorMessageFromBody / errorMessageFromEvent / failStreaming / stopStreaming)
 * behave; this file proves HelperChatContext.jsx and HelperChatPanel.jsx
 * actually wire them in (#2700): the server's reason reaches the bubble, the
 * picker nudges still fire, and the composer can stop a running turn.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

// Strip block, JSX and whole-line comments, then collapse whitespace so the
// assertions pin call shapes rather than formatting.
function normalize(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

// The body of `const sendMessage = useCallback(…` up to the next top-level
// `const value = useMemo(` — keeps the assertions scoped to the send path.
function sendMessageBody(src) {
  const start = src.indexOf('const sendMessage = useCallback(');
  const end = src.indexOf('const value = useMemo(', start);
  assert.ok(start !== -1 && end > start, 'sendMessage useCallback not found');
  return src.slice(start, end);
}

function count(src, needle) {
  return src.split(needle).length - 1;
}

const CTX = normalize(read('./HelperChatContext.jsx'));
const PANEL = normalize(read('../components/HelperChatPanel.jsx'));

function assertContextWiring(ctx) {
  const send = sendMessageBody(ctx);
  // AC1 — plain JSON error: the server's `error` text reaches the bubble.
  assert.match(
    send,
    /if \(!res\.ok\) \{.*setBoth\(failStreaming\(messagesRef\.current, placeholderId, errorMessageFromBody\(errBody\)\)\); return; \}/,
    'the !res.ok branch must pass the server reason to failStreaming',
  );
  // AC2 — the assist-selection nudges still fire from the same branch.
  assert.match(send, /if \(errBody && errBody\.code\) notifyAssistError\(errBody\.code\);/);
  // AC1 — stream error events: both the loop and the tail flush keep the message.
  assert.equal(
    count(send, "} else if (ev.type === 'error') { sawError = true; errorText = errorMessageFromEvent(ev) || errorText; }"),
    2,
    'both NDJSON loops must capture the error event message',
  );
  assert.match(send, /if \(sawError\) \{ setBoth\(failStreaming\(messagesRef\.current, placeholderId, errorText\)\);/);
  // AC3 — the fetch is abortable and an abort ends the turn as stopped.
  assert.match(send, /const controller = new AbortController\(\); abortRef\.current = controller;/);
  assert.match(send, /fetch\('\/api\/helper\/chat', \{ method: 'POST',.*?signal: controller\.signal, \}\)/);
  assert.match(
    send,
    /catch \{ if \(controller\.signal\.aborted\) \{ setBoth\(stopStreaming\(messagesRef\.current, placeholderId\)\); \} else \{ setBoth\(failStreaming\(messagesRef\.current, placeholderId\)\); \} \} finally \{ if \(abortRef\.current === controller\) abortRef\.current = null; setIsStreaming\(false\); \}/,
  );
  assert.match(ctx, /const stopMessage = useCallback\(\(\) => \{ if \(abortRef\.current\) abortRef\.current\.abort\(\); \}, \[\]\);/);
  assert.match(ctx, /const value = useMemo\(\(\) => \(\{[^}]*\bstopMessage\b/, 'stopMessage must be exposed on the context');
}

function assertPanelWiring(panel) {
  assert.match(panel, /const \{[^}]*\bstopMessage\b[^}]*\} = useHelperChat\(\);/);
  // While streaming the composer shows an enabled Stop wired to stopMessage;
  // Send is only rendered (and only disabled by an empty composer) otherwise.
  assert.match(
    panel,
    /\{isStreaming \? \( <button onClick=\{stopMessage\} title="Stop" aria-label="Stop"[^>]*> <Square size=\{16\} \/> <\/button> \) : \( <button onClick=\{submit\} disabled=\{!composer\.trim\(\)\} title="Send" aria-label="Send"/,
  );
}

test('HelperChatContext surfaces server error reasons and can abort a turn (#2700)', () => {
  assertContextWiring(CTX);
});

test('HelperChatPanel swaps Send for an enabled Stop while streaming (#2700)', () => {
  assertPanelWiring(PANEL);
});

test('the #2700 wiring guards are not vacuous', () => {
  // Each mutation is the regression the guard exists for; every one must fail.
  const ctxMutations = [
    ['errorMessageFromBody(errBody)))', 'undefined))'],
    ['errorText = errorMessageFromEvent(ev) || errorText;', ''],
    ['placeholderId, errorText))', 'placeholderId))'],
    ['signal: controller.signal, ', ''],
    ['if (controller.signal.aborted)', 'if (false)'],
    ['abortRef.current.abort();', ''],
    ['notifyAssistError(errBody.code);', ''],
  ];
  for (const [from, to] of ctxMutations) {
    assert.ok(CTX.includes(from), `mutation anchor missing: ${from}`);
    assert.throws(() => assertContextWiring(CTX.split(from).join(to)), `guard missed: ${from}`);
  }
  const panelMutations = [
    ['onClick={stopMessage}', 'onClick={submit}'],
    ['disabled={!composer.trim()}', 'disabled={isStreaming || !composer.trim()}'],
    ['{isStreaming ? (', '{false ? ('],
  ];
  for (const [from, to] of panelMutations) {
    assert.ok(PANEL.includes(from), `mutation anchor missing: ${from}`);
    assert.throws(() => assertPanelWiring(PANEL.split(from).join(to)), `guard missed: ${from}`);
  }
});
