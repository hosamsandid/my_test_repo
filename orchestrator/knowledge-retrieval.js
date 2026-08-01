'use strict';

// Read-side retrieval telemetry pure core (#915, Gap 1 of the KM future-proofing
// epic #914).
//
// The write path has emitted `harvest` events since Phase 2; this module adds
// the missing READ signal: every `knowledge search`/`list` (strong — the agent
// explicitly looked) and every digest injection (weak — inlined unconditionally)
// updates a compact per-team AGGREGATE, one row per entry — never an unbounded
// event log, and never a line in events.jsonl (the UI feed has no retention).
// The aggregate is what "last used" surfaces in the UI and what the Gap-5 decay
// sweep (#919) consumes; `since` is its cold-start baseline (an entry cannot be
// declared dead over a window in which nothing was being measured).
//
// Deliberately PURE — no fs, no network, no clock beyond an injected `ts` — so
// it is unit-testable without booting the orchestrator (repo convention: test
// pure helper cores only). The IO (the per-team JSON file, atomic tmp+rename)
// lives in orchestrator.js.

// `search` = the agent explicitly looked (also emitted by `knowledge list`);
// `digest` = inlined into knowledge-digest.md at rebuild. #917 will add
// `scoped` here when the trigger-based loading layer lands.
const RETRIEVAL_SOURCES = ['search', 'digest'];

const ID_RE = /^[0-9a-f]{12}$/;

// Validate a retrieval report (the POST body). Returns
// { ok: true, source, entryIds, ts } or { ok: false, error }. `now` is the
// injected server clock used when the caller sent no (or an unparseable) ts —
// the emitters are best-effort fire-and-forget, so their clock is advisory.
function validateRetrieval(body, { now } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const source = typeof b.source === 'string' ? b.source.trim() : '';
  if (!RETRIEVAL_SOURCES.includes(source)) {
    return { ok: false, error: `source must be one of ${RETRIEVAL_SOURCES.join('|')}` };
  }
  const entryIds = [...new Set(
    (Array.isArray(b.entryIds) ? b.entryIds : []).filter((x) => typeof x === 'string' && ID_RE.test(x)),
  )];
  if (entryIds.length === 0) return { ok: false, error: 'entryIds must contain at least one 12-char hex id' };
  let ts = typeof b.ts === 'string' && !Number.isNaN(Date.parse(b.ts)) ? b.ts.trim() : '';
  if (!ts) ts = typeof now === 'string' ? now : '';
  if (!ts) return { ok: false, error: 'no usable timestamp' };
  return { ok: true, source, entryIds, ts };
}

// Fold one validated retrieval report into the aggregate. Never mutates the
// input; returns the next aggregate. Shape:
//   { since: "<ISO first-write>", entries: { "<entryId>": {
//       lastSearchAt?, searchHits?, lastDigestAt?, digestCount? } } }
// `since` is stamped on the first-ever report and then preserved.
function applyRetrieval(stats, { source, entryIds, ts }) {
  const prev = stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
  const prevEntries = prev.entries && typeof prev.entries === 'object' && !Array.isArray(prev.entries)
    ? prev.entries
    : {};
  const entries = { ...prevEntries };
  for (const id of entryIds) {
    const row = entries[id] && typeof entries[id] === 'object' ? { ...entries[id] } : {};
    if (source === 'search') {
      row.lastSearchAt = ts;
      row.searchHits = (Number.isInteger(row.searchHits) && row.searchHits >= 0 ? row.searchHits : 0) + 1;
    } else {
      row.lastDigestAt = ts;
      row.digestCount = (Number.isInteger(row.digestCount) && row.digestCount >= 0 ? row.digestCount : 0) + 1;
    }
    entries[id] = row;
  }
  return {
    since: typeof prev.since === 'string' && prev.since ? prev.since : ts,
    entries,
  };
}

// The freshest use of one aggregate row, across both signals — what "Last used"
// renders and what the decay sweep compares against its horizon. Null when the
// entry has never been retrieved.
function lastUsedAt(row) {
  const r = row && typeof row === 'object' ? row : {};
  const a = typeof r.lastSearchAt === 'string' ? r.lastSearchAt : '';
  const b = typeof r.lastDigestAt === 'string' ? r.lastDigestAt : '';
  const max = a > b ? a : b;
  return max || null;
}

module.exports = { RETRIEVAL_SOURCES, validateRetrieval, applyRetrieval, lastUsedAt };
