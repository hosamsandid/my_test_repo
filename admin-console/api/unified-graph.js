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
//   'event'      — raw GitHub event wakes B (from the @github actor)    (Process)
//   'timer'      — cron/once schedule (from the @timer actor)           (Process)
//   'webhook'    — http trigger fired by a third party (@external)      (Process)
//   'review'     — PR-review flow (in / approve / changes)             (Process)
//   'dependency' — B depends_on A (readiness/ordering)                  (BP)
//   'artifact'   — A's output path is B's input path (data flow)        (BP)
//   'manual'     — operator-declared hand-off (explicit input edge)     (BP hand-off)
//
// Human-approval gates are an orthogonal `gate: 'human'` flag on the edge,
// not a separate edge type. BP `status` is intentionally NOT modeled (decision 2).
//
// Actor nodes (#410, reduced). Everything that can start an agent but is not
// itself an agent is a first-class *actor* pseudo-node (kind: 'actor'): GitHub
// (@github — raw events AND human-set labels/gates/brakes, since a human acts
// through GitHub labels anyway) and third-party systems (@external — webhooks).
// The scheduler keeps emitting `on:'timer'` edges from @timer for data
// consumers, but the canvas renders schedules inside the agent card instead of
// as an actor; the former @human actor is folded into @github. Every trigger
// edge therefore runs source → agent; nothing originates from `null` except
// true orphan listeners (which the renderer drops and the lints flag).
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
  artifactKey,
} = require('./process-template');

const UNIFIED_FLOW_VERSION = 1;

// Actor pseudo-node ids (#410) — stable, and safely outside the agent-id
// charset (agent ids never start with '@').
const ACTORS = {
  github: '@github',
  external: '@external',
  timer: '@timer',
};
const ACTOR_META = {
  [ACTORS.github]: { actor: 'github', displayName: 'GitHub' },
  [ACTORS.external]: { actor: 'external', displayName: 'External system' },
  [ACTORS.timer]: { actor: 'timer', displayName: 'Schedule' },
};
function isActorId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ACTOR_META, id);
}

// ── small pure helpers ───────────────────────────────────────────────────────

function asArray(x) { return Array.isArray(x) ? x : []; }

// Stable, deterministic edge id so re-builds and the renderer agree.
function edgeId(e) {
  const tail = e.label != null ? e.label
    : (Array.isArray(e.events) ? e.events.join(',')
      : (Array.isArray(e.paths) ? e.paths.join(',') : ''));
  // GitHub channels between the same pair are distinct per artifact (PR vs issue).
  const kind = e.on === 'github' ? `github:${e.artifact || 'pr'}` : e.on;
  // Trigger-backed edges are one-edge-per-trigger — key them by the trigger so
  // two triggers on the same agent never collapse into one edge. For label
  // edges this keeps e.g. "wake when L is added" and "wake when L is removed"
  // (two triggers on the same label) as two independently editable edges.
  const trig = (e.triggerId && (e.on === 'event' || e.on === 'webhook' || e.on === 'timer' || e.on === 'label'))
    ? `#${e.triggerId}` : '';
  return `${kind}|${e.from == null ? '∅' : e.from}→${e.to == null ? '∅' : e.to}|${tail}${trig}`;
}

// Output / input artifact match keys declared on a UnifiedNode. An artifact is
// matched by its logical name when it has one, else by its path (#382) — so
// agent artifacts with variable paths connect by name while BriefingPack
// artifacts (path only) connect by path exactly as before.
function outputPaths(node) {
  const out = new Set();
  for (const a of asArray(node.outputs)) {
    const k = artifactKey(a);
    if (k) out.add(k);
  }
  return out;
}
function inputPaths(node) {
  const out = new Set();
  for (const a of asArray(node.inputs)) {
    const k = artifactKey(a);
    if (k) out.add(k);
  }
  return out;
}

