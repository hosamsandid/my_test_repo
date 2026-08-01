// Auto-reconcile of pending skill members (skill-UX Phase 3, #776 §3).
//
// After a team skill is activated, a member whose workspace sync hasn't run yet
// (or who was materialized later) sits in `pending` until a human clicks "Sync
// now". This pure planner lets an orchestrator loop heal those members itself:
// given each team's active grant, every member's seed manifest, and the recorded
// per-member reconcile state, it decides which (member, skill) pairs are missing
// AND due for a retry now — bounded by a max attempt count and exponential
// backoff so a persistent failure (e.g. a deleted source file) can't loop hot.
//
// I/O-free by design: the orchestrator supplies the manifests + state and applies
// the idempotent `planSkillSync` copy for each returned target, then records the
// outcome back into the state file.

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 60 * 1000; // 1 min, doubling per attempt
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000; // capped at 1 h

// Skills a member should have, given the team's active list. An inheriting
// member (no skillsOverride) gets the whole team grant; an override member gets
// only the names on its own list — exactly the grant logic planSkillSync applies.
function grantedSkills(member, activeSkills) {
  const team = Array.isArray(activeSkills) ? activeSkills : [];
  if (member && Array.isArray(member.skillsOverride)) return member.skillsOverride.slice();
  return team.slice();
}

// Backoff before attempt N may run again: base * 2^attempts, capped. attempts=0
// means never tried → no wait.
function nextBackoffMs(attempts, { baseBackoffMs = DEFAULT_BASE_BACKOFF_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
  const n = Number.isFinite(attempts) && attempts > 0 ? attempts : 0;
  if (n === 0) return 0;
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** (n - 1));
}

function isExhausted(entry, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const attempts = entry && Number.isFinite(entry.attempts) ? entry.attempts : 0;
  return attempts >= maxAttempts;
}

// Whether a missing (member, skill) is due for a retry right now.
function dueNow(entry, nowMs, opts) {
  const attempts = entry && Number.isFinite(entry.attempts) ? entry.attempts : 0;
  if (attempts === 0) return true; // never attempted → sync immediately
  const last = entry && typeof entry.lastAttemptAt === 'string' ? Date.parse(entry.lastAttemptAt) : NaN;
  if (Number.isNaN(last)) return true; // no timestamp recorded → don't block
  return nowMs - last >= nextBackoffMs(attempts, opts);
}

/**
 * Plan the reconcile sync targets for ONE team.
 *
 * @param {object}   input
 * @param {object[]} input.members    materialized members ({id, token, skillsOverride})
 * @param {string[]} input.activeSkills the team agent's active skills[]
 * @param {(id:string)=>object} input.seededOf  → the member's seeded-skills manifest
 * @param {(id:string)=>object} input.stateOf   → the member's reconcile state map
 * @param {object}   opts
 * @param {string|number} opts.now
 * @param {number}   [opts.maxAttempts]
 * @param {number}   [opts.baseBackoffMs]
 * @param {number}   [opts.maxBackoffMs]
 * @returns {{ due: {agentId,skillName}[], waiting: {agentId,skillName}[], exhausted: {agentId,skillName}[] }}
 */
function planTeamReconcile({ members, activeSkills, seededOf, stateOf }, opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.parse(opts.now || '') || Date.now();
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const due = [];
  const waiting = [];
  const exhausted = [];

  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !m.id || !m.token) continue; // stubs have no workspace to sync into
    const seeded = (typeof seededOf === 'function' ? seededOf(m.id) : null) || {};
    const state = (typeof stateOf === 'function' ? stateOf(m.id) : null) || {};
    for (const name of grantedSkills(m, activeSkills)) {
      if (typeof name !== 'string' || !name) continue;
      if (seeded[name]) continue; // already installed — nothing to reconcile
      const entry = state[name] || {};
      const target = { agentId: m.id, skillName: name };
      if (isExhausted(entry, maxAttempts)) { exhausted.push(target); continue; }
      if (dueNow(entry, nowMs, opts)) due.push(target);
      else waiting.push(target);
    }
  }
  return { due, waiting, exhausted };
}

// Fold one attempt outcome into a member's reconcile state entry (pure). `ok`
// clears the entry (the skill is now installed); a failure bumps attempts and
// records the error + timestamp for the UI's Retry surface.
function recordAttempt(entry, { ok, error, now }) {
  const nowIso = typeof now === 'string' ? now : new Date(typeof now === 'number' ? now : Date.now()).toISOString();
  if (ok) return null; // caller deletes the entry — nothing left to track
  const attempts = (entry && Number.isFinite(entry.attempts) ? entry.attempts : 0) + 1;
  return {
    attempts,
    lastAttemptAt: nowIso,
    lastError: typeof error === 'string' && error ? error : 'sync failed',
  };
}

module.exports = {
  planTeamReconcile,
  grantedSkills,
  nextBackoffMs,
  isExhausted,
  dueNow,
  recordAttempt,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
};
