'use strict';

// Finished-session enumeration for the merged Sessions tab (#544, regrouped in
// #555).
//
// Session logs are durable: the runner appends every event to the per-room
// JSONL at sessions/<roomId>.jsonl. Every event carries the `correlationId` of
// the *run* it belongs to (a Matrix event_id for DMs, or a synthetic
// `trigger:<id>:<ts>` for triggered runs — see agent-entrypoint.py). A run is
// therefore one correlationId group.
//
// But a run is not a *session*. Consecutive manual DM messages in one ongoing
// conversation are each their own Matrix event (own correlationId) yet are
// handled within a **single Claude session** — the same `session_id`, reused
// via `--resume`, pinned to the room until a Reset drops the pointer (#555).
// Grouping on correlationId therefore lists every message separately; the right
// key is the Claude **session-ID**.
//
// The session-ID appears in the JSONL only on `system_init` / `result` rows
// (field `sessionId`); wrapper rows (`message.received`, `trigger.fired`,
// `claude.invoke`, `message.posted`, …) carry only `correlationId`. So we build
// per-run descriptors first, capture each run's observed `sessionId` from its
// own `system_init`/`result` rows, then merge the runs that share a session-ID
// into one session descriptor. Runs that never observed a session-ID (e.g. an
// early error before any `system_init`) stay as their own fallback entry and
// are never dropped (#555 AC6).
//
// Each descriptor mirrors the running-session shape (`type`, `triggerType`,
// `triggerId`, `label`, `startedAt`, `endedAt`) so the UI can render the same
// source label/icon for active and historical entries, plus `sessionId`,
// `correlationIds` (all runs of the session, chronological — the UI scopes the
// combined log to them), `runCount` and `eventCount`. Pure + unit-tested; the
// route in api.js does the file IO.

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
 * Group session-log events into finished-session descriptors, keyed by Claude
 * session-ID (#555).
 *
 * @param {Array<object>} events            Parsed JSONL events (each may carry
 *                                           `ts`, `type`, `correlationId`,
 *                                           `sessionId`, …).
 * @param {Iterable<string>} activeCorrelationIds  correlationIds of currently
 *                                           running sessions. A session that
 *                                           owns any active run is excluded so
 *                                           it stays represented once — as the
 *                                           active sub-tab, not also here
 *                                           (Decision A / AC7).
 * @param {{limit?: number, offset?: number}} [opts]
 * @returns {{sessions: object[], total: number, truncated: boolean}}
 *          `sessions` newest-first (by last activity), sliced to the page;
 *          `total` counts grouped **sessions** (AC8); `truncated` is true when
 *          more remain past the page.
 */
function buildSessionHistory(events, activeCorrelationIds = [], opts = {}) {
  const active = new Set();
  for (const cid of activeCorrelationIds || []) {
    if (cid) active.add(cid);
  }

  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;

  // Pass 1: one descriptor per run (correlationId), capturing the session-ID
  // observed on its own system_init/result rows.
  const runs = new Map(); // correlationId -> run descriptor
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const cid = ev.correlationId;
    if (!cid) continue; // internal markers (_cursor / _truncated) have none

    let r = runs.get(cid);
    if (!r) {
      r = {
        correlationId: cid,
        sessionId: null,
        type: null,
        triggerType: null,
        triggerId: null,
        label: null,
        startedAt: null,
        endedAt: null,
        eventCount: 0,
      };
      runs.set(cid, r);
    }

    r.eventCount += 1;
    const ts = typeof ev.ts === 'string' ? ev.ts : null;
    if (ts) {
      if (!r.startedAt || ts < r.startedAt) r.startedAt = ts;
      if (!r.endedAt || ts > r.endedAt) r.endedAt = ts;
    }

    // The Claude session-ID rides only on these two row types.
    if ((ev.type === 'system_init' || ev.type === 'result')
        && typeof ev.sessionId === 'string' && ev.sessionId) {
      r.sessionId = ev.sessionId;
    }

    // Prefer metadata from the run's own wrapper events (authoritative).
    if (ev.type === 'trigger.fired') {
      r.type = 'trigger';
      if (ev.triggerType) r.triggerType = ev.triggerType;
      if (ev.triggerId != null) {
        r.triggerId = String(ev.triggerId);
        if (!r.label) r.label = String(ev.triggerId);
      }
    } else if (ev.type === 'message.received') {
      if (!r.type) r.type = 'dm';
      if (!r.label) r.label = 'Direct message';
    }
  }

  // Fill in type/label for runs whose wrapper events were absent from the log.
  for (const r of runs.values()) {
    if (!r.type || !r.label) {
      const derived = deriveFromCorrelationId(r.correlationId);
      if (!r.type) r.type = derived.type;
      if (r.type === 'trigger' && !r.triggerId && derived.triggerId) r.triggerId = derived.triggerId;
      if (!r.label) r.label = derived.label || '(session)';
    }
  }

  // Pass 2: merge runs that share a session-ID into one session. Runs without a
  // session-ID stay solo, keyed by their correlationId so they never collide
  // (AC6 fallback — an early-error run with no system_init still appears).
  const sessions = new Map(); // key -> session descriptor
  for (const r of runs.values()) {
    const key = r.sessionId ? 'sid:' + r.sessionId : 'cid:' + r.correlationId;
    let s = sessions.get(key);
    if (!s) {
      s = {
        id: r.sessionId || r.correlationId,
        sessionId: r.sessionId || null,
        correlationIds: [],
        type: null,
        triggerType: null,
        triggerId: null,
        label: null,
        startedAt: null,
        endedAt: null,
        runCount: 0,
        eventCount: 0,
        _opening: null, // earliest run — represents the session's source (AC5)
      };
      sessions.set(key, s);
    }

    s.correlationIds.push(r.correlationId);
    s.runCount += 1;
    s.eventCount += r.eventCount;
    if (r.startedAt && (!s.startedAt || r.startedAt < s.startedAt)) s.startedAt = r.startedAt;
    if (r.endedAt && (!s.endedAt || r.endedAt > s.endedAt)) s.endedAt = r.endedAt;

    // The opening (earliest) run defines the whole session's source label —
    // an entry may mix origins (e.g. a trigger resuming the DM session on a
    // persistent agent), so we represent it by how it began (AC5 edge case).
    if (!s._opening
        || (r.startedAt && (!s._opening.startedAt || r.startedAt < s._opening.startedAt))) {
      s._opening = r;
    }
  }

  const list = [];
  for (const s of sessions.values()) {
    // A session with any currently-running run is still active — it lives as
    // the active sub-tab, not as a finished entry (Decision A / AC7).
    if (s.correlationIds.some(cid => active.has(cid))) continue;

    const op = s._opening;
    if (op) {
      s.type = op.type;
      s.triggerType = op.triggerType;
      s.triggerId = op.triggerId;
      s.label = op.label;
    }
    delete s._opening;

    // Chronological order of runs, so the combined log reads oldest-first.
    s.correlationIds.sort((a, b) =>
      (runs.get(a)?.startedAt || '').localeCompare(runs.get(b)?.startedAt || ''));

    list.push(s);
  }

  // Most-recent-first by last activity (endedAt), so the session you touched
  // most recently sits on top; startedAt breaks ties. ISO-8601 timestamps sort
  // lexicographically; entries without a timestamp sink to the bottom.
  list.sort((a, b) => {
    const byEnd = (b.endedAt || '').localeCompare(a.endedAt || '');
    if (byEnd !== 0) return byEnd;
    return (b.startedAt || '').localeCompare(a.startedAt || '');
  });

  const total = list.length;
  const paged = list.slice(offset, offset + limit);
  return { sessions: paged, total, truncated: offset + paged.length < total };
}

