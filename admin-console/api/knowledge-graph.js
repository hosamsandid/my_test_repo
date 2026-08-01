'use strict';

// Knowledge-graph pure builder (Shared Agent Learning & Knowledge Flow, Phase 2).
//
// The analogue of process-graph.js for the Knowledge Flow view. It turns already
// gathered inputs — deduped KB entries, the skills registry, and agent metadata —
// into the lane/node/edge model the /api/knowledge/graph route returns and the
// KnowledgeFlow page renders as a three-lane ladder (T0 agent → T1 team KB → T2
// skill). It is deliberately PURE — no fs, no network, an injected `now` — so it
// is unit-testable without booting the admin-console (repo convention: test pure
// helper cores only). All IO (reading the canonical clone / agent checkouts,
// gathering skills/agents) lives in the route.
//
// Phase 2 is read + display only: convergence is SURFACED faithfully from each
// entry's convergence[] (Phase 1 seeds [originAgent]; Phase 3 grows it), never
// detected here. promoted edges are modelled but usually empty until a later
// phase links a skill's provenance to a KB entry.

const DAY_MS = 24 * 60 * 60 * 1000;
const LANES = ['agent', 'team', 'global'];

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

// Parse a scope string into { kind, id }. Tolerant: anything that isn't a
// well-formed agent:/team: scope falls back to global (mirrors the route's
// "unknown scope → global"). Validation against AGENT_ID_RE is the route's job.
function parseScope(scope) {
  const s = typeof scope === 'string' ? scope.trim() : '';
  if (s.startsWith('agent:')) {
    const id = s.slice('agent:'.length).trim();
    if (id) return { kind: 'agent', id, scope: `agent:${id}` };
  }
  if (s.startsWith('team:')) {
    const id = s.slice('team:'.length).trim();
    if (id) return { kind: 'team', id, scope: `team:${id}` };
  }
  return { kind: 'global', id: null, scope: 'global' };
}

// ---------------------------------------------------------------------------
// Merge folding (Phase 3)
// ---------------------------------------------------------------------------

