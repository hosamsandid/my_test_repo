'use strict';

// The Flow Supervisor — deterministic auto-dispatch + bounded remediation for
// POOLED roles (#2247, epic #2251 Phase 2; design of record
// `docs/parallel-workers-concept.md` §7, `docs/flow-control-concept.md` §4.3a).
//
// WHY THIS EXISTS. Phase 1 (#2246) turned a pooled role into an auto-scaling,
// self-cleaning worker template — but only once a human applies its wake label
// to EACH item, one at a time. The wish this phase fills (concept §7): the
// operator marks a backlog of items ready and the platform drains it,
// oldest-first, up to the team's `wipLimit`, instead of triggering each ticket
// by hand.
//
// TIMING ONLY, NOT READINESS (D10). The human still decides WHICH items are
// ready — that decision is the wake label already sitting on the issue. What
// this module acts on is the ticket ledger's own `unclaimed` blocker class
// (#2115 §4.1: "dispatched > T1, no `:wip`, no run" — subsumes
// `wake-not-claimed`): a wake label the platform never actually delivered (a
// dropped poller event, a label applied while no agent was listening, GitHub's
// own event loss). "Auto-dispatch ready-but-undispatched items" and "re-fire a
// dropped dispatch" are the SAME operation under two names in the design docs,
// and this module implements them as one code path.
//
// DETERMINISTIC CORE, NO LLM (concept §4.3a — the LLM half is §4.3b, unbuilt,
// out of scope here). Pure, no fs, no network, `now` always injected — the
// `admission-control.js` shape. `orchestrator.js` is the fs/GitHub half: it
// reads the ticket ledger (#2115) + the admission lane (#2114), calls this
// module, then executes through the SAME audited hands #2114/#1858/#2030
// already built (the label fast-path's wake half, `wake-agent`) — never a new
// GitHub-writing primitive.

const { pathsOverlap } = require('./predicted-paths');

const AUTO_DISPATCH_BLOCKER = 'unclaimed';
const REMEDIATION_STALE_BASE = 'stale-base';
// Phase 4 (#2249, D6): the ONE additional contention policy this phase adds,
// layered ON TOP of epic-serialization (which is always on, per Amendment 1
// A1.4 — never gated by `contentionPolicy`) rather than replacing it. Off by
// default: unset/`'epic-serial'` behaves byte-identically to before this phase.
const CONTENTION_PREDICTED_PATHS = 'predicted-paths';

function budgetKey(ticketId, blocker) {
  return `${ticketId}::${blocker}`;
}

// Has this exact (ticket, blocker) action already fired within the window? A
// missing/unparseable timestamp reads as "never fired" — a corrupt budget log
// must degrade to acting again, never to a permanent silent skip.
function firedRecently(budget, key, now, windowMs) {
  const at = budget && typeof budget === 'object' ? budget[key] : null;
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) && (now - t) < windowMs;
}

/**
 * Which ready-but-undispatched pooled-role tickets to (re-)dispatch this tick,
 * oldest-first, honouring **epic-serialization** (never two in-flight items
 * sharing `epicId`) and the per-`(ticket,blocker)` action budget.
 *
 * `candidates` are ticket-ledger rows the caller has already narrowed to
 * `kind === 'issue'` tickets owned by a pooled role's template
 * (`agentPool.isPooledRole`) — this module has no notion of pooling itself,
 * only of the ledger shape and the budget.
 *
 * `busyEpicIds` are the epics already active elsewhere in the team's ledger
 * (any ticket not `backlog`/`done`), reserved BEFORE this pass runs. An epic
 * picked within this same pass is reserved too, so two backlog tickets sharing
 * an epic never both fire in one tick.
 *
 * `limit` bounds how many NEW dispatches this pass attempts — a heuristic, not
 * the enforcement: the admission lane (`admission-control.js`) is the actual
 * capacity gate every dispatch still passes through, so an over-eager pick
 * here is merely held, never double-admitted.
 *
 * `contentionPolicy`/`busyPathSets` are Phase 4's addition (#2249, D6): when
 * `contentionPolicy === 'predicted-paths'`, a candidate carrying a non-empty
 * `predictedPaths` array is ALSO skipped if it overlaps any set in
 * `busyPathSets` (paths already claimed by active tickets elsewhere, or by a
 * ticket picked earlier in this same pass — reserved the same way `busy`
 * reserves epics). Any other value (including unset) leaves this branch dead —
 * byte-identical to the pre-#2249 behaviour. A candidate with no/empty
 * `predictedPaths` (no assist LLM configured, prediction failed, or nothing
 * confident to report) is NEVER held back by this policy — an advisory miss
 * must fail open, not become a silent extra restriction (D6: the ledger stays
 * the real safety net).
 *
 * @returns {Array} the picked ticket rows, unmodified.
 */
