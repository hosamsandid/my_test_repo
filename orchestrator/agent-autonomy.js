"use strict";

// Pure autonomy predicate (#962). An agent is "autonomous" when it is driven by
// anything other than an interactive DM — which is what gates the injection of
// the Trigger-management docs and the unattended-run framing into its CLAUDE.md
// (see `agentIsAutonomous` in orchestrator.js, the I/O wrapper that reads the
// on-disk config + triggers.json and delegates here).
//
// Autonomous iff: a reactive session policy (`per-invocation`), or at least one
// configured trigger. Kept pure and side-effect-free so the trigger-write
// autonomy-flip check that rebuilds CLAUDE.md is unit-testable without touching
// the filesystem.
//
// The BriefingPack roles `orchestrator`/`bp-instance` used to be inherently
// autonomous here; both roles were removed with the BriefingPack model (#1962),
// so role no longer participates in the decision at all.
function isAutonomousState({ sessionPolicy, triggers } = {}) {
  if (sessionPolicy === "per-invocation") return true;
  if (Array.isArray(triggers) && triggers.length > 0) return true;
  return false;
}

// True when a trigger add/remove flips the autonomy state and therefore the
// CLAUDE.md must be rebuilt. Trivial by design, but named so the trigger-write
// path reads declaratively and the "no rebuild when unchanged" contract (AC4)
// is expressed in one testable place.
function autonomyChanged(before, after) {
  return !!before !== !!after;
}

module.exports = { isAutonomousState, autonomyChanged };
