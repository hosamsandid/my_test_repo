'use strict';

// Manual "Fire again" for a dropped GitHub-event wake (#2525).
//
// The poller's loop protection can leave a hand-off stuck: the edge dedup
// (#2152) keeps a wake label ARMED after its first delivery and drops every
// later matching event as `wake-already-armed`, the Layer-3 throttle drops as
// `throttle`, and the internal fast-path marker (#1858) drops as
// `internal-dedup`. None of those drops can be undone from the event itself —
// the event was already seen — so a human can re-deliver it from the agent's
// Events tab. This module is the decision half of that override: which drops
// are overridable, whether the item is still in a state the wake makes sense
// for, and the synthetic event + log entry the re-fire produces.
//
// A re-fire is a HUMAN override, not a relaxation of the protections: it is
// enqueued directly (never through the poller's gates, so none of the three can
// drop it) and touches no throttle bucket or dedup marker belonging to any other
// event. It RE-ARMS the wake key (see orchestrator.js) so a later duplicate of
// the same label is still dropped as `wake-already-armed` (AC10).
//
// fs-free so it is unit-testable (`node --test`); the event-log read, the
// GitHub fetch, the in-flight lock and the enqueue live in orchestrator.js.

// The only drop reasons a human may override (#2525 resolved decision). Every
// other reason is a routing decision (label-filter, self-claim-label, horizon,
// push-duplicate), not a protection that may have swallowed a real wake.
const REFIRABLE_REASONS = Object.freeze(['wake-already-armed', 'throttle', 'internal-dedup']);

// `source` stamped on the re-fire's pending entry and its event-log row.
const REFIRE_SOURCE = 'manual-refire';

const EVENT_ID_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
const TRIGGER_ID_RE = /^[A-Za-z0-9:_.-]{1,128}$/;

function isRefirableReason(reason) {
  return REFIRABLE_REASONS.includes(reason);
}

// `{ok, value: {eventId, triggerId}}` or `{ok: false, error}`. The actor is
// NOT read from the body's say-so alone — the console stamps it server-side.
function validateRefireRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const { eventId, triggerId } = body;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) {
    return { ok: false, error: 'eventId must be a non-empty id' };
  }
  if (typeof triggerId !== 'string' || !TRIGGER_ID_RE.test(triggerId)) {
    return { ok: false, error: 'triggerId must be a non-empty id' };
  }
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : null;
  return { ok: true, value: { eventId, triggerId, actor } };
}

// One-string key for the in-flight lock and the prior-refire lookup.
function refireKey({ eventId, agentId, triggerId }) {
  return JSON.stringify([eventId, agentId, triggerId]);
}

// The logged (entry, outcome) this re-fire targets, or null. Several triggers
// on one agent can listen to the same event (#2525 edge case), so the outcome is
// picked by BOTH agent and trigger, never just the agent.
function findDroppedOutcome(entries, { eventId, agentId, triggerId }) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || String(entry.eventId) !== eventId) continue;
    const outcome = (entry.outcomes || []).find(
      (o) => o && o.agentId === agentId && o.triggerId === triggerId,
    );
    if (outcome) return { entry, outcome };
  }
  return null;
}

// The earlier re-fire of this exact (event, agent, trigger), or null — the
// persisted half of the at-most-once guarantee (AC9); the in-flight lock in
// orchestrator.js is the concurrent half.
function findPriorRefire(entries, { eventId, agentId, triggerId }) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.source !== REFIRE_SOURCE || !entry.refireOf) continue;
    if (entry.refireOf.eventId !== eventId) continue;
    if ((entry.outcomes || []).some((o) => o && o.agentId === agentId && o.triggerId === triggerId)) {
      return entry;
    }
  }
  return null;
}

// For an `internal-dedup` drop: the earlier delivery of the same (agent,
// trigger, item, wake label) that the marker deduplicated against — the
// console fast-path / supervisor / previous re-fire row logged at or before the
// drop. Newest first. Null when it has aged out of the log.
function findTwinDelivery(entries, { entry, agentId, triggerId, wakeLabel }) {
  const num = entry && entry.workItem ? entry.workItem.number : null;
  if (num == null) return null;
  const dropTs = String(entry.ts || '');
  let best = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e === entry || e.repo !== entry.repo) continue;
    if (!e.workItem || e.workItem.number !== num) continue;
    if (dropTs && String(e.ts || '') > dropTs) continue;
    const o = (e.outcomes || []).find(
      (x) => x && x.agentId === agentId && x.triggerId === triggerId && x.status === 'delivered',
    );
    if (!o) continue;
    const label = typeof o.wakeLabel === 'string' ? o.wakeLabel : e.label;
    if (wakeLabel && label !== wakeLabel) continue;
    if (!best || String(e.ts || '') > String(best.ts || '')) best = e;
  }
  return best ? { eventId: String(best.eventId), triggerId, ts: best.ts || null, source: best.source || null } : null;
}

