'use strict';

// Agent instance pools — Phase 3: the recurring-analysis binding (#2248, epic
// #2251; design of record `docs/parallel-workers-concept.md` §6, D11). Proves
// the pool core is domain-neutral: no GitHub, no git-merge contention. A
// pooled role opts in via `pool.workSource` — a sibling of `pool.workspace`/
// `pool.baseBranch` on the SAME normalized config surface `agent-pool.js`
// already carries binding-specific fields on (`baseBranch` is the git
// binding's own such field; this is the recurring binding's).
//
// Pure core, no fs/network, mirroring `agent-pool.js`'s / `flow-supervisor.js`'s
// own shape — the fs-touching half (enumerating output files, copying input,
// spawning/reaping instances) lives in `orchestrator.js`, exactly like every
// other binding here (concept §10: "build the neutral pool core + adapters
// BESIDE" the existing GitHub-coupled internals, never generalise those).

/**
 * Normalize a role's `pool.workSource` config. `null` means "this pooled role
 * has no recurring-analysis work source" — i.e. it is the SDLC binding (§5)
 * or the field is missing/malformed, in which case the caller
 * (`agent-pool.js` `normalizePoolConfig`) leaves it out entirely rather than
 * pretending a work source exists.
 *
 * `items` is the "list" work source named in §6 — the current N item ids for
 * this cycle, deduplicated (idempotent by construction, D11: the same id
 * appearing twice must never resolve to two instances). `outputDir` is the
 * completion signal ("the run succeeded / the output artifact exists") that
 * also drives the "already done this cycle?" check — required, since without
 * it nothing could ever be marked done and every tick would re-process
 * everything. `inputDir` is only consulted for the `input-copy` workspace
 * binding; a `none` binding needs no input at all (concept Insight B).
 *
 * @returns {{items:string[], outputDir:string, inputDir:string|null}|null}
 */
function normalizeWorkSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = Array.isArray(raw.items)
    ? [...new Set(raw.items.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))]
    : [];
  if (!items.length) return null;
  const outputDir = typeof raw.outputDir === 'string' && raw.outputDir.trim() ? raw.outputDir.trim() : null;
  if (!outputDir) return null;
  const inputDir = typeof raw.inputDir === 'string' && raw.inputDir.trim() ? raw.inputDir.trim() : null;
  return { items, outputDir, inputDir };
}

/**
 * Which of this cycle's work items still need a fresh instance spawned this
 * tick — everything NOT already complete (the output-artifact signal, checked
 * by the caller and passed in as `completedItemIds`) and NOT already running
 * (`existingItemIds` — D11: a redelivered/duplicate tick must never spawn a
 * second instance for an item already being worked), capped at `limit`
 * (concept §6: "contention = none → full parallelism up to the resource/rate
 * limit"). List order is preserved — the caller's `items` order IS the
 * dispatch order; unlike the SDLC ticket ledger there is no `ageInStateMs` to
 * sort a flat list by.
 *
 * @returns {string[]} the item ids to spawn, in `items` order.
 */
function selectRecurringDispatch({ items = [], completedItemIds = [], existingItemIds = [], limit = Infinity } = {}) {
  const completed = new Set(completedItemIds);
  const existing = new Set(existingItemIds);
  const picked = [];
  for (const item of items) {
    if (picked.length >= limit) break;
    if (completed.has(item) || existing.has(item)) continue;
    picked.push(item);
  }
  return picked;
}

module.exports = {
  normalizeWorkSource,
  selectRecurringDispatch,
};