/**
 * Resolve a finished session that may be re-opened via `--resume` (#574).
 *
 * The set-pointer endpoint must not trust a client-supplied session-ID blindly:
 * a resumable session has to (a) actually exist in this room's finished-session
 * history, (b) not be one of the currently-running sessions (Decision A / AC7 —
 * an active run already owns the room), and (c) be a **DM** session (Open
 * Question A → DM only; triggered per-invocation runs never persist a pointer,
 * so they carry no resumable id — except a pool instance's, which continue its
 * one DM session (#2595) and so are merged into it by session-ID). Returns the matching session descriptor when
 * all hold, else `null` — the caller maps `null` to a clear "not resumable"
 * error and MUST NOT start a fresh empty session in its place (AC6).
 *
 * @param {Array<object>} events               Parsed JSONL events for the room.
 * @param {Iterable<string>} activeCorrelationIds  currently-running correlationIds.
 * @param {string} sessionId                    the Claude session-ID to resume.
 * @returns {object|null} the finished DM session descriptor, or null.
 */
function findResumableSession(events, activeCorrelationIds, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  // Enumerate every finished session (unpaged) so a resumable one that would
  // sit past the default page is still found; buildSessionHistory already
  // excludes active sessions.
  const { sessions } = buildSessionHistory(events, activeCorrelationIds, {
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
  const match = sessions.find(s => s && s.sessionId === sessionId);
  if (!match) return null;
  if (match.type !== 'dm') return null;
  return match;
}

module.exports = { buildSessionHistory, deriveFromCorrelationId, findResumableSession };