// Translate a buildProcessGraph edge (kind-discriminated) into a UnifiedEdge
// (on-discriminated). Returns null for edges we drop.
function processEdgeToUnified(e) {
  if (e.kind === 'timer') {
    const schedule = /^[\d*]/.test(String(e.label)) || String(e.label).includes(' ')
      ? { cron: e.label } : { at: e.label };
    // The scheduler is the source (#410) — no more self-loop.
    return { from: ACTORS.timer, to: e.to, on: 'timer', label: e.label, schedule, triggerId: e.triggerId };
  }
  if (e.kind === 'webhook') {
    // http trigger — fired by an external system via the webhook server (#410).
    return { from: ACTORS.external, to: e.to, on: 'webhook', label: e.label, triggerId: e.triggerId };
  }
  if (e.kind === 'review') {
    return {
      from: e.from, to: e.to, on: 'review', label: e.label,
      ...(e.reviewFlow ? { reviewFlow: e.reviewFlow } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
    };
  }
  if (e.external) {
    // Raw GitHub event — the repo itself is the source (#410).
    return { from: ACTORS.github, to: e.to, on: 'event', events: [e.label], triggerId: e.triggerId, external: true };
  }
  // 'agent' label wiring, plus gate/brake (human-only) edges. The carrying
  // label events (issue/PR × added/removed) ride along for display.
  const u = { from: e.from, to: e.to, on: 'label', label: e.label, triggerId: e.triggerId };
  if (Array.isArray(e.events) && e.events.length) u.events = e.events;
  if (e.kind === 'gate' || e.kind === 'brake' || isHumanGate(e.label) || isBrake(e.label)) {
    u.gate = 'human';
  }
  // Human-approval gates and brakes have no agent emitter (from: null in the
  // process graph); a human acts on them through a GitHub label, so they
  // originate at the @github actor. (Source/origin filters were removed, so
  // there is no longer any per-trigger `from`-based human inference for plain,
  // non-gate labels — those simply stay orphans.)
  if (u.from == null && u.gate === 'human') u.from = ACTORS.github;
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

  // Output nodes = Process node view enriched with the BP data-flow ports,
  // the expandable content/prompt, and the parent-child hierarchy (#362 UI).
  const outNodes = list.map(n => {
    const base = pgNodeById.get(n.id) || { id: n.id };
    return {
      ...base,
      inputs: asArray(n.inputs),
      outputs: asArray(n.outputs),
      dependsOn: asArray(n.dependsOn),
      content: typeof n.content === 'string' ? n.content : (n.systemPrompt || ''),
      parent: n.parent || null,
      children: asArray(n.children),
      isParent: n.isParent === true || asArray(n.children).length > 0,
      stage: typeof n.stage === 'string' ? n.stage : '',  // own stage (#362 E)
      // GitHub artifact ports (#380): produce flags for the node badge/ports;
      // channels drive the on:'github' edges below.
      github: (n.github && (n.github.producesPr || n.github.producesIssue))
        ? { ...(n.github.producesPr ? { producesPr: true } : {}), ...(n.github.producesIssue ? { producesIssue: true } : {}) }
        : null,
      channels: asArray(n.channels),
    };
  });

  // Effective stage: a node inherits its parent's stage by default and may
  // override it with its own (#362). Walked up the parent chain (cycle-safe).
  const byIdForStage = new Map(outNodes.map(n => [n.id, n]));
  const resolveStage = (n, seen) => {
    if (n.stage) return n.stage;
    if (!n.parent || seen.has(n.id)) return '';
    const p = byIdForStage.get(n.parent);
    if (!p) return '';
    seen.add(n.id);
    return resolveStage(p, seen);
  };
  outNodes.forEach(n => { n.effectiveStage = resolveStage(n, new Set()); });

  // Derive children from parent pointers so the parent-child hierarchy survives
  // a round-trip through the bundle (which persists only `parent`, the single
  // source of truth). Union with any explicitly-supplied children
  // (briefingsToUnified passes bp.children).
  const childrenByParent = new Map();
  for (const n of outNodes) {
    if (n.parent && nodeIds.has(n.parent) && n.parent !== n.id) {
      if (!childrenByParent.has(n.parent)) childrenByParent.set(n.parent, []);
      childrenByParent.get(n.parent).push(n.id);
    }
  }
  outNodes.forEach(n => {
    const derived = childrenByParent.get(n.id) || [];
    n.children = [...new Set([...asArray(n.children), ...derived])];
    n.isParent = n.isParent === true || n.children.length > 0;
  });

  const unifiedEdges = [];
  const seen = new Set();
  const push = (e) => {
    const id = edgeId(e);
    if (seen.has(id)) return null;
    seen.add(id);
    const stored = { id, ...e };
    unifiedEdges.push(stored);
    return stored;
  };

  // The process builder emits one edge per raw event; a trigger with several
  // events is still ONE trigger (one edit dialog, one 👁 toggle), so merge its
  // event edges into a single @github → agent edge carrying all events.
  const eventEdgeByTrigger = new Map(); // `${from}|${to}|${triggerId}` → edge
  for (const e of pg.edges) {
    const u = processEdgeToUnified(e);
    if (!u) continue;
    if (u.on === 'event' && u.triggerId) {
      const k = `${u.from}|${u.to}|${u.triggerId}`;
      const prior = eventEdgeByTrigger.get(k);
      if (prior) {
        prior.events = [...new Set([...(prior.events || []), ...(u.events || [])])];
        prior.id = edgeId(prior); // keep the id in sync with the merged events
        continue;
      }
      const stored = push(u);
      if (stored) eventEdgeByTrigger.set(k, stored);
      continue;
    }
    push(u);
  }

  // 1b) Hierarchy edges from node.parent (BP parent-child). View-only: the
  //     routing layer (resolve-handoffs) ignores `on:'parent'`, so parents are
  //     still not units of work — they only group their children visually.
  for (const n of list) {
    if (n.parent && nodeIds.has(n.parent) && n.parent !== n.id) {
      push({ from: n.parent, to: n.id, on: 'parent' });
    }
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

  // 3b) GitHub channel edges (#380): a consumer's `channels` port declares which
  //     producer's PR/issue it reacts to. Producer → consumer, tagged with the
  //     artifact, the optional routing label, and the optional human-approval
  //     gate (the inline gate the renderer draws on the edge).
  for (const n of list) {
    for (const ch of asArray(n.channels)) {
      if (!ch || !ch.from || ch.from === n.id) continue;
      const artifact = ch.artifact === 'issue' ? 'issue' : 'pr';
      push({
        from: ch.from, to: n.id, on: 'github', artifact,
        ...(ch.label ? { label: ch.label } : {}),
        ...(ch.gate === 'human' ? { gate: 'human' } : {}),
        ...(nodeIds.has(ch.from) ? {} : { orphan: true }),
      });
    }
  }

  // 4) Explicit input edges (manual hand-offs, operator-drawn). Never silently
  //    rewrite emits — these are operator-declared and pass straight through.
  for (const e of asArray(edges)) {
    if (!e || !e.on) continue;
    push({ ...e });
  }

  // 5) Actor pseudo-nodes (#410): append one node per actor that some edge
  //    references, so every trigger source is visible on the canvas. Views
  //    without trigger edges (BriefingPacks) naturally get none.
  const usedActors = new Set(unifiedEdges.map(e => e.from).filter(isActorId));
  for (const [id, meta] of Object.entries(ACTOR_META)) {
    if (!usedActors.has(id)) continue;
    outNodes.push({
      id, kind: 'actor', role: 'actor', actor: meta.actor, displayName: meta.displayName,
      sessionPolicy: null, environmentId: null, triggers: [], emits: [],
      inputs: [], outputs: [], dependsOn: [], content: '', parent: null,
      children: [], isParent: false, stage: '', effectiveStage: '',
      github: null, channels: [],
    });
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
      sessionPolicy: r.sessionPolicy || 'persistent',
      environmentId: null,
      systemPrompt: r.systemPrompt || '',
      // Content = the expandable prompt; for process roles it mirrors systemPrompt.
      content: r.systemPrompt || '',
      stage: typeof r.stage === 'string' ? r.stage : '',
      // Unified editing (#367): roles may carry data-flow ports + dependencies.
      inputs: asArray(r.inputs),
      outputs: asArray(r.outputs),
      dependsOn: asArray(r.dependsOn),
      // Parent-child hierarchy round-trips through the bundle (#377).
      parent: typeof r.parent === 'string' && r.parent ? r.parent : null,
      // Agent-level emitted labels (operator-declared label hand-offs).
      emits: asArray(r.emits),
      // GitHub artifact ports (#380): produce flags + consumed channels.
      github: (r.github && (r.github.producesPr || r.github.producesIssue)) ? r.github : null,
      channels: asArray(r.channels),
      triggers: asArray(r.triggers),
    })),
    edges: [],
    gates: asArray(b.gates),
    labels: asArray(b.labels),
  };
}

