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
      displayName: a.displayName || a.id,
      sessionPolicy: a.sessionPolicy || 'persistent',
      environmentId: a.environmentId || null,
      triggers,
      // DM-only front door: nothing wakes it from git, it talks to a human.
      isEntryPoint: !hasGithubEvent,
    };
  });

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

  for (const n of nodes) {
    for (const t of n.triggers) {
      for (const e of t.emits) {
        if (!emitIndex.has(e)) emitIndex.set(e, new Set());
        emitIndex.get(e).add(n.id);
        noteLabel(e);
      }
      const lk = labelListenKey(t);
      if (lk) { allListenKeys.add(lk); noteLabel(lk); }
    }
  }

  const edges = [];
  const gateSet = new Set();

  for (const n of nodes) {
    for (const t of n.triggers) {
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
  for (const n of nodes) {
    if (n.synthetic) continue;
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
