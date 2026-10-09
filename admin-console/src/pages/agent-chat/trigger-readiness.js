// The hand-off readiness gate (#2795) in Agent Chat → Triggers (#2912): which
// triggers can carry it, what a save sends, and the list hint. Pure
// (React-free) so it can be unit-tested with `node --test`; the gate's form
// state and rules are the Flow editor's (process/readiness-gate.js), so both
// surfaces store exactly the same `readinessGate`.

import {
  READINESS_EVENTS, readinessForm, readinessFromForm, readinessSummary, readinessWaitsFor,
} from '../process/readiness-gate.js';

// Whether a trigger of `type` listening on `events` can be gated: a
// github-event PR hand-off (PR labeled / opened / reopened) — the same rule the
// API applies (READINESS_EVENTS). Several events, only some PR-eligible, still
// count: the gate then applies to the PR hand-off events only.
export function showsReadinessGate(type, events) {
  if (type !== 'github-event') return false;
  return (Array.isArray(events) ? events : []).some(e => READINESS_EVENTS.includes(e));
}

// The gate section's form state for a stored trigger (absent = off — a new
// trigger is never gated silently).
export function readinessFormFor(trigger) {
  return readinessForm(trigger ? trigger.readinessGate : null);
}

// What "Off: … is woken as soon as …" says for these events.
export function readinessWakeWhen(events) {
  const evs = Array.isArray(events) ? events : [];
  if (evs.includes('pull_request.labeled')) return 'the label is set';
  if (evs.includes('pull_request.reopened') && !evs.includes('pull_request.opened')) return 'the PR is reopened';
  return 'the PR is opened';
}

function sameGate(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

// The `readinessGate` a TriggerForm save sends, or undefined to omit the field:
//   - create: the gate when a toggle is on, else omitted;
//   - edit: only a CHANGE is sent — the new gate, or `null` to clear it (both
//     toggles off, or the trigger is no longer a PR hand-off). An edit of other
//     fields leaves a stored gate untouched, also a combined fan-in gate on a
//     flow-derived listener, which the API would otherwise write back to every
//     contributing channel.
// `stored` is the trigger's stored `readinessGate` (canonical, defaults not
// written — the same shape readinessFromForm produces).
export function readinessGateBody({ show, form, stored, isEdit }) {
  const next = show ? readinessFromForm(form) : null;
  if (!isEdit) return next || undefined;
  const prev = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
  if (sameGate(readinessFromForm(readinessForm(prev)), next)) return undefined;
  return next;
}

// The trigger list's hint for a gated PR hand-off: `{ text: 'waits for CI +
// conflict-free', title: <full readout> }`, or null when the trigger is not
// gated (or cannot be — a stray gate on another event is never shown).
export function readinessHint(trigger) {
  if (!trigger || !showsReadinessGate(trigger.type, trigger.events)) return null;
  const what = readinessWaitsFor(trigger.readinessGate);
  if (!what) return null;
  return { text: `waits for ${what}`, title: readinessSummary(trigger.readinessGate) };
}
