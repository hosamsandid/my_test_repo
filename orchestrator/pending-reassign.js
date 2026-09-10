'use strict';

// Operator-initiated reassignment of a WAITING pending-queue entry from one
// agent to another (#2102 — the half #724 explicitly deferred). Pure and
// fs-free; the endpoints, the disk reads and the delete-then-enqueue ordering
// live in orchestrator.js.
//
// Two jobs:
//
//  1. ELIGIBILITY — "which sibling agents would accept this queued event?" is
//     answered by composing the poller's OWN exported predicates
//     (`pollerSubscribes`, `labelFilterMatches`, `effectiveHorizon`,
//     `passesHorizon`), never by a second matcher. This is not stylistic. The
//     failure mode this whole ticket exists to prevent is a move that LOOKS
//     successful and then evaporates: the target resolves the entry's
//     `triggerId` against its own `triggers.json`, finds nothing, writes one
//     line to stderr and drops an entry that was already removed from the
//     source queue. A re-implemented matcher that drifts from the poller by one
//     gate produces exactly that (#2102 AC1), so the real predicates are the
//     only acceptable source of the answer.
//
//  2. THE MOVED ENTRY — re-stamped with the TARGET's own trigger id plus
//     provenance, because a queued entry carries the id of the trigger on the
//     ORIGINAL agent and trigger ids are minted per agent (they never collide
//     across two agents). See agent-entrypoint.py `_handle_pending_entry`.

const {
  pollerSubscribes,
  labelFilterMatches,
  effectiveHorizon,
  passesHorizon,
  GRACE_MS,
} = require('./github-poller');

// Why a candidate was refused, in the poller's own vocabulary so an operator
// reading a refusal can look the reason up in the Event Log's outcome legend.
const REFUSAL_REASONS = {
  'not-subscribed': 'that agent has no enabled github-event trigger of this shape',
  'repo-mismatch': 'its trigger watches a different repository',
  'event-not-subscribed': 'it does not subscribe to this event type',
  'history-horizon': 'the event predates its trigger\'s subscription window',
  'label-filter': 'its trigger subscribes to a different label',
};

// Rebuild the event shape the poller matched on from a queued `github` entry.
// This is a RENAME, not a reconstruction: `github-poller._enqueue` stores its
// own projection of the event (`{event, eventId, repo, actor, createdAt,
// payload}`) and the payload it matched on is carried verbatim, so the
// predicates below see exactly the bytes the poller saw.
function ghEventFromEntry(entry) {
  const g = (entry && entry.github) || {};
  return {
    id: g.eventId,
    created_at: g.createdAt || null,
    payload: (g.payload && typeof g.payload === 'object') ? g.payload : {},
    repo: { name: g.repo || null },
    actor: { login: g.actor || null },
  };
}

// Would `trigger` — as authored on some candidate agent — accept this queued
// event? Mirrors the gate ORDER of `github-poller._fanOutBatch`, minus the
// three gates that are a property of RUNTIME STATE rather than of
// (trigger, event):
//
//   - the Layer-3 throttle          — a per-(agent, conversation) counter. Not
//                                     a match question, and an operator move is
//                                     a deliberate single act, not a burst.
//   - the internal fast-path dedup  — keyed to a delivery that already
//                                     happened; this entry has not been
//                                     delivered to the target at all.
//   - the self-claim-label drop     — the SOURCE agent's own `<wake>:wip`
//                                     decoration. It exists so a trigger cannot
//                                     re-wake itself; an operator handing the
//                                     entry to a different agent is not a
//                                     self-wake.
//
// What remains IS the match: event-key membership, the history horizon and the
// label filter — each evaluated with the poller's own exported predicate, and
// each in the same order, so the reason a candidate is refused reads the same
// way it would in the Event Log.
function triggerAccepts(trigger, { eventKey, ghEvent, repo, triggersMtime }) {
  if (!pollerSubscribes(trigger)) return { ok: false, reason: 'not-subscribed' };
  // The poller never even offers a trigger an event from another repository:
  // its plan is keyed on `t.repo` (`_buildPollPlan`), so the repo binding is
  // structural there and has to be an explicit gate here.
  if (repo && trigger.repo !== repo) return { ok: false, reason: 'repo-mismatch' };
  if (!eventKey || !trigger.events.includes(eventKey)) {
    return { ok: false, reason: 'event-not-subscribed' };
  }
  if (!passesHorizon(ghEvent && ghEvent.created_at, effectiveHorizon(trigger, triggersMtime), GRACE_MS)) {
    return { ok: false, reason: 'history-horizon' };
  }
  // Same normalisation `_buildPollPlan` applies: a blank/whitespace filter is
  // no filter (legacy any-label listener), not a filter on the empty string.
  const labelFilter = (typeof trigger.labelFilter === 'string' && trigger.labelFilter.trim()) || null;
  if (labelFilter && !labelFilterMatches(ghEvent, labelFilter)) {
    return { ok: false, reason: 'label-filter' };
  }
  return { ok: true, triggerId: trigger.id, labelFilter };
}

