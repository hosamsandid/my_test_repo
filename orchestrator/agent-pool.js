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

const { normalizeWorkSource } = require('./recurring-pool-source');

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
 *            workSource:{items:string[],outputDir:string,inputDir:string|null}|null,
 *            teardown:{idleTimeoutMs:number|null,maxRuntimeMs:number|null,retainLogsMs:number|null}}|null}
 */
function normalizePoolConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const maxInstances = Number.isInteger(raw.maxInstances) && raw.maxInstances >= 1 ? raw.maxInstances : null;
  const workspace = POOL_WORKSPACES.includes(raw.workspace) ? raw.workspace : 'git-clean-base';
  const baseBranch = typeof raw.baseBranch === 'string' && raw.baseBranch.trim() ? raw.baseBranch.trim() : null;
  // Phase 3 (#2248, concept §6) — the recurring-analysis binding's own
  // config, a sibling of `baseBranch` (the git binding's own field) on this
  // same normalized surface. Meaningless for `git-clean-base`; left in place
  // even then rather than cross-validated against `workspace` here, since
  // `normalizePoolConfig` never refuses input (it only defaults) — the strict
  // typo/shape refusal lives in `process-template.js`'s `validateProcessTemplate`.
  const workSource = normalizeWorkSource(raw.workSource);
  const t = raw.teardown && typeof raw.teardown === 'object' ? raw.teardown : {};
  const positiveMs = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return {
    enabled: true,
    maxInstances,
    workspace,
    baseBranch,
    workSource,
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

// A git ref name can contain almost anything, but git's OWN argument parser
// treats any argv entry beginning with `-` as an OPTION regardless of where
// it sits — e.g. a branch literally named `--upload-pack=<cmd>` turns
// `git fetch origin <branch>` into arbitrary command execution on some git
// versions (CodeQL `js/second-order-command-line-injection`; the CVE class
// this whole D3 feature has to be careful of, since a GitHub branch name is
// attacker-controlled — anyone who can open a PR names its branch). Refused
// at the SOURCE, not just at the point of use, so a rejected value never even
// looks like a resolved rework ref to a caller that forgot to re-check it.
function isSafeGitRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-');
}

/**
 * D3, the free (no network) signal: when the GitHub event that triggered a
 * pooled dispatch is ITSELF a `pull_request.*` event (or an `issue_comment` on
 * a PR, which arrives with the same `pull_request` field), the PR under work
 * is already sitting in the payload — this is the common case the review's
 * repro names (a reviewer role dispatched by a PR event). Returns `null` for
 * everything else (an `issues.*` event, e.g. a plain `ready` relabel, or an
 * unsafe/malformed branch name — see `isSafeGitRef`), which is the caller's
 * cue to fall back to a live lookup (`_lookupPoolReworkRef` in
 * orchestrator.js) rather than guess.
 *
 * @returns {{branch:string, repo:string|null}|null}
 */
function reworkRefFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const pr = payload.pull_request && typeof payload.pull_request === 'object' ? payload.pull_request : null;
  const head = pr && pr.head && typeof pr.head === 'object' ? pr.head : null;
  if (!head || !isSafeGitRef(head.ref)) return null;
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
// Runtime control (Phase 5 #2250, epic #2251; concept §11's open board-control
// item) — pause / drain a pooled role from the Flow Control board, WITHOUT
// touching its `pool` config (§9). Config is the static template shape
// round-tripped through the bundle; this is an operator's live on/off switch,
// so it is kept out of the bundle entirely and persisted beside the admission
// lane / flow-supervisor budget (`orchestrator.js`'s `poolControlPath`).
//
// Two states beyond the implicit default, deliberately given the SAME
// dispatch-refusing effect (the concept's own §11 leaves the pause/drain
// distinction open; a judgement call, flagged in the PR): `paused` reads as
// "temporary, expect to resume"; `draining` reads as "shutting this role down
// — flip pool.enabled off once it goes idle". Both let an already-running
// instance finish (D4's slot-held-until-completion is untouched) and both
// only block a NEW spawn — a redelivered event for a ticket already in flight
// still resolves to its existing instance (D11), because pausing dispatch of
// new work is not the same as abandoning work already admitted.
const POOL_CONTROL_STATES = ['paused', 'draining'];

/**
 * `raw` is the whole team's `{ "<roleId>": { state, changedAt } }` map as
 * persisted on disk. `running` (the default) is never stored — an absent key
 * IS running, so an unconfigured team is byte-identical to today and the file
 * never grows for a team that has never paused anything.
 */
function normalizePoolControl(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [roleId, v] of Object.entries(raw)) {
    if (typeof roleId !== 'string' || !roleId) continue;
    if (!v || typeof v !== 'object' || !POOL_CONTROL_STATES.includes(v.state)) continue;
    out[roleId] = {
      state: v.state,
      changedAt: typeof v.changedAt === 'string' ? v.changedAt : null,
    };
  }
  return out;
}

// The effective state for one role — `running` for anything not recorded
// (never-touched, or explicitly resumed, which simply deletes the key).
function poolControlState(control, roleId) {
  const c = control && control[roleId];
  return c && POOL_CONTROL_STATES.includes(c.state) ? c.state : 'running';
}

// ---------------------------------------------------------------------------
// Dispatch routing — spawn, reuse, or refuse
// ---------------------------------------------------------------------------

/**
 * Decide what a dispatch destined for a pooled role's TEMPLATE should actually
 * do: spawn a fresh instance, reuse the one already there (D11), or refuse —
 * either the additive per-role `maxInstances` cap (D5's later refinement — the
 * team-wide `wipLimit` is the primary governor and is enforced upstream by
 * `admission-control.js`, not here) or an operator's `paused`/`draining` hold
 * on the role (above).
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
function planPoolDispatch({ teamId, roleId, pool, itemKey, existingInstanceIds = [], controlState = 'running' }) {
  if (itemKey === null || itemKey === undefined) return { action: 'unpooled' };
  const instanceId = poolInstanceId(teamId, roleId, itemKey);
  if (existingInstanceIds.includes(instanceId)) {
    return { action: 'reuse', instanceId };
  }
  if (POOL_CONTROL_STATES.includes(controlState)) {
    return { action: 'refuse', reason: controlState, instanceId };
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
  POOL_CONTROL_STATES,
  normalizePoolConfig,
  isPooledRole,
  isSafeGitRef,
  reworkRefFromPayload,
  poolInstanceId,
  roleIdFromMemberId,
  normalizePoolControl,
  poolControlState,
  planPoolDispatch,
  isInstanceTimedOut,
};
