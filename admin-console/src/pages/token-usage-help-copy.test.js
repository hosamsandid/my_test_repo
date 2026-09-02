// ─── Token Usage help-extraction drift guard (#1885, epic #1870 Phase 3) ──────
//
// #1885 removed the multi-paragraph intro banner from TokenUsage.jsx and moved
// its content into api/helper-chat/help-topics/token-usage.md. Nothing in a JSX
// file is unit-testable (the #651 convention keeps JSX uncovered), so this reads
// the source text and asserts the *shape* of the extraction instead:
//
//   • the shared "?" affordance is rendered, so the topic is reachable,
//   • the removed banner's MARKUP is gone (the <ul> of tab bullets over
//     PAGE_INTRO, and PAGE_INTRO itself),
//   • the surfaces the ticket deliberately KEPT are still there — both tab
//     labels, the tokens-not-costs line above the figures it guards, and the
//     per-tile InfoTips.
//
// Asserting on markup rather than on bare phrases matters: "Statistics" and
// "Work items" legitimately survive as the tab labels and inside the topic, so a
// phrase-level ban would fail on copy that is supposed to stay.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, 'TokenUsage.jsx'), 'utf8');
const VIEW = fs.readFileSync(path.join(HERE, 'token-usage-view.js'), 'utf8');

test('TokenUsage.jsx renders the shared PageHelpButton', () => {
  assert.match(PAGE, /import PageHelpButton from '\.\.\/components\/PageHelpButton';/);
  assert.match(PAGE, /<PageHelpButton\s/);
});

test('TokenUsage.jsx shows the one-line description instead of the intro banner', () => {
  assert.match(PAGE, /\{PAGE_DESCRIPTION\}/);
  // The banner rendered PAGE_INTRO.lead plus a two-item <ul> of tab bullets.
  assert.doesNotMatch(PAGE, /PAGE_INTRO/);
  assert.doesNotMatch(PAGE, /<li>\{PAGE_INTRO/);
  assert.doesNotMatch(VIEW, /export const PAGE_INTRO/);
});

test('TokenUsage.jsx keeps the surfaces #1885 deliberately did not extract', () => {
  // Both tab labels — the topic describes the tabs, it does not replace them.
  assert.match(PAGE, /label: 'Statistics'/);
  assert.match(PAGE, /label: 'Work items'/);
  // The tokens-not-costs rule stays directly above the figures it guards.
  assert.match(PAGE, /\{COST_NOTE\}/);
  // Per-figure InfoTips stay at the point of reading.
  assert.match(PAGE, /STAT_TILE_HELP/);
  assert.match(PAGE, /WORK_ITEM_TILE_HELP/);
  assert.match(PAGE, /TIER_SIGNAL_HELP/);
});
