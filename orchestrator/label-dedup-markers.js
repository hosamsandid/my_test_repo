'use strict';

// Dedup markers for the internal label fast-path (#1858).
//
// When the Admin Console delivers a human-applied label internally (see
// github-label-fastpath.js), it writes one marker per woken listener. The
// poller -- which also still subscribes to the same label on the Events API as
// the fallback for labels set elsewhere -- consults these markers in
// `_fanOutBatch`: if the later poller event matches an UNCONSUMED marker within
// the match window, it drops that event (`reason: 'internal-dedup'`) instead of
// waking the agent a second time.
//
// The store is IN-MEMORY: the poller and the endpoint run in the same
// orchestrator process, so a shared instance is enough and needs no fs. A lost
// marker (orchestrator restart) only risks one duplicate wake -- low-harm, and
// further softened by the claim-swap `ready` -> `ready:wip` (a re-fired
// `issues.labeled` on an already-claimed issue no-ops downstream).
//
// The marker is TIME-BOUNDED and CONSUME-ONCE -- that is what lets a legitimate
// later re-label (remove `ready`, re-add an hour later) still fire: its poller
// event carries a newer `created_at` and, once the first marker was consumed
// (or GC'd past the TTL), finds no matching unconsumed marker.

// Match window: a poller event whose created_at is within +/-WINDOW of the
// internal delivery is treated as the SAME apply and deduped. Kept generous
// enough (~5 min) to absorb Events-API delivery lag, tight enough that a
// genuine re-label an hour later is never mistaken for the first.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// GC horizon: a marker older than this is dropped regardless of consumed state.
// Generous (~6 h) so it still covers the measured Events-API delivery lag of up
// to ~3 h before a marker expires.
const MARKER_TTL_MS = 6 * 60 * 60 * 1000;

// Stable identity for a marker -- the (agent, trigger, repo, kind, number,
// label) tuple. JSON-encoded so no field value can collide with the separator.
function markerId({ agentId, triggerId, repo, kind, number, label }) {
  return JSON.stringify([agentId, triggerId, repo, kind, number, label]);
}

function toMs(v) {
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : NaN;
}

class LabelDedupMarkers {
  constructor({ windowMs = DEDUP_WINDOW_MS, ttlMs = MARKER_TTL_MS, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.ttlMs = ttlMs;
    this._now = now;
    this._markers = new Map(); // markerId -> { ...fields, appliedAt(ms), consumed }
  }

  // Record a delivery marker. `appliedAt` is the internal delivery time (the
  // synthetic event's created_at) -- number ms or ISO string. A re-delivery of
  // the same tuple overwrites the prior (dead-or-alive) marker with the fresh
  // time, so a later legitimate re-label re-arms the dedup for its own window.
  add({ agentId, triggerId, repo, kind, number, label, appliedAt }) {
    this._gc();
    const at = toMs(appliedAt);
    const m = { agentId, triggerId, repo, kind, number, label, appliedAt: at, consumed: false };
    this._markers.set(markerId(m), m);
    return m;
  }

  // Consume-once: find an UNCONSUMED marker matching the tuple whose appliedAt
  // is within +/-windowMs of the poller event's created_at. Marks it consumed
  // and returns it, or null when there is no match (-> the poller delivers
  // normally).
  consume({ agentId, triggerId, repo, kind, number, label, eventCreatedAt }) {
    this._gc();
    const m = this._markers.get(markerId({ agentId, triggerId, repo, kind, number, label }));
    if (!m || m.consumed) return null;
    const evAt = toMs(eventCreatedAt);
    if (!Number.isFinite(evAt) || !Number.isFinite(m.appliedAt)) return null;
    if (Math.abs(evAt - m.appliedAt) > this.windowMs) return null;
    m.consumed = true;
    return m;
  }

  // Drop markers past the TTL. Called on every add/consume; cheap for the
  // handful of live markers a stack ever holds.
  _gc() {
    const now = this._now();
    for (const [id, m] of this._markers) {
      if (!Number.isFinite(m.appliedAt) || now - m.appliedAt > this.ttlMs) {
        this._markers.delete(id);
      }
    }
  }

  size() {
    return this._markers.size;
  }
}

module.exports = { LabelDedupMarkers, DEDUP_WINDOW_MS, MARKER_TTL_MS, markerId };
