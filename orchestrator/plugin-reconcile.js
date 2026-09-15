'use strict';

// Auto-reconcile of pending plugin members (#2308, the plugin sibling of
// skill-reconcile.js's #776 §3). A member whose resolved plugin grant includes
// an id its workspace has never been synced for — created before the grant
// existed, or created while a sync failed — sits broken until this heals it.
// Bounded by the same max-attempt + exponential-backoff discipline as skills so
// a persistent failure (an uninstalled plugin, a broker that never comes up)
// records its error and stops rather than looping hot.
//
// I/O-free by design: the orchestrator supplies each member's seeded-plugins
// manifest + reconcile state, applies the idempotent workspace sync for each
// returned target, and records the outcome back into the state file.

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 60 * 1000; // 1 min, doubling per attempt
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000; // capped at 1 h

// Plugin ids a member should have, given the team's active grant. An
// inheriting member (no pluginsOverride) gets the whole team grant; an
// override member gets only the ids on its own list — exactly the grant logic
// plugin-grants.js's `effectivePlugins` applies. Accepts either the string
// shorthand or the `{ id, scopeGranularity }` object shape.
function grantedPluginIds(member, activeGrant) {
  const team = Array.isArray(activeGrant) ? activeGrant : [];
  const list = (member && Array.isArray(member.pluginsOverride)) ? member.pluginsOverride : team;
  return list
    .map((e) => (typeof e === 'string' ? e : (e && typeof e.id === 'string' ? e.id : null)))
    .filter((id) => typeof id === 'string' && id);
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

// Whether a missing (member, plugin) is due for a retry right now.
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
 * @param {object[]} input.members    materialized members ({id, token, pluginsOverride})
 * @param {object[]} input.activeGrant the team agent's active plugins[] (normalised or raw)
 * @param {(id:string)=>object} input.seededOf  → the member's seeded-plugins manifest
 * @param {(id:string)=>object} input.stateOf   → the member's reconcile state map
 * @param {object}   opts
 * @param {string|number} opts.now
 * @param {number}   [opts.maxAttempts]
 * @param {number}   [opts.baseBackoffMs]
 * @param {number}   [opts.maxBackoffMs]
 * @returns {{ due: {agentId,pluginId}[], waiting: {agentId,pluginId}[], exhausted: {agentId,pluginId}[] }}
 */
function planTeamReconcile({ members, activeGrant, seededOf, stateOf }, opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.parse(opts.now || '') || Date.now();
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const due = [];
  const waiting = [];
  const exhausted = [];

  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !m.id || !m.token) continue; // stubs have no workspace to sync into
    const seeded = (typeof seededOf === 'function' ? seededOf(m.id) : null) || {};
    const state = (typeof stateOf === 'function' ? stateOf(m.id) : null) || {};
    for (const pluginId of grantedPluginIds(m, activeGrant)) {
      if (seeded[pluginId]) continue; // already installed — nothing to reconcile
      const entry = state[pluginId] || {};
      const target = { agentId: m.id, pluginId };
      if (isExhausted(entry, maxAttempts)) { exhausted.push(target); continue; }
      if (dueNow(entry, nowMs, opts)) due.push(target);
      else waiting.push(target);
    }
  }
  return { due, waiting, exhausted };
}

// Fold one attempt outcome into a member's reconcile state entry (pure). `ok`
// clears the entry (the plugin is now installed); a failure bumps attempts and
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
  grantedPluginIds,
  nextBackoffMs,
  isExhausted,
  dueNow,
  recordAttempt,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
};