// The trigger's session correlationId for a delivered GitHub event —
// byte-identical to the runner's `trigger:<triggerId>:gh:<eventId>` stamp
// (agent-entrypoint.py) and the console's `buildTriggerCorrelationId`.
function triggerCorrelationId(triggerId, eventId) {
  if (!triggerId || !eventId) return null;
  return `trigger:${triggerId}:gh:${eventId}`;
}

// Decide whether the logged drop may be re-fired, BEFORE any GitHub call.
// Returns `{ok: true, wakeLabel, workItem}` or a refusal `{ok: false, status,
// code, error}` whose `error` is the plain-language message the dialog shows.
function planRefire({ found, prior, trigger, agentEnabled, retentionCutoffMs }) {
  if (!found) {
    return { ok: false, status: 404, code: 'not-found', error: 'That event is no longer in the event log (past retention or never recorded for this trigger).' };
  }
  const { entry, outcome } = found;
  const ts = Date.parse(entry.ts);
  if (Number.isFinite(retentionCutoffMs) && Number.isFinite(ts) && ts < retentionCutoffMs) {
    return { ok: false, status: 404, code: 'not-found', error: 'That event is past the event-log retention window.' };
  }
  if (outcome.status !== 'dropped' || !isRefirableReason(outcome.reason)) {
    return {
      ok: false, status: 409, code: 'not-refirable',
      error: `Only drops for ${REFIRABLE_REASONS.join(', ')} can be fired again (this one was ${outcome.status}${outcome.reason ? ` / ${outcome.reason}` : ''}).`,
    };
  }
  if (prior) {
    const by = prior.refiredBy ? ` by ${prior.refiredBy}` : '';
    return { ok: false, status: 409, code: 'already-refired', error: `This event was already fired again${by} at ${prior.ts}.`, refire: refireSummary(prior) };
  }
  const workItem = entry.workItem;
  if (!workItem || workItem.number == null || (workItem.kind !== 'pr' && workItem.kind !== 'issue')) {
    return { ok: false, status: 409, code: 'no-work-item', error: 'This event has no pull request or issue to wake the agent for.' };
  }
  if (!trigger) {
    return { ok: false, status: 409, code: 'trigger-gone', error: 'The trigger that received this event no longer exists on the agent.' };
  }
  if (trigger.enabled === false) {
    return { ok: false, status: 409, code: 'trigger-disabled', error: 'The trigger that received this event is disabled.' };
  }
  if (agentEnabled === false) {
    return { ok: false, status: 409, code: 'agent-disabled', error: 'The agent is disabled — enable it before firing again.' };
  }
  const wakeLabel = typeof outcome.wakeLabel === 'string' && outcome.wakeLabel
    ? outcome.wakeLabel
    : (typeof trigger.labelFilter === 'string' && trigger.labelFilter.trim() ? trigger.labelFilter.trim() : null);
  return { ok: true, wakeLabel, workItem };
}

// Check the item's CURRENT GitHub state (AC8). `detail` is the issue/PR object
// from the REST API (`state`, `merged`/`merged_at`, `labels`). A missing detail
// (fetch failed) refuses rather than guesses: waking an agent on a merged PR is
// the one outcome this check exists to prevent.
function checkItemState(detail, { kind, wakeLabel }) {
  if (!detail || typeof detail !== 'object') {
    return { ok: false, status: 502, code: 'github-unavailable', error: 'Could not read the item\'s current state from GitHub — try again in a moment.' };
  }
  const noun = kind === 'pr' ? 'pull request' : 'issue';
  if (kind === 'pr' && (detail.merged === true || detail.merged_at)) {
    return { ok: false, status: 409, code: 'item-merged', error: `The ${noun} is already merged — there is nothing to wake the agent for.` };
  }
  if (detail.state && detail.state !== 'open') {
    return { ok: false, status: 409, code: 'item-closed', error: `The ${noun} is closed — reopen it before firing again.` };
  }
  if (wakeLabel) {
    const labels = Array.isArray(detail.labels)
      ? detail.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
      : [];
    if (!labels.includes(wakeLabel)) {
      const wip = labels.includes(`${wakeLabel}:wip`);
      return {
        ok: false, status: 409, code: wip ? 'label-claimed' : 'label-gone',
        error: wip
          ? `The wake label '${wakeLabel}' was already claimed ('${wakeLabel}:wip' is on the ${noun}) — an agent is working on it.`
          : `The wake label '${wakeLabel}' is no longer on the ${noun} — re-apply it to wake the agent.`,
      };
    }
  }
  return { ok: true };
}