// The candidates that would accept this entry, each with the trigger id the
// moved entry must carry, plus the ones that would not and why.
//
// `candidates` is `[{agentId, agentName, triggers, triggersMtime}]` — the
// caller does the fs reads and the same-team / self / `role:'team'` / disabled
// filtering, so this stays pure and testable against the poller's fan-out.
//
// The FIRST accepting trigger per agent wins: the moved entry carries exactly
// one trigger id, and the poller would itself fan the event out once per
// matching trigger on that agent, so any one of them is a faithful delivery.
// The per-agent refusal reason is the reason of its LAST refusing trigger,
// which is the useful one when an agent has a single trigger — the common case.
function eligibleTargets(entry, candidates) {
  const ghEvent = ghEventFromEntry(entry);
  const g = (entry && entry.github) || {};
  const eventKey = g.event || null;
  const repo = g.repo || null;
  const eligible = [];
  const refused = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || typeof c.agentId !== 'string' || !c.agentId) continue;
    const triggers = Array.isArray(c.triggers) ? c.triggers : [];
    let accepted = null;
    let reason = 'not-subscribed';
    for (const t of triggers) {
      const verdict = triggerAccepts(t, { eventKey, ghEvent, repo, triggersMtime: c.triggersMtime || null });
      if (verdict.ok) { accepted = verdict; break; }
      reason = verdict.reason;
    }
    const name = c.agentName || c.agentId;
    if (accepted) {
      eligible.push({
        agentId: c.agentId,
        agentName: name,
        triggerId: accepted.triggerId,
        labelFilter: accepted.labelFilter,
      });
    } else {
      refused.push({ agentId: c.agentId, agentName: name, reason });
    }
  }
  return { eligible, refused };
}

// The entry to enqueue on the target. Three things change and nothing else:
//
//  - `triggerId` becomes the TARGET's own trigger id. This is the whole point
//    of the feature (#2102's opening warning): the consumer resolves the id
//    against its own trigger list and silently drops what it cannot find.
//  - a fresh `id`, so the moved entry is independently addressable — and
//    cancellable — in the target's queue. The source id is kept as provenance,
//    never reused, so the two are never confused in a log.
//  - provenance: where it came from, who moved it, when.
//
// `receivedAt` is deliberately PRESERVED (#2102 Q3). It answers "when did
// GitHub emit this", which is the age signal that made the operator intervene
// in the first place, and `reassignedAt` answers "when was it moved" — two
// different questions, two fields, neither overwriting the other. Safe because
// `passesHorizon` runs only in the poller's fan-out, never on drain: a
// preserved timestamp cannot cause the target to drop the entry. (The horizon
// IS still honoured for the move itself — `triggerAccepts` above applies it to
// the target's trigger, so an operator cannot hand an agent an event that
// predates its own subscription window.)
//
// `source: 'internal'` matches the flow-emit / wake-agent entries so log
// readers can tell the delivery path apart (docs/direct-agent-handoff-concept.md).
//
// `wakeLabel` is re-stamped from the TARGET's own `labelFilter` (#2151), never
// carried over from `...base`: the entry now sits in the target's queue under
// the target's trigger, and the source's wakeLabel recorded what woke a
// DIFFERENT trigger — carrying it over would misattribute the target's own
// notice the same way this ticket fixes elsewhere.
function buildReassignedEntry(entry, { triggerId, labelFilter, fromAgentId, byUserId, at, id }) {
  const base = (entry && typeof entry === 'object') ? entry : {};
  return {
    ...base,
    id,
    triggerId,
    wakeLabel: labelFilter || null,
    source: 'internal',
    reassignedFrom: fromAgentId,
    reassignedFromEntryId: base.id || null,
    reassignedBy: byUserId || null,
    reassignedAt: at,
  };
}

// The transparency-log event for a reassignment (#2102 AC6). Mirrors
// `wake-agent.buildWakeLogEvent`: `buildEventEntry` is GitHub-event-shaped, so
// we hand it the queued event's OWN identity — same `eventId`, same repo, same
// payload — and let it re-extract the label and the work item. Sharing the
// event id is the point: the Processed-events tab then shows the original
// `delivered → <source>` row and this `reassigned → <target>` row against the
// same event, so the trail no longer claims the source agent was served and
// stops there (which is precisely what AC6 forbids).
function buildReassignLogEvent(entry, { now }) {
  const ghEvent = ghEventFromEntry(entry);
  return { ...ghEvent, created_at: ghEvent.created_at || now };
}

// The reassignment fields that ride ALONGSIDE the GitHub-shaped entry, in the
// same slot `wake-agent.buildWakeLogFields` uses and for the same reason:
// `buildEventEntry` extracts only GitHub's own vocabulary (`label`, `ref`,
// `workItem`) and would drop who-moved-what-where on the floor.
function buildReassignLogFields({ fromAgentId, toAgentId, byUserId }) {
  return {
    reassign: {
      from: fromAgentId,
      to: toAgentId,
      ...(byUserId ? { by: byUserId } : {}),
    },
  };
}

