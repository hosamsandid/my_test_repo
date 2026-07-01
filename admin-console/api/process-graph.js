'use strict';

// ─── process-graph (Process Canvas, #329) ────────────────────────────────────
//
// Pure, side-effect-free builder that turns a list of agents (each with its
// triggers) into the orchestration graph the Process Canvas renders. No file or
// network I/O lives here — the HTTP endpoint in api.js gathers agents/templates
// and computes each trigger's *effective* emits (persisted `emits`, or a
// heuristic fallback for the template preview), then hands them to this builder.
//
// Edge model: a trigger *listens* on a key (a label via `labelFilter`, or an
// event name when it has none). A trigger *emits* labels (its `emits` array).
// An edge S→T with label L exists when some trigger of S emits L and some
// trigger of T listens on L. Labels only a human can set (`human:*`) and the
// universal brakes (`hold`, `needs:human`) have no agent emitter — their edges
// originate from `null` and are tagged so the renderer can colour them.

const BRAKES = new Set(['hold', 'needs:human']);

function isHumanGate(label) {
  return typeof label === 'string' && label.startsWith('human:');
}
function isBrake(label) {
  return BRAKES.has(label);
}

// The keys a trigger reacts to. A github-event trigger with a labelFilter reacts
// to that one label (the carrying event — issues.labeled — is implied, so we do
// not also emit an edge for it). Without a labelFilter it reacts to its raw
// event names. cron/once react to nothing external (handled as timers).
function listenKeys(trigger) {
  if (!trigger || trigger.type !== 'github-event') return [];
  if (typeof trigger.labelFilter === 'string' && trigger.labelFilter.trim()) {
    return [trigger.labelFilter.trim()];
  }
  return Array.isArray(trigger.events) ? trigger.events.slice() : [];
}

// The single label a github-event trigger filters on, or null when it reacts to
// raw events. Only label keys participate in agent→agent wiring and orphan
// detection; raw events come from external actors (GitHub), not agent `emits`.
function labelListenKey(trigger) {
  if (!trigger || trigger.type !== 'github-event') return null;
  return (typeof trigger.labelFilter === 'string' && trigger.labelFilter.trim())
    ? trigger.labelFilter.trim() : null;
}

// The routing labels a node listens on through its GitHub channels (#380). A
// channel without a label reacts to the raw PR/issue open (no label routing),
// so it contributes no label-listen key.
function channelLabels(node) {
  const out = [];
  for (const ch of (node && Array.isArray(node.channels) ? node.channels : [])) {
    if (ch && typeof ch.label === 'string' && ch.label.trim()) out.push(ch.label.trim());
  }
  return out;
}

function classifyKind(key) {
  if (isHumanGate(key)) return 'gate';
  if (isBrake(key)) return 'brake';
  if (typeof key === 'string' && key.startsWith('pull_request_review')) return 'review';
  return 'agent';
}

// Slim, render-ready view of a trigger.
function triggerView(t) {
  const v = { id: t.id, type: t.type, enabled: t.enabled !== false };
  if (t.type === 'github-event') {
    v.events = Array.isArray(t.events) ? t.events : [];
    if (t.from) v.from = t.from;
    if (t.labelFilter) v.labelFilter = t.labelFilter;
  } else if (t.type === 'cron') {
    v.cron = t.cron || null;
  } else if (t.type === 'once') {
    v.at = t.at || null;
  }
  v.emits = Array.isArray(t.emits) ? t.emits.slice() : [];
  if (t.emitsDerived) v.emitsDerived = true; // heuristic, not operator-confirmed
  if (t.channel) v.channel = true; // derived GitHub-channel trigger (#380)
  if (t.dataFlow) v.dataFlow = true; // derived data-flow push trigger (#379)
  return v;
}

/**
 * Build the orchestration graph.
 *
 * @param {Array} agents - [{ id, role, displayName, sessionPolicy,
 *   environmentId, triggers: [{ id, type, events, labelFilter, from, cron, at,
 *   emits, emitsDerived }] }]. `emits` must already be the effective set.
 * @returns {{ nodes, edges, gates, labels }}
 */
