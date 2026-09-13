'use strict';

// Pure planner for the one-time migration sweep that brings every remaining
// standalone `role: 'agent'` up to a team of one (#2232, Phase C of epic
// #2229 — "every agent is a team of one from creation"). Phase B (#2231)
// stopped new standalone agents being minted; this is the cleanup half that
// brings everything created *before* that change up to the same shape, then
// lets the manual `convert-to-team` mechanism (#2052) be retired outright.
//
// Mirrors the #1960 orphan-cleanup shape (`agent-orphans.js`): a dry-run
// planner an operator can GET, and a re-planned apply that only ever mutates
// through the SAME mechanics the (now-retired) manual conversion action used
// — `Orchestrator.convertAgentToTeam()`. This module decides WHICH agents
// qualify; it is never the one deciding HOW to convert one, so a candidate
// here is exactly the set the old "Convert into a team..." menu entry would
// have offered, one at a time, by hand.

const { assessConversionEligibility } = require('./team-conversion');

// Only a standalone `role: 'agent'` is in scope — a `team`/`team-member`
// already has a resolvable shape, and `orchestrator`/`bp-instance` are a
// different model entirely that this epic never touches. `loadAgentConfig`
// already normalizes the legacy `expert` role to `agent` before this is ever
// called, so no legacy-role branch is needed here.
function classifyCandidate(id, cfg) {
  if (!id || !cfg || cfg.role !== 'agent') return null;

  const verdict = assessConversionEligibility(cfg);
  return {
    id,
    displayName: typeof cfg.displayName === 'string' ? cfg.displayName : null,
    eligible: verdict.eligible,
    code: verdict.code,
    reason: verdict.reason,
  };
}

// `configs` is the same `{ id, cfg }[]` shape `listAgentConfigs()` /
// `planOrphanCleanup` take, so every whole-installation scan in the codebase
// reads the workspace the same way. Sorted by id so two runs over an
// unchanged workspace produce byte-identical output (the `agent-orphans.js`
// convention).
function planTeamOfOneMigration(configs) {
  const list = [];
  for (const entry of configs || []) {
    if (!entry || !entry.id) continue;
    const candidate = classifyCandidate(entry.id, entry.cfg);
    if (candidate) list.push(candidate);
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    scanned: (configs || []).length,
    candidates: list.filter((c) => c.eligible),
    // Reported, never silently skipped — an operator reading the dry run
    // needs to know a standalone agent is being left alone and why (e.g. it
    // is mid-provisioning, or ephemeral).
    ineligible: list.filter((c) => !c.eligible),
  };
}

// One log/report line per candidate, for the "list what it would act on
// before acting" half of the contract — the same discipline #1960's cleanup
// follows.
function formatMigrationLine(candidate) {
  return candidate.eligible
    ? `${candidate.id} — eligible for migration`
    : `${candidate.id} — skipped (${candidate.reason})`;
}

module.exports = {
  classifyCandidate,
  planTeamOfOneMigration,
  formatMigrationLine,
};
