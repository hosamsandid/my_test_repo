// Reader tests (#707): NAV_PAGES + walkthrough README parsing. Pure `node --test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readNavPages } = require('./nav-pages');
const { readChapters, normalizeTitle } = require('./walkthrough');

test('readNavPages returns the ordered nav labels from the F0 spec', () => {
  const labels = readNavPages();
  assert.ok(labels.length >= 15, `expected the full nav list, got ${labels.length}`);
  // The unified "Create" launcher (#1665) replaced the separate Single Agent +
  // Agent Team Wizard nav entries as the single front door.
  assert.ok(labels.includes('Create'));
  assert.ok(labels.includes('Agent Templates'));
  assert.ok(labels.includes('Knowledge'));
});

test('readChapters parses the walkthrough table and flags TODO chapters', () => {
  const chapters = readChapters();
  const byNorm = new Map(chapters.map((c) => [normalizeTitle(c.title), c]));
  // Grouped title-only TODO chapters are split into individual entries.
  assert.ok(byNorm.has(normalizeTitle('Team Setup (wizard)')));
  assert.ok(byNorm.has(normalizeTitle('Skills Registry')));
  assert.ok(byNorm.has(normalizeTitle('Token Usage')));
  assert.equal(byNorm.get(normalizeTitle('Skills Registry')).todo, true);
  assert.equal(byNorm.get(normalizeTitle('Team Setup (wizard)')).todo, false);
});

test('normalizeTitle strips parenthetical qualifiers', () => {
  assert.equal(normalizeTitle('Team Setup (wizard)'), 'team setup');
  assert.equal(normalizeTitle('Agent Templates'), 'agent templates');
});