function buildProcessGraph(agents) {
  const list = Array.isArray(agents) ? agents : [];

  const nodes = list.map(a => {
    const triggers = (a.triggers || []).map(triggerView);
    const hasGithubEvent = triggers.some(t => t.type === 'github-event');
    return {
      id: a.id,
      role: a.role || 'agent',
      kind: a.kind || 'agent', // 'pr-review' (#347) renders distinctly
      displayName: a.displayName || a.id,
      sessionPolicy: a.sessionPolicy || 'persistent',
      environmentId: a.environmentId || null,
      triggers,
      // Agent-level emitted labels (operator-declared): the labels this agent
      // sets during its work, independent of which trigger run does it. Lets a
      // label hand-off be wired from the edge alone, without attaching the emit
      // to a pre-existing trigger.
      emits: Array.isArray(a.emits) ? a.emits.filter(e => typeof e === 'string' && e) : [],
      // GitHub artifact ports (#380): produce flags drive the node badge/ports;
      // the consumed channels drive the on:'github' edges (built in unified-graph
      // from these ports, not from the derived triggers).
      github: (a.github && (a.github.producesPr || a.github.producesIssue))
        ? { ...(a.github.producesPr ? { producesPr: true } : {}), ...(a.github.producesIssue ? { producesIssue: true } : {}) }
        : null,
      channels: Array.isArray(a.channels) ? a.channels : [],
      // DM-only front door: nothing wakes it from git, it talks to a human.
      isEntryPoint: !hasGithubEvent,
    };
  });
  const nodeIds = new Set(nodes.map(n => n.id));

  // label -> Set(agentId) that emits it
  const emitIndex = new Map();
  // every label/key referenced anywhere, for the registry + dead-end detection
  const allListenKeys = new Set();
  const labelMeta = new Map(); // name -> { humanGate, brake }

  const noteLabel = (name) => {
    if (!labelMeta.has(name)) {
      labelMeta.set(name, { humanGate: isHumanGate(name), brake: isBrake(name) });
    }
  };

  const addEmit = (label, agentId) => {
    if (!emitIndex.has(label)) emitIndex.set(label, new Set());
    emitIndex.get(label).add(agentId);
    noteLabel(label);
  };
  for (const n of nodes) {
    // Agent-level emits (operator-declared on the agent, no trigger needed).
    for (const e of n.emits) addEmit(e, n.id);
    for (const t of n.triggers) {
      // Derived GitHub-channel triggers (#380) are represented by the on:'github'
      // edges built from the channel ports (unified-graph) — never as label/event
      // edges here, so their labelFilter must not register as a listen key.
      if (t.channel) continue;
      for (const e of t.emits) addEmit(e, n.id);
      const lk = labelListenKey(t);
      if (lk) { allListenKeys.add(lk); noteLabel(lk); }
    }
    // A GitHub channel with a routing label makes the consumer a *label listener*
    // for that label (#380 + #401): the channel's pinned `from` is drawn as the
    // on:'github' edge, but the label is also set by any other emitter (e.g. a
    // companion/escalation router routing rework back), so it must register as a
    // listen key here — otherwise every such emit is a false dead-end and the
    // feedback edges never appear.
    for (const ch of channelLabels(n)) { allListenKeys.add(ch); noteLabel(ch); }
  }

  const edges = [];
  const gateSet = new Set();

  for (const n of nodes) {
    for (const t of n.triggers) {
      if (t.channel) continue; // GitHub-channel edges come from the ports (#380)
      if (t.type === 'cron' || t.type === 'once') {
        edges.push({
          from: n.id, to: n.id,
          label: t.type === 'cron' ? (t.cron || 'cron') : (t.at || 'once'),
          kind: 'timer', triggerId: t.id,
        });
        continue;
      }
      const key = labelListenKey(t);
      if (key) {
        // Label listener — participates in agent→agent wiring.
        const kind = classifyKind(key);
        if (kind === 'gate') gateSet.add(key);
        if (kind === 'gate' || kind === 'brake') {
          // No agent may emit these — the edge comes from outside (a human).
          edges.push({ from: null, to: n.id, label: key, kind, triggerId: t.id });
        } else {
          const emitters = [...(emitIndex.get(key) || [])];
          if (emitters.length === 0) {
            // Orphan listener: nothing emits this label. Represented from null so
            // the lint layer flags it; the renderer shows a dangling-in node.
            edges.push({ from: null, to: n.id, label: key, kind, triggerId: t.id, orphan: true });
          } else {
            for (const s of emitters) {
              edges.push({ from: s, to: n.id, label: key, kind, triggerId: t.id });
            }
          }
        }
      } else {
        // Raw GitHub events (no label filter) come from external actors, not
        // agent emits — record as external (renderer drops, lints ignore).
        for (const ev of (Array.isArray(t.events) ? t.events : [])) {
          edges.push({ from: null, to: n.id, label: ev, kind: classifyKind(ev), triggerId: t.id, external: true });
        }
      }
    }
  }

  // Channel-label hand-offs (#401). A GitHub channel with a routing label makes
  // its consumer a label listener. The pinned `from` producer is already drawn
  // as the on:'github' edge (built in unified-graph from the port), so here we
  // only wire the *other* emitters of that label — the rework/feedback loops
  // (e.g. a companion/escalation router re-applying the label to send work back)
  // that a single-producer channel cannot express. Without this they collapse to
  // dead-ends and the renderer drops them.
  for (const n of nodes) {
    for (const ch of (n.channels || [])) {
      const label = (ch && typeof ch.label === 'string') ? ch.label.trim() : '';
      if (!label) continue;
      const kind = classifyKind(label);
      if (kind === 'gate' || kind === 'brake') continue; // human-set, edge comes from null
      for (const s of (emitIndex.get(label) || [])) {
        if (s === n.id || s === ch.from) continue; // self / already the github edge
        edges.push({ from: s, to: n.id, label, kind });
      }
    }
  }

  // Dead-end emitters: a label emitted but no trigger listens on it.
  for (const [label, emitters] of emitIndex) {
    if (isHumanGate(label) || isBrake(label)) continue;
    if (!allListenKeys.has(label)) {
      for (const s of emitters) {
        edges.push({ from: s, to: null, label, kind: classifyKind(label), deadEnd: true });
      }
    }
  }

  const gates = [...gateSet].sort().map(label => ({ label, humanOnly: true }));
  const labels = [...labelMeta.keys()].sort().map(name => ({ name, ...labelMeta.get(name) }));

  return { nodes, edges, gates, labels, lints: computeLints(nodes, edges) };
}