// Resolve the Phase-3 canonical merge: the orchestrator collector writes a
// `status:"merged"` tombstone { id, mergedInto } into the canonical <kind>.jsonl
// for every entry it absorbed into a canonical fact, while the winner keeps its
// id with a grown convergence[]. This drops the absorbed ids so the graph shows
// ONE node per cluster; dedupById (below) then collapses the winner's own shard
// copy against the grown canonical copy. Additive: no `status:"merged"` records
// ⇒ this is the identity function ⇒ Phase 2 output is unchanged.
function foldMerges(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  // Build absorbedId → mergedInto, and the set of ids that survive as entries.
  const redirect = new Map();
  const presentIds = new Set();
  for (const e of list) {
    if (typeof e.id === 'string' && e.id.trim()) presentIds.add(e.id);
  }
  for (const e of list) {
    if (e.status === 'merged' && typeof e.id === 'string' && typeof e.mergedInto === 'string' && e.mergedInto.trim()) {
      redirect.set(e.id, e.mergedInto);
    }
  }
  // Follow redirects to a terminal target (cycle-guarded).
  const terminal = (id) => {
    let cur = id;
    const seen = new Set();
    while (redirect.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = redirect.get(cur);
    }
    return cur;
  };
  const out = [];
  for (const e of list) {
    if (e.status === 'merged') continue; // tombstones never become nodes
    const id = typeof e.id === 'string' ? e.id : null;
    // Drop an entry only when it was absorbed AND its canonical target is present
    // (a dangling tombstone must not hide a still-live entry).
    if (id && redirect.has(id) && presentIds.has(terminal(id))) continue;
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

function entryTime(e) {
  const raw = e && (e.updatedAt || e.createdAt);
  const n = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Archive folding (Phase 4)
// ---------------------------------------------------------------------------

// Drop entries the curator retired via status:"archived" (non-destructive KB
// curation, docs/knowledge-curation.md §6): the canonical writer stamps a
// superseded/stale canonical entry archived; the raw shard lines stay in git for
// audit but the entry leaves the ACTIVE graph. Runs BEFORE dedupById, so it
// decides per id by the LATEST copy (updatedAt/createdAt): if the freshest copy of
// an id is archived, every copy of that id is dropped — a stale live shard copy
// can't resurrect an archived entry. Additive: no archived records ⇒ identity ⇒
// Phase 2/3 output byte-identical.
// Drop every copy of an id whose LATEST copy (by updatedAt/createdAt) has a status
// the predicate hides. Shared by foldArchived + foldReview: same latest-per-id
// tie-break, only the hidden-status test differs. Identity when nothing matches.
function foldByLatest(entries, isHiddenEntry) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const latest = new Map();
  for (const e of list) {
    const id = typeof e.id === 'string' && e.id.trim() ? e.id : null;
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || entryTime(e) >= entryTime(prev)) latest.set(id, e);
  }
  const hiddenIds = new Set();
  for (const [id, e] of latest) if (isHiddenEntry(e)) hiddenIds.add(id);
  if (hiddenIds.size === 0) return list;
  return list.filter((e) => !(typeof e.id === 'string' && hiddenIds.has(e.id)));
}

function foldByStatus(entries, isHidden) {
  return foldByLatest(entries, (e) => isHidden(e.status));
}

function foldArchived(entries) {
  return foldByStatus(entries, (s) => s === 'archived');
}

// ---------------------------------------------------------------------------
// Expiry folding (#916 bitemporal validity)
// ---------------------------------------------------------------------------

// An entry whose validTo lies before the injected `now` is no longer current.
// Field-derived (never a status); ISO-8601 UTC strings compare lexicographically
// == chronologically, so this is a plain string comparison — identical in all
// four fold mirrors (knowledge CLI, digest JS+Py, this module). No `now` ⇒
// never expired (the pure cores have no clock).
function entryExpired(e, now) {
  const vt = e && typeof e.validTo === 'string' ? e.validTo : '';
  return vt !== '' && typeof now === 'string' && now !== '' && vt < now;
}

// Drop every copy of an id whose LATEST copy has expired — exactly the archived
// fold's latest-per-id semantics, keyed on the validTo field instead of status.
// Identity when nothing is expired (or no clock is supplied).
function foldExpired(entries, now) {
  return foldByLatest(entries, (e) => entryExpired(e, now));
}

// ---------------------------------------------------------------------------
// Review folding (supervised-review mode)
// ---------------------------------------------------------------------------

// Drop entries a team running in supervised-review mode has not yet let into the
// curated KB: the orchestrator collector stamps an un-approved canonical entry
// status:"pending" and a rejected one status:"rejected". Like foldArchived this
// decides per id by the LATEST copy (updatedAt/createdAt) — the collector always
// refreshes the overlay copy's updatedAt, so a stale live shard copy can't
// resurrect a held entry into the active graph. These entries surface only in the
// review queue (selectReviewQueue), never the active lanes. Additive: no
// pending/rejected records ⇒ identity ⇒ non-review teams are byte-identical.
const REVIEW_HELD = new Set(['pending', 'rejected']);
function foldReview(entries) {
  return foldByStatus(entries, (s) => REVIEW_HELD.has(s));
}

// Apply the operator-decision overlays at READ time, as a pure function of
// (entries, decision stores) — the mirror of what the orchestrator collector
// stamps into the canonical files. This makes archive + supervised review work
// even when a team has no canonical clone yet (the git-sync side is best-effort
// and may lag or be unprovisioned): the admin-console reads raw shards and this
// overlay re-derives the same statuses the collector would have written.
// Identity for entries whose id is in no store. Never overrides a terminal
// status (merged / promoted).
//   archivedIds: Set/array of entry ids the operator retired.
//   decisions:   { <id>: "approved" | "rejected" } review decisions.
//   reviewOn:    when true, an undecided entry is held as "pending".
function overlayStatuses(entries, { archivedIds = [], decisions = {}, reviewOn = false } = {}) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds);
  const list = Array.isArray(entries) ? entries : [];
  const KEEP = new Set(['merged', 'promoted']);
  return list.map((e) => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') return e;
    if (KEEP.has(e.status)) return e;
    if (archived.has(e.id)) {
      return e.status === 'archived' ? e : { ...e, status: 'archived' };
    }
    const d = decisions && decisions[e.id];
    if (d === 'rejected') return e.status === 'rejected' ? e : { ...e, status: 'rejected' };
    if (d === 'approved') {
      // An earlier overlay copy may still say pending — approval releases it.
      return e.status === 'pending' || e.status === 'rejected' ? { ...e, status: 'active' } : e;
    }
    if (reviewOn) return e.status === 'pending' ? e : { ...e, status: 'pending' };
    return e;
  });
}

