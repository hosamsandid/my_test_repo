'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decaySuggestionId,
  planDecaySuggestions,
  computeCurationHealth,
  planHealthTransition,
} = require('./knowledge-decay');

const NOW = '2026-08-01T12:00:00Z';
const OLD = '2026-04-01T10:00:00Z'; // > 60d before NOW

function entry(over = {}) {
  return {
    v: 1,
    id: over.id || 'a'.repeat(12),
    kind: 'fact',
    text: over.text || 'a durable statement',
    originAgent: 'dev-1',
    teamId: 'acme',
    createdAt: OLD,
    convergence: ['dev-1'],
    status: 'active',
    ...over,
  };
}

// A retrieval aggregate whose baseline is comfortably older than the horizon.
function retrieval(entries = {}) {
  return { since: '2026-05-01T00:00:00Z', entries };
}

const BASE = { includedIds: [], candidates: [], horizonDays: 60, now: NOW };

test('AC1: an unused old entry yields exactly one open decay card; re-runs and dismissals never duplicate', () => {
  const e = entry();
  const p1 = planDecaySuggestions({ ...BASE, entries: [e], retrieval: retrieval() });
  assert.equal(p1.raise.length, 1);
  const card = p1.raise[0];
  assert.equal(card.id, decaySuggestionId(e.id));
  assert.equal(card.source, 'decay');
  assert.equal(card.status, 'open');
  assert.equal(card.canonicalId, e.id);
  assert.ok(card.evidence.unusedDays >= 60);
  assert.equal(card.evidence.searchHits, 0);
  assert.equal(p1.batch.type, 'suggestion');
  assert.equal(p1.batch.source, 'decay');
  // idempotent across nightly runs — the raised card is now in the store
  const p2 = planDecaySuggestions({ ...BASE, entries: [e], retrieval: retrieval(), candidates: p1.raise });
  assert.equal(p2.raise.length, 0);
  // dismissed stays dismissed
  const dismissed = [{ ...card, status: 'dismissed' }];
  const p3 = planDecaySuggestions({ ...BASE, entries: [e], retrieval: retrieval(), candidates: dismissed });
  assert.equal(p3.raise.length, 0);
});

test('AC2: digest-included, promoted and recently-retrieved entries are never proposed', () => {
  const evergreen = entry({ id: 'b'.repeat(12), kind: 'convention' }); // zero searches, but in the digest
  const promoted = entry({ id: 'c'.repeat(12), status: 'promoted' });
  const used = entry({ id: 'd'.repeat(12) });
  const stale = entry({ id: 'e'.repeat(12) });
  const p = planDecaySuggestions({
    ...BASE,
    entries: [evergreen, promoted, used, stale],
    retrieval: retrieval({ ['d'.repeat(12)]: { lastSearchAt: '2026-07-20T00:00:00Z', searchHits: 1 } }),
    includedIds: ['b'.repeat(12)],
  });
  assert.deepEqual(p.raise.map((c) => c.canonicalId), ['e'.repeat(12)]);
});

test('AC2: an old retrieval outside the horizon does not protect; any future source (scoped) does', () => {
  const longAgo = entry({ id: 'f'.repeat(12) });
  const scoped = entry({ id: 'ab'.repeat(6) });
  const p = planDecaySuggestions({
    ...BASE,
    entries: [longAgo, scoped],
    retrieval: retrieval({
      ['f'.repeat(12)]: { lastSearchAt: '2026-05-02T00:00:00Z', searchHits: 9 }, // > 60d ago
      ['ab'.repeat(6)]: { lastScopedAt: '2026-07-30T00:00:00Z' },                // #917 forward-compat
    }),
  });
  assert.deepEqual(p.raise.map((c) => c.canonicalId), ['f'.repeat(12)]);
});

test('AC3: cold-start gate — no proposals before the telemetry baseline is a full horizon old', () => {
  const e = entry();
  const young = planDecaySuggestions({ ...BASE, entries: [e], retrieval: { since: '2026-07-01T00:00:00Z', entries: {} } });
  assert.equal(young.raise.length, 0);
  assert.equal(young.skipped, 'cold-start');
  const none = planDecaySuggestions({ ...BASE, entries: [e], retrieval: { since: null, entries: {} } });
  assert.equal(none.skipped, 'cold-start');
});

test('AC5 + youth guard: horizon 0 disables; an entry younger than the horizon is never proposed', () => {
  const p = planDecaySuggestions({ ...BASE, horizonDays: 0, entries: [entry()], retrieval: retrieval() });
  assert.equal(p.raise.length, 0);
  assert.equal(p.skipped, 'disabled');
  const fresh = entry({ id: 'ba'.repeat(6), createdAt: '2026-07-15T00:00:00Z' });
  const p2 = planDecaySuggestions({ ...BASE, entries: [fresh], retrieval: retrieval() });
  assert.equal(p2.raise.length, 0);
});

// ── curation health ─────────────────────────────────────────────────────────

const harvest = (ts) => ({ type: 'harvest', ts, teamId: 'acme' });

test('AC6: counters cover the trailing window; silent = pushes without any raise/promotion', () => {
  const ok = computeCurationHealth({
    teamId: 'acme',
    now: NOW,
    candidates: [
      { id: '1'.repeat(12), status: 'open', raisedAt: '2026-07-20T00:00:00Z' },
      { id: '2'.repeat(12), status: 'promoted', raisedAt: '2026-07-10T00:00:00Z' },
      { id: '3'.repeat(12), status: 'dismissed', raisedAt: '2026-07-10T00:00:00Z', dismissedAt: '2026-07-12T00:00:00Z' },
      { id: '4'.repeat(12), status: 'open', raisedAt: '2026-01-01T00:00:00Z' }, // outside window
    ],
    events: [harvest('2026-07-25T00:00:00Z'), harvest('2026-01-05T00:00:00Z'), { type: 'harvest', ts: '2026-07-26T00:00:00Z', teamId: 'other' }],
  });
  assert.equal(ok.suggestionsRaised, 3);
  assert.equal(ok.promoted, 1);
  assert.equal(ok.dismissed, 1);
  assert.equal(ok.pushesSeen, 1); // windowed + team-scoped
  assert.equal(ok.status, 'ok');

  const silent = computeCurationHealth({
    teamId: 'acme', now: NOW, candidates: [], events: [harvest('2026-07-25T00:00:00Z')],
  });
  assert.equal(silent.status, 'silent');
  // no pushes at all is NOT silent — there was nothing to converge
  const idle = computeCurationHealth({ teamId: 'acme', now: NOW, candidates: [], events: [] });
  assert.equal(idle.status, 'ok');
});

test('AC6: exactly one curation-health event per state transition', () => {
  const okHealth = { status: 'ok' };
  const silentHealth = { status: 'silent' };
  const ev = planHealthTransition(okHealth, silentHealth, { teamId: 'acme', now: NOW });
  assert.equal(ev.type, 'curation-health');
  assert.equal(ev.status, 'silent');
  assert.equal(ev.previous, 'ok');
  assert.equal(planHealthTransition(silentHealth, silentHealth, { teamId: 'acme', now: NOW }), null);
  // first-ever record (no previous file) emits too
  assert.equal(planHealthTransition(null, okHealth, { teamId: 'acme', now: NOW }).previous, null);
});
