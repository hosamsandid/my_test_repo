import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GITHUB_EVENTS_HELP_SECTIONS } from './github-events-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

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

// The pending row's action copy lives in the pure view module since #2102 gave
// the row a kebab menu — a menu item is a descriptor, so its label and tooltip
// are decided there rather than in the JSX.
const pendingRowView = readFileSync(
  fileURLToPath(new URL('./pending-queue-view.js', import.meta.url)),
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

/* ── #1995 (epic #1981): every surface has a "?", and every "?" has a chapter ──

   The topic is now a per-surface reference, so two things can rot and neither
   throws at runtime: a chapter heading reworded out from under the slug a call
   site names (the panel then silently renders from the top, which still *looks*
   like the "?" worked), and a surface losing its affordance or growing a
   hand-written slug instead of the shared constant. Both are asserted here.

   The companion topic-side guard is the `chapters` list in
   help-topics-content.test.js. */

const topicBody = readFileSync(
  fileURLToPath(new URL('../../api/helper-chat/help-topics/github-events.md', import.meta.url)),
  'utf8',
);

// The three surfaces live in one file, so "the file mentions the constant" would
// not prove the "?" is on the right one. Slice the source per component and
// assert inside the slice. Runs on the comment-stripped source: this ticket's
// own comments name the chapters they explain.
function componentSource(startMarker, endMarker) {
  const from = prose.indexOf(startMarker);
  assert.notEqual(from, -1, `GithubEventLog.jsx no longer defines ${startMarker}`);
  const to = endMarker ? prose.indexOf(endMarker, from) : prose.length;
  assert.notEqual(to, -1, `GithubEventLog.jsx no longer defines ${endMarker}`);
  return prose.slice(from, to === -1 ? prose.length : to);
}

const processedView = componentSource('function ProcessedEventsView(', 'function KindBadge(');
const pendingView = componentSource('function PendingQueueView(', 'const PAGE_DESCRIPTION');
const pageShell = componentSource('export default function GithubEventLog(', null);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(GITHUB_EVENTS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/github-events.md no longer has a heading for these chapters. '
    + 'Reword the heading back, or update GITHUB_EVENTS_HELP_SECTIONS — a stale '
    + `slug degrades silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What the GitHub Event Log is'), GITHUB_EVENTS_HELP_SECTIONS.page);
  assert.equal(sectionSlug('Processed events'), GITHUB_EVENTS_HELP_SECTIONS.processed);
  assert.equal(sectionSlug('Outcomes'), GITHUB_EVENTS_HELP_SECTIONS.outcomes);
  assert.equal(sectionSlug('Pending queue'), GITHUB_EVENTS_HELP_SECTIONS.pending);
});

test('the topic keeps one clearly-headed chapter per area of the page', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const slug of Object.values(GITHUB_EVENTS_HELP_SECTIONS)) {
    assert.ok(h2.includes(slug), `"${slug}" must stay a top-level chapter, not a sub-heading`);
  }
});

test('AC4: each surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['the page header', pageShell, 'page'],
    ['the processed-events table toolbar', processedView, 'processed'],
    ['the outcome legend', processedView, 'outcomes'],
    ['the pending-queue toolbar', pendingView, 'pending'],
  ];
  for (const [what, source, key] of wired) {
    assert.ok(source.includes('PageHelpButton'), `${what} must render the shared PageHelpButton`);
    assert.ok(
      source.includes(`GITHUB_EVENTS_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
});

test('AC4: the outcomes "?" sits with the legend it deepens, not loose in the tab', () => {
  // Anchored on the render sequence rather than on the constant alone: the
  // processed tab hosts two "?"s, and only their placement tells them apart.
  assert.match(
    processedView,
    /<OutcomeLegend\s*\/>[\s\S]{0,400}GITHUB_EVENTS_HELP_SECTIONS\.outcomes/,
    'the outcomes "?" must be rendered next to <OutcomeLegend />',
  );
});

test('AC5: no point-of-decision microcopy was traded for a "?"', () => {
  // Restated against the surfaces this ticket touched, so adding an affordance
  // can never be the edit that removes the hint it sits beside.
  assert.match(processedView, /<OutcomeLegend\s*\/>/);
  assert.match(src, /kindTooltip\(kind\)/);
  // Cancel's own tooltip. It moved out of the JSX and into the row's menu
  // descriptor when #2102 gave the row a second action (the copy travels with
  // the control, and a menu item's copy belongs in the pure builder) — so the
  // assertion follows it rather than being dropped. What it guards is unchanged:
  // the hint must still exist at the point of decision, wherever that now is.
  assert.match(pendingRowView, /Remove this entry from the queue before it is delivered/);
});

test('#2102: the row menu keeps Cancel and states why Reassign is unavailable', () => {
  // Both halves of AC7/AC9's copy contract, next to the assertion above so a
  // future edit that guts one is caught by the same file.
  assert.match(pendingRowView, /Hand this entry to another agent on the same team/);
  assert.match(pendingRowView, /Only queued GitHub events can be reassigned/);
});
