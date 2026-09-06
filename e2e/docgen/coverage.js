// Coverage report (docs/journey-spec-concept.md §3.2 item 3, #707).
//
// Turns "which corners are documented/tested" from tribal knowledge into a
// printed list, along two axes:
//   1. Nav pages (NAV_PAGES) that no journey step touches.
//   2. Walkthrough chapters that no journey covers (incl. the TODO chapters).
//
// Pure: callers supply the journeys, the nav-page list and the chapter list; the
// readers (nav-pages.js / walkthrough.js) do the I/O. That keeps this unit-testable
// against fixed inputs and keeps a false gap (a page a journey really touches, or a
// chapter that has a journey) impossible to introduce silently.
'use strict';

const { referencedStepNames } = require('../journey-runner/schema');
const { normalizeTitle } = require('./walkthrough');

// Which nav page(s) a step namespace drives. A journey "touches" a nav page when
// any of its action/assert steps live in the matching step-library module
// (wizard.* ⇒ the Agent Team Wizard, templates.* ⇒ Agent Templates, …). Namespaces that
// are pure plumbing (env/teardown fixtures) map to nothing so they never claim
// coverage. Extend this map when a new step module drives a new page.
const NAMESPACE_TO_NAV = {
  wizard: ['Agent Team Wizard'],
  templates: ['Agent Templates'],
  chat: ['Agent Chat'],
  // agents.* asserts a materialised team in the Agent Chat left rail since
  // #1930 removed the Agents page (its nav entry is gone from NAV_PAGES, so
  // mapping to it would silently contribute nothing). Several namespaces may
  // map to one nav page — navLabelsForJourney returns a SET of labels, so a
  // journey using both chat.* and agents.* is still counted once (context.*
  // already shared 'Agent Chat' this way).
  agents: ['Agent Chat'],
  knowledge: ['Knowledge'],
  flows: ['Flows'],
  triggers: ['Triggers'],
  credentials: ['SSH Keys', 'GitHub Tokens'],
  // context.* drives the Agent Chat page's workspace rail (#1319 journey).
  context: ['Agent Chat'],
};

// The set of nav-page labels a single journey touches, derived from the
// namespaces of the steps it references.
function navLabelsForJourney(journey, namespaceMap = NAMESPACE_TO_NAV) {
  const labels = new Set();
  for (const name of referencedStepNames(journey)) {
    const ns = name.split('.')[0];
    for (const label of namespaceMap[ns] || []) labels.add(label);
  }
  return labels;
}

// Compute both coverage axes. Returns:
//   navPages:  [{ label, covered, journeys: [id] }]
//   chapters:  [{ title, maturity, todo, covered, journeyId|null }]
//   navGaps / chapterGaps: the uncovered subsets (convenience for callers/tests).
function computeCoverage({ journeys = [], navPages = [], chapters = [], namespaceMap = NAMESPACE_TO_NAV } = {}) {
  // Nav axis: map label → journey ids that touch it.
  const labelToJourneys = new Map(navPages.map((l) => [l, []]));
  for (const journey of journeys) {
    for (const label of navLabelsForJourney(journey, namespaceMap)) {
      if (labelToJourneys.has(label)) labelToJourneys.get(label).push(journey.id);
    }
  }
  const navRows = navPages.map((label) => ({
    label,
    journeys: labelToJourneys.get(label),
    covered: labelToJourneys.get(label).length > 0,
  }));

  // Chapter axis: normalise journey titles once, then match each chapter to a
  // journey by normalised title.
  const journeyByTitle = new Map();
  for (const journey of journeys) journeyByTitle.set(normalizeTitle(journey.title), journey.id);
  const chapterRows = chapters.map((ch) => {
    const journeyId = journeyByTitle.get(normalizeTitle(ch.title)) || null;
    return { ...ch, covered: Boolean(journeyId), journeyId };
  });

  return {
    navPages: navRows,
    chapters: chapterRows,
    navGaps: navRows.filter((r) => !r.covered),
    chapterGaps: chapterRows.filter((r) => !r.covered),
  };
}

// Render the coverage result as a Markdown report. Deterministic (no timestamp):
// it describes the static inputs, not a run, so it diffs cleanly.
function renderCoverageReport(coverage) {
  const { navPages, chapters, navGaps, chapterGaps } = coverage;
  const lines = [];
  lines.push('# Journey coverage report');
  lines.push('');
  lines.push('Cross-checks the journeys under `e2e/journeys/` against the platform');
  lines.push('nav-page inventory (`NAV_PAGES`) and the walkthrough chapter list.');
  lines.push('');

  lines.push('## Nav pages');
  lines.push('');
  lines.push(`Covered ${navPages.length - navGaps.length} / ${navPages.length}.`);
  lines.push('');
  if (navGaps.length) {
    lines.push('Nav pages no journey touches yet:');
    lines.push('');
    for (const r of navGaps) lines.push(`- ${r.label}`);
  } else {
    lines.push('Every nav page is touched by a journey.');
  }
  lines.push('');

  lines.push('## Walkthrough chapters');
  lines.push('');
  lines.push(`Covered ${chapters.length - chapterGaps.length} / ${chapters.length}.`);
  lines.push('');
  if (chapterGaps.length) {
    lines.push('Chapters without a journey:');
    lines.push('');
    for (const r of chapterGaps) {
      const tag = r.maturity ? ` — ${r.maturity}` : '';
      lines.push(`- ${r.title}${tag}`);
    }
  } else {
    lines.push('Every walkthrough chapter has a journey.');
  }
  lines.push('');

  return `${lines.join('\n')}`;
}

module.exports = {
  computeCoverage,
  renderCoverageReport,
  navLabelsForJourney,
  NAMESPACE_TO_NAV,
};
