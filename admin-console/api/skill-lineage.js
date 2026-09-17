'use strict';

// Skill lineage view (#632, concept §4.1 + §4.3, epic #624 phase 5).
//
// Phases 1–4 write the raw material — `skill.json` (content lineage: version,
// hash, history, origin), `provenance.json` (knowledge lineage: entryIds,
// origin agents/teams), and the per-copy drift state (#629). This module is the
// PURE assembler that turns that already-read material into the single view the
// Skills-surface detail panel renders across its Versions and Lineage tabs:
// the viewed copy's version history, its provenance, and every KNOWN copy of the
// same skill name across tiers/agents with its drift.
//
// It is deliberately fs-free: the api.js route reads manifests / provenance and
// computes per-copy drift (both need fs), then hands the plain data here. That
// keeps this module unit-testable with `node --test` and no install step (the
// same pure-core + IO-caller split as skill-transfer / skill-deletion / -merge).

const skillDrift = require('./skill-drift');

// Normalize a skill.json manifest into the {current, history} shape the Versions
// tab renders. `history` is already newest-first + bounded in the manifest; we
// only coerce it to plain, predictable entries and flag the one that is the
// current version (so the UI can mark "you are here"). A missing/!object
// manifest yields an empty view rather than throwing.
function normalizeVersionHistory(manifest) {
  const man = manifest && typeof manifest === 'object' ? manifest : null;
  const current = man ? {
    version: Number.isInteger(man.version) ? man.version : null,
    contentHash: typeof man.contentHash === 'string' ? man.contentHash : null,
    updatedAt: man.updatedAt || null,
    updatedBy: man.updatedBy || null,
  } : { version: null, contentHash: null, updatedAt: null, updatedBy: null };

  const rawHistory = man && Array.isArray(man.history) ? man.history : [];
  const history = rawHistory
    .filter(h => h && typeof h === 'object')
    .map(h => ({
      version: Number.isInteger(h.version) ? h.version : null,
      hash: typeof h.hash === 'string' ? h.hash : null,
      at: h.at || null,
      by: h.by || null,
      action: h.action || null,
      note: h.note != null && h.note !== '' ? String(h.note) : undefined,
      // The current version is the newest history entry whose version matches;
      // marking it lets the timeline highlight the live revision.
      current: current.version != null && h.version === current.version,
    }));
  return { current, history };
}

// A stable identity key for one copy, so a caller can dedup a copy that is
// reachable via more than one enumeration path (e.g. the viewed copy is also in
// the gathered set).
function copyKey(copy) {
  if (!copy || typeof copy !== 'object') return '::';
  return `${copy.tier || ''}:${copy.teamId || ''}:${copy.agentId || ''}`;
}

// Order copies deterministically for display: global first, then team, then
// agent; within a tier by teamId/agentId. The viewed copy keeps its natural
// place — the UI marks it with `viewed: true`, it is not hoisted.
const TIER_ORDER = { global: 0, team: 1, agent: 2 };
function sortCopies(copies) {
  return copies.slice().sort((a, b) => {
    const ta = TIER_ORDER[a.tier] ?? 9;
    const tb = TIER_ORDER[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    const sa = `${a.teamId || ''}${a.agentId || ''}`;
    const sb = `${b.teamId || ''}${b.agentId || ''}`;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

// Roll the per-copy drift states up into a node-level summary + counts by tier,
// so the Lineage tab can headline "this skill lives in N places" and surface the
// single worst drift across every copy (a conflict outranks a mere outdated).
function summarizeCopies(copies) {
  const list = Array.isArray(copies) ? copies.filter(c => c && typeof c === 'object') : [];
  const byTier = { global: 0, team: 0, agent: 0 };
  const driftStates = [];
  for (const c of list) {
    if (byTier[c.tier] != null) byTier[c.tier] += 1;
    if (c.drift) driftStates.push(c.drift);
  }
  const rollup = skillDrift.rollupDrift(driftStates);
  return {
    total: list.length,
    byTier,
    worstDrift: rollup.worst,
    resyncable: rollup.resyncable,
  };
}

// Assemble the full lineage view the endpoint returns. `viewed` identifies the
// copy the panel is showing ({tier, teamId?, agentId?}); its manifest + the
// gathered copies + provenance are supplied by the (fs-bound) caller. Copies are
// deduped on their identity key, marked `viewed` where they match, sorted, and
// summarized.
function assembleLineage({ name, viewed, manifest, provenance, copies } = {}) {
  const viewedKey = copyKey(viewed);
  const seen = new Set();
  const deduped = [];
  for (const c of Array.isArray(copies) ? copies : []) {
    if (!c || typeof c !== 'object' || !c.tier) continue;
    const k = copyKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push({ ...c, viewed: k === viewedKey });
  }
  const sorted = sortCopies(deduped);
  return {
    name: name || null,
    viewed: viewed || null,
    versions: normalizeVersionHistory(manifest),
    origin: (manifest && typeof manifest === 'object' && manifest.origin) || null,
    provenance: provenance && typeof provenance === 'object' ? provenance : null,
    copies: sorted,
    summary: summarizeCopies(sorted),
  };
}

// Summarize the DOWNSTREAM drift for one list row (#2317) — the count/worst
// state of the copies that descend from THIS row (a pool row's downstream is
// every team+agent copy of the name; a team row's downstream is only that
// team's own agent copies), so the Skills Registry list can show "N copies
// need an update" without opening the row. `in-sync` copies are excluded from
// the count (AC1/AC2 — only non-in-sync copies are noise-worthy); an empty
// result after filtering returns null (no indicator). Reuses `rollupDrift`
// rather than re-deriving severity, so it can never disagree with the
// detail-view Usage/Copies tabs computed from the same per-copy states (AC3).
function summarizeDownstreamDrift(states) {
  const filtered = (Array.isArray(states) ? states : []).filter(s => s && s !== 'in-sync');
  if (!filtered.length) return null;
  const rollup = skillDrift.rollupDrift(filtered);
  return { total: filtered.length, counts: rollup.counts, worst: rollup.worst };
}

module.exports = {
  normalizeVersionHistory,
  summarizeCopies,
  sortCopies,
  copyKey,
  assembleLineage,
  summarizeDownstreamDrift,
};
