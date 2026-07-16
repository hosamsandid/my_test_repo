'use strict';

// Skill drift resolution (#629, concept §2.4 + §3.6).
//
// The pure state classifier lives in skill-manifest.js (classifyCopyDrift,
// isResyncable) and is byte-mirrored + golden-fixture-locked. This module is the
// thin, admin-console-only glue that turns the classifier into a per-copy state
// (hash the copy dir + the source dir on disk, compare against the anchor the
// copy recorded at copy/seed time) and rolls a set of member states up into a
// node-level summary the Skills surface / Knowledge graph render.
//
// It depends only on `fs`/`path` + the dep-free skill-manifest core, so it is
// unit-testable with `node --test` and no install step. IO is injectable.

const fs = require('fs');
const path = require('path');
const skillManifest = require('./skill-manifest');

// Node-level severity order, worst first — the single state a badge shows when a
// skill has many copies in mixed states (a conflict outranks a mere outdated).
const DRIFT_SEVERITY = Object.freeze([
  'conflict', 'diverged', 'orphaned', 'outdated', 'unknown', 'in-sync',
]);

function dirHasSkill(dir, fsImpl) {
  if (!dir) return false;
  try { return fsImpl.existsSync(path.join(dir, 'SKILL.md')); } catch { return false; }
}

// Drift state of ONE copy against the source it descends from:
//   copyDir     the copy's own directory (hashed to detect local edits)
//   sourceHash  the source content hash recorded at copy/seed time (the anchor)
//   sourceDir   the source's CURRENT directory (missing SKILL.md ⇒ source gone)
// Returns { state, copyHash, sourceCurrentHash }. `state` is one of
// skillManifest.DRIFT_STATES; a copy with no recorded anchor is `unknown`
// (surfaced, never auto-synced). A deleted source is detected by the absent
// SKILL.md (NOT by a hash of an empty dir, which would look in-sync).
function copyDriftState({ copyDir, sourceHash, sourceDir } = {}, io = {}) {
  const fsImpl = io.fs || fs;
  let copyHash = null;
  if (dirHasSkill(copyDir, fsImpl)) {
    try { copyHash = skillManifest.hashSkillDir(copyDir, io); } catch { copyHash = null; }
  }
  let sourceCurrentHash = null;
  if (dirHasSkill(sourceDir, fsImpl)) {
    try { sourceCurrentHash = skillManifest.hashSkillDir(sourceDir, io); } catch { sourceCurrentHash = null; }
  }
  const state = skillManifest.classifyCopyDrift({
    copyHash, sourceHash: sourceHash || null, sourceCurrentHash,
  });
  return { state, copyHash, sourceCurrentHash };
}

// The resync decision for ONE copy state (#629 AC3/AC4), the three-way gate the
// resync engine applies per copy:
//   'resync'  the copy is `outdated` (isResyncable) — deliver the new content.
//   'skip'    the copy is already `in-sync` — a no-op (keeps resync idempotent).
//   'refuse'  everything else (diverged/conflict/orphaned/unknown) — never
//             auto-overwritten; the operator is pointed at the manual path.
function resyncDecision(state) {
  if (skillManifest.isResyncable(state)) return 'resync';
  if (state === 'in-sync') return 'skip';
  return 'refuse';
}

// The single worst state across a list of copy states (or null for an empty
// list) — drives the one badge a skill node shows for its fan-out.
function worstDrift(states) {
  const set = new Set(Array.isArray(states) ? states : []);
  for (const s of DRIFT_SEVERITY) if (set.has(s)) return s;
  return null;
}

// Roll a set of member/copy states up into a node-level summary:
//   { worst, outdated, resyncable, total, counts }
// `resyncable` counts only the states an automatic resync may touch (outdated) —
// the number a "Sync all outdated" action would act on.
function rollupDrift(states) {
  const list = (Array.isArray(states) ? states : []).filter(Boolean);
  const counts = {};
  for (const s of list) counts[s] = (counts[s] || 0) + 1;
  const resyncable = list.filter(s => skillManifest.isResyncable(s)).length;
  return {
    worst: worstDrift(list),
    outdated: counts.outdated || 0,
    resyncable,
    total: list.length,
    counts,
  };
}

module.exports = {
  DRIFT_SEVERITY,
  copyDriftState,
  resyncDecision,
  worstDrift,
  rollupDrift,
};
