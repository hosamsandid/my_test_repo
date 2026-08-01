import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUGGESTION_SOURCES,
  INBOX_CAP,
  skillLifecycle,
  partitionSkills,
  recencyWeight,
  evidenceScore,
  sortSuggestions,
  groupSuggestions,
  skillMatchesQuery,
  suggestionMatchesQuery,
  buildInbox,
  tabCounts,
  hasNewEvidence,
} from './skill-inbox-view.js';

const NOW = Date.parse('2026-07-22T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

// ── lifecycle tabs ──────────────────────────────────────────────────────────

test('skillLifecycle: active → inuse, else ready', () => {
  assert.equal(skillLifecycle({ activation: { active: true } }), 'inuse');
  assert.equal(skillLifecycle({ activation: { active: false } }), 'ready');
  assert.equal(skillLifecycle({ activation: null }), 'ready');
  assert.equal(skillLifecycle({}), 'ready');
});

test('partitionSkills splits by activation', () => {
  const { inuse, ready } = partitionSkills([
    { id: 'a', activation: { active: true } },
    { id: 'b', activation: { active: false } },
    { id: 'c' },
  ]);
  assert.deepEqual(inuse.map(s => s.id), ['a']);
  assert.deepEqual(ready.map(s => s.id), ['b', 'c']);
});

// ── evidence scoring + ordering (AC5) ────────────────────────────────────────

test('recencyWeight decays with age and is neutral without a timestamp', () => {
  assert.equal(recencyWeight({ raisedAt: daysAgo(0) }, NOW), 1);
  assert.ok(Math.abs(recencyWeight({ raisedAt: daysAgo(14) }, NOW) - 0.5) < 1e-9);
  assert.equal(recencyWeight({}, NOW), 0.5);
  // future/negative age never exceeds 1
  assert.ok(recencyWeight({ raisedAt: daysAgo(-5) }, NOW) <= 1);
});

test('evidenceScore = agents × lessons × recency, guarded to >= 1 factors', () => {
  const s = { convergenceCount: 3, lessonCount: 4, raisedAt: daysAgo(0) };
  assert.equal(evidenceScore(s, NOW), 12);
  // agent-nominated with no counts still scores from the guards
  assert.equal(evidenceScore({ source: 'agent-nominated', raisedAt: daysAgo(0) }, NOW), 1);
  // convergence array used when count absent
  assert.equal(evidenceScore({ convergence: ['x', 'y'], lessonCount: 2, raisedAt: daysAgo(0) }, NOW), 4);
});

test('sortSuggestions evidence mode ranks strong-recent above stale-large', () => {
  const fresh = { id: 'fresh', convergenceCount: 2, lessonCount: 2, raisedAt: daysAgo(0) }; // 4
  const stale = { id: 'stale', convergenceCount: 5, lessonCount: 3, raisedAt: daysAgo(60) }; // 15 * ~0.05
  const ranked = sortSuggestions([stale, fresh], 'evidence', NOW);
  assert.deepEqual(ranked.map(s => s.id), ['fresh', 'stale']);
});

test('sortSuggestions newest / oldest by timestamp', () => {
  const a = { id: 'a', raisedAt: daysAgo(1) };
  const b = { id: 'b', raisedAt: daysAgo(5) };
  const c = { id: 'c', raisedAt: daysAgo(3) };
  assert.deepEqual(sortSuggestions([a, b, c], 'newest', NOW).map(s => s.id), ['a', 'c', 'b']);
  assert.deepEqual(sortSuggestions([a, b, c], 'oldest', NOW).map(s => s.id), ['b', 'c', 'a']);
});

test('sortSuggestions is a pure copy (does not mutate input)', () => {
  const input = [{ id: 'a', raisedAt: daysAgo(1) }, { id: 'b', raisedAt: daysAgo(5) }];
  const snapshot = input.map(s => s.id);
  sortSuggestions(input, 'evidence', NOW);
  assert.deepEqual(input.map(s => s.id), snapshot);
});

// ── theme grouping (AC5) ──────────────────────────────────────────────────────

test('groupSuggestions splits related themes from single suggestions, order kept', () => {
  const ranked = [
    { id: '1', source: 'related' },
    { id: '2', source: 'convergence' },
    { id: '3', source: 'related' },
    { id: '4', source: 'agent-nominated' },
  ];
  const { themed, singles } = groupSuggestions(ranked);
  assert.deepEqual(themed.map(s => s.id), ['1', '3']);
  assert.deepEqual(singles.map(s => s.id), ['2', '4']);
});

// ── search ────────────────────────────────────────────────────────────────────

test('skillMatchesQuery matches label + tier, empty query matches all', () => {
  assert.equal(skillMatchesQuery({ label: 'Deploy Runbook', tier: 'team' }, 'deploy'), true);
  assert.equal(skillMatchesQuery({ label: 'Deploy Runbook' }, 'xyz'), false);
  assert.equal(skillMatchesQuery({ label: 'X' }, ''), true);
});

test('suggestionMatchesQuery searches text, draft name and member texts', () => {
  const s = { text: 'about caching', draft: { name: 'cache-skill' }, members: [{ text: 'redis TTL' }] };
  assert.equal(suggestionMatchesQuery(s, 'redis'), true);
  assert.equal(suggestionMatchesQuery(s, 'cache-skill'), true);
  assert.equal(suggestionMatchesQuery(s, 'nomatch'), false);
});

// ── inbox assembly ────────────────────────────────────────────────────────────

test('buildInbox ranks, caps and reports the hidden remainder', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    id: `s${i}`, source: 'convergence', convergenceCount: 14 - i, lessonCount: 1, raisedAt: daysAgo(0),
  }));
  const inbox = buildInbox(many, { now: NOW, cap: INBOX_CAP });
  assert.equal(inbox.total, 14);
  assert.equal(inbox.shown.length, 10);
  assert.equal(inbox.hiddenCount, 4);
  assert.equal(inbox.shown[0].id, 's0'); // highest convergenceCount ranks first
});