function selectAutoDispatch({
  candidates = [], busyEpicIds = [], budget = {}, now = Date.now(), windowMs, limit = Infinity,
  contentionPolicy = null, busyPathSets = [],
} = {}) {
  const busy = new Set(busyEpicIds.filter((e) => e != null));
  const pathContentionOn = contentionPolicy === CONTENTION_PREDICTED_PATHS;
  const busyPaths = pathContentionOn ? busyPathSets.filter((p) => Array.isArray(p) && p.length) : [];
  const sorted = [...candidates]
    .filter((t) => t && t.blocker === AUTO_DISPATCH_BLOCKER && t.kind === 'issue' && t.lane)
    .sort((a, b) => (b.ageInStateMs || 0) - (a.ageInStateMs || 0));
  const picked = [];
  for (const t of sorted) {
    if (picked.length >= limit) break;
    if (t.epicId != null && busy.has(t.epicId)) continue;
    const ownPaths = pathContentionOn && Array.isArray(t.predictedPaths) && t.predictedPaths.length
      ? t.predictedPaths : null;
    if (ownPaths && busyPaths.some((paths) => pathsOverlap(ownPaths, paths))) continue;
    if (firedRecently(budget, budgetKey(t.ticketId, AUTO_DISPATCH_BLOCKER), now, windowMs)) continue;
    picked.push(t);
    if (t.epicId != null) busy.add(t.epicId);
    if (ownPaths) busyPaths.push(ownPaths);
  }
  return picked;
}

/**
 * Which `stale-base` PRs to hand back to their owning agent this tick — the
 * remediation ladder's other named row (concept §7; flow-control-concept.md
 * §4.3a's `conflict`/`stale-base` rows, narrowed here to `stale-base`, the case
 * the ticket ledger already tells apart from an author's own `ci-red` bug —
 * #2115 A1.4). Budgeted identically to auto-dispatch so a stuck PR is nudged
 * at most once per window, not on every tick until a human intervenes.
 */
function selectStaleBaseRework({ candidates = [], budget = {}, now = Date.now(), windowMs } = {}) {
  return candidates.filter((t) => (
    t && t.blocker === REMEDIATION_STALE_BASE && t.ownerAgentId
    && !firedRecently(budget, budgetKey(t.ticketId, REMEDIATION_STALE_BASE), now, windowMs)
  ));
}

// Fold a batch of fired action keys into the budget log, returning a NEW
// object (never mutates its input — the `admission-control.js` discipline).
function recordFired(budget, keys, now = Date.now()) {
  const next = { ...(budget || {}) };
  const iso = new Date(now).toISOString();
  for (const k of keys) next[k] = iso;
  return next;
}

// Drop budget entries past the window so a long-lived team's log does not grow
// forever. Called once per sweep, after recording this tick's actions.
function pruneBudget(budget, now, windowMs) {
  const next = {};
  for (const [k, v] of Object.entries(budget || {})) {
    if (firedRecently({ [k]: v }, k, now, windowMs)) next[k] = v;
  }
  return next;
}

module.exports = {
  AUTO_DISPATCH_BLOCKER,
  REMEDIATION_STALE_BASE,
  CONTENTION_PREDICTED_PATHS,
  budgetKey,
  firedRecently,
  selectAutoDispatch,
  selectStaleBaseRework,
  recordFired,
  pruneBudget,
};
