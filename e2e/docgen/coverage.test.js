// Coverage-report tests (#707). Runs against the REAL inventories — the actual
// journeys, the real NAV_PAGES constant and the real walkthrough README — so it
// verifies the acceptance directly: the known gaps (TODO chapters, untouched nav
// pages) are listed, and the pages/chapters that DO have a journey are never
// falsely flagged. Pure Node, `node --test`, no browser/podman.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadJourneysDir } = require('../journey-runner/loader');
const { readNavPages } = require('./nav-pages');
const { readChapters, normalizeTitle } = require('./walkthrough');
const { computeCoverage, renderCoverageReport, navLabelsForJourney } = require('./coverage');

const journeys = loadJourneysDir();
const navPages = readNavPages();
const chapters = readChapters();
const coverage = computeCoverage({ journeys, navPages, chapters });

const navGapLabels = new Set(coverage.navGaps.map((r) => r.label));
const chapterGapTitles = new Set(coverage.chapterGaps.map((r) => normalizeTitle(r.title)));

test('journeys that drive a page are reflected as touched (no false nav gap)', () => {
  // The pilot journeys touch the Team Wizard (wizard.*) and Agent Templates
  // (templates.*) pages — neither may show up as an uncovered nav page.
  assert.ok(journeys.some((j) => j.id === 'team-setup'), 'team-setup journey missing');
  assert.ok(journeys.some((j) => j.id === 'agent-templates'), 'agent-templates journey missing');
  assert.equal(navGapLabels.has('Team Wizard'), false, 'Team Wizard falsely reported as a gap');
  assert.equal(navGapLabels.has('Agent Templates'), false, 'Agent Templates falsely reported as a gap');
});

test('nav pages no journey touches are reported as gaps', () => {
  // Pages with no journey (real gaps today) must be listed.
  assert.ok(navGapLabels.has('MCP Servers'), 'expected MCP Servers among nav gaps');
  assert.ok(navGapLabels.has('Token Usage'), 'expected Token Usage among nav gaps');
});

test('chapters with a journey are not flagged; TODO chapters are', () => {
  // Team Setup + Agent Templates have journeys → not gaps (no false gap).
  assert.equal(chapterGapTitles.has(normalizeTitle('Team Setup (wizard)')), false, 'Team Setup falsely flagged');
  assert.equal(chapterGapTitles.has(normalizeTitle('Agent Templates')), false, 'Agent Templates falsely flagged');
  // A known TODO chapter is surfaced as a gap.
  assert.ok(chapterGapTitles.has(normalizeTitle('Skills Registry')), 'expected Skills Registry among chapter gaps');
});

test('the report surfaces TODO maturity on gap chapters', () => {
  const report = renderCoverageReport(coverage);
  assert.match(report, /## Nav pages/);
  assert.match(report, /## Walkthrough chapters/);
  // At least one TODO chapter shows its maturity tag in the list.
  assert.match(report, /Skills Registry — TODO/);
});

test('navLabelsForJourney derives pages from step namespaces', () => {
  const teamSetup = journeys.find((j) => j.id === 'team-setup');
  assert.ok(navLabelsForJourney(teamSetup).has('Team Wizard'));
});
