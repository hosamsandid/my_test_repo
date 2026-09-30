import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOKEN_CLASSES, CLASS_COLOR } from './token-usage-view.js';

// Guard for the per-class colours on the Token Usage page (#2618).
//
// Input and Cache read once rendered in the same blue: Cache read referenced
// `--eb-accent`, which tokens.css never defined, so its fallback — the Input
// token — always won. Stacked in the "Tokens per day" chart, the two series
// merged into one block. Nothing errors when that happens, so this resolves
// every CLASS_COLOR against tokens.css for each theme and asserts the four
// computed colours are defined and pairwise different.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, '..', 'theme', 'tokens.css'), 'utf8');

// Custom-property declarations of the first rule whose selector list matches
// `selectorRe`. Comments are stripped so commented-out tokens don't count.
function declarations(selectorRe) {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = new RegExp(`${selectorRe.source}[^{]*\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, `tokens.css has no rule for ${selectorRe}`);
  const vars = {};
  for (const m of rule[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

// The dark block is also the bare `:root` default, so the other themes inherit
// every token they don't override.
const BASE = declarations(/:root,\s*:root\[data-theme="admin-dark"\]/);
const THEMES = {
  'admin-dark': BASE,
  'admin-light': { ...BASE, ...declarations(/:root\[data-theme="admin-light"\]/) },
  'high-contrast': { ...BASE, ...declarations(/:root\[data-theme="high-contrast"\]/) },
};

// Only a bare `var(--token)` is accepted: a fallback (`var(--a, var(--b))`)
// is exactly what hid the original bug.
function tokenOf(value) {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  assert.ok(m, `CLASS_COLOR value must be a bare var(--token) without fallback, got ${value}`);
  return m[1];
}

test('CLASS_COLOR has exactly one colour per token class', () => {
  assert.deepEqual(Object.keys(CLASS_COLOR).sort(), TOKEN_CLASSES.map(c => c.key).sort());
});

test('CLASS_COLOR references only tokens defined in tokens.css', () => {
  for (const [key, value] of Object.entries(CLASS_COLOR)) {
    const token = tokenOf(value);
    for (const [theme, vars] of Object.entries(THEMES)) {
      assert.ok(vars[token], `${key}: ${token} is not defined for theme ${theme}`);
    }
  }
});

test('the four token classes resolve to pairwise different colours in every theme', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    const resolved = TOKEN_CLASSES.map(c => [c.key, vars[tokenOf(CLASS_COLOR[c.key])]]);
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        assert.notEqual(resolved[i][1], resolved[j][1],
          `${theme}: ${resolved[i][0]} and ${resolved[j][0]} share ${resolved[i][1]}`);
      }
    }
  }
});

test('mutation: the pre-#2618 Cache read value is rejected', () => {
  assert.throws(() => tokenOf('var(--eb-accent, var(--eb-status-info))'));
  assert.equal(THEMES['admin-light']['--eb-accent'], undefined);
});
