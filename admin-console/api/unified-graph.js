'use strict';

// ─── unified-graph (Unified Orchestration, #362 / #365) ──────────────────────
//
// One pure, side-effect-free model over BOTH orchestration concepts:
//
//   • Process-Flows — agents wired by a label choreography (emits[] ↔
//     labelFilter), time triggers, human gates, PR-review steps.
//   • BriefingPack-Flows — work-units wired by `depends_on` (ordering) and
//     `artifacts` (input/output data flow).
//
// A `UnifiedNode` is an agent/role that carries the Process wake mechanism
// (`triggers`) AND the BP data-flow ports (`inputs`/`outputs`) + `dependsOn`.
// A `UnifiedEdge` is a typed hand-off discriminated by `on`:
//
//   'label'      — A emits label L, B's trigger filters on L            (Process)
//   'event'      — raw GitHub event wakes B (no labelFilter)            (Process)
//   'timer'      — cron/once self-loop                                  (Process)
//   'review'     — PR-review flow (in / approve / changes)             (Process)
//   'dependency' — B depends_on A (readiness/ordering)                  (BP)
//   'artifact'   — A's output path is B's input path (data flow)        (BP)
//   'manual'     — operator-declared hand-off (explicit input edge)     (BP hand-off)
//
// Human-approval gates are an orthogonal `gate: 'human'` flag on the edge,
// not a separate edge type. BP `status` is intentionally NOT modeled (decision 2).
//
// No I/O here. The HTTP endpoint gathers live agents + BP briefings, maps them
// through the adapters below, and hands nodes/edges to buildUnifiedGraph.

const {
  buildProcessGraph,
  isHumanGate,
  isBrake,
} = require('./process-graph');
const {
  buildProcessTemplate,
} = require('./process-template');

const UNIFIED_FLOW_VERSION = 1;

// ── small pure helpers ───────────────────────────────────────────────────────

function asArray(x) { return Array.isArray(x) ? x : []; }

// Stable, deterministic edge id so re-builds and the renderer agree.
function edgeId(e) {
  const tail = e.label != null ? e.label
    : (Array.isArray(e.paths) ? e.paths.join(',') : '');
  return `${e.on}|${e.from == null ? '∅' : e.from}→${e.to == null ? '∅' : e.to}|${tail}`;
}

// Output / input artifact paths declared on a UnifiedNode. Ported (pure) from
// orchestrator/bp-event-router.js outputsOf/inputsOf — kept local so this
// module has no cross-service dependency.
function outputPaths(node) {
  const out = new Set();
  for (const a of asArray(node.outputs)) {
    const p = typeof a === 'string' ? a : (a && a.path);
    if (typeof p === 'string' && p) out.add(p);
  }
  return out;
}
function inputPaths(node) {
  const out = new Set();
  for (const a of asArray(node.inputs)) {
    const p = typeof a === 'string' ? a : (a && a.path);
    if (typeof p === 'string' && p) out.add(p);
  }
  return out;
}