// The GitHub event key's action (`pull_request.labeled` → `labeled`).
function actionOf(key) {
  const s = String(key || '');
  const i = s.indexOf('.');
  return i === -1 ? null : s.slice(i + 1);
}

// Synthesize the poller-shaped event the re-fire delivers: same event key as the
// dropped one, the item's CURRENT title/closes (so the trigger notice and
// admission control see exactly what a fresh rising edge would), and — for a
// label wake — the wake label as the attributed label. Byte-compatible with the
// fast-path synthetic (github-label-fastpath.js) so the runner's claim swap and
// prompt context work unchanged.
function buildRefireEvent({ entry, wakeLabel, title, closesIssues, actor, eventId, now }) {
  const wi = entry.workItem;
  const repo = entry.repo;
  const subject = {
    number: wi.number,
    html_url: wi.url || `https://github.com/${repo}/${wi.kind === 'pr' ? 'pull' : 'issues'}/${wi.number}`,
    ...((typeof title === 'string' && title) || wi.title ? { title: (typeof title === 'string' && title) || wi.title } : {}),
    ...(wi.kind === 'pr' && Array.isArray(closesIssues) && closesIssues.length ? { closesIssues } : {}),
  };
  const action = actionOf(entry.event) || 'labeled';
  const label = wakeLabel || entry.label || null;
  return {
    id: eventId,
    actor: { login: actor || 'console' },
    repo: { name: repo },
    created_at: now,
    payload: {
      action,
      ...(label && (action === 'labeled' || action === 'unlabeled') ? { label: { name: label } } : {}),
      ...(wi.kind === 'pr' ? { pull_request: subject } : { issue: subject }),
    },
  };
}

// The pending-queue entry for the re-fire. Same shape the poller's `_enqueue`
// writes (so the drain builds the SAME trigger prompt), plus `source` and the
// pointer back to the drop it overrides.
function buildRefirePendingEntry({ triggerId, key, ghEvent, wakeLabel, refireOf }) {
  return {
    triggerId,
    source: REFIRE_SOURCE,
    wakeLabel: wakeLabel || null,
    refireOf,
    github: {
      event: key,
      eventId: ghEvent.id,
      repo: ghEvent.repo && ghEvent.repo.name,
      actor: ghEvent.actor && ghEvent.actor.login,
      createdAt: ghEvent.created_at,
      payload: ghEvent.payload,
    },
  };
}

// The event-log row the re-fire writes (AC6): an ordinary delivered row — so
// the global GitHub Event Log lists it and links its session like any other —
// carrying who re-fired it and which drop it overrides.
function buildRefireLogFields({ entry, outcome, actor }) {
  return {
    source: REFIRE_SOURCE,
    refiredBy: actor || null,
    refireOf: {
      eventId: String(entry.eventId),
      reason: outcome.reason,
      ts: entry.ts || null,
    },
  };
}

// The compact `{eventId, by, at}` a drop row shows once it has been re-fired.
function refireSummary(refireEntry) {
  if (!refireEntry) return null;
  return {
    eventId: String(refireEntry.eventId),
    by: refireEntry.refiredBy || null,
    at: refireEntry.ts || null,
  };
}

module.exports = {
  REFIRABLE_REASONS,
  REFIRE_SOURCE,
  isRefirableReason,
  validateRefireRequest,
  refireKey,
  findDroppedOutcome,
  findPriorRefire,
  findTwinDelivery,
  triggerCorrelationId,
  planRefire,
  checkItemState,
  buildRefireEvent,
  buildRefirePendingEntry,
  buildRefireLogFields,
  refireSummary,
};
