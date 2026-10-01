'use strict';

// Hill-climbing loop Phase 2b (#1225): the applier's console-side guard.
//
// Concept `docs/hill-climbing-agent-concept.md` §3.3. The admin console runs a
// card's declared apply path through the existing audited choke-point (as the
// acting human), so the *decision* to run it — is this class executable, does
// the card still name a live object, and is deleting this trigger even allowed —
// belongs here, in the container that holds `req.user` and performs the
// mutation. Pure and fs-free (the console reads live config with its own
// helpers and passes it in), in the discipline of `process-template.js`; the
// orchestrator's disjoint half (autonomy + applied-card patch) lives in
// `orchestrator/hill-climb-apply.js`. Kept in `admin-console/api/` because the
// admin-console image copies only `api/*.js` and can't require across to the
// orchestrator tree.

// Which card classes this ticket can execute end-to-end. `trigger-hygiene` maps
// to the already-existing, audited `DELETE /api/agents/:id/triggers/:tid`
// choke-point and the deterministic heuristic pass raises it on its own, so it
// is wired first. The remaining classes' apply paths (prompt choke-points,
// port/threshold writes, curator hand-off) land as follow-ups on the same
// engine — the console rejects an apply on a not-yet-wired class rather than
// half-applying it.
const EXECUTABLE_CARD_CLASSES = ['trigger-hygiene'];

function isExecutableClass(cardClass) {
  return EXECUTABLE_CARD_CLASSES.includes(cardClass);
}

// Resolve a trigger-hygiene card to the concrete `(agentId, triggerId)` it
// targets. The heuristic pass stores both on `proposedChange` and encodes them
// as `"<agentId>/<triggerId>"` in `object.id`; prefer the structured fields and
// fall back to splitting the object id (an agent id carries no slash, so split
// on the first only — a trigger id theoretically could).
function parseTriggerRef(card) {
  if (!card || typeof card !== 'object') return null;
  const pc = card.proposedChange && typeof card.proposedChange === 'object' ? card.proposedChange : {};
  let agentId = typeof pc.agentId === 'string' ? pc.agentId.trim() : '';
  let triggerId = typeof pc.triggerId === 'string' ? pc.triggerId.trim() : '';
  if ((!agentId || !triggerId) && card.object && typeof card.object.id === 'string') {
    const raw = card.object.id.trim();
    const slash = raw.indexOf('/');
    if (slash > 0) {
      if (!agentId) agentId = raw.slice(0, slash).trim();
      if (!triggerId) triggerId = raw.slice(slash + 1).trim();
    }
  }
  if (!agentId || !triggerId) return null;
  return { agentId, triggerId };
}

