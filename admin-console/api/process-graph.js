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
      for (const k of listenKeys(t)) { allListenKeys.add(k); noteLabel(k); }
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
      for (const key of listenKeys(t)) {
        const kind = classifyKind(key);
        if (kind === 'gate') gateSet.add(key);
        if (kind === 'gate' || kind === 'brake') {
          // No agent may emit these — the edge comes from outside (a human).
          edges.push({ from: null, to: n.id, label: key, kind, triggerId: t.id });
          continue;
        }
        const emitters = [...(emitIndex.get(key) || [])];
        if (emitters.length === 0) {
          // Orphan listener: nothing emits this label. Represented from null so
          // the lint layer (#333) can flag it; the renderer shows a dangling in.
          edges.push({ from: null, to: n.id, label: key, kind, triggerId: t.id, orphan: true });
        } else {
          for (const s of emitters) {
            edges.push({ from: s, to: n.id, label: key, kind, triggerId: t.id });
          }
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

  return { nodes, edges, gates, labels };
}

module.exports = { buildProcessGraph, listenKeys, classifyKind, isHumanGate, isBrake };
