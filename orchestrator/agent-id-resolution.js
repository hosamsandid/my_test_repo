'use strict';

/*
 * Pure resolution of the first free agent id under collision (#2217). The
 * platform derives an agent id itself (from a repository URL or a display
 * name), so it must also resolve a collision itself — the caller never
 * chooses the id and has no way to influence it. Kept pure (no fs) so the
 * suffix-walking loop is unit-testable without an orchestrator instance; the
 * caller supplies `isTaken`, the strictest existing predicate (a persisted
 * config, an on-disk directory, or an id whose teardown is still in flight).
 */

// Cap the suffix walk so a repository created/deleted many times cannot spin
// forever (a pathological case, not a normal one) — refused with a distinct,
// actionable error rather than looping indefinitely.
const MAX_ID_SUFFIX = 50;

function nextAvailableAgentId(baseId, isTaken) {
  const base = baseId || 'agent';
  if (!isTaken(base)) return base;
  for (let n = 2; n <= MAX_ID_SUFFIX; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  const err = new Error(
    `No free id found for '${base}' after ${MAX_ID_SUFFIX} attempts — delete some old agents for this name first.`
  );
  err.code = 'id-sequence-exhausted';
  throw err;
}

module.exports = { nextAvailableAgentId, MAX_ID_SUFFIX };
