import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AGENT_CHAT_MD_CSS,
  MD_TABLE_WRAP_CLASS,
  parseRules,
  declarationsFor,
} from './markdown-css.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const messageSource = readFileSync(join(HERE, 'Message.jsx'), 'utf8');

/** Strip line + block comments so a prose mention is never read as code. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('parseRules reads flat single-line rules', () => {
  const rules = parseRules('.a, .b { color: red; margin: 0 }\n.c { padding: 1px; }');
  assert.deepEqual(rules[0].selectors, ['.a', '.b']);
  assert.deepEqual(rules[0].declarations, { color: 'red', margin: '0' });
  assert.deepEqual(rules[1].selectors, ['.c']);
  assert.deepEqual(rules[1].declarations, { padding: '1px' });
});

test('parseRules ignores comments', () => {
  const rules = parseRules('/* .ghost { color: red } */ .real { color: blue; }');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].selectors, ['.real']);
});

// ---------------------------------------------------------------------------
// #2048 — a short cell value must never be broken character-by-character.
// ---------------------------------------------------------------------------

test('cells reset the bubble wrap rules that collapse a short-value column (AC1)', () => {
  // The bubble sets `overflow-wrap: anywhere` + `word-break: break-word`; both
  // make every character a wrap opportunity when the min-content width is
  // measured, which is what let a `D10` column shrink to one character.
  for (const selector of ['.agent-chat-md th', '.agent-chat-md td']) {
    const decls = declarationsFor(AGENT_CHAT_MD_CSS, selector);
    assert.equal(decls['overflow-wrap'], 'break-word', `${selector} overflow-wrap`);
    assert.equal(decls['word-break'], 'normal', `${selector} word-break`);
  }
});

test('header cells follow the same wrap rules as body cells (AC5)', () => {
  const th = declarationsFor(AGENT_CHAT_MD_CSS, '.agent-chat-md th');
  const td = declarationsFor(AGENT_CHAT_MD_CSS, '.agent-chat-md td');
  assert.equal(th['overflow-wrap'], td['overflow-wrap']);
  assert.equal(th['word-break'], td['word-break']);
  assert.equal(th.padding, td.padding);
});

test('inline code inside a cell is measured like text, not per character (AC1)', () => {
  // `.agent-chat-md :not(pre) > code` opts inline code into `anywhere`; inside
  // a cell that would collapse the column again, so it is overridden with a
  // more specific selector.
  const generic = declarationsFor(AGENT_CHAT_MD_CSS, '.agent-chat-md :not(pre) > code');
  assert.equal(generic['overflow-wrap'], 'anywhere');
  for (const selector of [
    '.agent-chat-md th :not(pre) > code',
    '.agent-chat-md td :not(pre) > code',
  ]) {
    assert.equal(declarationsFor(AGENT_CHAT_MD_CSS, selector)['overflow-wrap'], 'break-word', selector);
  }
});

test('the table is a real table box that sizes to its content (AC2, AC4)', () => {
  const table = declarationsFor(AGENT_CHAT_MD_CSS, '.agent-chat-md table');
  // `display: block` + its own `overflow-x` was the root cause: it shrank the
  // table to the bubble width and let the automatic layout squeeze columns.
  assert.equal(table.display, undefined, 'table must not be display: block');
  assert.equal(table['overflow-x'], undefined, 'the wrapper scrolls, not the table');
  // `width: auto` = shrink-to-fit: a narrow table is not stretched with empty
  // column padding (D2), a wide one is capped at the bubble and wraps.
  assert.equal(table.width, 'auto');
  assert.equal(table['max-width'], '100%');
});

test('the scroll wrapper is the last-resort overflow surface (D1)', () => {
  const wrap = declarationsFor(AGENT_CHAT_MD_CSS, `.agent-chat-md .${MD_TABLE_WRAP_CLASS}`);
  assert.equal(wrap['overflow-x'], 'auto');
  assert.equal(wrap['max-width'], '100%');
});

test('cell text-align is only a default, so markdown alignment still wins', () => {
  // remark-gfm's `align` reaches the DOM as an inline `style="text-align:…"`
  // (react-markdown rewrites the attribute), which outranks this sheet — so
  // the sheet may only carry the default, never `!important` and never a rule
  // that would have to be kept in sync with the alignment syntax.
  for (const selector of ['.agent-chat-md th', '.agent-chat-md td']) {
    assert.equal(declarationsFor(AGENT_CHAT_MD_CSS, selector)['text-align'], 'left', selector);
  }
  assert.ok(!/!important/.test(AGENT_CHAT_MD_CSS), 'no !important may override an inline alignment');
});

test('code blocks keep their own horizontal scroll (D3, AC10)', () => {
  const pre = declarationsFor(AGENT_CHAT_MD_CSS, '.agent-chat-md pre');
  assert.equal(pre['max-width'], '100%');
  const figure = declarationsFor(AGENT_CHAT_MD_CSS, '.agent-chat-md figure');
  assert.equal(figure['max-width'], '100%');
  assert.equal(figure['min-width'], '0');
  // PreWithCollapse owns `overflowX: 'auto'` on the <pre> itself; the shared
  // sheet must not fight it.
  assert.equal(pre['overflow-x'], undefined);
  assert.match(code(messageSource), /overflowX:\s*'auto'/);
});

test('no rule in the sheet reintroduces per-character breaking inside a table', () => {
  for (const rule of parseRules(AGENT_CHAT_MD_CSS)) {
    const anywhere = rule.declarations['overflow-wrap'] === 'anywhere'
      || rule.declarations['word-break'] === 'break-word';
    if (!anywhere) continue;
    for (const selector of rule.selectors) {
      assert.ok(
        !/\b(table|th|td|tr)\b/.test(selector),
        `selector ${selector} would collapse a table column again`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Wiring drift guards (#651: the JSX itself stays uncovered).
// ---------------------------------------------------------------------------

test('Message.jsx injects the shared sheet from this module', () => {
  const src = code(messageSource);
  assert.match(src, /import\s*\{[^}]*AGENT_CHAT_MD_CSS[^}]*\}\s*from\s*'\.\/markdown-css\.js'/);
  assert.match(src, /el\.textContent\s*=\s*AGENT_CHAT_MD_CSS/);
  // The sheet must not have been forked back into the component.
  assert.ok(!/const\s+AGENT_CHAT_MD_CSS\s*=/.test(src), 'CSS must live in markdown-css.js only');
});

test('Message.jsx wraps every rendered table in the scroll wrapper', () => {
  const src = code(messageSource);
  assert.match(src, /import\s*\{[^}]*MD_TABLE_WRAP_CLASS[^}]*\}\s*from\s*'\.\/markdown-css\.js'/);
  assert.match(src, /table:\s*\(\{[^}]*\}\)\s*=>\s*\(\s*<div className=\{MD_TABLE_WRAP_CLASS\}>\s*<table \{\.\.\.props\} \/>/);
});

test('both markdown tiers render through the same component map', () => {
  const src = code(messageSource);
  const uses = src.match(/components=\{MARKDOWN_COMPONENTS\}/g) || [];
  assert.equal(uses.length, 2, 'MarkdownFull and MarkdownGfmOnly must both use it');
});
