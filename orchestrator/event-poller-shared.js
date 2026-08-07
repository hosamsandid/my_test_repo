'use strict';

// ============================================================
// Shared primitives for polling-based external-event integrations
// (GitHub, Jira, ...). Factored out of github-poller.js once a second
// poller needed the exact same seen-id dedup, history-horizon gating,
// burst-cap digest grouping, and Layer-3 throttle bookkeeping — pure
// refactor, no behavior change versus their previous home there.
// ============================================================

const fs = require('fs');
const path = require('path');

// #320-F: upper bound on the sliding set of processed event ids kept per
// poll unit (a repo, a Jira project, ...). One poll's worth of events is
// small; retaining several polls' worth means a delayed/re-observed event
// is still recognised as already-seen. Tiny on disk; oldest ids beyond
// this bound are pruned.
const SEEN_MAX = 500;

// #449-C: burst cap for the fan-out. When MORE than BURST_CAP fresh events
// for the same (agent, conversationKey) arrive in a SINGLE poll, they
// collapse into one lossless digest queue entry instead of BURST_CAP+
// individual agent wake-ups. This is the poll-scoped sibling of the
// Layer-3 throttle (THROTTLE_*, hour-scoped): the throttle silently
// *drops* beyond its threshold, the digest *bundles* without losing
// any event.
const BURST_CAP = 3;

// Layer-3 loop protection: per (agent, conversation-key) sliding window.
// If an agent has reacted more than THROTTLE_THRESHOLD times to the same
// thread within THROTTLE_WINDOW_MS, further events are dropped until the
// window resets, and a one-shot warning is posted to the agent's DM.
const THROTTLE_WINDOW_MS = 60 * 60_000;
const THROTTLE_THRESHOLD = 5;

// #320-B: safety look-back applied to the per-subscriber history horizon.
// Source APIs can deliver events out of order and somewhat late, so an
// event that legitimately belongs to a subscriber can carry a timestamp
// slightly older than the subscriber's activation stamp. Widening the
// horizon by GRACE_MS catches those border cases without letting a real
// backlog in.
const GRACE_MS = 5 * 60_000;

// Backoff bounds for poll units that consistently fail (expired
// credential, deleted project/repo, network outage). Capped at 30m so a
// once-flaky credential recovers within at most one work-break.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

// Exponential backoff (1m, 2m, 4m, ...) capped at BACKOFF_MAX_MS, given the
// number of consecutive failures observed so far (>=1).
function computeBackoffDelayMs(consecutiveFailures) {
  const failures = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0 ? consecutiveFailures : 1;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);
}

// #320-A: the per-subscriber history horizon. Prefer the trigger's activation
// stamp (set on create and refreshed on re-enable), then its creation stamp,
// then the triggers.json mtime as the legacy fallback for triggers authored
// before the stamps existed. Returns an ISO string or null (no horizon known).
function effectiveHorizon(trigger, triggersMtime) {
  return (trigger && (trigger.activatedAt || trigger.createdAt)) || triggersMtime || null;
}

// #320-B: is `eventCreatedAt` recent enough to reach a subscriber whose horizon
// is `horizonIso`? The horizon is widened by `graceMs` to absorb late/out-of-
// order delivery. Missing horizon or timestamp fails open (deliver) — the same
// posture the code had before a horizon existed.
function passesHorizon(eventCreatedAt, horizonIso, graceMs) {
  if (!horizonIso || !eventCreatedAt) return true;
  const cutoff = Date.parse(horizonIso) - (graceMs || 0);
  const ts = Date.parse(eventCreatedAt);
  if (Number.isNaN(cutoff) || Number.isNaN(ts)) return true;
  return ts >= cutoff;
}

// #320-F: split a freshly fetched event list into the events not yet processed
// (`fresh`) and the next sliding id set (`nextSeen`), given the previous set.
// Membership is by event id, so delivery order/lag no longer matter: an event
// with an older timestamp but an unseen id is still fresh, and a re-observed
// id is never re-delivered. `nextSeen` prepends every currently visible id (so
// ids still in the source's window stay remembered), dedups preserving
// newest-first order, and caps at `seenMax`.
function selectFreshEvents(events, seenArr, seenMax) {
  const list = Array.isArray(events) ? events : [];
  const seen = new Set(Array.isArray(seenArr) ? seenArr : []);
  const fresh = list.filter(e => e && e.id != null && !seen.has(String(e.id)));

  const nextSeen = [];
  const added = new Set();
  const push = (id) => {
    if (id == null) return;
    const s = String(id);
    if (added.has(s)) return;
    added.add(s);
    nextSeen.push(s);
  };
  for (const e of list) push(e && e.id);
  for (const id of (Array.isArray(seenArr) ? seenArr : [])) push(id);
  return { fresh, nextSeen: nextSeen.slice(0, seenMax || SEEN_MAX) };
}

