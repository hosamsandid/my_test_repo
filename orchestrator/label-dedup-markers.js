'use strict';

// Dedup markers for the internal label fast-path (#1858).
//
// When the Admin Console delivers a human-applied label internally (see
// github-label-fastpath.js), it writes one marker per woken listener. The
// poller -- which also still subscribes to the same label on the Events API as
// the fallback for labels set elsewhere -- consults these markers in
// `_fanOutBatch`: if a later poller event matches a live marker within the
// match window, it drops that event (`reason: 'internal-dedup'`) instead of
// waking the agent a second time.
//
// The store is IN-MEMORY: the poller and the endpoint run in the same
// orchestrator process, so a shared instance is enough and needs no fs. A lost
// marker (orchestrator restart) only risks one duplicate wake -- low-harm, and
// further softened by the claim-swap `ready` -> `ready:wip` self-event now being
// dropped at the poller's `self-claim-label` gate.
//
// The marker is TIME-BOUNDED and WINDOW-SCOPED (not consume-once). A single
// human apply frequently churns up SEVERAL `*.labeled` events that all match the
// wake label off the event-time snapshot: the poller's own delivery of `<wake>`,
// the claim swap's `<wake>:wip` add (whose snapshot still carries `<wake>`), and
// any second label the human set in the same breath. Consume-once dropped only
// the FIRST and let the rest double-wake the agent (the reported bug). So EVERY
// matching event whose `created_at` falls inside the window is dropped. A
// genuine later re-label carries a `created_at` OUTSIDE the window and still
// fires; the plugin path re-arms the marker (fresh `appliedAt`) on every real
// apply, so its window travels with it.

// Match window: a poller event whose created_at is within +/-WINDOW of the
// internal delivery is treated as fallout of the SAME apply and deduped. Kept
// generous enough (~5 min) to absorb Events-API delivery lag, tight enough that
// a genuine re-label an hour later is never mistaken for the first.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// GC horizon: a marker older than this is dropped regardless of its window.
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
    const m = { agentId, triggerId, repo, kind, number, label, appliedAt: at };
    this._markers.set(markerId(m), m);
    return m;
  }

  // Window-scoped: return the marker matching the tuple whose appliedAt is within
  // +/-windowMs of the poller event's created_at, or null when there is no match
  // (-> the poller delivers normally). NOT consume-once — the marker stays live
  // for its whole window (then TTL-GC'd), so every event the same apply churned
  // up is deduped, not just the first. A later re-label outside the window is
  // unaffected.
  shouldDrop({ agentId, triggerId, repo, kind, number, label, eventCreatedAt }) {
    this._gc();
    const m = this._markers.get(markerId({ agentId, triggerId, repo, kind, number, label }));
    if (!m) return null;
    const evAt = toMs(eventCreatedAt);
    if (!Number.isFinite(evAt) || !Number.isFinite(m.appliedAt)) return null;
    if (Math.abs(evAt - m.appliedAt) > this.windowMs) return null;
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