// Apply the operator-set validity window at READ time (#916) — the field-overlay
// sibling of overlayStatuses: the orchestrator persists {entryId: {validTo?,
// supersededBy?}} in a per-team sidecar and stamps the fields onto the canonical
// file at re-projection; this re-derives the same fields over raw shard reads so
// validity holds even when the git-sync side lags. The sidecar is the ONLY
// writer of these fields, so it is authoritative both ways: an id present in
// the map gets exactly the map's fields; an id absent has them stripped (a
// stale canonical copy can't keep an entry expired after the operator cleared
// it). Identity when the map is empty and no entry carries the fields.
function overlayValidity(entries, validity = {}) {
  const map = validity && typeof validity === 'object' ? validity : {};
  const list = Array.isArray(entries) ? entries : [];
  return list.map((e) => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') return e;
    const v = map[e.id];
    if (v && typeof v === 'object') {
      const validTo = typeof v.validTo === 'string' && v.validTo.trim() ? v.validTo.trim() : null;
      const supersededBy = typeof v.supersededBy === 'string' && /^[0-9a-f]{12}$/.test(v.supersededBy) ? v.supersededBy : null;
      if (e.validTo === (validTo || undefined) && e.supersededBy === (supersededBy || undefined)) return e;
      const next = { ...e };
      if (validTo) next.validTo = validTo; else delete next.validTo;
      if (supersededBy) next.supersededBy = supersededBy; else delete next.supersededBy;
      return next;
    }
    if (e.validTo !== undefined || e.supersededBy !== undefined) {
      const next = { ...e };
      delete next.validTo;
      delete next.supersededBy;
      return next;
    }
    return e;
  });
}

// The inverse of foldReview for the review-queue endpoint: the deduped set of
// entries whose latest copy is pending/rejected, newest first, as item views.
// `only` optionally narrows to one status ("pending" | "rejected").
function selectReviewQueue(entries, { only = null } = {}) {
  const merged = foldMerges(Array.isArray(entries) ? entries : []);
  const deduped = dedupById(merged);
  const held = deduped.filter((e) => REVIEW_HELD.has(e && e.status) && (!only || e.status === only));
  held.sort((a, b) => entryTime(b) - entryTime(a));
  return held.map(toItem);
}

