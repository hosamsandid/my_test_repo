import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading drift guard over SidePanel.jsx, which `node --test` cannot
 * load (the #651 convention). The decision logic is covered behaviourally in
 * side-panel-view.test.js; this file pins that the component actually uses it,
 * so every SidePanel consumer behaves as a keyboard modal (#2960).
 */

const src = readFileSync(fileURLToPath(new URL('./SidePanel.jsx', import.meta.url)), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s+/g, ' ');

function dialogTag() {
  const i = src.indexOf('<div ref={panelRef}');
  assert.ok(i !== -1, 'panel container `<div ref={panelRef}` not found');
  return src.slice(i, src.indexOf('style={{', i));
}

test('#2960 AC4 — the dialog container is aria-modal with an accessible name', () => {
  const tag = dialogTag();
  assert.match(tag, /aria-modal="true"/);
  assert.match(tag, /aria-label=\{title\}/);
  assert.match(tag, /role="dialog"/);
  // Programmatically focusable as the fallback focus target, not a Tab stop.
  assert.match(tag, /tabIndex=\{-1\}/);
});

test('#2960 AC1 — opening moves focus via initialFocusTarget to the body field or close button', () => {
  assert.match(src, /initialFocusTarget\(\{/);
  assert.match(src, /if \(target === 'body'\) bodyList\[0\]\.focus\(\)/);
  assert.match(src, /else if \(target === 'close'\) \(closeRef\.current \|\| panel\)\.focus\(\)/);
  assert.match(src, /<div ref=\{bodyRef\}/);
  assert.match(src, /<button ref=\{closeRef\}/);
});

test('#2960 AC2 — Tab is routed through panelTabAction and the shared Modal trap', () => {
  assert.match(src, /import \{ focusTrapTarget, FOCUSABLE_SELECTOR \} from '\.\/modal-view\.js'/);
  assert.match(src, /panelTabAction\(\{/);
  assert.match(src, /isTop: isTopPanel\(token\)/);
  assert.match(src, /focusTrapTarget\(index, list\.length, e\.shiftKey\)/);
  assert.match(src, /document\.addEventListener\('keydown', onKeyDown\)/);
  assert.match(src, /document\.removeEventListener\('keydown', onKeyDown\)/);
});

test('#2960 AC3 — the opener is captured on open and refocused on close', () => {
  assert.match(src, /const previouslyFocused = document\.activeElement;/);
  assert.match(src, /if \(canRestoreFocus\(previouslyFocused\)\) previouslyFocused\.focus\(\)/);
  assert.match(src, /pushOpenPanel\(token\)/);
  assert.match(src, /removeOpenPanel\(token\)/);
});

test('#2960 — the focus effect depends on `open` only (inline onClose must not re-run it)', () => {
  const i = src.indexOf('pushOpenPanel(token)');
  const end = src.indexOf('}, [', i);
  assert.equal(src.slice(end, end + 11), '}, [open]);');
});
