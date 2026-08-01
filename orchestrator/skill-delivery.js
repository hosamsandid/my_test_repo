'use strict';

// Delivery verdict for a team-skill activation fan-out (#750 AC7).
//
// `setTeamSkillActive` returns `{ members: [{ agentId, status, reason? }] }`.
// The auto-promote → auto-activate pass (autonomy 3) used to fire that call and
// discard the result, so a promotion that reached ZERO members still looked like
// a silent success (badge `active · 0/N`, every member `pending`). This pure
// helper turns the per-member statuses into an honest verdict the caller can act
// on — mirroring the frontend's knowledge-activation-view.summarizeActivation,
// but kept CJS so the orchestrator can use it and node:test can cover it without
// booting the service.
//
// A member is:
//   - synced   → the file was actually copied in (status seeded/removed/synced/active)
//   - neutral  → nothing to sync for it (stub / override-excluded); NOT a failure
//   - failed   → a sync was attempted and errored (source-missing / copy-failed / …)
//
// `delivered` is true iff at least one syncable member received the skill. A pass
// where every syncable member failed (or there were syncable members but none
// synced) is a FAILURE — never reported green (preserves #740's honest feedback).

const SUCCESS_RE = /^(seeded|removed|synced|active)$/i;
const NEUTRAL_RE = /^(stub|skipped-override|skip|excluded|excluded-override)$/i;

function statusOf(m) {
  return String((m && m.status) || '').trim();
}

function deliveryVerdict(members) {
  const ms = Array.isArray(members) ? members : [];
  const synced = ms.filter((m) => SUCCESS_RE.test(statusOf(m))).length;
  const neutral = ms.filter((m) => NEUTRAL_RE.test(statusOf(m))).length;
  const failedMs = ms.filter((m) => !SUCCESS_RE.test(statusOf(m)) && !NEUTRAL_RE.test(statusOf(m)));
  const failed = failedMs.length;
  const syncable = ms.length - neutral; // members a sync was actually attempted on
  // No syncable members at all (e.g. every member is a stub) is not a failure —
  // there was simply nobody to deliver to; the skill will seed on materialization.
  const delivered = syncable === 0 ? true : synced > 0;
  const allSourceMissing = failed > 0 && failedMs.every((m) =>
    String((m && m.reason) || '') === 'source-missing' ||
    /not found in pool/i.test(String((m && m.error) || '')));
  return { delivered, synced, failed, syncable, neutral, allSourceMissing };
}

// Build the knowledge-feed event for a delivery that reached nobody (#750 AC7):
// an explicit failure record so the operator sees the auto-promotion did NOT
// silently succeed. `kind: "error"` so the live feed renders it as a failure.
function buildDeliveryFailureEvent({ teamId, skillName, verdict, auto = true, ts } = {}) {
  const v = verdict || {};
  return {
    type: 'skill-delivery-failed',
    ts: ts || new Date().toISOString(),
    kind: 'error',
    teamId: teamId || null,
    skillName: skillName || null,
    auto: !!auto,
    synced: v.synced || 0,
    syncable: v.syncable || 0,
    failed: v.failed || 0,
    reason: v.allSourceMissing ? 'source-missing' : 'sync-failed',
  };
}

module.exports = { deliveryVerdict, buildDeliveryFailureEvent };