// The server-side trigger guard (§3.3, AC "Guard rejects apply on intrinsic/
// derived/human-gate triggers even via direct API call"). Returns a human-
// readable reason string when the trigger must NOT be deleted by the applier,
// or null when a delete is allowed. `humanGateLabels` is the set (or array) of
// the team's label names flagged `humanGate: true` — a listener for one of those
// is a human-approval gate and is off-limits like the derived wiring. Enforced
// here, not just in the UI, so a raw API call can't bypass it.
//
// `handoffLabels` is the set (or array) of labels a team member emits through
// its outcomes/emits port (see `emittedLabelSet`). A Flow-editor label hand-off
// (#2710) wires a plain `github-event` listener with `labelFilter` (+ `claim`)
// on the target and a `setLabel` outcome on the source — no derived flag marks
// it. Deleting that listener while the source still emits the label silently
// breaks the hand-off, so it is protected like the other derived wiring.
function triggerApplyGuardError(trigger, { humanGateLabels, handoffLabels } = {}) {
  if (!trigger || typeof trigger !== 'object') return 'trigger not found';
  if (trigger.intrinsic === true) {
    return "intrinsic triggers are part of the agent's role and cannot be deleted by the applier";
  }
  if (trigger.dataFlow === true) {
    return 'data-flow triggers are derived from ports; edit the ports instead of deleting the trigger';
  }
  if (trigger.channel === true) {
    return 'channel triggers are derived from ports; edit the ports instead of deleting the trigger';
  }
  // P3 (#2032) direct hand-off listener. hill-climb-sweep.js:triggerDefsFromMembers
  // flattens EVERY trigger with an id (no type filter), so a wake-agent listener
  // that has not fired within windowDays becomes a zero-fire trigger-hygiene card;
  // at autonomy >= 2 the applier would delete it. It is derived from the producer's
  // outcomes port exactly like channel/dataFlow, so it is off-limits here too —
  // otherwise aee-wake keeps reporting "delivered" while the entry is dropped.
  if (trigger.wakeHandoff === true || trigger.type === 'wake-agent') {
    return 'hand-off listeners are derived from outcomes; edit the outcomes port instead of deleting the trigger';
  }
  if (trigger.humanGate === true) {
    return 'human-gate listeners hold approval flow and cannot be deleted by the applier';
  }
  const gate = humanGateLabels instanceof Set
    ? humanGateLabels
    : new Set(Array.isArray(humanGateLabels) ? humanGateLabels : []);
  const labelFilter = typeof trigger.labelFilter === 'string' ? trigger.labelFilter.trim() : '';
  if (labelFilter && gate.has(labelFilter)) {
    return `listener for human-gate label '${labelFilter}' cannot be deleted by the applier`;
  }
  const handoff = handoffLabels instanceof Set
    ? handoffLabels
    : new Set(Array.isArray(handoffLabels) ? handoffLabels : []);
  if (labelFilter && handoff.has(labelFilter)) {
    return `listener for hand-off label '${labelFilter}' is wired from a teammate's outcomes; remove the hand-off in the Flow editor instead of deleting the trigger`;
  }
  return null;
}

// Staleness for a trigger-hygiene apply (AC "target object changed since
// detection → 409 stale-card"). The card was raised because a specific trigger
// existed and was dead; if it is gone (already deleted, renamed, or re-scoped)
// the evidence no longer holds and the applier must re-detect rather than act on
// a phantom. Returns a reason string when the card is stale, or null when the
// live trigger still matches.
function staleTriggerReason(card, liveTrigger) {
  const ref = parseTriggerRef(card);
  if (!ref) return 'card does not name a concrete trigger';
  if (!liveTrigger) return `trigger '${ref.triggerId}' no longer exists — re-detect first`;
  return null;
}

// The set of the team's label names flagged `humanGate: true` (registry lives on
// the team agent's `labels[]`, like `stages`). Passed to `triggerApplyGuardError`
// so a listener for a gate label is treated as a human-approval gate.
function humanGateLabelSet(teamCfg) {
  const labels = teamCfg && Array.isArray(teamCfg.labels) ? teamCfg.labels : [];
  const out = new Set();
  for (const l of labels) {
    if (l && typeof l.name === 'string' && l.name.trim() && l.humanGate === true) {
      out.add(l.name.trim());
    }
  }
  return out;
}

// The set of labels the team's members emit — each member's `outcomes` port
// `setLabel` actions plus the legacy `emits` list (the same derivation as the
// orchestrator's `emitLabelsFromMembers`). Passed to `triggerApplyGuardError`
// so a label hand-off listener is protected while its producer still emits.
function emittedLabelSet(members) {
  const out = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    for (const l of Array.isArray(m && m.emits) ? m.emits : []) {
      if (typeof l === 'string' && l.trim()) out.add(l.trim());
    }
    const opts = m && m.outcomes && Array.isArray(m.outcomes.options) ? m.outcomes.options : [];
    for (const opt of opts) {
      for (const a of Array.isArray(opt && opt.actions) ? opt.actions : []) {
        if (a && a.type === 'setLabel' && typeof a.label === 'string' && a.label.trim()) out.add(a.label.trim());
      }
    }
  }
  return out;
}

module.exports = {
  EXECUTABLE_CARD_CLASSES,
  isExecutableClass,
  parseTriggerRef,
  triggerApplyGuardError,
  staleTriggerReason,
  humanGateLabelSet,
  emittedLabelSet,
};
