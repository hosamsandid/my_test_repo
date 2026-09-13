'use strict';

// Agent instance pools — Phase 1: pool core + SDLC binding (#2246, epic #2251;
// design of record `docs/parallel-workers-concept.md`).
//
// WHY THIS EXISTS. A role today is one persistent agent bound to one git
// checkout, so it works exactly one ticket at a time (WorkspaceGate, #1157).
// Parallelising it by hand means cloning the role and re-pointing each clone at
// a different label (`ready-2`, `ready-3`, …) — toil, and the same unbounded
// multi-lane dispatch whose stall is what #2114's admission control exists to
// prevent. A pooled role is a TEMPLATE: one label starts one ephemeral instance
// per work item, up to the team's `wipLimit`, torn down when its ticket is
// released.
//
// THE LEANEST DECISION (concept §2): reuse the admission lane as the instance
// registry and the reconcile tick as the reaper. This module is the pure core
// that decision needs — no fs, no network, no clock of its own (`now` is always
// injected) — mirroring `admission-control.js`'s own shape. `orchestrator.js` is
// the fs/spawn/reap half.

const POOL_WORKSPACES = ['git-clean-base', 'input-copy', 'none'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Normalize a role's `pool` config (process-template.js §9). `null` means "not
 * pooled" — a role with no `pool` field, or `pool.enabled` anything but the
 * literal `true`, is byte-identical to a role that never heard of pooling.
 *
 * @returns {{enabled:true, maxInstances:number|null, workspace:string,
 *            baseBranch:string|null,
 *            teardown:{idleTimeoutMs:number|null,maxRuntimeMs:number|null,retainLogsMs:number|null}}|null}
 */
function normalizePoolConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const maxInstances = Number.isInteger(raw.maxInstances) && raw.maxInstances >= 1 ? raw.maxInstances : null;
  const workspace = POOL_WORKSPACES.includes(raw.workspace) ? raw.workspace : 'git-clean-base';
  const baseBranch = typeof raw.baseBranch === 'string' && raw.baseBranch.trim() ? raw.baseBranch.trim() : null;
  const t = raw.teardown && typeof raw.teardown === 'object' ? raw.teardown : {};
  const positiveMs = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return {
    enabled: true,
    maxInstances,
    workspace,
    baseBranch,
    teardown: {
      idleTimeoutMs: positiveMs(t.idleTimeoutMs),
      maxRuntimeMs: positiveMs(t.maxRuntimeMs),
      retainLogsMs: positiveMs(t.retainLogsMs),
    },
  };
}

// Is this agent config a pool ROLE TEMPLATE — i.e. does it opt into pooling?
// An already-spawned instance carries `poolInstance: true` instead and is
// never itself pooled (no nested spawning).
function isPooledRole(cfg) {
  return !!(cfg && !cfg.poolInstance && normalizePoolConfig(cfg.pool));
}

// ---------------------------------------------------------------------------
// Workspace binding — D3 (rework resolves to the PR head branch, not clean
// main)
// ---------------------------------------------------------------------------

/**
 * D3, the free (no network) signal: when the GitHub event that triggered a
 * pooled dispatch is ITSELF a `pull_request.*` event (or an `issue_comment` on
 * a PR, which arrives with the same `pull_request` field), the PR under work
 * is already sitting in the payload — this is the common case the review's
 * repro names (a reviewer role dispatched by a PR event). Returns `null` for
 * everything else (an `issues.*` event, e.g. a plain `ready` relabel), which
 * is the caller's cue to fall back to a live lookup (`_lookupPoolReworkRef`
 * in orchestrator.js) rather than guess.
 *
 * @returns {{branch:string, repo:string|null}|null}
 */
function reworkRefFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const pr = payload.pull_request && typeof payload.pull_request === 'object' ? payload.pull_request : null;
  const head = pr && pr.head && typeof pr.head === 'object' ? pr.head : null;
  if (!head || typeof head.ref !== 'string' || !head.ref) return null;
  const repo = head.repo && typeof head.repo.full_name === 'string' ? head.repo.full_name : null;
  return { branch: head.ref, repo };
}

// ---------------------------------------------------------------------------
// Instance identity (D11 — idempotency keyed on the work-item id)
// ---------------------------------------------------------------------------

/**
 * The deterministic, item-keyed instance id (concept §5): the SAME work item
 * always resolves to the SAME instance, so a redelivered event finds the
 * instance already there instead of spawning a duplicate.
 */
function poolInstanceId(teamId, roleId, itemKey) {
  return `${teamId}-${roleId}-i${itemKey}`;
}

// The role id a materialized team-member id encodes, i.e. the inverse of
// `${teamId}-${roleId}` (the platform's own member-naming convention, #1665
// §"Materialisation"). Falls back to the bare member id when it doesn't carry
// the team prefix (a hand-authored id, or a config error) — never throws.
function roleIdFromMemberId(memberId, teamId) {
  if (typeof memberId !== 'string') return memberId;
  const prefix = `${teamId}-`;
  return memberId.startsWith(prefix) ? memberId.slice(prefix.length) : memberId;
}

// ---------------------------------------------------------------------------
// Dispatch routing — spawn, reuse, or refuse
// ---------------------------------------------------------------------------

/**
 * Decide what a dispatch destined for a pooled role's TEMPLATE should actually
 * do: spawn a fresh instance, reuse the one already there (D11), or refuse
 * (the additive per-role `maxInstances` cap, D5's later refinement — the
 * team-wide `wipLimit` is the primary governor and is enforced upstream by
 * `admission-control.js`, not here).
 *
 * `itemKey` is the work-item id (an issue number for the SDLC binding) — `null`
 * means the dispatch names no item to key on (control traffic, or a malformed
 * event), in which case pooling does not apply and the caller should dispatch
 * to the template itself, exactly as an unpooled role would.
 *
 * @returns {{action:'unpooled'}|{action:'reuse',instanceId:string}|
 *           {action:'spawn',instanceId:string}|
 *           {action:'refuse',reason:string,instanceId:string}}
 */
function planPoolDispatch({ teamId, roleId, pool, itemKey, existingInstanceIds = [] }) {
  if (itemKey === null || itemKey === undefined) return { action: 'unpooled' };
  const instanceId = poolInstanceId(teamId, roleId, itemKey);
  if (existingInstanceIds.includes(instanceId)) {
    return { action: 'reuse', instanceId };
  }
  if (pool && pool.maxInstances != null && existingInstanceIds.length >= pool.maxInstances) {
    return { action: 'refuse', reason: 'max-instances', instanceId };
  }
  return { action: 'spawn', instanceId };
}

// ---------------------------------------------------------------------------
// Teardown (D4 slot release, D8 graceful teardown, hard timeout)
// ---------------------------------------------------------------------------

/**
 * D8's hard timeout: a stuck or crashed instance must never hold its slot
 * forever — the reaper the ephemeral route (`POST /internal/agents/ephemeral`)
 * lacks today. `spawnedAt` is an ISO timestamp; an unset `maxRuntimeMs` (the
 * default) means "no hard timeout", matching a role that never configured one.
 */
function isInstanceTimedOut({ spawnedAt, maxRuntimeMs }, now = Date.now()) {
  if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0) return false;
  const start = typeof spawnedAt === 'string' ? Date.parse(spawnedAt) : NaN;
  if (!Number.isFinite(start)) return false;
  return (now - start) >= maxRuntimeMs;
}

module.exports = {
  POOL_WORKSPACES,
  normalizePoolConfig,
  isPooledRole,
  reworkRefFromPayload,
  poolInstanceId,
  roleIdFromMemberId,
  planPoolDispatch,
  isInstanceTimedOut,
};
