import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Drift guard for the #1886 help extraction (epic #1870 Phase 3).
   `GithubEventLog.jsx` is JSX, so it has no unit-testable export for this — but
   the *copy* is the deliverable here, and a later edit could quietly grow the
   explanatory prose back onto the page while the help topic keeps claiming to
   be its single home. So this reads the source and asserts on its text, the
   same way github-event-log-type.test.js already checks the column set.

   The companion assertion lives on the other side, in
   admin-console/api/helper-chat/help-topics-content.test.js — that one proves
   the concepts survived *into* the topic; this one proves they left the page. */

const src = readFileSync(
  fileURLToPath(new URL('./GithubEventLog.jsx', import.meta.url)),
  'utf8',
);

// The "is this phrase gone?" assertions run against the source with comments
// stripped: a code comment naming what moved to the topic (as the ones this
// ticket added do) is documentation, not copy the user reads.
const prose = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('AC2: the page carries the shared PageHelpButton', () => {
  assert.match(src, /import PageHelpButton from '\.\.\/components\/PageHelpButton'/);
  assert.match(src, /<PageHelpButton\b/);
});

test('AC2: the description above the tabs is a single one-liner', () => {
  const m = src.match(/^const PAGE_DESCRIPTION = '([^']+)';$/m);
  assert.ok(m, 'the page description is a named module-level constant');
  const text = m[1];
  // One sentence, short enough that it cannot regrow into the removed intro's
  // three clauses (the old paragraph was ~230 chars across three sentences).
  assert.ok(text.length <= 120, `page description is ${text.length} chars, expected a one-liner`);
  assert.equal(text.split('.').filter((s) => s.trim()).length, 1);
});

test('AC2: the removed multi-clause intro is gone from the page', () => {
  // Asserted on the markup form the paragraph actually had (<strong>-wrapped
  // tab names), not on the bare tab names — those legitimately survive as the
  // TABS labels and in the tab leads.
  assert.doesNotMatch(prose, /<strong[^>]*>\s*Processed events<\/strong>/);
  assert.doesNotMatch(prose, /<strong[^>]*>\s*Pending queue<\/strong>/);
  for (const phrase of [
    'purely observational',
    'is the history',
    'actionable backlog',
  ]) {
    assert.ok(!prose.includes(phrase), `"${phrase}" belongs to the help topic now, not the page`);
  }
});

test('AC3: neither tab lead re-enumerates the outcomes', () => {
  // The outcome vocabulary is the topic's table plus the per-chip tooltips; a
  // tab lead listing them again is the duplication this ticket removed.
  for (const phrase of [
    'folded into a digest',
    'dropped by a protection layer',
    'matched no trigger',
    'drains every few seconds',
    'Maintenance Mode',
  ]) {
    assert.ok(!prose.includes(phrase), `"${phrase}" belongs to the help topic now, not a tab lead`);
  }
});

test('the point-of-decision help on the page survives', () => {
  // The epic removes the big explanatory boxes, not the live in-context hints:
  // every chip still explains itself, the collapsible legend still sits next to
  // the chips it decodes, and both teaching empty states stay (ticket scope).
  assert.match(src, /outcomeTooltip\(outcome\)/);
  assert.match(src, /What do these outcomes mean\?/);
  assert.match(src, /Nothing is waiting in the dispatch queue\./);
  assert.match(src, /No GitHub events recorded in this time range\./);
});
