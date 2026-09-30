'use strict';

// #2493 — stuck-`_provisioning` reaper: the pure core.
//
// Creating an agent (standalone via `resolveAndReserveAgentId` / `createAgent`,
// or a team-member / pool-instance via `addTeamMember`) writes a config with
// `_provisioning: true` to disk BEFORE the remaining provisioning steps run
// (Matrix user creation/login, workspace seed, plugin materialisation, container
// start). If any of those throws, the error propagates to the caller but the
// on-disk `_provisioning:true` config stays behind — half-created, unusable, and
// (for an unattended pool spawn) unnoticed. The ONLY place that clears
// `_provisioning` is the success path, so nothing detects or repairs a stalled
// attempt; over time these leftovers accumulate.
//
// This module holds the pure decisions the orchestrator's `provisioningReapSweep`
// tick makes — age resolution, the stuck predicate, origin classification, and
// the synthetic transparency-log row — so they are unit-testable without booting
// orchestrator.js (which reaches for the container runtime, the webhook server
// and Matrix on require). The impure half — scanning configs, issuing the reap
// through the DELETE route, recording the log row — stays in orchestrator.js.

// Default age past which a still-`_provisioning` config is treated as stuck
// rather than merely mid-flight. Provisioning normally completes in seconds;
// ten minutes leaves an enormous margin so a slow-but-live attempt is never
// reaped as a false positive (AC5). Overridable via AEE_PROVISIONING_STUCK_MS.
const PROVISIONING_STUCK_MS = 10 * 60 * 1000;

// The dedicated event-log key for a reap row. `buildEventEntry` (github-event-log.js)
// speaks only GitHub's own vocabulary, so a distinguishing key is what lets the
// Event column read as a provisioning reap rather than as a blank GitHub event.
const PROVISIONING_SWEEP_KEY = 'provisioning.reaped';

// Resolve how long a config has held `_provisioning:true`. Prefers the explicit
// `_provisioningAt` stamp the write sites now record; falls back to the config
// file's mtime for a leftover written before that stamp existed (a pre-existing
// stuck config must still be reapable). Returns null when neither source yields
// a finite, non-future timestamp — the sweep must never act on an age it cannot
// trust (a future timestamp means clock skew or a bad stamp; skip and let a
// later tick decide once time has moved on).
function provisioningAgeMs({ provisioningAt, fileMtimeMs } = {}, now = Date.now()) {
  const parsedStamp = provisioningAt != null ? Date.parse(provisioningAt) : NaN;
  // The stamp is authoritative when present; mtime is the fallback only.
  const startedAt = Number.isFinite(parsedStamp)
    ? parsedStamp
    : (Number.isFinite(fileMtimeMs) ? fileMtimeMs : null);
  if (startedAt == null) return null;
  const age = now - startedAt;
  return age >= 0 ? age : null;
}

// Is this config a stuck provisioning leftover? Pure: `ageMs` is resolved by the
// caller via `provisioningAgeMs`. A config that is not `_provisioning:true`, or
// younger than the threshold, or whose age could not be trusted, is never stuck —
// AC5's no-false-positives guarantee.
function isStuckProvisioning(cfg, ageMs, thresholdMs = PROVISIONING_STUCK_MS) {
  if (!cfg || cfg._provisioning !== true) return false;
  if (ageMs == null || !Number.isFinite(ageMs)) return false;
  return ageMs >= thresholdMs;
}

// Classify which creation path left the leftover — recorded on the log row so an
// operator can tell an ordinary standalone / team-member half-create apart from
// an unattended pool spawn (the highest-frequency, least-supervised origin the
// ticket calls out). A pool instance carries `poolInstance:true`; a team member
// carries `role:'team-member'` / `parentTeamId`; anything else is a standalone
// `role:'agent'` placeholder.
function provisioningOrigin(cfg) {
  if (!cfg) return 'unknown';
  if (cfg.poolInstance) return 'pool-instance';
  if (cfg.role === 'team-member' || cfg.parentTeamId) return 'team-member';
  return 'standalone';
}

// Synthesize the GitHub-shaped event the transparency log records for a reap.
// `buildEventEntry` extracts only GitHub's own vocabulary, so a reap has no repo,
// no label and no work item and those columns honestly render `—`; the
// distinguishing `source: 'provisioning-sweep'` is stamped by the caller. The
// real content rides alongside via `buildProvisioningSweepLogFields`.
function buildProvisioningSweepLogEvent({ agentId, eventId, now }) {
  return {
    id: eventId,
    actor: { login: 'provisioning-sweep' },
    // No repo: a provisioning reap is not anchored to one, and inventing a
    // plausible-looking value here would make the row lie.
    repo: { name: null },
    created_at: now,
    payload: { action: 'reap', agentId },
  };
}

// The reap fields that ride ALONGSIDE the GitHub-shaped entry — the same slot the
// caller stamps `source`/`emittedBy` into, because `buildEventEntry` would drop
// everything below on the floor. `action` is `'reaped'` when the delete route
// confirmed the teardown, `'reap-failed'` when it was unreachable or refused (so
// a persistent failure is auditable rather than a config that silently keeps
// reappearing every tick).
function buildProvisioningSweepLogFields({ agentId, origin, ageMs, action, error }) {
  return {
    provisioningSweep: {
      agentId,
      origin,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      action,
      ...(error ? { error: String(error) } : {}),
    },
  };
}

module.exports = {
  PROVISIONING_STUCK_MS,
  PROVISIONING_SWEEP_KEY,
  provisioningAgeMs,
  isStuckProvisioning,
  provisioningOrigin,
  buildProvisioningSweepLogEvent,
  buildProvisioningSweepLogFields,
};
