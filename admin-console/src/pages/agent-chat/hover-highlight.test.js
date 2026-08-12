import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOVER_SCOPE_ATTR,
  HOVER_ROW_ATTR,
  DEFAULT_DIM_OPACITY,
  cssEscapeAttrValue,
  hoverBaseCss,
  hoverDimCss,
} from './hover-highlight.js';

test('cssEscapeAttrValue escapes backslashes and quotes', () => {
  assert.equal(cssEscapeAttrValue('$abc'), '$abc');
  assert.equal(cssEscapeAttrValue('a"b'), 'a\\"b');
  assert.equal(cssEscapeAttrValue('a\\b'), 'a\\\\b');
});

test('cssEscapeAttrValue neutralises newlines (defensive)', () => {
  assert.equal(cssEscapeAttrValue('a\nb'), 'a\\A b');
  assert.equal(cssEscapeAttrValue('a\rb'), 'a\\D b');
});

test('cssEscapeAttrValue coerces non-strings', () => {
  assert.equal(cssEscapeAttrValue(42), '42');
});

test('hoverBaseCss always applies a transition to rows in the scope', () => {
  const css = hoverBaseCss('chat');
  assert.match(css, /\[data-hover-scope="chat"\] \[data-cid\]\{transition:opacity 0\.15s;\}/);
});

test('hoverDimCss returns empty when nothing is hovered', () => {
  assert.equal(hoverDimCss('chat', null), '');
  assert.equal(hoverDimCss('chat', ''), '');
  assert.equal(hoverDimCss('chat', undefined), '');
});

test('hoverDimCss dims all rows and un-dims the matching one', () => {
  const css = hoverDimCss('log', '$evt1');
  // Every row in the scope is dimmed…
  assert.ok(css.includes(`[${HOVER_SCOPE_ATTR}="log"] [${HOVER_ROW_ATTR}]{opacity:${DEFAULT_DIM_OPACITY};}`));
  // …then the matching row is restored to full opacity, later in source order
  // so it wins on equal specificity.
  const dimIdx = css.indexOf('opacity:0.35');
  const keepIdx = css.indexOf('[data-cid="$evt1"]{opacity:1;}');
  assert.ok(keepIdx > dimIdx, 'un-dim rule must come after the dim rule');
});

test('hoverDimCss honours a custom dim opacity', () => {
  const css = hoverDimCss('chat', '$e', 0.5);
  assert.ok(css.includes('opacity:0.5;'));
});

test('hoverDimCss escapes the hovered id in the selector', () => {
  const css = hoverDimCss('chat', 'a"b');
  assert.ok(css.includes('[data-cid="a\\"b"]{opacity:1;}'));
});
