'use strict';

// Edge-triggered wake de-duplication for label hand-offs (#2152).
//
// THE BUG. `labelFilterMatches` (#1376) deliberately matches a subscriber's
// `labelFilter` against the object's FULL current label set (`payload.labels`),
// not just the single label the `*.labeled` event names — the Events API
// collapses a multi-label add into one event that names only one of the added
// labels, so the full-set match is the only way to recover a wake whose label
// was collapsed away. The side effect: ANY `*.labeled` event on the object
// re-fires EVERY listener whose wanted label merely PERSISTS on the object.
//
// So a `labelFilter: 'ready'` developer, woken by `ready`, is woken AGAIN by:
//   - an unrelated label being added/removed while `ready` still hangs on,
//   - the agent's OWN claim swap — `<wake>` -> `<wake>:wip` is not atomic, so
//     the `labeled(<wake>:wip)` event's snapshot still carries `<wake>`, and
//   - the Events API mis-attributing `payload.label.name` (it is unreliable),
//     which defeats the `self-claim-label` guard that keys on that field.
// The `seen`-id set does not help: these are genuinely distinct event ids.
//
// THE FIX. Track, per repo, which wake labels have already been DELIVERED and
// are still present ("armed"). A full-set match fires only on the RISING EDGE —
// when its wake label is not already armed for that object. Arm on first
// encounter; DISARM when the label is observed removed (`*.unlabeled`) or the
// object is closed, so a genuine remove -> re-add re-fires. This is immune to
// unrelated churn, the agent's own claim swap, slow claim-swap timing, and the
// Events API's unreliable `payload.label` — because it never trusts a single
// event's attributed label, only the object's armed history across polls.
//
// The armed set lives in the poller `state.json` per repo (unlike the in-memory
// #1858 `LabelDedupMarkers`), because the re-fire window here is the whole
// delivery-to-claim-swap latency — an agent's run can sit queued behind the
// WorkspaceGate for far longer than a process lifetime, so a restart must not
// forget an arm and re-open the double-fire.

// A wake stays armed at most this long even if we never observe its removal
// (a missed `unlabeled`/`closed` event — the Events API is lossy). Generous:
// an issue can legitimately hold a wake label for days while queued, and a
// stale arm only suppresses a duplicate wake, never a first one.
const ARMED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Hard cap on armed entries per repo — a backstop against unbounded growth if
// `closed`/`unlabeled` events are consistently missed. Far above the number of
// simultaneously-open wake labels any real flow holds; oldest are dropped first.
const ARMED_MAX = 5000;

// Stable identity for an armed wake — the (trigger, object-kind, number, label)
// tuple. JSON-encoded so no field value can collide with a separator, and
// parseable back out for the object-scoped disarm/close sweeps.
function armedKey({ triggerId, kind, number, label }) {
  return JSON.stringify([triggerId, kind, number, label]);
}

function parseArmedKey(k) {
  try {
    const [triggerId, kind, number, label] = JSON.parse(k);
    return { triggerId, kind, number, label };
  } catch {
    return null;
  }
}

// Is this (trigger, object, label) already armed? A malformed/absent map reads
// as "not armed" (fail-open — deliver, i.e. today's behaviour).
function isArmed(armed, key) {
  return !!armed && Object.prototype.hasOwnProperty.call(armed, key);
}

// Arm a wake on its rising edge, stamping the arm time for TTL GC.
function arm(armed, key, atMs) {
  armed[key] = atMs;
  return armed;
}

// Disarm every entry for a removed (kind, number, label) — across all triggers,
// since a label removal is a fact about the OBJECT, not about one listener.
function disarmLabel(armed, { kind, number, label }) {
  if (!armed) return armed;
  for (const k of Object.keys(armed)) {
    const p = parseArmedKey(k);
    if (p && p.kind === kind && p.number === number && p.label === label) delete armed[k];
  }
  return armed;
}

// Disarm every entry for a closed object (any label, any trigger).
function disarmObject(armed, { kind, number }) {
  if (!armed) return armed;
  for (const k of Object.keys(armed)) {
    const p = parseArmedKey(k);
    if (p && p.kind === kind && p.number === number) delete armed[k];
  }
  return armed;
}

// Presence-based disarm: drop every entry for (kind, number) whose label is NOT
// in the object's CURRENT full label set. This does not depend on ever
// observing the label's removal event — which is the whole point, because the
// Events API does not deliver a standalone `unlabeled(<wake>)` for a PR (a
// removal is collapsed with the paired add, or dropped), so the `unlabeled`
// disarm never fires for the dominant claim-swap flow. Every `labeled` event
// instead carries the object's full set, so a wake armed earlier but no longer
// present has been removed by SOME means and is disarmed here.
//
// `presentLabels` is a Set of the label names on the object right now. Call ONLY
// when that snapshot is genuinely present on the event — an ABSENT set must
// never be read as "everything was removed" (it would disarm every wake on the
// object). The failure direction is deliberately benign either way: a wrongly
// kept arm suppresses at most a duplicate wake, a wrongly cleared one permits at
// most a duplicate — never a lost first wake (the module's fail-open contract).
function disarmAbsent(armed, { kind, number, presentLabels }) {
  if (!armed || !presentLabels) return armed;
  for (const k of Object.keys(armed)) {
    const p = parseArmedKey(k);
    if (p && p.kind === kind && p.number === number && !presentLabels.has(p.label)) {
      delete armed[k];
    }
  }
  return armed;
}

// Drop armed entries past the TTL, then enforce the per-repo cap by evicting
// the oldest. Cheap for the handful of live entries a stack ever holds.
function gcArmed(armed, { now = Date.now(), ttlMs = ARMED_TTL_MS, maxEntries = ARMED_MAX } = {}) {
  if (!armed) return armed;
  for (const [k, at] of Object.entries(armed)) {
    if (!Number.isFinite(at) || now - at > ttlMs) delete armed[k];
  }
  const keys = Object.keys(armed);
  if (keys.length > maxEntries) {
    keys
      .sort((a, b) => (armed[a] || 0) - (armed[b] || 0)) // oldest first
      .slice(0, keys.length - maxEntries)
      .forEach((k) => delete armed[k]);
  }
  return armed;
}

module.exports = {
  armedKey,
  parseArmedKey,
  isArmed,
  arm,
  disarmLabel,
  disarmObject,
  disarmAbsent,
  gcArmed,
  ARMED_TTL_MS,
  ARMED_MAX,
};