// The move itself, with its two side effects INJECTED (`removeAtSource`,
// `enqueueAtTarget`) so the thing that actually needs proving — the order they
// run in, and that no refusal reaches either of them — is testable without a
// filesystem. orchestrator.js supplies the real fs pair; without this seam the
// whole sequence would sit in a 15k-line module that cannot be imported, and
// "the source entry is left untouched after a refusal" (#2102 AC4) could only
// ever be asserted by reading source text.
//
// ORDER IS THE DESIGN (AC2). The removal runs FIRST and IS the atomic claim:
// `removeAtSource` reports `removed: false` when the agent already drained the
// entry, and on that answer nothing is enqueued. Enqueue-first would mean a
// concurrently-draining source makes BOTH agents run the same work item — the
// #1527 race, expensive and only visible at end-of-invocation. A lost event is
// recoverable by a human re-applying the label; a double run is not.
//
// `deps` = { entry, isReassignable, resolveTarget, candidate, removeAtSource,
//            enqueueAtTarget, newId, now, byUserId }
function performReassign({ sourceAgentId, targetAgentId }, deps) {
  const {
    entry, isReassignable, resolveTarget, candidate,
    removeAtSource, enqueueAtTarget, newId, now, byUserId = null,
  } = deps;

  // ── Refusals. Every one of these returns BEFORE removeAtSource is called, so
  //    a refused move cannot have touched either queue (AC4).
  if (!entry) return { ok: false, code: 'entry-gone' };
  if (!isReassignable(entry)) {
    return { ok: false, code: 'kind-not-reassignable' };
  }
  // Same-team integrity (and self-targeting), delegated to the direct-hand-off
  // resolver so the rule is stated once. An integrity constraint on the flow
  // graph, NOT authentication — the console's per-user gate is the authz half.
  const resolved = resolveTarget();
  if (!resolved.ok) return { ok: false, code: resolved.reason };
  if (!candidate) return { ok: false, code: 'target-not-a-candidate' };

  // Re-resolve the trigger ON THE TARGET. The check that makes the feature real
  // rather than apparent: without it the entry lands carrying the SOURCE's
  // trigger id, which resolves to nothing on the target.
  const { eligible, refused } = eligibleTargets(entry, [candidate]);
  if (!eligible.length) {
    return {
      ok: false,
      code: 'no-matching-trigger',
      reason: (refused[0] && refused[0].reason) || 'not-subscribed',
    };
  }
  const target = eligible[0];
  const workItem = describeEntryWorkItem(entry);

  // ── Claim it.
  let claim;
  try {
    claim = removeAtSource();
  } catch (err) {
    return { ok: false, code: 'source-write-failed', error: err.message };
  }
  if (!claim || !claim.removed) return { ok: false, code: 'already-fired' };

  // ── Hand it over, re-stamped for the target.
  const moved = buildReassignedEntry(entry, {
    triggerId: target.triggerId,
    labelFilter: target.labelFilter,
    fromAgentId: sourceAgentId,
    byUserId,
    at: now,
    id: newId,
  });
  if (enqueueAtTarget(moved) === false) {
    // AC8: the event is now in NO queue. Never a success. The caller parks the
    // entry and the sentence names the work item, because re-applying the label
    // on GitHub is the operator's only recovery.
    return { ok: false, code: 'enqueue-failed', workItem, entry: moved };
  }
  return {
    ok: true,
    from: sourceAgentId,
    to: targetAgentId,
    triggerId: target.triggerId,
    labelFilter: target.labelFilter,
    entryId: moved.id,
    entry: moved,
    workItem,
  };
}

// A one-line, operator-readable identification of the work item an entry is
// about. Used by the AC8 hard error: after a successful removal whose enqueue
// then failed, the event is gone from every queue and the ONLY recovery is a
// human re-applying the label on GitHub — so the error has to name the repo,
// the issue/PR and the label, not just say "failed".
function describeEntryWorkItem(entry) {
  const g = (entry && entry.github) || {};
  const p = (g.payload && typeof g.payload === 'object') ? g.payload : {};
  const item = p.issue || p.pull_request || {};
  const number = Number.isInteger(item.number) ? item.number : null;
  const label = (p.label && typeof p.label.name === 'string') ? p.label.name : null;
  const parts = [];
  if (g.repo) parts.push(number != null ? `${g.repo}#${number}` : g.repo);
  else if (number != null) parts.push(`#${number}`);
  if (label) parts.push(`label '${label}'`);
  if (g.event) parts.push(g.event);
  return {
    repo: g.repo || null,
    number,
    label,
    event: g.event || null,
    text: parts.length ? parts.join(' · ') : 'the queued event',
  };
}

module.exports = {
  REFUSAL_REASONS,
  ghEventFromEntry,
  triggerAccepts,
  eligibleTargets,
  performReassign,
  buildReassignedEntry,
  buildReassignLogEvent,
  buildReassignLogFields,
  describeEntryWorkItem,
};
