'use strict';

// Convergence detection + canonical projection pure core (Shared Agent Learning
// & Knowledge Flow, Phase 3). This is the cross-agent brain that turns the raw,
// per-agent harvest shards into converged canonical facts and promotable
// clusters. It runs in the orchestrator's collector (the ONLY sanctioned
// cross-agent reader — see docs/knowledge-convergence.md §2), so the clustering
// lives here and nowhere else; the admin-console reads pre-clustered canonical
// entries + candidates and never re-clusters.
//
// Deliberately PURE — no fs, no network, an injected `now` — so it is
// unit-testable without booting the orchestrator (repo convention: test pure
// helper cores only). The IO (reading shards, writing/pushing canonical files,
// the candidate store, feed events) lives in orchestrator.js.
//
// Similarity is lexical + dependency-free (Phase 3 decision b): normalized
// token-set Jaccard with an exact-normalized fast path. Everything routes
// through the one `similarity(a, b)` seam, so an embedding backend can slot in
// later (Phase 5) without touching clustering, projection or thresholds.

const crypto = require('crypto');
const { serializeEntry } = require('./knowledge-store');

// ---------------------------------------------------------------------------
// Text normalization + lexical similarity (decision b)
// ---------------------------------------------------------------------------

// Lowercase, strip punctuation to spaces, collapse whitespace. The canonical
// comparison form — two texts that differ only in casing/punctuation/spacing
// normalize to the same string and score 1.0 on the fast path below.
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenSet(text) {
  const norm = normalizeText(text);
  if (norm === '') return new Set();
  return new Set(norm.split(' '));
}

