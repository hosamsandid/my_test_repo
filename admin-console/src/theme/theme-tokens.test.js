import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  THEMES, themeTokens, usedTokens, resolveToken, contrastRatio, whiteOnAccentLines,
  whiteOnWarningLines,
} from './theme-tokens.js';

// Guard for #2701: every --eb-* token the console uses must be defined in
// every theme, and the text/background pairs the UI tester flagged must reach
// WCAG AA (4.5:1). An undefined token fails silently — the browser falls back
// to a hard-coded light-theme colour, or drops the declaration altogether —
// so only a static comparison catches it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..');
const TOKENS = themeTokens(fs.readFileSync(path.join(HERE, 'tokens.css'), 'utf8'));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(jsx?|css)$/.test(e.name) && !e.name.endsWith('.test.js') ? [p] : [];
  });
}

const AA = 4.5;

function ratio(theme, fg, bg) {
  const vars = TOKENS[theme];
  return contrastRatio(resolveToken(vars, fg), resolveToken(vars, bg));
}

function assertAA(fg, bgs) {
  for (const theme of THEMES) {
    for (const bg of bgs) {
      const r = ratio(theme, fg, bg);
      assert.ok(r >= AA, `${theme}: ${fg} on ${bg} is ${r.toFixed(2)}:1, below ${AA}:1`);
    }
  }
}

test('contrastRatio matches known WCAG values', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#fff', '#fff'), 1);
  assert.ok(Math.abs(contrastRatio('#777777', '#ffffff') - 4.48) < 0.01);
  assert.ok(Math.abs(contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)') - 21) < 0.01);
  // Out-of-gamut OKLCH is clipped to sRGB rather than producing NaN.
  assert.ok(Number.isFinite(contrastRatio('oklch(0.75 0.30 293)', '#000')));
});

test('every var(--eb-…) used in src/ is defined in every theme', () => {
  const missing = new Map();
  for (const file of sourceFiles(SRC)) {
    for (const token of usedTokens(fs.readFileSync(file, 'utf8'))) {
      for (const theme of THEMES) {
        if (TOKENS[theme][token] !== undefined) continue;
        const key = `${token} (${theme})`;
        if (!missing.has(key)) missing.set(key, path.relative(SRC, file));
      }
    }
  }
  assert.deepEqual([...missing].map(([k, f]) => `${k} — e.g. ${f}`), []);
});

test('usedTokens finds tokens with and without fallbacks', () => {
  const used = usedTokens("a: 'var(--eb-warn-fg, #8a6d00)', b: 'var( --eb-x)', c: '--eb-not-a-use'");
  assert.deepEqual([...used].sort(), ['--eb-warn-fg', '--eb-x']);
});

test('muted text reaches AA on every surface it is drawn on', () => {
  assertAA('--eb-text-muted', ['--eb-bg-app', '--eb-bg-surface', '--eb-bg-elevated', '--eb-bg-hover']);
});

test('status text reaches AA on the app surfaces and on its own notice tint', () => {
  for (const status of ['success', 'warning', 'error']) {
    assertAA(`--eb-status-${status}-text`, [
      '--eb-bg-app', '--eb-bg-surface', '--eb-bg-elevated', `--eb-status-${status}-bg`,
    ]);
  }
});

test('notice body text (text-secondary) reaches AA on the warning and error tints', () => {
  assertAA('--eb-text-secondary', ['--eb-status-warning-bg', '--eb-status-error-bg']);
});

test('text on primary (accent) buttons reaches AA', () => {
  assertAA('--eb-text-inverted', ['--eb-accent-primary']);
});

// #2752: text on a solid warning fill (SkillsRegistry acknowledge button,
// ProcessCanvas count badges) and accent text on accent-muted badges.
test('text on the solid warning fill reaches AA', () => {
  assertAA('--eb-text-on-warning', ['--eb-status-warning']);
});

test('accent text on accent-muted badges reaches AA', () => {
  assertAA('--eb-accent-primary', ['--eb-accent-muted']);
});

test('no style block puts literal white text on an --eb-status-warning fill', () => {
  const offenders = sourceFiles(SRC).flatMap((file) =>
    whiteOnWarningLines(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(SRC, file)}:${line}`));
  assert.deepEqual(offenders, []);
});

test('whiteOnWarningLines flags ternary and fallback fills, not the warning tint', () => {
  const src = [
    "a = { background: ack ? 'var(--eb-status-warning)' : 'var(--eb-accent-primary)', color: ack ? '#fff' : 'x' };",
    "b = { background: 'var(--eb-status-warning, #d97706)', color: 'var(--eb-text-on-warning)' };",
    "c = { background: 'var(--eb-status-warning-bg)', color: '#fff' };",
    '.d { background:var(--eb-status-warning,#d97706);color:#fff; }',
  ].join('\n');
  assert.deepEqual(whiteOnWarningLines(src), [1, 4]);
});

test('mutation: the pre-#2752 colours are rejected by the same thresholds', () => {
  for (const theme of THEMES) {
    const warning = resolveToken(TOKENS[theme], '--eb-status-warning');
    assert.ok(contrastRatio('#ffffff', warning) < AA, `${theme}: white on the warning fill`);
  }
  const darkAccent = resolveToken(TOKENS['admin-dark'], '--eb-accent-primary');
  assert.ok(contrastRatio(darkAccent, 'oklch(0.26 0.08 293)') < AA, 'old dark accent-muted');
});

// The token pair above was already AA on main; the real high-contrast button
// defect was call sites hard-coding '#fff' on the accent fill. Guard those too.
test('no style block puts literal white text on an --eb-accent-primary fill', () => {
  const offenders = sourceFiles(SRC).flatMap((file) =>
    whiteOnAccentLines(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(SRC, file)}:${line}`));
  assert.deepEqual(offenders, []);
});

test('whiteOnAccentLines flags JS style objects and CSS rules, not other colours', () => {
  const src = [
    "a = { background: 'var(--eb-accent-primary)', color: '#fff' };",
    "b = { background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)' };",
    '.c { background-color: var(--eb-accent-primary); color: white; }',
    "d = { background: 'var(--eb-bg-app)', color: '#fff' };",
    "e = { backgroundColor: 'var(--eb-accent-primary)', borderColor: '#fff' };",
    "f = { backgroundColor: 'var(--eb-accent-primary)',\n  color: '#FFFFFF' };",
  ].join('\n');
  assert.deepEqual(whiteOnAccentLines(src), [1, 3, 6]);
});

test('mutation: the pre-#2701 colours are rejected by the same thresholds', () => {
  const hcAccent = resolveToken(TOKENS['high-contrast'], '--eb-accent-primary');
  assert.ok(contrastRatio('#ffffff', hcAccent) < AA, 'white on the HC accent');
  assert.ok(contrastRatio('#9e9da4', '#fff8e1') < AA, 'grey on the old warn fallback');
  const darkHover = resolveToken(TOKENS['admin-dark'], '--eb-bg-hover');
  assert.ok(contrastRatio('oklch(0.55 0.008 293)', darkHover) < AA, 'old dark muted');
  const lightApp = resolveToken(TOKENS['admin-light'], '--eb-bg-app');
  assert.ok(contrastRatio('oklch(0.60 0.008 293)', lightApp) < AA, 'old light muted');
  assert.equal(TOKENS['admin-dark']['--eb-warn-fg'], undefined);
});