// Translate a buildProcessGraph edge (kind-discriminated) into a UnifiedEdge
// (on-discriminated). Returns null for edges we drop.
function processEdgeToUnified(e) {
  if (e.kind === 'timer') {
    const schedule = /^[\d*]/.test(String(e.label)) || String(e.label).includes(' ')
      ? { cron: e.label } : { at: e.label };
    return { from: e.from, to: e.to, on: 'timer', label: e.label, schedule, triggerId: e.triggerId };
  }
  if (e.kind === 'review') {
    return {
      from: e.from, to: e.to, on: 'review', label: e.label,
      ...(e.reviewFlow ? { reviewFlow: e.reviewFlow } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
    };
  }
  if (e.external) {
    // Raw GitHub event from an external actor (no agent emitter).
    return { from: null, to: e.to, on: 'event', events: [e.label], triggerId: e.triggerId, external: true };
  }
  // 'agent' label wiring, plus gate/brake (human-only) edges.
  const u = { from: e.from, to: e.to, on: 'label', label: e.label, triggerId: e.triggerId };
  if (e.kind === 'gate' || e.kind === 'brake' || isHumanGate(e.label) || isBrake(e.label)) {
    u.gate = 'human';
  }
  if (e.orphan) u.orphan = true;
  if (e.deadEnd) u.deadEnd = true;
  return u;
}

// ── builder ──────────────────────────────────────────────────────────────────

/**
 * Build the unified orchestration graph.
 *
 * @param {Array} nodes - UnifiedNode[]: { id, displayName, role, kind,
 *   sessionPolicy, environmentId, systemPrompt, triggers[], inputs[], outputs[],
 *   dependsOn[], review? }. `triggers[].emits` must already be the effective set.
 * @param {Array} [edges] - explicit UnifiedEdge[] (e.g. on:'manual' hand-offs,
 *   operator-drawn dependencies). Derived label/timer/review/event/dependency/
 *   artifact edges are computed here and merged in.
 * @returns {{ nodes, edges, gates, labels, lints }}
 */
function buildUnifiedGraph(nodes, edges) {
  const list = asArray(nodes);
  const nodeIds = new Set(list.map(n => n.id));

  // 1) Process-style edges (label / timer / review / event) + gates/labels +
  //    the Process lints — reuse the existing builder verbatim.
  const pg = buildProcessGraph(list);
  const pgNodeById = new Map(pg.nodes.map(n => [n.id, n]));

  // Output nodes = Process node view enriched with the BP data-flow ports.
  const outNodes = list.map(n => {
    const base = pgNodeById.get(n.id) || { id: n.id };
    return {
      ...base,
      inputs: asArray(n.inputs),
      outputs: asArray(n.outputs),
      dependsOn: asArray(n.dependsOn),
    };
  });

  const unifiedEdges = [];
  const seen = new Set();
  const push = (e) => {
    const id = edgeId(e);
    if (seen.has(id)) return;
    seen.add(id);
    unifiedEdges.push({ id, ...e });
  };

  for (const e of pg.edges) {
    const u = processEdgeToUnified(e);
    if (u) push(u);
  }

  // 2) Dependency edges from node.dependsOn[] (BP `depends_on`).
  for (const n of list) {
    for (const dep of asArray(n.dependsOn)) {
      if (typeof dep !== 'string' || !dep) continue;
      push({
        from: dep, to: n.id, on: 'dependency',
        ...(nodeIds.has(dep) ? {} : { orphan: true }), // dangling dependency
      });
    }
  }

  // 3) Artifact edges: a producer's output path is a consumer's input path.
  //    Grouped per (producer → consumer) so co-flowing paths share one edge —
  //    mirrors orchestrator/bp-event-router.js input-artifact matching.
  const producersByPath = new Map(); // path -> [nodeId]
  for (const n of list) {
    for (const p of outputPaths(n)) {
      if (!producersByPath.has(p)) producersByPath.set(p, []);
      producersByPath.get(p).push(n.id);
    }
  }
  const artifactPaths = new Map(); // `${from}→${to}` -> Set(path)
  for (const n of list) {
    for (const p of inputPaths(n)) {
      for (const producer of (producersByPath.get(p) || [])) {
        if (producer === n.id) continue; // a node consuming its own output is not a hand-off
        const key = `${producer}→${n.id}`;
        if (!artifactPaths.has(key)) artifactPaths.set(key, new Set());
        artifactPaths.get(key).add(p);
      }
    }
  }
  for (const [key, paths] of artifactPaths) {
    const [from, to] = key.split('→');
    push({ from, to, on: 'artifact', paths: [...paths].sort() });
  }

  // 4) Explicit input edges (manual hand-offs, operator-drawn). Never silently
  //    rewrite emits — these are operator-declared and pass straight through.
  for (const e of asArray(edges)) {
    if (!e || !e.on) continue;
    push({ ...e });
  }

  const lints = [
    ...asArray(pg.lints),
    ...computeDataflowLints(list, unifiedEdges),
  ];

  return { nodes: outNodes, edges: unifiedEdges, gates: pg.gates, labels: pg.labels, lints };
}

// Data-flow + dependency lints layered on top of the Process lints (#365).
function computeDataflowLints(nodes, edges) {
  const lints = [];
  const list = asArray(nodes);

  const allOutputs = new Set();
  const allInputs = new Set();
  for (const n of list) {
    for (const p of outputPaths(n)) allOutputs.add(p);
    for (const p of inputPaths(n)) allInputs.add(p);
  }

  for (const n of list) {
    for (const p of inputPaths(n)) {
      if (!allOutputs.has(p)) {
        lints.push({
          code: 'dangling-input', severity: 'warning', nodeId: n.id, path: p,
          message: `\`${n.id}\` consumes input \`${p}\` but no node produces it.`,
        });
      }
    }
    for (const p of outputPaths(n)) {
      if (!allInputs.has(p)) {
        lints.push({
          code: 'unconsumed-output', severity: 'info', nodeId: n.id, path: p,
          message: `\`${n.id}\` produces output \`${p}\` but nothing consumes it.`,
        });
      }
    }
  }

  // Dependency cycles — over `on:'dependency'` edges only (ordering constraint).
  const adj = new Map();
  for (const e of asArray(edges)) {
    if (e.on !== 'dependency' || e.from == null || e.to == null) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const cycle = firstCycle(adj);
  if (cycle) {
    lints.push({
      code: 'dependency-cycle', severity: 'error', nodes: cycle,
      message: `dependency cycle: ${cycle.join(' → ')}.`,
    });
  }

  return lints;
}

// DFS cycle detection; returns the first cycle as an ordered node list, or null.
function firstCycle(adj) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  let found = null;

  const visit = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of (adj.get(u) || [])) {
      if (found) return;
      const c = color.get(v) || WHITE;
      if (c === WHITE) visit(v);
      else if (c === GRAY) {
        const i = stack.indexOf(v);
        found = stack.slice(i).concat(v);
        return;
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const u of adj.keys()) {
    if (found) break;
    if ((color.get(u) || WHITE) === WHITE) visit(u);
  }
  return found;
}

// ── adapters (pure) ────────────────────────────────────────────────────────

// Process-template bundle → UnifiedFlow. Roles become nodes; their triggers
// drive label/timer/review/event edges at build time. No artifact ports.
function processTemplateToUnified(bundle) {
  const b = bundle || {};
  return {
    unifiedFlowVersion: UNIFIED_FLOW_VERSION,
    name: b.name || 'process',
    level: b.level || 'template',
    nodes: asArray(b.roles).map(r => ({
      id: r.id,
      displayName: r.displayName || r.id,
      role: r.role || 'team-member',
      kind: r.kind || 'agent',
      ...(r.kind === 'pr-review' && r.review ? { review: r.review } : {}),
      sessionPolicy: r.sessionPolicy || 'persistent',
      environmentId: null,
      systemPrompt: r.systemPrompt || '',
      triggers: asArray(r.triggers),
      // Unified editing (#367): roles may carry data-flow ports + dependencies.
      inputs: asArray(r.inputs),
      outputs: asArray(r.outputs),
      dependsOn: asArray(r.dependsOn),
    })),
    edges: [],
    gates: asArray(b.gates),
    labels: asArray(b.labels),
  };
}

// bp-explorer /api/briefings (list of parsed brief.md) → UnifiedFlow. Leaf BPs
// become nodes; `depends_on` and `artifacts` drive dependency/artifact edges at
// build time. `status` is dropped (decision 2); parent BPs are not work-units.
function briefingsToUnified(bps, { name = 'briefings' } = {}) {
  const nodes = [];
  for (const bp of asArray(bps)) {
    if (!bp || typeof bp.id !== 'string' || !bp.id) continue;
    const isParent = bp.is_parent === true
      || (Array.isArray(bp.children) && bp.children.length > 0);
    if (isParent) continue; // only leaf BPs are units of work that can react
    const artifacts = asArray(bp.artifacts);
    nodes.push({
      id: bp.id,
      displayName: bp.title || bp.slug || bp.id,
      role: 'bp-instance',
      kind: 'agent',
      sessionPolicy: 'persistent',
      environmentId: null,
      systemPrompt: '',
      triggers: [],
      inputs: artifacts.filter(a => a && a.direction === 'input'),
      outputs: artifacts.filter(a => a && a.direction === 'output'),
      dependsOn: asArray(bp.depends_on),
      // NOTE: bp.status intentionally not carried.
    });
  }
  return {
    unifiedFlowVersion: UNIFIED_FLOW_VERSION,
    name,
    level: 'live',
    nodes,
    edges: [],
    gates: [],
    labels: [],
  };
}

// UnifiedFlow → process-template bundle, so the existing /api/teams
// materialisation path (templateToCustomRoles) keeps working unchanged.
// Dependency/artifact edges are not materialised here — that is Phase 4 (#368);
// this adapter round-trips the Process-expressible structure.
function unifiedToProcessTemplate(flow) {
  const f = flow || {};
  const bundle = buildProcessTemplate({
    name: f.name,
    level: f.level,
    roles: asArray(f.nodes).map(n => ({
      id: n.id,
      displayName: n.displayName,
      role: n.role,
      ...(n.kind === 'pr-review' ? { kind: 'pr-review', review: n.review } : {}),
      sessionPolicy: n.sessionPolicy,
      systemPrompt: n.systemPrompt,
      triggers: asArray(n.triggers),
    })),
    gates: asArray(f.gates),
    labels: asArray(f.labels),
  });
  // buildProcessTemplate emits a fixed role shape; re-attach the BP data-flow
  // ports + dependencies so the round-trip is loss-free (#367).
  const nodeById = new Map(asArray(f.nodes).map(n => [n.id, n]));
  bundle.roles = bundle.roles.map(r => {
    const n = nodeById.get(r.id) || {};
    const extra = {};
    if (asArray(n.inputs).length) extra.inputs = n.inputs;
    if (asArray(n.outputs).length) extra.outputs = n.outputs;
    if (asArray(n.dependsOn).length) extra.dependsOn = n.dependsOn;
    return { ...r, ...extra };
  });
  return bundle;
}

module.exports = {
  buildUnifiedGraph,
  computeDataflowLints,
  processTemplateToUnified,
  briefingsToUnified,
  unifiedToProcessTemplate,
  UNIFIED_FLOW_VERSION,
};