// #449-C (pure core, unit-tested). Given the events that survived every
// delivery gate in one poll — each tagged as { agentId, convKey, ... } —
// group them by (agentId, convKey) and decide per group how to hand off:
//   mode 'digest'     when a group has MORE than `cap` events (the burst
//                     case collapses into one lossless notification), else
//   mode 'individual' (normal volume — the caller enqueues each event and
//                     applies the Layer-3 throttle unchanged).
// Group insertion order and per-group event order (caller passes oldest-
// first) are preserved. Pure — no I/O.
function planBurstHandoffs(deliverables, cap) {
  const CAP = Number.isInteger(cap) && cap >= 0 ? cap : BURST_CAP;
  const groups = new Map();
  const order = [];
  for (const d of Array.isArray(deliverables) ? deliverables : []) {
    if (!d || !d.agentId) continue;
    const convKey = d.convKey ?? null;
    const gkey = `${d.agentId} ${convKey ?? ''}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { agentId: d.agentId, convKey, items: [] };
      groups.set(gkey, g);
      order.push(gkey);
    }
    g.items.push(d);
  }
  return order.map((k) => {
    const g = groups.get(k);
    return {
      agentId: g.agentId,
      convKey: g.convKey,
      mode: g.items.length > CAP ? 'digest' : 'individual',
      items: g.items,
    };
  });
}

// ─── Layer-3 throttle ────────────────────────────────────────────────
// The state file is a flat map of `<key>` (typically `<agentId>:<convKey>`)
// → bucket. Buckets older than 2x the window are pruned at load time so the
// file doesn't grow unbounded as old threads go quiet.
function loadThrottleState(stateFilePath, windowMs = THROTTLE_WINDOW_MS) {
  try {
    if (!fs.existsSync(stateFilePath)) return {};
    const raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) || {};
    const buckets = raw.buckets || {};
    const now = Date.now();
    const pruned = {};
    for (const [k, b] of Object.entries(buckets)) {
      if (!b?.windowStart) continue;
      const age = now - new Date(b.windowStart).getTime();
      if (age <= 2 * windowMs) pruned[k] = b;
    }
    return pruned;
  } catch (err) {
    console.error(`[event-poller] Cannot load throttle state (${stateFilePath}): ${err.message}`);
    return {};
  }
}

function saveThrottleState(stateFilePath, buckets) {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({ buckets }, null, 2));
  } catch (err) {
    console.error(`[event-poller] Cannot save throttle state (${stateFilePath}): ${err.message}`);
  }
}

// Increments the bucket for `key` (mutates `buckets` in place). Returns:
//   { drop: bool, justWarned: bool, count, threshold, windowEndsAt }
// `justWarned` is true exactly once per window — when the count first
// crosses the threshold — so the agent gets one DM, not one per dropped
// event.
function checkAndIncThrottle(buckets, key, { windowMs = THROTTLE_WINDOW_MS, threshold = THROTTLE_THRESHOLD } = {}) {
  const now = Date.now();
  let bucket = buckets[key];
  if (!bucket || now - new Date(bucket.windowStart).getTime() > windowMs) {
    bucket = { count: 1, windowStart: new Date(now).toISOString(), warned: false };
    buckets[key] = bucket;
    return {
      drop: false,
      justWarned: false,
      count: 1,
      threshold,
      windowEndsAt: new Date(now + windowMs).toISOString(),
    };
  }
  bucket.count++;
  let justWarned = false;
  let drop = false;
  if (bucket.count > threshold) {
    drop = true;
    if (!bucket.warned) {
      bucket.warned = true;
      justWarned = true;
    }
  }
  const windowEndsAt = new Date(
    new Date(bucket.windowStart).getTime() + windowMs,
  ).toISOString();
  return { drop, justWarned, count: bucket.count, threshold, windowEndsAt };
}

module.exports = {
  SEEN_MAX,
  BURST_CAP,
  THROTTLE_WINDOW_MS,
  THROTTLE_THRESHOLD,
  GRACE_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  computeBackoffDelayMs,
  effectiveHorizon,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  loadThrottleState,
  saveThrottleState,
  checkAndIncThrottle,
};