test('buildInbox applies source filter and search', () => {
  const list = [
    { id: 'r', source: 'related', text: 'grouped theme', raisedAt: daysAgo(0) },
    { id: 'c', source: 'convergence', text: 'lone lesson', raisedAt: daysAgo(0) },
  ];
  assert.deepEqual(buildInbox(list, { now: NOW, sourceFilter: 'related' }).shown.map(s => s.id), ['r']);
  assert.deepEqual(buildInbox(list, { now: NOW, query: 'lone' }).shown.map(s => s.id), ['c']);
  assert.equal(buildInbox(list, { now: NOW, cap: null }).shown.length, 2);
});

test('buildInbox groups the shown set', () => {
  const list = [
    { id: 'r', source: 'related', convergenceCount: 5, lessonCount: 5, raisedAt: daysAgo(0) },
    { id: 'c', source: 'convergence', convergenceCount: 1, lessonCount: 1, raisedAt: daysAgo(0) },
  ];
  const inbox = buildInbox(list, { now: NOW });
  assert.deepEqual(inbox.themed.map(s => s.id), ['r']);
  assert.deepEqual(inbox.singles.map(s => s.id), ['c']);
});

// ── tab counts + new-evidence dot ─────────────────────────────────────────────

test('tabCounts counts inuse / ready skills and open suggestions', () => {
  const counts = tabCounts(
    [{ activation: { active: true } }, { activation: { active: false } }, {}],
    [{ id: '1' }, { id: '2' }],
  );
  assert.deepEqual(counts, { inuse: 1, ready: 2, suggested: 2 });
});

test('hasNewEvidence compares evidence timestamps against last visit', () => {
  const list = [{ id: '1', raisedAt: daysAgo(2) }];
  assert.equal(hasNewEvidence(list, daysAgo(5)), true);   // evidence newer than visit
  assert.equal(hasNewEvidence(list, daysAgo(1)), false);  // visit newer than evidence
  assert.equal(hasNewEvidence(list, null), true);         // never visited
  assert.equal(hasNewEvidence([], daysAgo(5)), false);    // nothing to flag
});

test('SUGGESTION_SOURCES is the triage filter vocabulary', () => {
  assert.deepEqual(SUGGESTION_SOURCES, ['convergence', 'related', 'agent-nominated', 'manual', 'decay']); // #919
});
