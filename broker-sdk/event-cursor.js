'use strict';

// ─── Broker SDK: event-source polling primitives (Jira plugin, Phase 0) ──────
//
// A broker that polls an external system for events (Jira today; ServiceNow,
// Azure DevOps, Confluence webhooks next) needs the exact bookkeeping the
// platform's own GitHub poller has always done: a seen-id cursor so delivery
// order/lag never causes a re-fire or a miss, a per-poll burst collapse so a
// bulk transition does not become N wake-ups, an hour-scoped throttle so a
// looping flow is capped, and an exponential backoff so a dead endpoint is not
// hammered.
//
// These live in the SDK — whose source is vendored into every broker image —
// as a COPY of the platform's `orchestrator/github-poller.js` primitives, NOT a
// refactor of them (docs/jira-plugin-plan.md §6.2). `github-poller.js` keeps
// its own and is untouched by any plugin work: the poller that runs the whole
// GitHub flow must not be destabilised for a new plugin. The duplication is the
// same trade the platform already accepts for `plugin-manifest.js` and
// `scope-token.js` — a mirror test can pin the two if it is ever worth it.
//
// Pure except for the two throttle-state fs helpers, which take an explicit
// path (a broker points them at AEE_PLUGIN_STATE_DIR). No third-party deps.

const fs = require('fs');
const path = require('path');

// Upper bound on the sliding set of processed event ids kept per poll unit
// (a Jira project on a site, a repo, ...). One poll's worth of events is small;
// retaining several polls' worth means a delayed / re-observed event is still
// recognised as already-seen. Tiny on disk; oldest ids beyond this bound prune.
const SEEN_MAX = 500;

// Burst cap for the fan-out. When MORE than BURST_CAP fresh events for the same
// (agent, conversationKey) arrive in a SINGLE poll, they collapse into one
// lossless digest instead of BURST_CAP+ individual wake-ups. The poll-scoped
// sibling of the hour-scoped throttle: the throttle silently drops beyond its
// threshold, the digest bundles without losing an event.
const BURST_CAP = 3;

// Hour-scoped loop protection: per (agent, conversation-key) sliding window.
// Past THROTTLE_THRESHOLD reactions to the same thread within THROTTLE_WINDOW_MS
// further events drop until the window resets, with a one-shot warning.
const THROTTLE_WINDOW_MS = 60 * 60_000;
const THROTTLE_THRESHOLD = 5;

// Safety look-back on the per-subscriber history horizon. Source APIs deliver
// events out of order and somewhat late, so an event that legitimately belongs
// to a subscriber can carry a timestamp slightly older than its activation
// stamp; widening by GRACE_MS catches those without letting a real backlog in.
const GRACE_MS = 5 * 60_000;

// Backoff bounds for poll units that consistently fail (expired credential,
// deleted project, network outage). Capped at 30m so a once-flaky credential
// recovers within at most one work-break.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

// Exponential backoff (1m, 2m, 4m, ...) capped at BACKOFF_MAX_MS, given the
// number of consecutive failures observed so far (>= 1).
function computeBackoffDelayMs(consecutiveFailures) {
  const failures = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0 ? consecutiveFailures : 1;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);
}

// The per-subscriber history horizon. Prefer the trigger's activation stamp
// (set on create, refreshed on re-enable), then its creation stamp, then the
// config mtime as the legacy fallback. ISO string or null (no horizon known).
function effectiveHorizon(trigger, triggersMtime) {
  return (trigger && (trigger.activatedAt || trigger.createdAt)) || triggersMtime || null;
}

// Is `eventCreatedAt` recent enough to reach a subscriber whose horizon is
// `horizonIso`? The horizon is widened by `graceMs` to absorb late / out-of-
// order delivery. Missing horizon or timestamp fails open (deliver).
function passesHorizon(eventCreatedAt, horizonIso, graceMs) {
  if (!horizonIso || !eventCreatedAt) return true;
  const cutoff = Date.parse(horizonIso) - (graceMs || 0);
  const ts = Date.parse(eventCreatedAt);
  if (Number.isNaN(cutoff) || Number.isNaN(ts)) return true;
  return ts >= cutoff;
}

// Split a freshly fetched event list into the events not yet processed (`fresh`)
// and the next sliding id set (`nextSeen`), given the previous set. Membership
// is by event id, so delivery order / lag no longer matter: an event with an
// older timestamp but an unseen id is still fresh, and a re-observed id is
// never re-delivered. `nextSeen` prepends every currently visible id (so ids
// still in the source's window stay remembered), dedups newest-first, caps at
// `seenMax`.
function selectFreshEvents(events, seenArr, seenMax) {
  const list = Array.isArray(events) ? events : [];
  const seen = new Set(Array.isArray(seenArr) ? seenArr : []);
  const fresh = list.filter((e) => e && e.id != null && !seen.has(String(e.id)));

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

// Given the events that survived every delivery gate in one poll — each tagged
// { agentId, convKey, ... } — group by (agentId, convKey) and decide per group
// how to hand off: mode 'digest' when a group has MORE than `cap` events, else
// mode 'individual' (the caller enqueues each and applies the throttle). Group
// insertion order and per-group event order (caller passes oldest-first) are
// preserved. Pure — no I/O.
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

// ─── hour-scoped throttle ───────────────────────────────────────────────────
// The state file is a flat map of `<key>` (typically `<agentId>:<convKey>`) →
// bucket. Buckets older than 2x the window prune at load so the file does not
// grow unbounded as old threads go quiet.
function loadThrottleState(stateFilePath, windowMs = THROTTLE_WINDOW_MS) {
  try {
    if (!fs.existsSync(stateFilePath)) return {};
    const raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) || {};
    const buckets = raw.buckets || {};
    const now = Date.now();
    const pruned = {};
    for (const [k, b] of Object.entries(buckets)) {
      if (!b || !b.windowStart) continue;
      const age = now - new Date(b.windowStart).getTime();
      if (age <= 2 * windowMs) pruned[k] = b;
    }
    return pruned;
  } catch {
    return {};
  }
}

function saveThrottleState(stateFilePath, buckets) {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({ buckets }, null, 2));
  } catch {
    /* best-effort */
  }
}

// Increments the bucket for `key` (mutates `buckets` in place). Returns
// { drop, justWarned, count, threshold, windowEndsAt }. `justWarned` is true
// exactly once per window — when the count first crosses the threshold — so the
// agent gets one warning, not one per dropped event.
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
  bucket.count += 1;
  let justWarned = false;
  let drop = false;
  if (bucket.count > threshold) {
    drop = true;
    if (!bucket.warned) {
      bucket.warned = true;
      justWarned = true;
    }
  }
  const windowEndsAt = new Date(new Date(bucket.windowStart).getTime() + windowMs).toISOString();
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
