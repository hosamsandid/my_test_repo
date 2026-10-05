import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  railSectionState,
  RAIL_SECTION_LOADING_TEXT,
  RAIL_SECTION_ERROR_TEXT,
} from './rail-section-state.js';

// #2847 — Flows rail Teams/Drafts sections tell loading, error, empty and list apart.

test('AC1/AC2: first load in flight is loading, not empty', () => {
  assert.equal(railSectionState({ data: null, error: null, items: [] }), 'loading');
  assert.equal(railSectionState({ data: undefined, error: null, items: [] }), 'loading');
});

test('AC3: loaded and genuinely empty is empty', () => {
  assert.equal(railSectionState({ data: [], error: null, items: [] }), 'empty');
});

test('AC3: loaded agents with no team rows is empty', () => {
  const data = [{ id: 'a', role: 'developer' }];
  assert.equal(railSectionState({ data, error: null, items: [] }), 'empty');
});

test('AC4: loaded with entries is list', () => {
  const data = [{ id: 't', role: 'team' }];
  assert.equal(railSectionState({ data, error: null, items: data }), 'list');
});

test('AC5: failed first load is error — not empty, not loading', () => {
  assert.equal(railSectionState({ data: null, error: 'HTTP 500', items: [] }), 'error');
});

test('AC6/edge: a failed refetch after a successful load keeps the list', () => {
  const data = [{ id: 'd' }];
  assert.equal(railSectionState({ data, error: 'HTTP 502', items: data }), 'list');
});

test('AC6: a failed refetch of a loaded empty list stays empty, not error', () => {
  assert.equal(railSectionState({ data: [], error: 'HTTP 502', items: [] }), 'empty');
});

test('missing items on loaded data is empty', () => {
  assert.equal(railSectionState({ data: {}, error: null, items: undefined }), 'empty');
});

test('copy: loading matches the page\'s muted "Loading…", errors are short', () => {
  assert.equal(RAIL_SECTION_LOADING_TEXT, 'Loading…');
  assert.match(RAIL_SECTION_ERROR_TEXT.teams, /teams/);
  assert.match(RAIL_SECTION_ERROR_TEXT.drafts, /drafts/);
});

// Wiring drift guard (#651): the JSX must consult the helper per section and
// read each section's own useApi error, so the sections stay independent (AC7).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const briefings = fs.readFileSync(path.join(HERE, '..', 'Briefings.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('wiring: Briefings.jsx derives each section state from its own fetch', () => {
  assert.match(briefings, /from '\.\/process\/rail-section-state\.js'/);
  assert.match(briefings, /error:\s*agentsError[^}]*\}\s*=\s*useApi\('\/api\/agents'\)/);
  assert.match(briefings, /error:\s*draftsError[^}]*\}\s*=\s*useApi\('\/api\/process\/drafts'\)/);
  assert.match(briefings, /railSectionState\(\{\s*data:\s*agents,\s*error:\s*agentsError,\s*items:\s*teams\s*\}\)/);
  assert.match(briefings, /railSectionState\(\{\s*data:\s*draftsList,\s*error:\s*draftsError,\s*items:\s*drafts\s*\}\)/);
});

test('wiring: empty copy is only rendered for the empty state', () => {
  assert.doesNotMatch(briefings, /teams\.length === 0 \?/);
  assert.doesNotMatch(briefings, /drafts\.length === 0 \?/);
  assert.match(briefings, /teamsSection === 'empty'/);
  assert.match(briefings, /draftsSection === 'empty'/);
  assert.match(briefings, /RAIL_SECTION_ERROR_TEXT\.teams/);
  assert.match(briefings, /RAIL_SECTION_ERROR_TEXT\.drafts/);
});