// Collapse entries that share an `id` — the same KB entry seen across multiple
// shard roots (the canonical clone AND stale agent checkouts, §2). Last writer
// wins on updatedAt/createdAt; ties keep the last one seen so a caller can order
// its shard reads to prefer a source. Entries without a string id are dropped
// (parseEntry already filtered malformed lines upstream).
function dedupById(entries) {
  const byId = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' && e.id.trim() ? e.id : null;
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || entryTime(e) >= entryTime(prev)) byId.set(id, e);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normStrArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Turn a raw KB entry into the item view the graph exposes (convergence surfaced,
// provenance grouped). originAgent falls back to the first convergence id so a
// hand-authored entry without the field still anchors an edge.
function toItem(e, now = '') {
  const convergence = normStrArray(e.convergence);
  const originAgent =
    typeof e.originAgent === 'string' && e.originAgent.trim()
      ? e.originAgent.trim()
      : convergence[0] || null;
  const sourceRefs = Array.isArray(e.sourceRefs)
    ? e.sourceRefs.filter((r) => r && typeof r === 'object')
    : [];
  return {
    id: e.id,
    entryKind: typeof e.kind === 'string' ? e.kind : 'fact',
    text: typeof e.text === 'string' ? e.text : '',
    teamId: typeof e.teamId === 'string' && e.teamId.trim() ? e.teamId.trim() : 'default',
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : null,
    originAgent,
    status: typeof e.status === 'string' ? e.status : 'active',
    archived: e.status === 'archived',
    pending: e.status === 'pending',
    rejected: e.status === 'rejected',
    // #916 bitemporal validity: validFrom semantically defaults to createdAt.
    validFrom: typeof e.validFrom === 'string' ? e.validFrom : null,
    validTo: typeof e.validTo === 'string' ? e.validTo : null,
    supersededBy: typeof e.supersededBy === 'string' ? e.supersededBy : null,
    expired: entryExpired(e, now),
    convergence,
    convergenceCount: convergence.length,
    converged: convergence.length >= 2,
    provenance: {
      originAgent,
      teamId: typeof e.teamId === 'string' && e.teamId.trim() ? e.teamId.trim() : 'default',
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : null,
      correlationId: typeof e.correlationId === 'string' ? e.correlationId : null,
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
      sourceRefs,
    },
  };
}

// A skill's provenance may name the KB entry it was promoted from (Phase 3/4).
// Collect any such entry ids so we can draw the T1→T2 promoted edge.
function skillEntryIds(skill) {
  const p = skill && skill.provenance;
  if (!p || typeof p !== 'object') return [];
  const ids = [];
  if (typeof p.entryId === 'string' && p.entryId.trim()) ids.push(p.entryId.trim());
  for (const v of normStrArray(p.entryIds)) ids.push(v);
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the knowledge lane/node/edge model.
 *
 * @param {object} args
 * @param {string} args.scope            agent:<id> | team:<id> | global (default global)
 * @param {object[]} args.entries        already-parsed KB entries (any shard roots — deduped here)
 * @param {object[]} args.skills         [{ name, tier, teamId?, originTeamId?, provenance? }]
 * @param {object[]} args.agents         [{ id, parentTeamId, environmentId, displayName }]
 * @param {number|string} args.now       clock for the "today" window
 * @param {string[]} args.warnings       IO-layer warnings to echo (e.g. no canonical clone)
 * @returns {{ scope, lanes, nodes, edges, counts, warnings }}
 */
function buildKnowledgeGraph({ scope, entries = [], skills = [], agents = [], now = Date.now(), warnings = [], includeArchived = false } = {}) {
  const parsed = parseScope(scope);
  const nowMs = typeof now === 'number' ? now : Date.parse(now) || Date.now();

  // includeArchived keeps status:"archived" AND expired entries visible (so the
  // operator can find + unarchive/re-validate them — the item's `expired` flag
  // distinguishes the two); the default view folds both out (#916: one reveal
  // toggle, "Show retired & expired").
  // Fold pipeline: merges → archived+expired (unless includeArchived) →
  // review-held (pending/rejected always fold out of the active graph; they
  // live in the review queue). Each fold is identity when nothing matches.
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const merged = foldMerges(entries);
  const afterArchive = includeArchived ? merged : foldExpired(foldArchived(merged), nowIso);
  const allItems = dedupById(foldReview(afterArchive)).map((e) => toItem(e, nowIso));
  const agentMeta = new Map(
    (Array.isArray(agents) ? agents : [])
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => [a.id, a]),
  );

  // ── which items are "in scope" (drive counts) ─────────────────────────────
  let scopedItems;
  if (parsed.kind === 'agent') {
    scopedItems = allItems.filter(
      (it) => it.originAgent === parsed.id || it.convergence.includes(parsed.id),
    );
  } else if (parsed.kind === 'team') {
    scopedItems = allItems.filter((it) => it.teamId === parsed.id);
  } else {
    scopedItems = allItems; // global: counts summarise everything
  }

  // Item nodes are emitted for agent/team scope; global summarises the team lane
  // (one contributing-team node per team, no per-entry nodes).
  const laneItems = parsed.kind === 'global' ? [] : scopedItems;

  const nodes = [];
  const edges = [];

  // ── agent lane (T0) ───────────────────────────────────────────────────────
  const isToday = (createdAt) => {
    if (!createdAt) return false;
    const t = Date.parse(createdAt);
    if (Number.isNaN(t)) return false;
    const d = nowMs - t;
    return d >= 0 && d < DAY_MS;
  };
  const agentCounts = (agentId) => {
    let items = 0;
    let today = 0;
    for (const it of scopedItems) {
      if (!it.convergence.includes(agentId)) continue;
      items += 1;
      if (isToday(it.createdAt)) today += 1;
    }
    return { items, today };
  };
  const agentNode = (agentId, faded) => {
    const meta = agentMeta.get(agentId);
    const node = {
      id: `agent:${agentId}`,
      lane: 'agent',
      kind: 'agent',
      label: (meta && meta.displayName) || agentId,
      agentId,
      teamId: (meta && meta.parentTeamId) || (parsed.kind === 'team' ? parsed.id : undefined),
      counts: agentCounts(agentId),
    };
    if (faded) node.faded = true;
    return node;
  };

  if (parsed.kind === 'global') {
    // One node per contributing team (collapsed contributors).
    const teamIds = [...new Set(scopedItems.map((it) => it.teamId))].sort();
    for (const teamId of teamIds) {
      let items = 0;
      let today = 0;
      for (const it of scopedItems) {
        if (it.teamId !== teamId) continue;
        items += 1;
        if (isToday(it.createdAt)) today += 1;
      }
      nodes.push({
        id: `team:${teamId}`,
        lane: 'agent',
        kind: 'team',
        label: teamId,
        teamId,
        counts: { items, today },
      });
    }
  } else {
    const contributors = new Set();
    for (const it of scopedItems) {
      for (const c of it.convergence) contributors.add(c);
      if (it.originAgent) contributors.add(it.originAgent);
    }
    // In agent scope the focus agent is always present even if it hasn't
    // contributed yet; co-contributors of its shared items render faded.
    if (parsed.kind === 'agent') contributors.add(parsed.id);
    for (const agentId of [...contributors].sort()) {
      nodes.push(agentNode(agentId, parsed.kind === 'agent' && agentId !== parsed.id));
    }
  }

  // ── team lane (T1) — one item node per KB entry ────────────────────────────
  const itemIds = new Set(laneItems.map((it) => it.id));
  const sortedItems = [...laneItems].sort(
    (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id),
  );
  for (const it of sortedItems) {
    nodes.push({
      id: `item:${it.id}`,
      lane: 'team',
      kind: 'item',
      entryKind: it.entryKind,
      text: it.text,
      teamId: it.teamId,
      createdAt: it.createdAt,
      convergence: it.convergence,
      convergenceCount: it.convergenceCount,
      converged: it.converged,
      archived: it.archived,
      provenance: it.provenance,
    });
    // T0→T1: one harvested edge per convergence contributor → the fan-in that
    // literally draws "N× independent" on a converged item.
    for (const contributor of it.convergence) {
      const edge = {
        from: `agent:${contributor}`,
        to: `item:${it.id}`,
        kind: 'harvested',
      };
      if (contributor === it.originAgent) edge.origin = true;
      edges.push(edge);
    }
  }

  // ── global lane (T2) — skills ───────────────────────────────────────────────
  const skillList = Array.isArray(skills) ? skills.filter((s) => s && typeof s.name === 'string') : [];
  let laneSkills;
  if (parsed.kind === 'agent') {
    // Skills whose provenance traces to one of the scoped items (usually none).
    laneSkills = skillList.filter((s) => skillEntryIds(s).some((id) => itemIds.has(id)));
  } else if (parsed.kind === 'team') {
    laneSkills = skillList.filter(
      (s) =>
        (s.tier === 'team' && s.teamId === parsed.id) ||
        (s.tier === 'global' && s.originTeamId === parsed.id),
    );
  } else {
    laneSkills = skillList.filter((s) => s.tier === 'global');
  }

  // Problem A / AC1: collapse skill records to ONE node per name. A skill
  // promoted to global while still present in the team pool enters the team lane
  // as TWO records (a {tier:'team'} pool file AND a {tier:'global', originTeamId}
  // copy), and unlike item nodes skill nodes were never deduped — so the same
  // name rendered twice. Keep one record per name, preferring the TEAM-owned card
  // (the copy that is editable here) and flagging `alsoGlobal` so the UI can note
  // "also promoted to global" (open question 2). Provenance entry-ids are unioned
  // across both records so the T1→T2 promoted edge survives either source.
  const skillByName = new Map();
  for (const s of laneSkills) {
    let e = skillByName.get(s.name);
    if (!e) {
      e = { rec: s, alsoGlobal: false, entryIds: new Set() };
      skillByName.set(s.name, e);
    } else {
      if (e.rec.tier !== s.tier) e.alsoGlobal = true;
      if (e.rec.tier !== 'team' && s.tier === 'team') e.rec = s; // team-owned wins
    }
    for (const id of skillEntryIds(s)) e.entryIds.add(id);
  }

  const byKind = {};
  for (const e of skillByName.values()) {
    const s = e.rec;
    const node = {
      id: `skill:${s.name}`,
      lane: 'global',
      kind: 'skill',
      label: s.name,
      tier: s.tier || 'global',
    };
    if (s.originTeamId) node.originTeamId = s.originTeamId;
    if (s.teamId) node.teamId = s.teamId;
    if (e.alsoGlobal) node.alsoGlobal = true;
    if (s.provenance && typeof s.provenance.promotedBy === 'string') node.promotedBy = s.provenance.promotedBy;
    nodes.push(node);
    // T1→T2 promoted edge — only when the referenced entry is a node here.
    for (const entryId of e.entryIds) {
      if (itemIds.has(entryId)) {
        edges.push({ from: `item:${entryId}`, to: `skill:${s.name}`, kind: 'promoted' });
      }
    }
  }

  // ── counts ──────────────────────────────────────────────────────────────────
  for (const it of scopedItems) {
    byKind[it.entryKind] = (byKind[it.entryKind] || 0) + 1;
  }
  const agentNodeCount = nodes.filter((n) => n.lane === 'agent').length;
  const counts = {
    agents: agentNodeCount,
    items: scopedItems.length,
    skills: skillByName.size,
    byKind,
    converged: scopedItems.filter((it) => it.converged).length,
    today: scopedItems.filter((it) => isToday(it.createdAt)).length,
  };

  // Stable edge order for deterministic tests / diffs.
  edges.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  return {
    scope: parsed.scope,
    lanes: LANES.slice(),
    nodes,
    edges,
    counts,
    warnings: normStrArray(warnings),
  };
}

// Cheap counts-only summary for the LearningBadge (no node/edge model built).
// Same scope semantics as the graph; entries already deduped by the caller path
// via dedupById here so a badge over stale shards still converges.
function summarizeKnowledge({ scope, entries = [], now = Date.now() } = {}) {
  const parsed = parseScope(scope);
  const nowMs = typeof now === 'number' ? now : Date.parse(now) || Date.now();
  // Held (pending/rejected) entries aren't in the curated KB yet, so a badge
  // must not count them as "learned" — fold them out like archived.
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const items = dedupById(foldReview(foldExpired(foldArchived(foldMerges(entries)), nowIso))).map(toItem);
  let scoped;
  if (parsed.kind === 'agent') {
    scoped = items.filter((it) => it.originAgent === parsed.id || it.convergence.includes(parsed.id));
  } else if (parsed.kind === 'team') {
    scoped = items.filter((it) => it.teamId === parsed.id);
  } else {
    scoped = items;
  }
  const isToday = (createdAt) => {
    if (!createdAt) return false;
    const t = Date.parse(createdAt);
    if (Number.isNaN(t)) return false;
    const d = nowMs - t;
    return d >= 0 && d < DAY_MS;
  };
  return {
    scope: parsed.scope,
    items: scoped.length,
    today: scoped.filter((it) => isToday(it.createdAt)).length,
    converged: scoped.filter((it) => it.converged).length,
  };
}

module.exports = {
  LANES,
  parseScope,
  dedupById,
  foldMerges,
  foldArchived,
  foldReview,
  foldExpired,
  entryExpired,
  overlayStatuses,
  overlayValidity,
  selectReviewQueue,
  buildKnowledgeGraph,
  summarizeKnowledge,
};