// Advisory wiring checks (#333) — surfaced as a panel + inline badges, never
// block saving. Derived purely from the built nodes/edges.
function computeLints(nodes, edges) {
  const lints = [];
  for (const e of edges) {
    if (e.orphan) {
      lints.push({ code: 'orphan-listener', severity: 'warning', label: e.label, nodeId: e.to,
        message: `\`${e.to}\` listens on \`${e.label}\` but no agent emits it.` });
    }
    if (e.deadEnd) {
      lints.push({ code: 'dead-end-emitter', severity: 'warning', label: e.label, nodeId: e.from,
        message: `\`${e.from}\` emits \`${e.label}\` but nothing listens on it.` });
    }
  }
  // GitHub-channel wiring checks (#380). A producer whose PR/issue nobody
  // consumes, and a channel that points at a role which doesn't produce that
  // artifact, are both advisory smells.
  const consumedArtifactsByProducer = new Map(); // producerId -> Set(artifact)
  for (const n of nodes) {
    for (const ch of (n.channels || [])) {
      if (!ch || !ch.from) continue;
      if (!consumedArtifactsByProducer.has(ch.from)) consumedArtifactsByProducer.set(ch.from, new Set());
      consumedArtifactsByProducer.get(ch.from).add(ch.artifact === 'issue' ? 'issue' : 'pr');
    }
  }
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.synthetic) continue;
    const gh = n.github || {};
    const consumed = consumedArtifactsByProducer.get(n.id) || new Set();
    if (gh.producesPr && !consumed.has('pr')) {
      lints.push({ code: 'producer-unconsumed', severity: 'info', nodeId: n.id,
        message: `\`${n.id}\` opens pull requests but no agent consumes them.` });
    }
    if (gh.producesIssue && !consumed.has('issue')) {
      lints.push({ code: 'producer-unconsumed', severity: 'info', nodeId: n.id,
        message: `\`${n.id}\` opens issues but no agent consumes them.` });
    }
    for (const ch of (n.channels || [])) {
      if (!ch || !ch.from) continue;
      const prod = nodeById.get(ch.from);
      const artifact = ch.artifact === 'issue' ? 'issue' : 'pr';
      const producesIt = prod && prod.github && (artifact === 'pr' ? prod.github.producesPr : prod.github.producesIssue);
      if (prod && !producesIt) {
        lints.push({ code: 'channel-from-non-producer', severity: 'warning', nodeId: n.id, label: ch.from,
          message: `\`${n.id}\` consumes a ${artifact === 'pr' ? 'PR' : 'issue'} from \`${ch.from}\`, which isn't marked as opening ${artifact === 'pr' ? 'PRs' : 'issues'}.` });
      }
    }
    const stageEmits = new Set();
    for (const t of n.triggers || []) {
      if (t.type === 'github-event' && !t.from) {
        lints.push({ code: 'unguarded-self-trigger', severity: 'warning', nodeId: n.id, triggerId: t.id,
          message: `Trigger \`${t.id}\` on \`${n.id}\` has no origin filter (\`from\`) — self-loop risk.` });
      }
      for (const lbl of t.emits || []) {
        if (isHumanGate(lbl)) {
          lints.push({ code: 'gate-violation', severity: 'error', nodeId: n.id, label: lbl, triggerId: t.id,
            message: `\`${n.id}\` declares emit of gate label \`${lbl}\` — only humans may set it.` });
        }
        if (lbl.startsWith('stage:')) stageEmits.add(lbl);
      }
    }
    if (stageEmits.size > 1) {
      lints.push({ code: 'competing-stage', severity: 'warning', nodeId: n.id,
        message: `\`${n.id}\` emits multiple stage labels: ${[...stageEmits].join(', ')}.` });
    }
  }
  return lints;
}

module.exports = { buildProcessGraph, computeLints, listenKeys, classifyKind, isHumanGate, isBrake };
