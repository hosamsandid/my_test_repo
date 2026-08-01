// Pure interpreters for the skill (de)activation / "Sync now" result (#739).
//
// The activation endpoint returns `{ members: [{ agentId, status, error?,
// reason? }] }`. Historically the UI treated any HTTP-200 as success and flashed
// a green "active for N/M members" even when EVERY member returned
// `status: "error"` — so an activation that reached nobody looked like a win and
// the failure reasons were thrown away. These helpers turn the raw member
// results into an honest verdict the card renders faithfully:
//
//   kind: 'ok'   → green, something actually synced (or nothing needed syncing)
//   kind: 'warn' → amber, a partial success (some synced, some failed)
//   kind: 'error'→ red,   nothing synced while members were expected to
//
// Kept as a side-effect-free module so it can be unit-tested with node:test,
// mirroring the pending-queue-view.js pattern.

import { tallyRollout, classifyMemberStatus, ROLLOUT_CLASS } from './skill-rollout-view.js';

// Per-member statuses the orchestrator emits (see _syncSkillIntoWorkspace /
// setTeamSkillActive): a real file sync succeeded, was neutral (nothing to do),
// or failed.
const SUCCESS_RE = /^(seeded|removed|synced|active)$/i;
const NEUTRAL_RE = /^(stub|skipped-override|skip|excluded|excluded-override)$/i;

function statusOf(m) {
  return String((m && m.status) || '').trim();
}

// Human-readable reason for a single failed member, preferring the
// machine-readable `reason` code over the raw error string.
export function syncFailureReason(m) {
  // Plain language, no internal terms like "pool"/"manifest" (#750 AC4): the
  // operator sees this in the card flash and it must make sense to a
  // non-technical user.
  const code = String((m && m.reason) || '').trim();
  if (code === 'source-missing') return 'this skill’s files are no longer available';
  if (code === 'copy-failed') {
    const msg = String((m && m.error) || '').trim();
    return msg ? `couldn’t install it (${msg})` : 'couldn’t install it';
  }
  const msg = String((m && m.error) || '').trim();
  if (/not found in pool/i.test(msg)) return 'this skill’s files are no longer available';
  return msg || 'couldn’t install it';
}

// True when every failure in the set is the "pool file gone" condition — the
// caller uses this to point at recovery (restore/re-promote) instead of a retry.
export function isSourceMissing(members) {
  const ms = Array.isArray(members) ? members : [];
  const failed = ms.filter(m => !SUCCESS_RE.test(statusOf(m)) && !NEUTRAL_RE.test(statusOf(m)));
  if (!failed.length) return false;
  return failed.every(m =>
    String((m && m.reason) || '') === 'source-missing' ||
    /not found in pool/i.test(String((m && m.error) || '')));
}

// Interpret the per-member results of an activate / "Sync now" run.
// `scoped` = a single-member "Sync now" retry (wording tweaks only, so repeated
// clicks report that member's concrete outcome rather than an identical no-op).
export function summarizeActivation(members, { scoped = false } = {}) {
  const ms = Array.isArray(members) ? members : [];
  if (!ms.length) {
    return { kind: 'ok', text: 'activated', synced: 0, failed: 0, syncable: 0, reasons: [] };
  }

  // Counting delegated to the ONE shared basis (#774): `synced` = installed,
  // `syncable` = target (materialized, non-override). This is the same basis the
  // status pill uses, so the flash and the badge can never disagree again.
  const counts = tallyRollout(ms.map(classifyMemberStatus));
  const synced = counts.installed;
  const failed = counts.failed;
  const syncable = counts.target; // members a sync was actually attempted on
  const failedMs = ms.filter(m => classifyMemberStatus(m) === ROLLOUT_CLASS.FAILED);
  const reasons = [...new Set(failedMs.map(syncFailureReason))].filter(Boolean);

  if (scoped) {
    const m = ms[0];
    const cls = classifyMemberStatus(m);
    if (cls === ROLLOUT_CLASS.INSTALLED) return { kind: 'ok', text: 'synced', synced: 1, failed: 0, syncable: 1, reasons: [] };
    if (cls === ROLLOUT_CLASS.STUB) return { kind: 'ok', text: 'not materialized yet', synced: 0, failed: 0, syncable: 0, reasons: [] };
    if (cls === ROLLOUT_CLASS.OVERRIDE) return { kind: 'ok', text: 'member manages its own skill list', synced: 0, failed: 0, syncable: 0, reasons: [] };
    return { kind: 'error', text: `still failing — ${syncFailureReason(m)}`, synced: 0, failed: 1, syncable: 1, reasons };
  }

  // AC1/AC2: a run where no member actually synced is never a green success.
  if (failed === 0) {
    const text = syncable
      ? `active for ${synced}/${syncable} member${syncable === 1 ? '' : 's'}`
      : 'activated';
    return { kind: 'ok', text, synced, failed, syncable, reasons: [] };
  }
  const head = `${synced}/${syncable} synced`;
  const tail = reasons.length ? ` — ${reasons.join('; ')}` : '';
  return { kind: synced > 0 ? 'warn' : 'error', text: head + tail, synced, failed, syncable, reasons };
}
