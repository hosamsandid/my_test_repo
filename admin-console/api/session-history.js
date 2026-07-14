'use strict';

// Finished-session enumeration for the merged Sessions tab (#544).
//
// Session logs are already durable: the runner appends every event to the
// per-room JSONL at sessions/<roomId>.jsonl, and each event carries the
// `correlationId` of the run it belongs to (a Matrix event_id for DMs, or a
// synthetic `trigger:<id>:<ts>` for triggered runs — see agent-entrypoint.py).
// So a "session" is just one correlationId group, and a *finished* session is
// one whose correlationId is no longer in running-sessions.json.
//
// This module groups the room's events by correlationId into descriptors whose
// shape mirrors the running-session descriptor (`type`, `triggerType`,
// `triggerId`, `label`, `correlationId`, `startedAt` — plus `endedAt`) so the
// UI can render the same source label/icon for active and historical entries.
// Pure + unit-tested; the route in api.js does the file IO.

// Recover a session's type/label from its correlationId when the wrapper event
// that would normally carry it (`message.received` / `trigger.fired`) is absent
// — e.g. a log tail that scrolled past the session's opening lines. Belt-and-
// braces: the wrapper events are appended at session start, so this rarely
// fires for a complete log.
function deriveFromCorrelationId(cid) {
  if (typeof cid !== 'string' || !cid) return { type: 'unknown', label: null };
  if (cid.startsWith('trigger:')) {
    // trigger:<triggerId>:<ts> or trigger:<triggerId>:gh:<eventId>
    const triggerId = cid.slice('trigger:'.length).split(':')[0] || null;
    return { type: 'trigger', triggerId, label: triggerId };
  }
  if (cid.startsWith('handover-dm:')) return { type: 'handover', label: 'Handover' };
  if (cid.startsWith('claim-suggest:')) return { type: 'claim-suggest', label: 'Claim suggestion' };
  if (cid.startsWith('$')) return { type: 'dm', label: 'Direct message' };
  return { type: 'unknown', label: null };
}

/**
 * Group session-log events into finished-session descriptors.
 *
 * @param {Array<object>} events            Parsed JSONL events (each may carry
 *                                           `ts`, `type`, `correlationId`, …).
 * @param {Iterable<string>} activeCorrelationIds  correlationIds of currently
 *                                           running sessions — excluded from the
 *                                           result so active runs stay as
 *                                           sub-tabs and never double up here.
 * @param {{limit?: number, offset?: number}} [opts]
 * @returns {{sessions: object[], total: number, truncated: boolean}}
 *          `sessions` newest-first, sliced to the page; `total` is the full
 *          finished count; `truncated` is true when more remain past the page.
 */
function buildSessionHistory(events, activeCorrelationIds = [], opts = {}) {
  const active = new Set();
  for (const cid of activeCorrelationIds || []) {
    if (cid) active.add(cid);
  }

  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;

  const groups = new Map(); // correlationId -> descriptor
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const cid = ev.correlationId;
    if (!cid) continue; // internal markers (_cursor / _truncated) have none

    let g = groups.get(cid);
    if (!g) {
      g = {
        correlationId: cid,
        type: null,
        triggerType: null,
        triggerId: null,
        label: null,
        startedAt: null,
        endedAt: null,
        eventCount: 0,
      };
      groups.set(cid, g);
    }

    g.eventCount += 1;
    const ts = typeof ev.ts === 'string' ? ev.ts : null;
    if (ts) {
      if (!g.startedAt || ts < g.startedAt) g.startedAt = ts;
      if (!g.endedAt || ts > g.endedAt) g.endedAt = ts;
    }

    // Prefer metadata from the run's own wrapper events (authoritative).
    if (ev.type === 'trigger.fired') {
      g.type = 'trigger';
      if (ev.triggerType) g.triggerType = ev.triggerType;
      if (ev.triggerId != null) {
        g.triggerId = String(ev.triggerId);
        if (!g.label) g.label = String(ev.triggerId);
      }
    } else if (ev.type === 'message.received') {
      if (!g.type) g.type = 'dm';
      if (!g.label) g.label = 'Direct message';
    }
  }

  const list = [];
  for (const g of groups.values()) {
    if (active.has(g.correlationId)) continue; // still running — not history
    if (!g.type || !g.label) {
      const derived = deriveFromCorrelationId(g.correlationId);
      if (!g.type) g.type = derived.type;
      if (g.type === 'trigger' && !g.triggerId && derived.triggerId) g.triggerId = derived.triggerId;
      if (!g.label) g.label = derived.label || '(session)';
    }
    list.push(g);
  }

  // Most-recent-first. ISO-8601 timestamps sort lexicographically; entries
  // without a timestamp sink to the bottom.
  list.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

  const total = list.length;
  const sessions = list.slice(offset, offset + limit);
  return { sessions, total, truncated: offset + sessions.length < total };
}

module.exports = { buildSessionHistory, deriveFromCorrelationId };
