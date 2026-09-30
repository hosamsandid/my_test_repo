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

// Sensible out-of-the-box teardown timeouts (#2301 gap "sensible pool.teardown
// defaults... so cleanup works out of the box") — an unconfigured pooled role
// used to reap NOTHING on these three axes (`positiveMs` defaulted straight to
// `null`), even though the Scaling section's own UI copy ("blank = default")
// already promised a default existed. `idleTimeoutMs`/`maxRuntimeMs` mirror the
// concept doc's own mockup values (`docs/parallel-workers-concept.md`'s Scaling
// panel: "Idle timeout [ 30m ]  Hard timeout [ 2h ]"); `retainLogsMs` has no
// mockup precedent — 7 days, a judgement call, flagged in the PR.
const TEARDOWN_DEFAULTS = Object.freeze({
  idleTimeoutMs: 30 * 60 * 1000,
  maxRuntimeMs: 2 * 60 * 60 * 1000,
  retainLogsMs: 7 * 24 * 60 * 60 * 1000,
});

/**
 * Normalize a role's `pool` config (process-template.js §9). `null` means "not
 * pooled" — a role with no `pool` field, or `pool.enabled` anything but the
 * literal `true`, is byte-identical to a role that never heard of pooling.
 *
 * Defaulting happens HERE, at the runtime-consumption site, rather than in
 * `process-template.js`'s own `normalizePool` (bundle round-trip) — a bundle
 * should keep storing exactly what was authored (`null` = "unset"), so a
 * future change to `TEARDOWN_DEFAULTS` takes effect for every already-saved
 * config instead of only newly-authored ones.
 *
 * @returns {{enabled:true, maxInstances:number|null, workspace:string,
 *            baseBranch:string|null,
 *            workSource:{items:string[],outputDir:string,inputDir:string|null}|null,
 *            teardown:{idleTimeoutMs:number,maxRuntimeMs:number,retainLogsMs:number}}|null}
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
  const positiveMsOr = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
  return {
    enabled: true,
    maxInstances,
    workspace,
    baseBranch,
    workSource,
    teardown: {
      idleTimeoutMs: positiveMsOr(t.idleTimeoutMs, TEARDOWN_DEFAULTS.idleTimeoutMs),
      maxRuntimeMs: positiveMsOr(t.maxRuntimeMs, TEARDOWN_DEFAULTS.maxRuntimeMs),
      retainLogsMs: positiveMsOr(t.retainLogsMs, TEARDOWN_DEFAULTS.retainLogsMs),
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
//
// #2573 gives Drain its own ending: once the last running instance of a
// `draining` role has finished, the role settles to `off` by itself
// (`settleDrain`, driven by the orchestrator's periodic pool sweep). `off`
// refuses/holds new work exactly like `paused`; the difference is only in who
// ends it — a paused role expects a Resume, an off role a deliberate
// "Switch on". Both clear back to running through the same POST, which
// redelivers everything held meanwhile, so nothing is lost either way.
const POOL_CONTROL_STATES = ['paused', 'draining', 'off'];

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

/**
 * #2573: the drain → off transition. Returns the state the role should be in
 * given how many of its instances are still running — `off` once a
 * `draining` role has nothing left running, otherwise the state unchanged.
 * A non-finite busy count (unreadable) never settles — fails closed so a
 * drain is never declared finished on a guess.
 */
function settleDrain(state, busyCount) {
  if (state !== 'draining') return state;
  return Number.isFinite(busyCount) && busyCount <= 0 ? 'off' : state;
}

