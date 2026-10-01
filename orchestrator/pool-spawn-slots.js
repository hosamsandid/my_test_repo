'use strict';

// Provisioning slots for pooled roles (#2760).
//
// A pool instance only becomes visible to `_liveInstanceIdsForRole` once its
// config exists on disk — but `spawnPoolInstance` first awaits a rework-ref
// lookup and then `addTeamMember`, which can take seconds. Dispatches for
// OTHER work items arriving inside that window used to see a too-low count and
// spawn as well, overshooting the role's `maxInstances` cap. This registry
// makes an in-flight spawn count from the moment it is decided:
// `reserve()` runs synchronously in the same tick as the cap check, and the
// slot is released when the spawn settles (success: the instance's own config
// now carries the count; failure: the slot frees for a later dispatch).
//
// Deliberately in-memory: after an orchestrator restart nothing is in flight
// any more, so there is no slot to leak. A spawn that got as far as writing
// its (`_provisioning`) config before the restart is still counted by the
// on-disk walk, and the #2493 stuck-provisioning reaper frees it eventually.

/** Delays before re-routing a dispatch whose spawn failed (AC: failure is retried). */
const SPAWN_RETRY_DELAYS_MS = Object.freeze([15_000, 60_000, 300_000]);

/** The delay before retry number `attempt` (1-based), or null once retries are exhausted. */
function spawnRetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return attempt <= SPAWN_RETRY_DELAYS_MS.length ? SPAWN_RETRY_DELAYS_MS[attempt - 1] : null;
}

/**
 * The ids the per-role cap counts: every live (on-disk) instance plus every
 * instance still provisioning, each once — a spawn whose config was already
 * written but whose promise has not settled yet is in both lists.
 */
function countedInstanceIds(liveIds = [], provisioningIds = []) {
  return [...new Set([...liveIds, ...provisioningIds])];
}

function createSpawnSlots() {
  const byInstance = new Map(); // instanceId → { roleId, promise }
  const failures = new Map();   // instanceId → consecutive failed spawns

  return {
    /** Claim a slot for `instanceId` under `roleId`, tied to its spawn promise. */
    reserve(roleId, instanceId, promise) {
      byInstance.set(instanceId, { roleId, promise });
    },
    /**
     * Free the slot — only if it still belongs to `promise`, so a late-settling
     * earlier attempt can never release a newer attempt's slot.
     */
    release(instanceId, promise) {
      const slot = byInstance.get(instanceId);
      if (slot && (promise === undefined || slot.promise === promise)) byInstance.delete(instanceId);
    },
    /** The in-flight spawn promise for `instanceId`, or null. */
    pending(instanceId) {
      const slot = byInstance.get(instanceId);
      return slot ? slot.promise : null;
    },
    /** Every instance of `roleId` still provisioning. */
    provisioningIds(roleId) {
      const out = [];
      for (const [id, slot] of byInstance) if (slot.roleId === roleId) out.push(id);
      return out;
    },
    /** Record one more failed spawn for `instanceId`; returns the running count. */
    noteFailure(instanceId) {
      const n = (failures.get(instanceId) || 0) + 1;
      failures.set(instanceId, n);
      return n;
    },
    clearFailures(instanceId) {
      failures.delete(instanceId);
    },
  };
}

module.exports = {
  SPAWN_RETRY_DELAYS_MS,
  spawnRetryDelayMs,
  countedInstanceIds,
  createSpawnSlots,
};
