import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading drift guard over the JSX that `node --test` cannot load
 * (the #651 convention). A closed Help panel is only slid off-screen; this
 * file pins that its root container is also `inert` while closed, so none of
 * its controls stay in the keyboard tab order (#2702), and that the open
 * panel is left fully interactive.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

// Strip block, JSX and whole-line comments, then collapse whitespace so the
// assertions pin attribute shapes rather than formatting.
function normalize(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

const src = normalize(read('./HelperChatPanel.jsx'));

// The opening tag of the panel's root container: the first <div after the
// component's `return (`, up to its style object.
function rootTag() {
  const ret = src.lastIndexOf('return ( <div');
  assert.ok(ret !== -1, 'panel root `return ( <div` not found');
  const end = src.indexOf('style={{', ret);
  assert.ok(end > ret, 'panel root style not found');
  return src.slice(ret, end);
}

test('#2702 AC1/AC3 — the closed panel root is inert, so nothing inside it is focusable', () => {
  const tag = rootTag();
  assert.match(tag, /\binert=\{!isOpen\}/, 'root container must carry inert={!isOpen}');
  // aria-hidden and inert must agree: hidden from screen readers AND the keyboard.
  assert.match(tag, /aria-hidden=\{!isOpen\}/);
});

test('#2702 AC2 — the open panel is not made inert and keeps its tab order', () => {
  // inert follows isOpen alone — no unconditional inert and no tabIndex overrides.
  assert.doesNotMatch(src, /\binert(?:=\{true\})?(?=[\s>])/, 'no unconditional inert');
  assert.doesNotMatch(src, /tabIndex=\{-1\}/, 'no blanket tabIndex=-1 on panel controls');
  assert.equal(src.split('inert=').length - 1, 1, 'exactly one inert wiring, on the root');
});
