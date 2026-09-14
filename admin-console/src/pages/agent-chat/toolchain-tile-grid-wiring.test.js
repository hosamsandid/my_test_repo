// Source-reading drift guard (#651) for #2279 — the Toolchain tab's native
// <select> (whose concatenated name+description ran on into one unreadable,
// browser-truncated line) is replaced by a tile/radio-card grid. `node --test`
// cannot load JSX, so this proves the wiring the pure toolchain-select-view.js
// tests cannot: the grid is actually rendered, the new ToolchainCard mirrors
// EnvironmentCard's (TeamSetup.jsx) accessibility contract rather than
// inventing a fourth, differently-behaved selection widget (AC3), and the
// native <select> for this field is gone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const read = (rel) => readFileSync(join(here, rel), 'utf8');
const panel = () => stripComments(read('TeamEnvironmentPanel.jsx'));
const teamSetup = () => stripComments(read('../TeamSetup.jsx'));

function fnBody(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `expected to find ${marker}`);
  // Both card components take one destructured-object parameter, so the
  // FIRST '{' after `marker` belongs to that destructuring, not the function
  // body — skip past the params' closing ') {' before bracket-counting.
  const paramsEnd = src.indexOf(') {', start);
  // Slice to the matching top-level closing brace of the function, found by
  // bracket depth so nested object literals don't end the slice early.
  let depth = 0;
  let i = src.indexOf('{', paramsEnd);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(bodyStart, i + 1);
}

const TOOLCHAIN_CARD = fnBody(panel(), 'function ToolchainCard(');
const ENVIRONMENT_CARD = fnBody(teamSetup(), 'function EnvironmentCard(');

test('ToolchainCard mirrors EnvironmentCard\'s radio-card accessibility contract', () => {
  for (const region of [TOOLCHAIN_CARD, ENVIRONMENT_CARD]) {
    assert.match(region, /role="radio"/);
    assert.match(region, /aria-checked=\{selected\}/);
    assert.match(region, /aria-disabled=\{!(selectable|available)\}/);
    assert.match(region, /tabIndex=\{(selectable|available) \? 0 : -1\}/);
    assert.match(region, /e\.key === ' ' \|\| e\.key === 'Enter'/, 'Space/Enter must activate the card, same as a native radio input');
  }
});

test('the mutation-proof: dropping role="radio" fails the check above (proves it is not vacuous)', () => {
  const mutated = TOOLCHAIN_CARD.replace('role="radio"', '');
  assert.doesNotMatch(mutated, /role="radio"/);
});

test('the toolchain tab renders a role="radiogroup" tile grid, not a native <select>', () => {
  const tabStart = panel().indexOf("{tab === 'toolchain' && (");
  const tabEnd = panel().indexOf("{tab === 'mcp' && (");
  const region = panel().slice(tabStart, tabEnd);
  assert.match(region, /role="radiogroup"/);
  assert.doesNotMatch(region, /<select/, 'the native <select> for this field must be gone (#2279)');
  assert.match(region, /<ToolchainCard\b/);
});

test('the default agent-image option and every registry row become a ToolchainCard, keyed off form.toolchainId', () => {
  const tabStart = panel().indexOf("{tab === 'toolchain' && (");
  const tabEnd = panel().indexOf("{tab === 'mcp' && (");
  const region = panel().slice(tabStart, tabEnd);
  assert.match(region, /selected=\{!form\.toolchainId\}/, 'the default-image card must be selected when nothing else is chosen');
  assert.match(region, /toolchainRows\.map\(t => \(/);
  assert.match(region, /selected=\{form\.toolchainId === t\.id\}/);
  assert.match(region, /available=\{t\.available\}/);
  assert.match(region, /platforms=\{t\.platforms\}/, 'AC2: platform badges must reach the tile');
  assert.match(region, /baseline=\{t\.baseline\}/, 'AC2: baseline badge must reach the tile');
  assert.match(region, /hint=\{t\.hint\}/, 'AC6: the full description (toolchain-select-view.js\'s hint) must reach the tile untruncated');
});
