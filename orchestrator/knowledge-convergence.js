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
// #918: pure cosine helpers only — the seam consumes pre-computed vectors via
// the optional `semantic` clustering context; no model, no IO in this module.
const knowledgeEmbeddings = require('./knowledge-embeddings');

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
// otherwise token-set Jaccard. Range [0, 1]. The #918 embedding layer plugs in
// BESIDE this (semanticLinks below), never replacing it: lexical is the cheap
// pre-filter and the always-there fallback.
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

// #918 semantic layer. `semantic` is the optional clustering context:
//   { vectors: Map<entryId, number[]>, cosineThreshold }
// built by the caller from the backstop-computed vector cache (only vectors
// whose contentHash still matches the entry's text). Two entries link
// semantically when BOTH have a cached vector and their cosine (clamped to
// [0,1]) reaches the threshold. No context / no vector ⇒ false — behaviour is
// bit-for-bit lexical-only, which is the disabled default.
function semanticLinks(a, b, semantic) {
  if (!semantic || !(semantic.vectors instanceof Map)) return false;
  const va = semantic.vectors.get(a && a.id);
  const vb = semantic.vectors.get(b && b.id);
  if (!va || !vb) return false;
  const t = Number.isFinite(semantic.cosineThreshold) ? semantic.cosineThreshold : 0.8;
  return knowledgeEmbeddings.cosineUnit(va, vb) >= t;
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

// The effective kind of an entry — entries may omit `kind` (defaults to "fact",
// the same default the store and canonical projection use).
function entryKind(e) {
  return e && typeof e.kind === 'string' ? e.kind : 'fact';
}

// Do two clusterable entries belong in the same cluster?
//  - SAME kind: the normal `similar` test (exact-normalized fast path OR fuzzy
//    Jaccard >= threshold) — unchanged Phase-3 behaviour.
//  - DIFFERENT kind: only an EXACT normalized-text match links them (C1, #605).
//    The same lesson recorded once as a `fact` and once as a `convention` is one
//    lesson and must converge; a merely fuzzy cross-kind pair is left apart to
//    avoid over-merging differently-phrased lessons of different kinds.
//  - SEMANTIC (#918): a same-kind pair may also link on embedding cosine when
//    the optional `semantic` context supplies vectors for both — additive, so
//    without the context this is exactly the Phase-3 lexical behaviour.
//    Cross-kind linking deliberately stays exact-only (embeddings would
//    reintroduce the over-merging #605 ruled out).
// Operates over entries whose `normalizeText` + `tokenSet` were computed ONCE up
// front (`prepareEntry` / `clusterEntries`). The naive form recomputes both —
// four `normalizeText` passes over the full text per pair — and the clustering
// below calls this O(n²) times, so at a few thousand entries the redundant
// Unicode-regex work pegged the single-threaded control plane for ~15-20 s per
// collector pass. Precomputing makes it a cheap set-intersection per pair.
// Semantics (unchanged, #605/#918):
//   - SAME kind: exact-normalized fast path OR token-set Jaccard >= threshold,
//     OR the optional embedding-cosine `semanticLinks` when context supplies both
//     vectors (additive — without context this is pure lexical behaviour).
//   - DIFFERENT kind: only an EXACT normalized-text match links, so one lesson
//     recorded under two kinds converges while fuzzy matches stay within a kind.
// `a`/`b` are `{ entry, kind, norm, tokens }` prepared records.
function entriesLinkPrepared(a, b, simThreshold, semantic = null) {
  const t = Number.isFinite(simThreshold) ? simThreshold : 0.6;
  if (a.kind === b.kind) {
    // similar(): exact-normalized fast path OR token-set Jaccard >= threshold.
    // Both empty-norm cases score 0 in similarity(), i.e. never link on text.
    if (a.norm !== '' && b.norm !== '' && (a.norm === b.norm || jaccard(a.tokens, b.tokens) >= t)) {
      return true;
    }
    return semanticLinks(a.entry, b.entry, semantic);
  }
  // Different kind: only an EXACT normalized-text match links (C1, #605).
  return a.norm !== '' && a.norm === b.norm;
}

// Precompute the canonical comparison forms once per entry.
function prepareEntry(e) {
  return { entry: e, kind: entryKind(e), norm: normalizeText(e.text), tokens: tokenSet(e.text) };
}

// Shape a settled member list into a cluster record. The FIRST member (oldest,
// id tiebreak — see sortMembers) is the canonical winner, so its kind is the
// deterministic canonical kind even for a cross-kind (exact-match) cluster.
function buildCluster(memberList) {
  const members = sortMembers(memberList);
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
}

/**
 * Single-link agglomerative clustering over ALL clusterable entries: an entry
 * joins a cluster if it `entriesLinkPrepared`s ANY member. Same-kind entries link by
 * similarity (exact or fuzzy); different-kind entries link only on an exact
 * normalized-text match (C1, #605), so an identical lesson recorded under two
 * kinds converges while fuzzy matches stay within one kind. O(n²) worst case,
 * fine for a team KB (hundreds of entries) and keeps the logic obvious.
 * @param {object[]} entries  raw parsed shard entries (any agents, any kinds)
 * @param {{simThreshold?: number, semantic?: {vectors: Map, cosineThreshold: number}|null}} opts
 * @returns {object[]} clusters (see buildCluster)
 */
function clusterEntries(entries, { simThreshold = 0.6, semantic = null } = {}) {
  const items = sortMembers((Array.isArray(entries) ? entries : []).filter(isClusterable));
  // Normalize + tokenize each entry ONCE (was recomputed on every pairwise link
  // test — the O(n²) hot path that stalled the event loop; see entriesLinkPrepared).
  const preps = items.map(prepareEntry);
  const clusters = [];
  for (const p of preps) {
    let joined = null;
    for (const c of clusters) {
      // Lexical first (cheap, always-on); a link that only holds semantically
      // flags the cluster so the suggestion card can show the "semantic match"
      // hint — an operator sanity-checks a surprising grouping before promoting.
      const lexicalHit = c.members.some((m) => entriesLinkPrepared(m, p, simThreshold));
      if (lexicalHit || (semantic && c.members.some((m) => entriesLinkPrepared(m, p, simThreshold, semantic)))) {
        if (!lexicalHit) c.semanticLink = true;
        c.members.push(p);
        joined = c;
        break;
      }
    }
    if (!joined) clusters.push({ members: [p] });
  }
  // Stable overall order: kind, then canonical createdAt, then id.
  return clusters.map((c) => {
    const cluster = buildCluster(c.members.map((m) => m.entry));
    if (c.semanticLink) cluster.semanticLink = true;
    return cluster;
  }).sort(
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

// Team-scope the clustering input (#603). Multiple teams working the same repo
// share ONE `agent-knowledge` branch, so a team's canonical clone physically
// contains the OTHER teams' shards. Convergence, the candidate store, suggestions
// and auto-promotion must all operate on this team's own knowledge only — filter
// the raw shard entries to the squad `memberIds` (agents whose knowledge belongs
// to this team) BEFORE projecting. `originAgent` is a required provenance field
// on every stored entry, so an entry whose originAgent is not a known member is a
// co-tenant team's shard and is dropped. When every entry is already team-owned
// (a team on its own, unshared branch) this is the identity function.
function filterEntriesToTeam(entries, memberIds) {
  if (!Array.isArray(entries)) return [];
  const members = memberIds instanceof Set
    ? memberIds
    : new Set(Array.isArray(memberIds) ? memberIds : []);
  return entries.filter((e) => {
    const origin = e && typeof e.originAgent === 'string' ? e.originAgent.trim() : '';
    return origin !== '' && members.has(origin);
  });
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
function buildCanonicalProjection(entries, { simThreshold = 0.6, semantic = null, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const clusters = clusterEntries(entries, { simThreshold, semantic });
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
    // Carried so the skill-provenance builders (admin-console
    // buildSkillProvenance, knowledge-curator curatorSkillProvenance) can trace
    // the promoted skill back to its PR/issue/commit.
    ...(Array.isArray(m.sourceRefs) && m.sourceRefs.length ? { sourceRefs: m.sourceRefs } : {}),
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
  // #918: at least one member joined this cluster on embedding cosine alone —
  // the card shows a "semantic match" hint so the operator can sanity-check.
  if (cluster.semanticLink) cand.semanticMatch = true;
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
  // Dismissed is in the known set on purpose: the operator said no to exactly
  // this member set (stable id). A grown cluster gets a new id and re-raises —
  // same semantics the level-3 curator applies in planAutoPromotions.
  const known = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter((c) => c && (c.status === 'open' || c.status === 'promoted' || c.status === 'dismissed'))
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

// ---------------------------------------------------------------------------
// Digest-only routing (#779, skill-aggregation Phase 1)
// ---------------------------------------------------------------------------
//
// A single converged convention/fact is already GUARANTEED in every agent's
// context via the knowledge digest (buildKnowledgeDigest injects exactly this
// class of content), so wrapping it in its own micro-skill adds no delivery
// value — only governance noise. This planner sits in FRONT of the single-cluster
// candidate/auto-promotion path: it classifies each converged cluster and pulls
// the digest-delivered ones out so they raise no candidate and no card. It is
// thresholded, not absolute: a cluster that keeps recurring (>= graduateAtAgents
// distinct agents) GRADUATES to a real candidate. Themes (multi-lesson synthesis)
// and non-collector paths (agent `knowledge promote`, manual combine) are never
// routed here — they are the preserved escape hatches.

// Kinds the digest reliably delivers as small, self-contained bullets. `entity`
// is intentionally excluded: an entity is a structural reference, not a one-line
// lesson, so it never routes digest-only. Frozen so a caller can't mutate it.
const DIGEST_DELIVERED_KINDS = Object.freeze(['convention', 'fact']);

/**
 * Classify one converged cluster for skill-candidate routing (#779).
 * @param {object} cluster  a cluster from clusterEntries/buildCanonicalProjection
 * @param {{ threshold?: number, graduateAtAgents?: number, digestKinds?: string[] }} opts
 * @returns {'not-converged'|'digest-only'|'candidate'}
 *   - 'not-converged': below the convergence threshold (raises nothing anyway).
 *   - 'digest-only':   a digest-delivered kind, converged but not yet graduated —
 *                      the digest already delivers it, so no candidate/card.
 *   - 'candidate':     eligible for a promotion candidate (a non-digest kind, or a
 *                      graduated cluster whose recurrence >= graduateAtAgents).
 */
function classifyClusterRouting(cluster, { threshold = 2, graduateAtAgents = 4, digestKinds = DIGEST_DELIVERED_KINDS } = {}) {
  if (!crossesConvergence(cluster, threshold)) return 'not-converged';
  const kinds = Array.isArray(digestKinds) ? digestKinds : DIGEST_DELIVERED_KINDS;
  const kind = (cluster && typeof cluster.kind === 'string') ? cluster.kind : 'fact';
  if (!kinds.includes(kind)) return 'candidate';
  const grad = Number.isInteger(graduateAtAgents) && graduateAtAgents > threshold
    ? graduateAtAgents
    : Math.max(threshold + 1, 4);
  const count = Number(cluster && cluster.convergenceCount);
  if (Number.isFinite(count) && count >= grad) return 'candidate';
  return 'digest-only';
}

// A lean, auditable record of a digest-only routing decision — stored on the
// candidate store (status:"digest-only", never rendered as an open card) and
// summarised in the feed event. Keyed by the SAME stable id a candidate would
// carry, so when the cluster grows (a new member ⇒ a new member-id set ⇒ a new
// stable id) it is naturally NOT the same row and re-classifies from scratch.
function toDigestOnlyRow(cluster, { teamId, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id: stableSuggestionId(cluster),
    teamId: typeof teamId === 'string' ? teamId : (cluster.teamId || 'default'),
    kind: cluster.kind,
    canonicalId: cluster.canonicalId,
    entryIds: (Array.isArray(cluster.memberIds) ? cluster.memberIds : []).slice(),
    convergence: (Array.isArray(cluster.convergence) ? cluster.convergence : []).slice(),
    convergenceCount: cluster.convergenceCount,
    text: cluster.text,
    source: 'convergence',
    status: 'digest-only',
    routedAt: ts,
  };
}

/**
 * Route the converged clusters for the single-cluster candidate path (#779).
 * Splits the input into the clusters still eligible to become a candidate and the
 * ones the digest already delivers, and produces the new digest-only store rows
 * (idempotent against the candidate store by stable id) plus ONE batched feed
 * event summarising newly-routed decisions.
 *
 * @param {object[]} clusters  converged clusters (from buildCanonicalProjection)
 * @param {object[]} existing  the team's current candidate store rows
 * @param {{ threshold?: number, graduateAtAgents?: number, digestKinds?: string[],
 *           teamId?: string, now?: string }} opts
 * @returns {{ candidateClusters, digestOnlyClusters, digestOnlyCanonicalIds:Set,
 *             rows: object[], batch: object|null }}
 *   candidateClusters:      pass these to planNewSuggestions / planAutoPromotions.
 *   digestOnlyClusters:     the routed-out clusters (kept in the THEME path).
 *   digestOnlyCanonicalIds: Set of their canonicalIds (for filtering elsewhere).
 *   rows:                   NEW digest-only rows to persist (not already known).
 *   batch:                  the `digest-routing` feed event (null when nothing new).
 */
function planDigestRouting(clusters, existing, { threshold = 2, graduateAtAgents = 4, digestKinds = DIGEST_DELIVERED_KINDS, teamId, now } = {}) {
  const list = Array.isArray(clusters) ? clusters : [];
  // Any row with this stable id already recorded (open/promoted/dismissed candidate
  // OR a prior digest-only decision) ⇒ don't re-emit the feed event for it.
  const known = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter((c) => c && ['open', 'promoted', 'dismissed', 'digest-only'].includes(c.status))
      .map((c) => c.id),
  );
  const candidateClusters = [];
  const digestOnlyClusters = [];
  const digestOnlyCanonicalIds = new Set();
  const rows = [];
  for (const cluster of list) {
    const routing = classifyClusterRouting(cluster, { threshold, graduateAtAgents, digestKinds });
    if (routing === 'digest-only') {
      digestOnlyClusters.push(cluster);
      if (cluster && cluster.canonicalId) digestOnlyCanonicalIds.add(cluster.canonicalId);
      const row = toDigestOnlyRow(cluster, { teamId, now });
      if (!known.has(row.id)) rows.push(row);
    } else {
      // 'candidate' and 'not-converged' both stay in the candidate path — the
      // downstream planners already skip non-converged clusters.
      candidateClusters.push(cluster);
    }
  }
  let batch = null;
  if (rows.length > 0) {
    const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    batch = {
      type: 'digest-routing',
      ts,
      teamId: typeof teamId === 'string' ? teamId : null,
      count: rows.length,
      samples: rows.slice(0, 5).map((r) => ({
        id: r.id, canonicalId: r.canonicalId, kind: r.kind, text: r.text, convergenceCount: r.convergenceCount,
      })),
    };
  }
  return { candidateClusters, digestOnlyClusters, digestOnlyCanonicalIds, rows, batch };
}

// ---------------------------------------------------------------------------
// Related-theme aggregation
// ---------------------------------------------------------------------------
//
// Convergence (above) finds the SAME lesson recorded by several agents. A skill,
// however, is typically a SYNTHESIS: several distinct-but-related lessons about
// one topic ("how we handle GitHub labels") that only together make a coherent,
// reusable instruction. This second, looser stage groups the already-converged
// clusters into topic themes — across kinds, since a convention + the facts
// around it belong in one skill — and raises ONE combined promotion suggestion
// per qualifying theme (source: "related"). Themes are never auto-promoted, even
// at autonomy 3: synthesising distinct lessons into one skill needs judgment, so
// they always surface as review cards.

// Topic tokens: the normalized tokens long enough to carry topic meaning
// (drops "the", "for", "a", ... without needing a stopword list).
function topicTokens(text) {
  return new Set([...tokenSet(text)].filter((t) => t.length >= 4));
}

// Relatedness = overlap coefficient (|A∩B| / min|A|,|B|) over topic tokens.
// Jaccard (the convergence seam) punishes length differences — two long,
// distinct sentences about one topic score ~0.1 — while the overlap
// coefficient asks "how much of the SMALLER lesson's vocabulary appears in
// the other", which is the right question for topical relatedness.
function relatedness(aText, bText) {
  const a = topicTokens(aText);
  const b = topicTokens(bText);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

// Single-link grouping of clusters by topical relatedness. Cross-kind on
// purpose (a convention + the facts around it belong in one skill). Returns
// only groups of >= 2 clusters — a lone cluster is not a theme.
function groupRelatedClusters(clusters, { relatedThreshold = 0.3 } = {}) {
  const list = (Array.isArray(clusters) ? clusters : []).filter(
    (c) => c && typeof c.text === 'string' && c.text.trim() !== '' && Array.isArray(c.memberIds),
  );
  // One token set per cluster, computed once — the O(n²) pairwise loop below
  // must not re-tokenize the same texts on every comparison.
  const toks = new Map(list.map((c) => [c, topicTokens(c.text)]));
  const related = (a, b) => {
    const ta = toks.get(a);
    const tb = toks.get(b);
    if (ta.size === 0 || tb.size === 0) return false;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter += 1;
    return inter / Math.min(ta.size, tb.size) >= relatedThreshold;
  };
  const groups = [];
  for (const c of list) {
    let joined = null;
    for (const g of groups) {
      if (g.some((m) => related(m, c))) {
        g.push(c);
        joined = g;
        break;
      }
    }
    if (!joined) groups.push([c]);
  }
  return groups.filter((g) => g.length >= 2);
}

// A theme is worth suggesting when it is either broad (>= strongLessons distinct
// lessons — even a single agent accumulating a topic deserves the card) or
// cross-agent (>= minLessons lessons from >= minAgents distinct agents — the
// theme-level analogue of "2× independent").
function themeQualifies(group, { minLessons = 2, minAgents = 2, strongLessons = 3 } = {}) {
  const g = Array.isArray(group) ? group : [];
  if (g.length >= strongLessons) return true;
  if (g.length < minLessons) return false;
  const agents = new Set();
  for (const c of g) for (const a of c.convergence || []) agents.add(a);
  return agents.size >= minAgents;
}

// Shape a qualifying theme into a candidate row. Same shape toCandidate emits,
// plus: source "related", `kinds` (the distinct kinds bundled), and
// `lessonCount` (distinct lessons — clusters — in the theme). The id hashes the
// full member-id set under the pseudo-kind "related" so it can never collide
// with a single-cluster convergence candidate over the same entries.
function themeToCandidate(group, { teamId, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const clusters = sortThemeClusters(group);
  const lead = clusters[0];
  const members = [];
  const seen = new Set();
  for (const c of clusters) {
    for (const m of c.members || []) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      members.push({
        id: m.id,
        originAgent: m.originAgent,
        text: m.text,
        createdAt: m.createdAt,
        correlationId: m.correlationId || null,
        sessionId: m.sessionId || null,
        ...(Array.isArray(m.sourceRefs) && m.sourceRefs.length ? { sourceRefs: m.sourceRefs } : {}),
      });
    }
  }
  const agents = new Set();
  for (const c of clusters) for (const a of c.convergence || []) agents.add(a);
  const convergence = [...agents].sort();
  const memberIds = members.map((m) => m.id);
  const kinds = [...new Set(clusters.map((c) => c.kind))].sort();
  return {
    id: stableSuggestionId({ kind: 'related', memberIds }),
    teamId: typeof teamId === 'string' ? teamId : (lead.teamId || 'default'),
    kind: dominantKind(clusters),
    kinds,
    canonicalId: lead.canonicalId,
    entryIds: memberIds.slice(),
    convergence,
    convergenceCount: convergence.length,
    lessonCount: clusters.length,
    text: lead.text,
    members,
    source: 'related',
    status: 'open',
    raisedAt: ts,
  };
}

function sortThemeClusters(group) {
  return (Array.isArray(group) ? group : []).slice().sort(
    (a, b) => entryCreatedMs(a.members && a.members[0]) - entryCreatedMs(b.members && b.members[0])
      || String(a.canonicalId).localeCompare(String(b.canonicalId)),
  );
}

function dominantKind(clusters) {
  const counts = new Map();
  for (const c of clusters) counts.set(c.kind, (counts.get(c.kind) || 0) + 1);
  let best = 'fact';
  let bestN = -1;
  for (const [k, n] of [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

/**
 * Decide which related themes are NEWLY suggestable. Mirrors planNewSuggestions:
 * idempotent against the candidate store (open/promoted/dismissed by stable id),
 * one batched feed event. Clusters whose knowledge already backs a promoted
 * skill are excluded from grouping — re-suggesting promoted knowledge is noise.
 *
 * @param {object[]} clusters   from clusterEntries/buildCanonicalProjection
 * @param {object[]} existing   the team's current candidate store rows
 * @param {{ relatedThreshold?: number, minLessons?: number, minAgents?: number,
 *           strongLessons?: number, teamId?: string, now?: string }} opts
 * @returns {{ raise: object[], batch: object|null }}
 */
function planRelatedSuggestions(clusters, existing, {
  relatedThreshold = 0.3, minLessons = 2, minAgents = 2, strongLessons = 3, teamId, now,
} = {}) {
  const rows = Array.isArray(existing) ? existing : [];
  const known = new Set(
    rows
      .filter((c) => c && (c.status === 'open' || c.status === 'promoted' || c.status === 'dismissed'))
      .map((c) => c.id),
  );
  const promotedEntryIds = new Set();
  const promotedCanonicalIds = new Set();
  for (const c of rows) {
    if (!c || c.status !== 'promoted') continue;
    if (c.canonicalId) promotedCanonicalIds.add(c.canonicalId);
    for (const id of c.entryIds || []) promotedEntryIds.add(id);
  }
  const eligible = (Array.isArray(clusters) ? clusters : []).filter((c) => {
    if (!c) return false;
    if (promotedCanonicalIds.has(c.canonicalId)) return false;
    const ids = Array.isArray(c.memberIds) ? c.memberIds : [];
    if (ids.length > 0 && ids.every((id) => promotedEntryIds.has(id))) return false;
    return true;
  });
  const raise = [];
  for (const group of groupRelatedClusters(eligible, { relatedThreshold })) {
    if (!themeQualifies(group, { minLessons, minAgents, strongLessons })) continue;
    const cand = themeToCandidate(group, { teamId, now });
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
    samples: raise.slice(0, 5).map((c) => ({
      id: c.id, canonicalId: c.canonicalId, text: c.text,
      convergenceCount: c.convergenceCount, lessonCount: c.lessonCount, source: 'related',
    })),
  };
  return { raise, batch };
}

/**
 * Canonical ids of clusters fully covered by an open/promoted AGGREGATED
 * candidate's entry set — a raised related-theme card, or a manual combine the
 * operator already promoted. Used by the collector so a lesson that is already
 * part of such a bundle does not also raise its own single-lesson card.
 */
function clustersCoveredByThemes(clusters, candidates) {
  const themeSets = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && (c.source === 'related' || c.source === 'manual')
      && (c.status === 'open' || c.status === 'promoted'))
    .map((t) => new Set(t.entryIds || []));
  const covered = new Set();
  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    if (!cluster || !Array.isArray(cluster.memberIds) || cluster.memberIds.length === 0) continue;
    if (themeSets.some((ids) => cluster.memberIds.every((id) => ids.has(id)))) {
      covered.add(cluster.canonicalId);
    }
  }
  return covered;
}

module.exports = {
  normalizeText,
  tokenSet,
  jaccard,
  similarity,
  similar,
  semanticLinks,
  isClusterable,
  filterEntriesToTeam,
  clusterEntries,
  mergedTombstone,
  canonicalEntry,
  buildCanonicalProjection,
  crossesConvergence,
  stableSuggestionId,
  toCandidate,
  planNewSuggestions,
  DIGEST_DELIVERED_KINDS,
  classifyClusterRouting,
  toDigestOnlyRow,
  planDigestRouting,
  topicTokens,
  relatedness,
  groupRelatedClusters,
  themeQualifies,
  themeToCandidate,
  planRelatedSuggestions,
  clustersCoveredByThemes,
};