// Paused/draining hold queue (code-review finding on #2281's review of this
// Phase). A dispatch refused because its role is `paused`/`draining` must
// never silently fall through to the role TEMPLATE's own pending queue — that
// would run the ticket under the shared, unpooled identity while the operator
// believes it is stopped. It is held here instead, durably, and replayed the
// moment the role resumes (`orchestrator.js`'s pool-control POST route) —
// mirroring the admission lane's own `held` shape (verbatim entry + agentId),
// but keyed per pooled ROLE rather than per team, since this has nothing to do
// with `wipLimit` capacity.
function normalizePausedHold(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [roleId, list] of Object.entries(raw)) {
    if (typeof roleId !== 'string' || !roleId || !Array.isArray(list)) continue;
    const entries = [];
    for (const h of list) {
      if (!h || typeof h !== 'object') continue;
      if (typeof h.agentId !== 'string' || !h.agentId) continue;
      if (!h.entry || typeof h.entry !== 'object') continue;
      entries.push({
        agentId: h.agentId,
        entry: h.entry,
        heldAt: typeof h.heldAt === 'string' ? h.heldAt : null,
      });
    }
    if (entries.length) out[roleId] = entries;
  }
  return out;
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
  // An `off` role has nothing running by definition (#2573: it only gets
  // there once a drain finished), so even a leftover idle instance for the
  // same item must not pick up new work until the role is switched on.
  if (controlState === 'off') {
    return { action: 'refuse', reason: controlState, instanceId };
  }
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

/**
 * #2301 gap 3: `idleTimeoutMs` was normalized but consumed nowhere — an
 * instance that finished its work and went idle was never reaped just because
 * it went quiet, only ever via the (ticket-release or hard-timeout) reapers.
 * This is the quiet-delete axis the issue asks for: "work done, ticket still
 * open". Deliberately gated on `state === 'idle'` (the same field
 * `_write_status` in `agent-entrypoint.py` maintains) so a run that is still
 * actively BUSY, however long, is never caught here — that is `maxRuntimeMs`
 * / `isInstanceTimedOut`'s job, and it stamps `needs-human` rather than
 * quietly deleting, because a stuck run is a signal a human should see.
 *
 * The reference point is `lastResponseAt` (the last time this instance
 * actually produced output) — falling back to `spawnedAt` only for the edge
 * case of an instance that went idle without ever recording a response
 * (`_write_status` sets `state` before the first `lastResponseAt` write).
 * An unresolvable/missing `state` or reference time never reaps — fails
 * closed, matching `isInstanceTimedOut`'s own "never guess" stance.
 */
function isInstanceIdle({ state, lastResponseAt, spawnedAt, idleTimeoutMs }, now = Date.now()) {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return false;
  if (state !== 'idle') return false;
  const refRaw = lastResponseAt || spawnedAt;
  const ref = typeof refRaw === 'string' ? Date.parse(refRaw) : NaN;
  if (!Number.isFinite(ref)) return false;
  return (now - ref) >= idleTimeoutMs;
}

/**
 * #2301 gap 4: `retainLogsMs` was normalized but the pruning pass was a TODO —
 * archived pool session logs (`gracefulPoolTeardown`'s `pool-archive/…` copy)
 * lived forever. `archivedAt` is the ISO stamp written at archive time, not
 * the directory's mtime (`fs.cpSync` can leave a freshly-archived directory
 * carrying its SOURCE files' older mtimes rather than the moment of archival).
 */
function isArchiveExpired({ archivedAt, retainLogsMs }, now = Date.now()) {
  if (!Number.isFinite(retainLogsMs) || retainLogsMs <= 0) return false;
  const ts = typeof archivedAt === 'string' ? Date.parse(archivedAt) : NaN;
  if (!Number.isFinite(ts)) return false;
  return (now - ts) >= retainLogsMs;
}

/**
 * #2595 AC10: a pool instance keeps ONE resumable session pointer
 * (`sessions/<roomId>.current.json`) for its whole lifetime. The teardown
 * archive keeps the transcript (`<roomId>.jsonl` + rotations) but must not
 * carry the pointer along — it only ever drives `--resume` inside the live
 * instance and would be orphaned state in `pool-archive/`. Used as the
 * `fs.cpSync` filter, so it is called for directories too: keep everything
 * that is not a pointer file.
 */
function isArchivableSessionPath(p) {
  return !(typeof p === 'string' && p.endsWith('.current.json'));
}

module.exports = {
  POOL_WORKSPACES,
  POOL_CONTROL_STATES,
  TEARDOWN_DEFAULTS,
  normalizePoolConfig,
  isPooledRole,
  isSafeGitRef,
  reworkRefFromPayload,
  poolInstanceId,
  roleIdFromMemberId,
  normalizePoolControl,
  poolControlState,
  settleDrain,
  normalizePausedHold,
  planPoolDispatch,
  isInstanceTimedOut,
  isInstanceIdle,
  isArchiveExpired,
  isArchivableSessionPath,
};
