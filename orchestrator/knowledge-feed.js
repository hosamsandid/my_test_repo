'use strict';

// Pure helpers for the canonical KB clone + live feed (Shared Agent Learning,
// Phase 2). The git IO (clone / fetch / reset) and the append-to-feed-file IO
// live in orchestrator.js; only the decision + shape logic worth pinning down
// lives here so it can be unit-tested without git, a network or the clock (repo
// convention: test pure cores only). See docs/knowledge-flow.md §2–§4.

const path = require('path');

// A team id must be a single safe path segment — the canonical clone lives at
// <root>/<teamId>/, so a traversal or separator would escape the KB tree.
function safeTeamSegment(teamId) {
  if (typeof teamId !== 'string') return null;
  const s = teamId.trim();
  if (s === '' || s === '.' || s === '..') return null;
  if (s.includes('/') || s.includes('\\')) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)) return null;
  return s;
}

// The orchestrator-maintained canonical KB clone for a team. Returns null for a
// team id that isn't a safe single segment (fail-closed against traversal).
function canonicalClonePath(root, teamId) {
  const seg = safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(root, seg);
}

// Should the canonical clone be refreshed? True when never refreshed or when at
// least `minMs` has elapsed. Tolerant of a missing/garbage lastAt (→ refresh).
function shouldRefresh(lastAt, now = Date.now(), minMs = 30_000) {
  const last = typeof lastAt === 'number' ? lastAt : Date.parse(lastAt);
  if (!Number.isFinite(last)) return true;
  const n = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(n)) return true;
  return n - last >= minMs;
}

// Build one lean `harvest` feed event from a pushed entry summary. The payload is
// provenance-lean (id/kind/text/originAgent/convergenceCount) — no secrets, the
// same fields the shard already exposes. When `entry` is absent (older CLI /
// offline manual push) the event is count-only so badges still tick; the graph
// endpoint stays the authoritative full view.
function buildHarvestEvent({ teamId, agentId, entry, ts } = {}) {
  const event = {
    type: 'harvest',
    ts: typeof ts === 'string' && ts.trim() ? ts.trim() : new Date().toISOString(),
    teamId: typeof teamId === 'string' ? teamId : null,
    agentId: typeof agentId === 'string' ? agentId : null,
  };
  const lean = leanEntry(entry);
  if (lean) event.entry = lean;
  return event;
}

function leanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
  if (!id) return null;
  const count = Number(entry.convergenceCount);
  return {
    id,
    kind: typeof entry.kind === 'string' ? entry.kind : 'fact',
    text: typeof entry.text === 'string' ? entry.text : '',
    originAgent: typeof entry.originAgent === 'string' ? entry.originAgent : null,
    convergenceCount: Number.isFinite(count) && count > 0 ? count : 1,
  };
}

// Normalize the push body into an array of lean entry summaries (dropping any
// that lack an id). An absent/garbage body yields [] so the caller emits a
// single count-only event instead.
function parsePushEntries(body) {
  let obj = body;
  if (typeof body === 'string') {
    try { obj = JSON.parse(body); } catch { return []; }
  }
  const arr = obj && Array.isArray(obj.entries) ? obj.entries : [];
  return arr.map(leanEntry).filter(Boolean);
}

function serializeEvent(event) {
  return JSON.stringify(event);
}

module.exports = {
  safeTeamSegment,
  canonicalClonePath,
  shouldRefresh,
  buildHarvestEvent,
  leanEntry,
  parsePushEntries,
  serializeEvent,
};