// |A ∩ B| / |A ∪ B|. Two empty sets are treated as identical (1) — but callers
// never compare empty texts (build/validate rejects empty `text` upstream).
function jaccard(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return 0;
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// The single similarity seam. Exact-normalized match short-circuits to 1.0;
// otherwise token-set Jaccard. Range [0, 1]. Embeddings would replace ONLY this.
function similarity(aText, bText) {
  const na = normalizeText(aText);
  const nb = normalizeText(bText);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  return jaccard(tokenSet(aText), tokenSet(bText));
}

function similar(aText, bText, threshold) {
  const t = Number.isFinite(threshold) ? threshold : 0.6;
  return similarity(aText, bText) >= t;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

// Non-tombstone, well-formed entries only (a merge tombstone or a mangled line
// must never seed a cluster). parseEntry already dropped unparseable lines.
function isClusterable(e) {
  return (
    e &&
    typeof e === 'object' &&
    typeof e.id === 'string' &&
    e.id.trim() !== '' &&
    typeof e.text === 'string' &&
    e.text.trim() !== '' &&
    e.status !== 'merged'
  );
}

function entryCreatedMs(e) {
  const t = e && e.createdAt ? Date.parse(e.createdAt) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Deterministic member order: oldest first, id as the tiebreak. The FIRST member
// is the canonical winner, so re-running the collector always picks the same id.
function sortMembers(members) {
  return members.slice().sort(
    (a, b) => entryCreatedMs(a) - entryCreatedMs(b) || String(a.id).localeCompare(String(b.id)),
  );
}

// The distinct union of every member's originAgent + existing convergence[].
// "Independent" = distinct agent id; the same agent recording twice does not
// grow convergence. Sorted for determinism.
function unionConvergence(members) {
  const seen = new Set();
  for (const m of members) {
    if (typeof m.originAgent === 'string' && m.originAgent.trim()) seen.add(m.originAgent.trim());
    if (Array.isArray(m.convergence)) {
      for (const c of m.convergence) if (typeof c === 'string' && c.trim()) seen.add(c.trim());
    }
  }
  return [...seen].sort();
}

// Single-link agglomerative clustering WITHIN one kind: an entry joins a cluster
// if it is `similar` to ANY member. O(n²) in the worst case, which is fine for a
// team KB (hundreds of entries) and keeps the logic obvious.
function clusterEntriesOfKind(entries, simThreshold) {
  const items = sortMembers((entries || []).filter(isClusterable));
  const clusters = [];
  for (const e of items) {
    let joined = null;
    for (const c of clusters) {
      if (c.members.some((m) => similar(m.text, e.text, simThreshold))) {
        c.members.push(e);
        joined = c;
        break;
      }
    }
    if (!joined) clusters.push({ members: [e] });
  }
  return clusters.map((c) => {
    const members = sortMembers(c.members);
    const winner = members[0];
    const convergence = unionConvergence(members);
    return {
      canonicalId: winner.id,
      kind: winner.kind,
      teamId: winner.teamId,
      text: winner.text,
      memberIds: members.map((m) => m.id),
      members,
      convergence,
      convergenceCount: convergence.length,
    };
  });
}

/**
 * Cluster entries across all kinds. Kinds never cross-cluster.
 * @param {object[]} entries  raw parsed shard entries (any agents)
 * @param {{simThreshold?: number}} opts
 * @returns {object[]} clusters (see clusterEntriesOfKind)
 */
function clusterEntries(entries, { simThreshold = 0.6 } = {}) {
  const byKind = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isClusterable(e)) continue;
    const kind = typeof e.kind === 'string' ? e.kind : 'fact';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(e);
  }
  const out = [];
  for (const [, group] of byKind) out.push(...clusterEntriesOfKind(group, simThreshold));
  // Stable overall order: kind, then canonical createdAt, then id.
  return out.sort(
    (a, b) =>
      String(a.kind).localeCompare(String(b.kind)) ||
      entryCreatedMs(a.members[0]) - entryCreatedMs(b.members[0]) ||
      String(a.canonicalId).localeCompare(String(b.canonicalId)),
  );
}

// ---------------------------------------------------------------------------
// Canonical projection (decision c) — one canonical entry per cluster + a
// status:"merged" tombstone per absorbed id. Shards are NEVER touched.
// ---------------------------------------------------------------------------

// A minimal, valid-enough tombstone line so parseEntry keeps it and foldMerges
// (admin-console) can resolve the redirect. Carries the absorbed entry's own
// provenance so nothing is lost.
function mergedTombstone(absorbed, canonicalId, now) {
  const t = {
    v: absorbed.v || 1,
    id: absorbed.id,
    kind: absorbed.kind,
    text: absorbed.text,
    originAgent: absorbed.originAgent,
    teamId: absorbed.teamId,
    createdAt: absorbed.createdAt,
  };
  if (absorbed.correlationId) t.correlationId = absorbed.correlationId;
  if (absorbed.sessionId) t.sessionId = absorbed.sessionId;
  if (Array.isArray(absorbed.sourceRefs) && absorbed.sourceRefs.length) t.sourceRefs = absorbed.sourceRefs;
  t.convergence = Array.isArray(absorbed.convergence) && absorbed.convergence.length
    ? absorbed.convergence
    : [absorbed.originAgent];
  if (Array.isArray(absorbed.tags) && absorbed.tags.length) t.tags = absorbed.tags;
  t.status = 'merged';
  t.mergedInto = canonicalId;
  t.updatedAt = now;
  return t;
}

// The grown canonical entry for a cluster: the winner with convergence unioned,
// status forced back to active (a re-merge un-tombstones nothing — the winner is
// always a live entry), updatedAt refreshed only when convergence actually grew.
function canonicalEntry(cluster, now) {
  const winner = cluster.members[0];
  const grewConvergence =
    cluster.convergence.length > (Array.isArray(winner.convergence) ? winner.convergence.length : 0);
  const out = { ...winner, convergence: cluster.convergence };
  if (out.status === 'merged') delete out.mergedInto;
  out.status = out.status === 'promoted' ? 'promoted' : 'active';
  if (grewConvergence || cluster.members.length > 1) {
    out.updatedAt = winner.updatedAt && !grewConvergence ? winner.updatedAt : now;
  }
  return out;
}

/**
 * Build the canonical projection from all shard entries.
 * @param {object[]} entries  raw parsed shard entries
 * @param {{simThreshold?: number, now?: string}} opts
 * @returns {{ clusters, byKind: { canonical, tombstones }, lines: { <kind>: string[] } }}
 *   `lines[kind]` is the exact JSONL body (canonical entries then tombstones,
 *   deterministic) the collector writes to <kind>/<kind>.jsonl — so re-running
 *   yields byte-identical files (idempotent, no spurious git churn).
 */
function buildCanonicalProjection(entries, { simThreshold = 0.6, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const clusters = clusterEntries(entries, { simThreshold });
  const byKind = {};
  for (const c of clusters) {
    if (!byKind[c.kind]) byKind[c.kind] = { canonical: [], tombstones: [] };
    byKind[c.kind].canonical.push(canonicalEntry(c, ts));
    for (const m of c.members.slice(1)) {
      byKind[c.kind].tombstones.push(mergedTombstone(m, c.canonicalId, ts));
    }
  }
  const lines = {};
  for (const kind of Object.keys(byKind)) {
    const { canonical, tombstones } = byKind[kind];
    // Canonical entries first (sorted by createdAt/id), then tombstones (by id) —
    // a fixed order so the file is a pure function of the shards.
    const sortedCanon = canonical.slice().sort(
      (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || String(a.id).localeCompare(String(b.id)),
    );
    const sortedTombs = tombstones.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    lines[kind] = [...sortedCanon, ...sortedTombs].map(serializeEntry);
  }
  return { clusters, byKind, lines };
}

// ---------------------------------------------------------------------------
// Promotion suggestions
// ---------------------------------------------------------------------------

function crossesConvergence(cluster, threshold) {
  const t = Number.isInteger(threshold) && threshold >= 2 ? threshold : 2;
  return !!cluster && Array.isArray(cluster.convergence) && cluster.convergence.length >= t;
}

// A stable id for a suggestion candidate: a hash of kind + the sorted member id
// set, so the same cluster maps to the same candidate id regardless of member
// order or how many times the collector re-runs (idempotent dedup + debounce).
function stableSuggestionId(cluster) {
  const kind = (cluster && cluster.kind) || 'fact';
  const ids = Array.isArray(cluster && cluster.memberIds) ? cluster.memberIds.slice().sort() : [];
  const h = crypto.createHash('sha1').update(`${kind}:${ids.join(',')}`).digest('hex');
  return h.slice(0, 12);
}

// Shape a cluster into a candidate record (the per-team suggestions store row).
// LLM-free — the SKILL.md draft is generated lazily in the admin-console.
function toCandidate(cluster, { teamId, source = 'convergence', note, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const members = (cluster.members || []).map((m) => ({
    id: m.id,
    originAgent: m.originAgent,
    text: m.text,
    createdAt: m.createdAt,
    correlationId: m.correlationId || null,
    sessionId: m.sessionId || null,
  }));
  const cand = {
    id: stableSuggestionId(cluster),
    teamId: typeof teamId === 'string' ? teamId : (cluster.teamId || 'default'),
    kind: cluster.kind,
    canonicalId: cluster.canonicalId,
    entryIds: cluster.memberIds.slice(),
    convergence: cluster.convergence.slice(),
    convergenceCount: cluster.convergenceCount,
    text: cluster.text,
    members,
    source,
    status: 'open',
    raisedAt: ts,
  };
  if (typeof note === 'string' && note.trim()) cand.note = note.trim();
  return cand;
}

/**
 * Decide which clusters are NEWLY promotable, skipping any already represented
 * by an existing open/promoted candidate (idempotency), and produce ONE batched
 * feed-event summary (the #449 burst-cap-style debounce, so cards arrive grouped
 * rather than one-per-fact).
 *
 * @param {object[]} clusters   from clusterEntries/buildCanonicalProjection
 * @param {object[]} existing   the team's current candidate store rows
 * @param {{ threshold?: number, teamId?: string, now?: string }} opts
 * @returns {{ raise: object[], batch: object|null }}
 *   raise: new candidate rows to persist; batch: the `suggestion` feed event
 *   (null when nothing new).
 */
function planNewSuggestions(clusters, existing, { threshold = 2, teamId, now } = {}) {
  const known = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter((c) => c && (c.status === 'open' || c.status === 'promoted'))
      .map((c) => c.id),
  );
  const raise = [];
  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    if (!crossesConvergence(cluster, threshold)) continue;
    const cand = toCandidate(cluster, { teamId, source: 'convergence', now });
    if (known.has(cand.id)) continue;
    raise.push(cand);
  }
  if (raise.length === 0) return { raise: [], batch: null };
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const batch = {
    type: 'suggestion',
    ts,
    teamId: typeof teamId === 'string' ? teamId : null,
    count: raise.length,
    samples: raise.slice(0, 5).map((c) => ({ id: c.id, canonicalId: c.canonicalId, text: c.text, convergenceCount: c.convergenceCount })),
  };
  return { raise, batch };
}

module.exports = {
  normalizeText,
  tokenSet,
  jaccard,
  similarity,
  similar,
  isClusterable,
  clusterEntries,
  mergedTombstone,
  canonicalEntry,
  buildCanonicalProjection,
  crossesConvergence,
  stableSuggestionId,
  toCandidate,
  planNewSuggestions,
};
