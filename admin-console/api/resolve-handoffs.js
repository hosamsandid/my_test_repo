'use strict';

// ─── resolve-handoffs (Unified Orchestration, #362 / #368) ───────────────────
//
// Pure generalization of `findAffectedBps` from the former
// orchestrator/bp-event-router.js (deleted with the BriefingPack model in
// #1962) over the unified edge model. Given a node that just reached a "producing" state
// (emitted a label, wrote an artifact, or completed), it returns the downstream
// hand-offs across ALL edge types — so an artifact production fans out the same
// way a label does, and vice versa (epic decision 4). It subsumes the BP router:
//
//   • `dependency` edges  ≡ findAffectedBps depends-on dependents
//   • `artifact`   edges  ≡ findAffectedBps input-artifact dependents
//   • `label` / `review` / `manual` edges = the new, generalized reach.
//
// Graph semantics: a node is never its own downstream target (no self hand-off
// edge in the reachability sense). This is NOT event-source filtering — the
// github-poller no longer filters by origin at all (a trigger fires on any
// matching event, self included); the only delivery backstop is the caller's
// conversation throttle, applied to the candidates this returns. This module
// answers *what is downstream*, never *whether to deliver*.

function asArray(x) { return Array.isArray(x) ? x : []; }

/**
 * @param {{ edges: Array }} graph - a unified graph (e.g. from buildUnifiedGraph)
 * @param {string | {
 *   node: string,            // the producing node id
 *   labels?: string[],       // labels it actually emitted (omit = match any label edge)
 *   paths?: string[],        // artifact paths it actually wrote (omit = match any artifact edge)
 *   completed?: boolean,     // did it complete? gates dependency edges (default true)
 * }} source
 * @returns {{ targets: Array<{ to, on, reason, label?, paths? }> }}
 */
function resolveHandoffs(graph, source) {
  const edges = asArray(graph && graph.edges);
  const src = typeof source === 'string' ? { node: source } : (source || {});
  const node = src.node;
  if (!node) return { targets: [] };

  const labels = Array.isArray(src.labels) ? new Set(src.labels) : null; // null = any
  const paths = Array.isArray(src.paths) ? new Set(src.paths) : null;    // null = any
  const completed = src.completed !== false; // dependency edges fire on completion

  const targets = [];
  const seen = new Set();

  for (const e of edges) {
    if (e.from !== node) continue;
    if (e.to == null || e.to === node) continue; // graph semantics — no self hand-off edge

    let match = false;
    switch (e.on) {
      case 'label':
        match = !labels || (e.label != null && labels.has(e.label));
        break;
      case 'artifact':
        match = !paths || asArray(e.paths).some(p => paths.has(p));
        break;
      case 'dependency':
        match = completed;
        break;
      case 'review':
      case 'manual':
        match = true;
        break;
      // 'timer' is a self-loop; 'event' originates from null — neither fans out
      // from a producing node.
      default:
        match = false;
    }
    if (!match) continue;

    const key = `${e.on}|${e.to}|${e.label != null ? e.label : asArray(e.paths).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      to: e.to,
      on: e.on,
      reason: e.on,
      ...(e.label != null ? { label: e.label } : {}),
      ...(asArray(e.paths).length ? { paths: e.paths.slice() } : {}),
    });
  }

  return { targets };
}

module.exports = { resolveHandoffs };