// bp-explorer /api/briefings (list of parsed brief.md) → UnifiedFlow. ALL BPs
// become nodes — parents are kept as grouping nodes so the viewer can show the
// parent-child hierarchy (the BP-Explorer look). `depends_on` + `artifacts`
// drive dependency/artifact edges, `parent` drives a hierarchy edge, and the
// `brief.md` body becomes the node's expandable `content`. `status` is dropped
// (decision 2). Hierarchy is view-only — resolve-handoffs ignores parents, so
// they remain non-work-units for routing.
function briefingsToUnified(bps, { name = 'briefings' } = {}) {
  const nodes = [];
  for (const bp of asArray(bps)) {
    if (!bp || typeof bp.id !== 'string' || !bp.id) continue;
    const children = asArray(bp.children);
    const isParent = bp.is_parent === true || children.length > 0;
    const artifacts = asArray(bp.artifacts);
    nodes.push({
      id: bp.id,
      displayName: bp.title || bp.slug || bp.id,
      role: 'bp-instance',
      kind: 'agent',
      sessionPolicy: 'persistent',
      environmentId: null,
      systemPrompt: '',
      // The brief.md body is the node's expandable content/prompt.
      content: typeof bp.body === 'string' ? bp.body : '',
      stage: typeof bp.stage === 'string' ? bp.stage : '',
      triggers: [],
      inputs: artifacts.filter(a => a && a.direction === 'input'),
      outputs: artifacts.filter(a => a && a.direction === 'output'),
      dependsOn: asArray(bp.depends_on),
      parent: typeof bp.parent === 'string' && bp.parent ? bp.parent : null,
      children,
      isParent,
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
      // "Content = the prompt": BP nodes carry the brief.md body in `content`
      // with an empty systemPrompt, so fall back to content on import (#377).
      systemPrompt: n.systemPrompt || n.content || '',
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
    if (n.stage) extra.stage = n.stage;
    if (n.parent) extra.parent = n.parent;
    if (asArray(n.emits).length) extra.emits = n.emits;
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
  ACTORS,
  isActorId,
  UNIFIED_FLOW_VERSION,
};
