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
// trigger of T listens on L. Labels only a human can set (human gates) and
// brake labels have no agent-wired listener edge — their edges originate from
// `null` and are tagged so the renderer can colour them.
//
// The one caveat to "T listens on L → edge exists": a `channel: true` trigger
// (#380) is a listener DERIVED from a `channels` port, whose edge is the
// on:'github' PORT edge drawn in unified-graph — so it is not re-drawn here as
// a label edge, to avoid a double edge on the unified canvas. That exclusion is
// only valid while the backing port still exists. A `channel: true` trigger
// carrying a `labelFilter` that matches NO channel-port label on the same node
// is NOT a live derived listener (a genuine one's labelFilter always equals one
// of its consumer's channel labels — see expandGithubChannels): it is a listener
// installed post-hoc via POST /api/agents/:id/triggers that copied the derived
// shape, or an orphan a reconcile has yet to strip. Such a trigger wires as an
// ordinary label listener — otherwise its producer's emit renders as a false
// dead-end even though emits + labelFilter match (#1524). Unlabelled channel
// triggers (PR/issue open, no labelFilter) stay excluded — they are pure
// artifact listeners whose only edge is the port edge.

// Structured OUTCOMES port (#827): the successor to flat `emits`. Legacy agents
// (flat `emits`, no `outcomes`) are untouched below and yield byte-identical
// edges; an authored `outcomes` port projects its `setLabel` labels into the
// same emit index (now keyed by outcome) and its `openPr`/`openIssue` actions
// into the github produce flags. `require`d at top is safe — outcomes.js only
// requires this module lazily (inside function bodies), so there is no
// load-time cycle.
const {
  isAuthoredOutcomes, normalizeOutcomes, outcomeEmitPairs, outcomeSetLabels, outcomesToGithub,
  // #2031: the `{to, note?, outcome}` triples a port hands off directly — the
  // wake-edge index, the sibling of `outcomeEmitPairs`.
  outcomeWakePairs,
} = require('./outcomes');
// Claim-label convention (#958) — the suffix is defined once, in process-template,
// so the lint below can never drift from what the expanders derive. Acyclic:
// process-template requires only ./outcomes, never this module.
const { CLAIM_SUFFIX, rawTriggerError } = require('./process-template');

// ─── gate/brake classification (#928) ────────────────────────────────────────
//
// Gate-ness and brake-ness are CONFIGURATION, not a naming convention. The
// authoritative sources are the persisted flags:
//
//   labels:   [ { name, humanGate: true } ]      → the label is a human gate
//             [ { name, brake: true } ]          → the label pauses the loop
//   channels: [ { label, gate: 'human' } ]       → that routing label is a gate
//
// The former `human:*` prefix match and the hardcoded `hold`/`needs:human`
// brake set are GONE as a classification source (#901 decision D3): a label
// carrying neither a registry flag nor a channel gate flag is a plain agent
// label, whatever it is called. That is what lets the vocabulary rename (#927)
// give human-applied labels ordinary action-style names (`approved-for-dispatch`).
//
// A human gate may not be set by an agent (`gate-violation` / the outcomes
// validator). A brake MAY be agent-applied — e.g. the reworker setting
// `human-decision-required` to pause the loop pending a human decision — so it
// is deliberately NOT forbidden as an emit/outcome.

/**
 * Build the authoritative gate/brake classifier from the config flags.
 *
 * @param {object} [sources]
 * @param {Array}  [sources.labels] - the bundle/team label registry:
 *   [{ name, humanGate?, brake? }]. Absent = no flags known.
 * @param {Array}  [sources.agents] - nodes/roles whose `channels[]` ports may
 *   carry `gate: 'human'` on a routing label. Read straight off the agents, so
 *   a channel gate classifies even when no `labels[]` registry is threaded in
 *   (imported drafts, the flow-weaver's `<prefix>:approved` boundaries).
 * @param {Array}  [sources.humans] - named human roles (#987). A label a human
 *   role `emits` is IMPLICITLY a gate (only a human may set it), even without a
 *   registry flag. The registry flag stays authoritative when present; on
 *   conflict the stricter gate wins — a human-emitted brake still classifies as
 *   a gate (a human decision, not an agent-appliable pause).
 * @returns {{ isHumanGate, isBrake, classifyKind, registryNames }}
 */
function makeLabelClassifier(sources) {
  const { labels, agents, humans } = sources || {};
  const gates = new Set();
  const brakes = new Set();
  const registryNames = [];
  for (const l of (Array.isArray(labels) ? labels : [])) {
    const name = (l && typeof l.name === 'string') ? l.name.trim() : '';
    if (!name) continue;
    registryNames.push(name);
    if (l.humanGate) gates.add(name);
    if (l.brake) brakes.add(name);
  }
  for (const a of (Array.isArray(agents) ? agents : [])) {
    for (const ch of (a && Array.isArray(a.channels) ? a.channels : [])) {
      if (!ch || ch.gate !== 'human') continue;
      const label = (typeof ch.label === 'string') ? ch.label.trim() : '';
      if (label) gates.add(label);
    }
  }
  // Human-role emits (#987) classify as gates — a person applies the label,
  // so no agent may. Added after brakes so the gate wins the classifyKind
  // precedence below even for a label the registry also flagged `brake`.
  for (const h of (Array.isArray(humans) ? humans : [])) {
    for (const e of (h && Array.isArray(h.emits) ? h.emits : [])) {
      const label = typeof e === 'string' ? e.trim() : '';
      if (label) gates.add(label);
    }
  }

  const isHumanGate = label => typeof label === 'string' && gates.has(label);
  const isBrake = label => typeof label === 'string' && brakes.has(label);
  // Gate wins over brake when a label carries both flags (a gate is the stricter
  // claim: no agent may set it), matching the old name-match precedence.
  const classifyKind = (key) => {
    if (isHumanGate(key)) return 'gate';
    if (isBrake(key)) return 'brake';
    if (typeof key === 'string' && key.startsWith('pull_request_review')) return 'review';
    return 'agent';
  };
  return { isHumanGate, isBrake, classifyKind, registryNames };
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

// Is this trigger a LIVE derived GitHub-channel listener (#380) — i.e. one whose
// edge is the on:'github' port edge drawn in unified-graph, so it must NOT be
// re-drawn here as a label/event edge? True for every `channel: true` trigger
// whose backing `channels` port still exists on the consumer node: an unlabelled
// channel listener (no `labelFilter`, reacts to PR/issue open), or a labelled one
// whose `labelFilter` matches one of the node's channel-port labels (`portLabels`).
// A `channel: true` trigger with a `labelFilter` that matches NO port label is
// NOT live-derived (post-hoc copy of the shape, or a not-yet-reconciled orphan) —
// it wires as an ordinary label listener so its producer's emit is not a false
// dead-end (#1524).
function isDerivedChannelListener(t, portLabels) {
  if (!t || t.channel !== true) return false;
  const lf = (typeof t.labelFilter === 'string' && t.labelFilter.trim()) ? t.labelFilter.trim() : '';
  if (!lf) return true; // unlabelled channel listener — always port-driven
  return portLabels instanceof Set && portLabels.has(lf);
}

// Convenience wrapper for a one-off classification: `classifyKind(key, sources)`
// builds a throw-away classifier from the same flag sources. Prefer
// `makeLabelClassifier(...).classifyKind` in a loop.
function classifyKind(key, sources) {
  return makeLabelClassifier(sources).classifyKind(key);
}

// Normalized `claim` (#958) for the graph, or null. Shared by triggerView and the
// label-listener edge builder so the node port and its edge never disagree.
function claimView(t) {
  const c = t && t.claim;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (typeof c.remove !== 'string' || !c.remove) return null;
  if (typeof c.add !== 'string' || !c.add) return null;
  return { remove: c.remove, add: c.add };
}

// Slim, render-ready view of a trigger.
function triggerView(t) {
  const v = { id: t.id, type: t.type, enabled: t.enabled !== false };
  if (t.type === 'github-event') {
    v.events = Array.isArray(t.events) ? t.events : [];
    if (t.labelFilter) v.labelFilter = t.labelFilter;
    // Claim (#958): what this listener takes over when it wakes. Carried so the
    // editor can render the claim badge and the read-only claim readout.
    const c = claimView(t);
    if (c) v.claim = c;
  } else if (t.type === 'cron') {
    v.cron = t.cron || null;
  } else if (t.type === 'once') {
    v.at = t.at || null;
  } else if (t.type === 'loop') {
    // Loop trigger (#932): a continuation primitive that re-arms itself until
    // `until.command` exits 0 or `maxIterations` is hit. Carry the stop-contract
    // summary so the graph view can render the self-edge + stop-contract badge
    // (#936).
    if (t.maxIterations != null) v.maxIterations = t.maxIterations;
    // Token budget (#934) — carried so the stop-contract badge can show it.
    if (t.maxTokens != null) v.maxTokens = t.maxTokens;
    if (t.until && typeof t.until === 'object'
        && typeof t.until.command === 'string' && t.until.command.trim()) {
      v.until = { command: t.until.command };
    }
    if (t.minGapSeconds != null) v.minGapSeconds = t.minGapSeconds;
    // Verifier gate summary (#933) so the graph view knows a separate check
    // exists — the stop-contract badge (#936) renders it. Only the shape is
    // surfaced (command presence / target agent), never the command string or
    // its env.
    if (t.verify && typeof t.verify === 'object') {
      if (typeof t.verify.command === 'string' && t.verify.command.trim()) {
        v.verify = { mode: 'command' };
      } else if (typeof t.verify.agentId === 'string' && t.verify.agentId.trim()) {
        v.verify = { mode: 'agent', agentId: t.verify.agentId };
      } else if (t.verify.flow === true) {
        // Flow hand-off: verification is delegated to the wired downstream
        // QS chain (no inline gate) — the badge renders it as `→ flow`.
        v.verify = { mode: 'flow' };
      } else if (t.verify.selfGraded === true) {
        v.verify = { mode: 'self-graded' };
      }
    }
  } else if (t.type === 'http') {
    // Webhook trigger (#410) — fired by an external system via HOOK_PORT. The
    // secret is intentionally not carried into the graph view.
    if (t.description) v.description = t.description;
  }
  // Trigger-level `emits` was removed (#783): the agent/role level (`n.emits`,
  // #414) is the canonical, sole source of label hand-off edges. A trigger no
  // longer carries or contributes emits — a supplied `t.emits` is ignored.
  if (t.channel) v.channel = true; // derived GitHub-channel trigger (#380)
  if (t.dataFlow) v.dataFlow = true; // derived data-flow push trigger (#379)
  // Consolidated-channel provenance (#826): which producers' channels share this
  // one derived listener. Informational — the on:'github' edges still come one
  // per channel port, mapped onto this shared listener.
  if (Array.isArray(t.sources) && t.sources.length) v.sources = t.sources.slice();
  return v;
}

// ─── named human roles (#987) ────────────────────────────────────────────────
//
// A human role is a first-class, purely declarative flow node: a named box
// ("Issue Reviewer", type Human) placed and wired on the canvas like an agent,
// but which never spawns anything — people keep acting through GitHub labels
// exactly as today. It carries `emits` (labels the person applies — implicitly
// gates) and `consumes` (what lands with the person: a brake label they decide
// on, or a PR/issue/file artifact they review). Binding these to the #981
// `@human`-actor edges reroutes each touchpoint onto the named node instead of
// the single generic hub; unbound touchpoints keep the generic `@human` actor.

// A consume entry is one of:
//   { label }                          — a brake label this person decides on
//   { artifact: 'pr'|'issue', from }    — an artifact they review
//   { artifact: 'file', name }          — a data-flow output they read
function normalizeConsumes(consumes) {
  const out = [];
  for (const c of (Array.isArray(consumes) ? consumes : [])) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    if (typeof c.label === 'string' && c.label.trim()) {
      out.push({ label: c.label.trim() });
    } else if (c.artifact === 'pr' || c.artifact === 'issue') {
      if (typeof c.from === 'string' && c.from.trim()) out.push({ artifact: c.artifact, from: c.from.trim() });
    } else if (c.artifact === 'file') {
      if (typeof c.name === 'string' && c.name.trim()) out.push({ artifact: 'file', name: c.name.trim() });
    }
  }
  return out;
}

// Synthesize the render-ready graph node for one human role. No triggers, no
// session policy — it is model + visualization only. `synthetic: true` keeps it
// out of every emit/lint loop (a human's `emits` are gates it is ALLOWED to set,
// so it must not trip gate-violation).
function humanNode(h) {
  const id = (h && typeof h.id === 'string') ? h.id.trim() : '';
  return {
    id,
    role: 'human',
    kind: 'human',
    displayName: (h && typeof h.name === 'string' && h.name.trim()) ? h.name.trim() : id,
    ...(h && typeof h.description === 'string' && h.description.trim() ? { description: h.description.trim() } : {}),
    sessionPolicy: null,
    environmentId: null,
    triggers: [],
    emits: (h && Array.isArray(h.emits)) ? h.emits.filter(e => typeof e === 'string' && e.trim()).map(e => e.trim()) : [],
    consumes: normalizeConsumes(h && h.consumes),
    github: null,
    channels: [],
    stage: (h && typeof h.stage === 'string') ? h.stage : '',
    synthetic: true,
    isEntryPoint: false,
  };
}

/**
 * Build the orchestration graph.
 *
 * @param {Array} agents - [{ id, role, displayName, sessionPolicy,
 *   environmentId, triggers: [{ id, type, events, labelFilter, from, cron, at,
 *   emits, emitsDerived }] }]. `emits` must already be the effective set.
 * @param {object} [options]
 * @param {Array}  [options.labels] - the authoritative label registry
 *   ([{ name, humanGate?, brake? }], #928): the bundle's `labels[]`, or the one
 *   persisted on the team agent for a live graph. Gate/brake classification
 *   reads these flags (plus each node's channel `gate: 'human'`) — never the
 *   label's name.
 * @param {Array}  [options.humans] - named human roles (#987):
 *   [{ id, name, description?, stage?, emits?, consumes? }]. Synthesized as
 *   `kind: 'human'` nodes; their `emits` classify as gates, and their `consumes`
 *   bind the #981 `@human` gate/brake/delivery edges to the named node.
 * @returns {{ nodes, edges, gates, labels }}
 */
function buildProcessGraph(agents, options) {
  const list = Array.isArray(agents) ? agents : [];
  const humanRoles = (options && Array.isArray(options.humans) ? options.humans : [])
    .map(humanNode).filter(h => h.id);
  // Authoritative gate/brake source (#928): the registry flags the caller
  // threads in, plus every channel port's `gate: 'human'`, plus each human
  // role's emits (#987 — implicitly gates).
  const classifierSources = { labels: options && options.labels, agents: list, humans: humanRoles };
  const classifier = makeLabelClassifier(classifierSources);
  const { isHumanGate, isBrake, classifyKind: classify } = classifier;

  // Binding indices (#987): which human role is on the far end of each #981
  // touchpoint. First matching human in `humans[]` order wins; a label emitted
  // by two humans yields both gate edges (so `humanEmitters` keeps a list).
  const humanEmitters = new Map();        // label -> [humanId, ...]
  const humanLabelConsumer = new Map();   // consumed label -> humanId (brake #987 / plain-label delivery #1197)
  const humanArtifactConsumer = new Map();// `${producerId}|${pr|issue}` -> humanId
  for (const h of humanRoles) {
    for (const e of h.emits) {
      if (!humanEmitters.has(e)) humanEmitters.set(e, []);
      humanEmitters.get(e).push(h.id);
    }
    for (const c of h.consumes) {
      if (c.label) { if (!humanLabelConsumer.has(c.label)) humanLabelConsumer.set(c.label, h.id); }
      else if (c.artifact === 'pr' || c.artifact === 'issue') {
        const k = `${c.from}|${c.artifact}`;
        if (!humanArtifactConsumer.has(k)) humanArtifactConsumer.set(k, h.id);
      }
      // `file` consumes bind a data-flow delivery — resolved in unified-graph
      // (which owns the output-artifact edges), not here.
    }
  }
  const humanIds = new Set(humanRoles.map(h => h.id));

  const nodes = list.map(a => {
    const triggers = (a.triggers || []).map(triggerView);
    const hasGithubEvent = triggers.some(t => t.type === 'github-event');
    // Structured outcomes (#827) supersede flat `emits` when authored: the emit
    // labels are the `setLabel` action labels, and the github produce flags fold
    // in the `openPr`/`openIssue` actions. A legacy agent (no authored outcomes)
    // takes the original code path verbatim, so its node — and every edge below
    // — is byte-identical to before.
    const authored = isAuthoredOutcomes(a.outcomes);
    const emits = authored
      ? outcomeSetLabels(a.outcomes, classifierSources)
      : (Array.isArray(a.emits) ? a.emits.filter(e => typeof e === 'string' && e) : []);
    const baseGh = a.github || {};
    const ocGh = authored ? outcomesToGithub(a.outcomes) : {};
    const producesPr = baseGh.producesPr || ocGh.producesPr;
    const producesIssue = baseGh.producesIssue || ocGh.producesIssue;
    // Artifact audience (#981): the producer declares that a person (not an
    // agent) consumes the PR/issue — review/merge is a human touchpoint, not a
    // wiring gap. Only the explicit 'human' value is carried; absent means
    // unspecified (today's behavior).
    const prAudience = producesPr && baseGh.prAudience === 'human' ? 'human' : null;
    const issueAudience = producesIssue && baseGh.issueAudience === 'human' ? 'human' : null;
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
      // to a pre-existing trigger. Projected from `outcomes` when authored (#827).
      emits,
      // GitHub artifact ports (#380): produce flags drive the node badge/ports;
      // the consumed channels drive the on:'github' edges (built in unified-graph
      // from these ports, not from the derived triggers).
      github: (producesPr || producesIssue)
        ? {
          ...(producesPr ? { producesPr: true } : {}),
          ...(producesIssue ? { producesIssue: true } : {}),
          ...(prAudience ? { prAudience } : {}),
          ...(issueAudience ? { issueAudience } : {}),
        }
        : null,
      channels: Array.isArray(a.channels) ? a.channels : [],
      // Structured OUTCOMES port (#827) — surfaced only when authored so a legacy
      // node stays byte-identical; phase 3 renders the switch/ports from this.
      ...(authored ? { outcomes: normalizeOutcomes(a.outcomes) } : {}),
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
  // Seed the registry's own entries (#928) so a flagged label survives the
  // graph round-trip (live team → `GET /api/process/template` → re-import) even
  // when no port references it yet — otherwise the flag that makes it a gate or
  // a brake would be silently dropped on export and the label would come back
  // as a plain agent label.
  for (const name of classifier.registryNames) noteLabel(name);

  const addEmit = (label, agentId) => {
    if (!emitIndex.has(label)) emitIndex.set(label, new Set());
    emitIndex.get(label).add(agentId);
    noteLabel(label);
  };
  for (const n of nodes) {
    // Agent-level emits (operator-declared on the agent) are the ONLY emit
    // source (#414/#783) — trigger-level emits were removed.
    for (const e of n.emits) addEmit(e, n.id);
    const portLabels = new Set(channelLabels(n));
    for (const t of n.triggers) {
      // Live derived GitHub-channel triggers (#380) are represented by the
      // on:'github' edges built from the channel ports (unified-graph) — never as
      // label/event edges here, so their labelFilter must not register as a listen
      // key. A `channel: true` trigger with no backing port is NOT one of those —
      // it wires as an ordinary label listener (#1524), so its labelFilter must
      // register here or the producer's emit becomes a false dead-end.
      if (isDerivedChannelListener(t, portLabels)) continue;
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

  // Outcome-keyed emit index (#827): label -> Map(agentId -> outcomeId), built
  // from AUTHORED outcomes only (a legacy agent leaves this empty, so its edges
  // gain no `outcome` field and stay byte-identical). `ocOf` annotates a label
  // edge with the id of the outcome whose `setLabel` action produced it.
  const outcomeByEmit = new Map();
  for (const a of list) {
    if (!isAuthoredOutcomes(a.outcomes)) continue;
    for (const { label, outcome } of outcomeEmitPairs(a.outcomes, classifierSources)) {
      if (!outcomeByEmit.has(label)) outcomeByEmit.set(label, new Map());
      const m = outcomeByEmit.get(label);
      if (!m.has(a.id)) m.set(a.id, outcome); // first outcome setting the label wins
    }
  }
  const ocOf = (label, agentId) => (outcomeByEmit.get(label) || new Map()).get(agentId);

  const edges = [];
  const gateSet = new Set();

  for (const n of nodes) {
    const portLabels = new Set(channelLabels(n));
    for (const t of n.triggers) {
      // Live derived channel edges come from the ports (#380); a `channel: true`
      // trigger with no backing port wires as an ordinary label listener (#1524).
      if (isDerivedChannelListener(t, portLabels)) continue;
      if (t.type === 'cron' || t.type === 'once') {
        edges.push({
          from: n.id, to: n.id,
          label: t.type === 'cron' ? (t.cron || 'cron') : (t.at || 'once'),
          kind: 'timer', triggerId: t.id,
        });
        continue;
      }
      if (t.type === 'loop') {
        // Loop trigger (#936): an agent re-arming itself until its stop contract
        // is met — the same self-edge shape as the cron `timer`, but a distinct
        // `kind: 'loop'` so the canvas draws it with a stop-contract badge
        // instead of a schedule row. Carry a render-ready summary (budget /
        // until / verifier) onto the edge; the command string and verifier
        // internals were already redacted by `triggerView`.
        const loop = {};
        if (t.maxIterations != null) loop.maxIterations = t.maxIterations;
        if (t.maxTokens != null) loop.maxTokens = t.maxTokens;
        if (t.until) loop.until = t.until;
        if (t.verify) loop.verify = t.verify;
        edges.push({ from: n.id, to: n.id, kind: 'loop', triggerId: t.id, loop });
        continue;
      }
      if (t.type === 'http') {
        // Webhook edge (#410): fired by an external system, so it originates
        // outside the agent set — unified-graph attaches it to the @external actor.
        edges.push({
          from: null, to: n.id,
          label: t.description || 'webhook',
          kind: 'webhook', triggerId: t.id,
        });
        continue;
      }
      const key = labelListenKey(t);
      if (key) {
        // Label listener — participates in agent→agent wiring. The carrying
        // events (issues/pull_request × labeled/unlabeled) ride along so the
        // renderer can show WHICH label change wakes the listener.
        const evs = Array.isArray(t.events) && t.events.length ? { events: t.events.slice() } : {};
        // Claim (#958) rides on the listener edge so the renderer can badge it.
        const cv = claimView(t);
        const clm = cv ? { claim: cv } : {};
        const kind = classify(key);
        if (kind === 'gate') gateSet.add(key);
        if (kind === 'gate' || kind === 'brake') {
          // No agent may emit these — the edge comes from outside (a human).
          // #987: when a named human role emits this gate label, the edge
          // originates at that role's node instead of the generic `@human`
          // actor; one edge per emitting human. Brakes are never human-emitted,
          // so they always come from `null`.
          const boundHumans = kind === 'gate' ? (humanEmitters.get(key) || []) : [];
          if (boundHumans.length) {
            for (const hid of boundHumans) {
              edges.push({ from: hid, to: n.id, label: key, kind, triggerId: t.id, ...evs, ...clm });
            }
          } else {
            edges.push({ from: null, to: n.id, label: key, kind, triggerId: t.id, ...evs, ...clm });
          }
        } else {
          const emitters = [...(emitIndex.get(key) || [])];
          if (emitters.length === 0) {
            // No agent emits this label. Without an origin filter we can't infer
            // whether a human sets it, so it's drawn as an orphan listener
            // (advisory lint) — a human applying the label still fires it at
            // runtime; this is only about what the static graph can prove.
            edges.push({ from: null, to: n.id, label: key, kind, triggerId: t.id, orphan: true, ...evs, ...clm });
          } else {
            for (const s of emitters) {
              const oc = ocOf(key, s);
              edges.push({ from: s, to: n.id, label: key, kind, triggerId: t.id, ...(oc ? { outcome: oc } : {}), ...evs, ...clm });
            }
          }
        }
      } else {
        // Raw GitHub events (no label filter) come from external actors, not
        // agent emits — record as external (renderer drops, lints ignore).
        for (const ev of (Array.isArray(t.events) ? t.events : [])) {
          edges.push({ from: null, to: n.id, label: ev, kind: classify(ev), triggerId: t.id, external: true });
        }
      }
    }
  }

  // Labels a node already listens on through an explicit `labelFilter` trigger.
  // The trigger loop above draws an edge from *every* emitter of such a label, so
  // the channel-label loop below must not redraw those emitters (#537).
  const triggerLabelListens = new Map(); // nodeId -> Set(label)
  for (const n of nodes) {
    const set = new Set();
    const portLabels = new Set(channelLabels(n));
    for (const t of n.triggers) {
      // Live derived channel triggers wire no label edges (#380); a channel:true
      // trigger with no backing port DOES wire one (#1524), so count it here too
      // — its label edge is drawn in the trigger loop above, and the channel-label
      // loop below must skip re-drawing that same label.
      if (isDerivedChannelListener(t, portLabels)) continue;
      const lk = labelListenKey(t);
      if (lk) set.add(lk);
    }
    triggerLabelListens.set(n.id, set);
  }

  // Channel-label hand-offs (#401). A GitHub channel with a routing label makes
  // its consumer a label listener. The pinned `from` producer is already drawn
  // as the on:'github' edge (built in unified-graph from the port), so here we
  // only wire the *other* emitters of that label — the rework/feedback loops
  // (e.g. a companion/escalation router re-applying the label to send work back)
  // that a single-producer channel cannot express. Without this they collapse to
  // dead-ends and the renderer drops them.
  for (const n of nodes) {
    const wiredByTrigger = triggerLabelListens.get(n.id) || new Set();
    for (const ch of (n.channels || [])) {
      const label = (ch && typeof ch.label === 'string') ? ch.label.trim() : '';
      if (!label) continue;
      // The consumer also listens on this label via an explicit `labelFilter`
      // trigger — the trigger loop already wired every emitter of it, so drawing
      // them again here yields a spurious duplicate edge (#537). The two survive
      // de-duplication because edgeId() suffixes the trigger-backed edge with
      // #<triggerId> while this one has none; skip at the source instead.
      if (wiredByTrigger.has(label)) continue;
      const kind = classify(label);
      if (kind === 'gate' || kind === 'brake') continue; // human-set, edge comes from null
      for (const s of (emitIndex.get(label) || [])) {
        if (s === n.id || s === ch.from) continue; // self / already the github edge
        const oc = ocOf(label, s);
        edges.push({ from: s, to: n.id, label, kind, ...(oc ? { outcome: oc } : {}) });
      }
    }
  }

  // Dead-end emitters: a label emitted but no trigger listens on it. Gate
  // emits stay skipped (an agent emitting a gate label is a `gate-violation`
  // error, not an edge); brake emits are no longer dropped — they become the
  // explicit hand-off edges below (#981).
  //
  // An outcome MARKED as an open end (#1004, §4.7 — `terminal: true` or
  // `external: {note?}`) is a declared endpoint, not a dead-end: its edge
  // carries `endpoint` (+ note) instead of `deadEnd`, so it renders as a
  // proper terminus and raises no lint.
  const markerOf = (agentId, outcomeId) => {
    const n = nodes.find(x => x.id === agentId);
    const o = (n && n.outcomes && Array.isArray(n.outcomes.options) ? n.outcomes.options : [])
      .find(x => x && x.id === outcomeId);
    if (!o) return null;
    if (o.terminal === true) return { endpoint: 'terminal' };
    if (o.external) return { endpoint: 'external', ...(o.external.note ? { note: o.external.note } : {}) };
    return null;
  };
  for (const [label, emitters] of emitIndex) {
    if (isHumanGate(label) || isBrake(label)) continue;
    // A named human role that `consumes` this plain label receives it as a
    // delivery (#1197, drawn below) — that is a real consumer, not a dead end.
    if (!allListenKeys.has(label) && !humanLabelConsumer.has(label)) {
      for (const s of emitters) {
        const oc = ocOf(label, s);
        const marker = oc ? markerOf(s, oc) : null;
        edges.push({
          from: s, to: null, label, kind: classify(label),
          ...(oc ? { outcome: oc } : {}),
          ...(marker || { deadEnd: true }),
        });
      }
    }
  }

  // Brake hand-offs (#981): an agent applying a brake label pauses the flow
  // pending a human decision — that is a hand-off TO the human, not a dead end.
  // Drawn for EVERY brake emitter (listened or not): even when a downstream
  // agent re-listens on the label, the human sits in between (they decide, then
  // release), so the emit side always routes through the human. Never a lint.
  for (const [label, emitters] of emitIndex) {
    if (!isBrake(label) || isHumanGate(label)) continue;
    // #987: when a named human role consumes this brake label, the hand-off
    // terminates on that role's node instead of the generic `@human` actor.
    const boundHuman = humanLabelConsumer.get(label) || null;
    for (const s of emitters) {
      const oc = ocOf(label, s);
      edges.push({ from: s, to: boundHuman, label, kind: 'brake', handoff: 'human', ...(oc ? { outcome: oc } : {}) });
    }
  }

  // Label deliveries to a person (#1197): an agent sets a PLAIN label (not a
  // human gate, not a brake) that a named human role `consumes` — the person is
  // notified / acts on the label. It is a delivery/touchpoint, NOT a gate and
  // NOT a brake, so it never blocks the flow. Drawn only to a BOUND human role
  // (an unconsumed plain label stays a normal agent→agent or dead-end edge).
  // Tagged `handoff: 'human'` like the brake edge but WITHOUT `brake`, so the
  // renderer styles it as a plain delivery. A label an agent listens on too
  // (fan-out to both an agent and a person) still draws its agent edges above.
  for (const [label, emitters] of emitIndex) {
    if (isHumanGate(label) || isBrake(label)) continue;
    const boundHuman = humanLabelConsumer.get(label) || null;
    if (!boundHuman) continue;
    for (const s of emitters) {
      if (s === boundHuman) continue;
      const oc = ocOf(label, s);
      edges.push({ from: s, to: boundHuman, label, kind: 'label', handoff: 'human', ...(oc ? { outcome: oc } : {}) });
    }
  }

  // Artifact deliveries to a person (#987): a produce port whose PR/issue a
  // person reviews/merges. The human is a NAMED role when one `consumes` this
  // producer's artifact (`to: <humanId>`); an `audience: 'human'` flag with no
  // role wired stays UNBOUND (`to: null`) — it still lists as a touchpoint and
  // suppresses `producer-unconsumed`, but draws no line (the generic `@human` hub
  // is gone, #987) and raises the advisory `unbound-delivery` lint. Exempted from
  // `producer-unconsumed` either way.
  for (const n of nodes) {
    const gh = n.github || {};
    for (const artifact of ['pr', 'issue']) {
      const produces = artifact === 'pr' ? gh.producesPr : gh.producesIssue;
      if (!produces) continue;
      const boundHuman = humanArtifactConsumer.get(`${n.id}|${artifact}`) || null;
      const audience = artifact === 'pr' ? gh.prAudience : gh.issueAudience;
      if (boundHuman) {
        edges.push({ from: n.id, to: boundHuman, kind: 'delivery', artifact, handoff: 'human' });
      } else if (audience === 'human') {
        edges.push({ from: n.id, to: null, kind: 'delivery', artifact, handoff: 'human' });
      }
    }
  }

  // Direct agent-to-agent hand-offs (#2031, concept §10): a `wakeAgent` outcome
  // action wakes a wired SAME-TEAM role inside the platform — no label token, no
  // issue/PR, no GitHub trace. `kind: 'wake'` maps onto the `on: 'wake'`
  // discriminator in unified-graph; the note rides along so the edge dialog and
  // the canvas can show what the producer hands over.
  //
  // Three cases draw NO edge, and each is deliberate:
  //   - an unknown target — validateOutcomes refuses one at authoring time, so a
  //     surviving one is imported/legacy data; a line into nothing is worse than
  //     no line, and P3 owns the lint that names it.
  //   - a HUMAN role as the target — `wakeAgent` wakes an agent through the
  //     pending queue; a person has no queue. `nodeIds` is the AGENT id set
  //     (human roles only join as `allNodes` further down), so the same
  //     membership check that rejects an unknown target rejects a person too.
  //   - a self-wake — refused server-side; drawing it would suggest a legal loop.
  //
  // Unlike the label paths above there is no emit index to consult and no
  // dead-end case: a `wakeAgent` names its consumer directly, so the edge either
  // resolves to that node or does not exist.
  for (const n of nodes) {
    if (!isAuthoredOutcomes(n.outcomes)) continue;
    for (const w of outcomeWakePairs(n.outcomes)) {
      if (w.to === n.id) continue;
      if (!nodeIds.has(w.to)) continue;
      edges.push({
        from: n.id, to: w.to, kind: 'wake', outcome: w.outcome,
        ...(w.note ? { note: w.note } : {}),
      });
    }
  }

  const gates = [...gateSet].sort().map(label => ({ label, humanOnly: true }));
  const labels = [...labelMeta.keys()].sort().map(name => ({ name, ...labelMeta.get(name) }));

  // Named human roles (#987) join the node set as first-class `kind: 'human'`
  // boxes. Appended last so every agent-side loop above ran over the agent
  // nodes only (a human's `emits` are gates it MAY set — they must never enter
  // the emit index or trip an emit-shape lint). `synthetic: true` keeps them out
  // of computeLints; a graph with no `humans[]` appends nothing, so its output
  // is byte-identical to before (AC8).
  const allNodes = humanRoles.length ? [...nodes, ...humanRoles] : nodes;

  return {
    nodes: allNodes, edges, gates, labels,
    humanTouchpoints: computeHumanTouchpoints(allNodes, edges, humanIds),
    lints: computeLints(allNodes, edges, classifier),
  };
}

// ─── human touchpoints (#981) ────────────────────────────────────────────────
//
// The derived list of every place a PERSON acts in the flow — computed purely
// from nodes/edges, never hand-maintained. Three types (generic human, no named
// roles by design):
//
//   injection — a human applies a gate label (or approves a gated channel),
//               waking an agent: work enters / passes a gate.
//   decision  — an agent applies a brake label: the flow pauses until a human
//               decides.
//   delivery  — an agent opens a PR/issue whose declared audience is a human
//               (review/merge).
//
// Sorted deterministically (type, then label/artifact, then agent) and deduped
// so N triggers on one label yield one touchpoint.
const TOUCHPOINT_ORDER = { injection: 0, decision: 1, delivery: 2 };
// Shared comparator so unified-graph can merge its data-flow delivery
// touchpoints (#981 follow-up) and keep the one deterministic order.
function compareHumanTouchpoints(a, b) {
  return (TOUCHPOINT_ORDER[a.type] - TOUCHPOINT_ORDER[b.type])
    || String(a.label || a.name || a.artifact || '').localeCompare(String(b.label || b.name || b.artifact || ''))
    || String(a.agentId).localeCompare(String(b.agentId))
    // Named-role tiebreaker (#987) so two humans injecting the same label sort
    // deterministically; unbound entries carry no role, so existing order holds.
    || String(a.role || '').localeCompare(String(b.role || ''));
}
function computeHumanTouchpoints(nodes, edges, humanIds) {
  const humans = humanIds instanceof Set ? humanIds : new Set();
  const out = [];
  const seen = new Set();
  const add = (t) => {
    // Keyed by label when there is one (a labelled gate channel and an explicit
    // label listener on the same label are ONE touchpoint), else by artifact.
    // The bound role (#987) joins the key so one label injected by two named
    // humans yields two touchpoints (unbound entries carry no role — key ends
    // in '|', byte-identical to before).
    const key = `${t.type}|${t.label || t.artifact || ''}|${t.agentId}|${t.role || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  // #987: a gate/brake/delivery edge bound to a named human role carries that
  // role's id on the far end; surface it as `role` so the panel groups by it.
  const roleOf = (id) => (humans.has(id) ? { role: id } : {});
  for (const e of edges) {
    // Gate label listeners: a human applies the label — from the generic
    // `@human` (null) or a named human role (#987).
    if (e.kind === 'gate' && (e.from == null || humans.has(e.from)) && e.to) {
      add({ type: 'injection', label: e.label, agentId: e.to, ...roleOf(e.from) });
    }
    // Brake hand-offs (from an agent, handoff: 'human'): human decides. The
    // deciding human is named when the edge terminates on a human role (#987).
    if (e.kind === 'brake' && e.from && e.handoff === 'human') {
      add({ type: 'decision', label: e.label, agentId: e.from, ...(e.outcome ? { outcome: e.outcome } : {}), ...roleOf(e.to) });
    }
    // Artifact deliveries: human reviews/merges the PR or issue.
    if (e.kind === 'delivery' && e.from) {
      add({ type: 'delivery', artifact: e.artifact, agentId: e.from, ...roleOf(e.to) });
    }
    // Label deliveries (#1197): an agent sets a plain label the person is
    // notified on — a delivery touchpoint (they receive it; no gate, no brake).
    if (e.kind === 'label' && e.handoff === 'human' && e.from && e.to) {
      add({ type: 'delivery', label: e.label, agentId: e.from, ...(e.outcome ? { outcome: e.outcome } : {}), ...roleOf(e.to) });
    }
  }
  // Gated channels (`gate: 'human'`) never appear as gate listener edges in
  // this builder (their consumer's derived trigger is `channel: true`, and the
  // producer→consumer edge is drawn in unified-graph) — read the ports directly.
  for (const n of nodes) {
    for (const ch of (Array.isArray(n.channels) ? n.channels : [])) {
      if (!ch || ch.gate !== 'human') continue;
      add({
        type: 'injection', agentId: n.id,
        ...(typeof ch.label === 'string' && ch.label.trim() ? { label: ch.label.trim() } : {}),
        ...(ch.artifact === 'issue' ? { artifact: 'issue' } : { artifact: 'pr' }),
      });
    }
  }
  return out.sort(compareHumanTouchpoints);
}

// Advisory wiring checks (#333) — surfaced as a panel + inline badges, never
// block saving. Derived purely from the built nodes/edges.
//
// `classifier` (#928) carries the authoritative gate/brake flags. It is optional
// so `computeLints(nodes, edges)` keeps working for callers that only have the
// nodes: the fallback still picks up every channel `gate: 'human'`, it just
// cannot see a `labels[]` registry that was never threaded in.
function computeLints(nodes, edges, classifier) {
  const { isHumanGate, isBrake } = classifier || makeLabelClassifier({ agents: nodes });
  const lints = [];
  for (const e of edges) {
    if (e.orphan) {
      lints.push({ code: 'orphan-listener', severity: 'warning', label: e.label, nodeId: e.to,
        message: `\`${e.to}\` waits for \`${e.label}\` but no outcome sets it.` });
    }
    if (e.deadEnd) {
      // outcome-without-consumer (#830) is the successor of dead-end-emitter for
      // OUTCOME edges: a dead-end carrying an `outcome` id comes from an authored
      // outcomes port (a legacy flat-emit dead-end has no outcome field and keeps
      // firing dead-end-emitter, so AC3 legacy output is byte-identical). `none`
      // actions set no label → no edge → naturally exempt.
      if (e.outcome) {
        lints.push({ code: 'outcome-without-consumer', severity: 'warning', label: e.label, nodeId: e.from, outcome: e.outcome,
          message: `\`${e.from}\` outcome \`${e.outcome}\` sets \`${e.label}\` but no consumer reacts to it.` });
      } else {
        lints.push({ code: 'dead-end-emitter', severity: 'warning', label: e.label, nodeId: e.from,
          message: `\`${e.from}\` sets \`${e.label}\` but no consumer reacts to it.` });
      }
    }
  }
  // Unbound human touchpoints (#987, advisory). The generic `@human` hub is gone,
  // so a gate/brake with no NAMED human role wired draws no edge — surface an
  // `info` hint prompting the operator to add a human role. Deduped by label; a
  // gate edge bound to a human (`from` set) or a brake bound to one (`to` set) is
  // NOT unbound. Kept `info` so the shipped-bundle guard (which fails on
  // error/warning) stays green for curated templates that predate human roles.
  const unboundGate = new Set();
  const unboundBrake = new Set();
  for (const e of edges) {
    if (e.kind === 'gate' && e.from == null && e.to && e.label) unboundGate.add(e.label);
    if (e.kind === 'brake' && e.handoff === 'human' && e.to == null && e.from && e.label) unboundBrake.add(e.label);
  }
  for (const label of unboundGate) {
    lints.push({ code: 'unbound-gate', severity: 'info', label,
      message: `gate label \`${label}\` has no human role — wire a human role that applies it.` });
  }
  for (const label of unboundBrake) {
    lints.push({ code: 'unbound-brake', severity: 'info', label,
      message: `brake label \`${label}\` pauses for a human but no human role decides it — wire a human role.` });
  }
  // ── direct hand-off checks (#2032, direct-agent-handoff concept §12 P3) ────
  //
  // Three lints over the `kind: 'wake'` edges P2 draws, plus one that suggests
  // replacing a label with a hand-off. They sit here rather than beside the
  // label lints because all three read the OUTCOME actions, not the edge alone.
  const wakeNodeById = new Map(nodes.filter(n => !n.synthetic).map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.synthetic || !isAuthoredOutcomes(n.outcomes)) continue;
    for (const w of outcomeWakePairs(n.outcomes)) {
      const target = wakeNodeById.get(w.to);
      // A hand-off naming something that is not an agent in this flow draws NO
      // edge at all (buildProcessGraph skips it deliberately — a line into
      // nothing is worse than no line), so without this lint it is invisible:
      // the outcome exists, the canvas shows nothing, and delivery refuses it
      // at runtime with a 404/403 the author never sees. `validateOutcomes`
      // rejects all three shapes at authoring time when an `agents` source is
      // threaded, so a surviving one is imported or hand-edited data.
      if (w.to === n.id) {
        lints.push({ code: 'wake-target-unresolved', severity: 'warning', nodeId: n.id, outcome: w.outcome,
          message: `\`${n.id}\` outcome \`${w.outcome}\` hands off to itself — a self-wake is refused on delivery.` });
        continue;
      }
      if (!target) {
        lints.push({ code: 'wake-target-unresolved', severity: 'warning', nodeId: n.id, outcome: w.outcome,
          message: `\`${n.id}\` outcome \`${w.outcome}\` hands off to \`${w.to}\`, which is not an agent in this flow — a person has no queue, and an unknown role is refused on delivery.` });
        continue;
      }
      // The `outcome-without-consumer` sibling. The consumer's `wake-agent`
      // listener carries the wake instruction, and `_execute_wake_agent` takes
      // the first ENABLED one; with none the entry is dequeued and dropped, so
      // the producer's hand-off succeeds and nothing runs.
      //
      // Deliberately narrower than "has no listener": that listener is DERIVED,
      // never authored (`expandWakeHandoffs` / `reconcileTeamWakeHandoffs`), so
      // its absence in a draft or an imported bundle is the reconciler's
      // business at materialise time, not an authoring error to warn about.
      // A listener that is present and switched off is nobody's derivation.
      const wakeListeners = (target.triggers || []).filter(t => t && t.type === 'wake-agent');
      if (wakeListeners.length > 0 && wakeListeners.every(t => t.enabled === false)) {
        lints.push({ code: 'wake-target-disabled', severity: 'warning', nodeId: n.id, outcome: w.outcome,
          message: `\`${n.id}\` outcome \`${w.outcome}\` hands off to \`${w.to}\`, whose hand-off input is disabled — the wake is queued and then dropped, with nothing on GitHub to show it.` });
      }
      // Q3 (§13): the note stays OPTIONAL, but a note-less hand-off carries
      // less than a label does — a label at least names a stage, while the
      // event-log row for this one can only say who woke whom. `info`, because
      // a required field invites `"done"`.
      if (!w.note) {
        lints.push({ code: 'wake-without-note', severity: 'info', nodeId: n.id, outcome: w.outcome,
          message: `\`${n.id}\` outcome \`${w.outcome}\` hands off to \`${w.to}\` with no note — a sentence of context is what makes the hand-off readable in the event log and useful to \`${w.to}\`.` });
      }
    }
  }
  // The former `direct-handoff-candidate` hint (#2032) only ever fired on edges
  // that had already opted out of GitHub delivery via the internal transport.
  // With that transport removed (#2578) every labelled edge is poller-delivered
  // — which is what lets a HUMAN wake the listener by re-applying the label — so
  // suggesting "drop the label" on it would skip exactly that property. Retired.
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
  // Producer→human deliveries (#987): a `kind: 'delivery'` edge means a person
  // reviews/merges that producer's PR/issue — a consumer, so it clears the
  // "nobody consumes this" smell. `to` set = a NAMED human role reviews it; `to`
  // null = an `audience: 'human'` flag with no role wired yet (unbound → the
  // advisory `unbound-delivery` lint below).
  const deliveredArtifacts = new Set(); // `${producerId}|${pr|issue}` — any delivery
  const unboundDelivery = new Set();    // `${producerId}|${pr|issue}` — flag, no role
  for (const e of edges) {
    if (e.kind !== 'delivery' || !e.from || !e.artifact) continue;
    deliveredArtifacts.add(`${e.from}|${e.artifact}`);
    if (e.to == null) unboundDelivery.add(`${e.from}|${e.artifact}`);
  }
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.synthetic) continue;
    const gh = n.github || {};
    const consumed = consumedArtifactsByProducer.get(n.id) || new Set();
    for (const artifact of ['pr', 'issue']) {
      const produces = artifact === 'pr' ? gh.producesPr : gh.producesIssue;
      if (!produces) continue;
      const key = `${n.id}|${artifact}`;
      const noun = artifact === 'pr' ? 'pull requests' : 'issues';
      // A declared open end (#1004, §4.7): the outcome carrying this artifact
      // action is marked terminal ("the merged PR IS the product") or external
      // ("consumed outside this flow") — a proper endpoint, not a smell.
      const action = artifact === 'pr' ? 'openPr' : 'openIssue';
      const marked = (n.outcomes && Array.isArray(n.outcomes.options) ? n.outcomes.options : [])
        .some(o => o && (o.terminal === true || o.external)
          && (o.actions || []).some(a => a && a.type === action));
      if (marked) continue;
      // A delivery to a person (named role or unbound audience flag) is a
      // consumer — it clears the "nobody consumes this" smell. An UNBOUND one
      // (flag, no role) instead raises the advisory `unbound-delivery` (#987).
      if (!consumed.has(artifact) && !deliveredArtifacts.has(key)) {
        lints.push({ code: 'producer-unconsumed', severity: 'info', nodeId: n.id,
          message: `\`${n.id}\` opens ${noun} but no agent consumes them.` });
      } else if (unboundDelivery.has(key)) {
        lints.push({ code: 'unbound-delivery', severity: 'info', nodeId: n.id, artifact,
          message: `\`${n.id}\` opens ${noun} for a person but no human role reviews them — wire a human role.` });
      }
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
    // Emit-shape lints read the agent-level `emits` (#414/#783) — the only emit
    // source now that trigger-level emits are gone.
    const stageEmits = new Set();
    for (const lbl of n.emits || []) {
      // Flag-based (#928): fires for a `humanGate` label whatever it is named, and
      // NOT for a `brake` label — a brake is agent-appliable by design.
      if (isHumanGate(lbl)) {
        lints.push({ code: 'gate-violation', severity: 'error', nodeId: n.id, label: lbl,
          message: `\`${n.id}\` declares it sets gate label \`${lbl}\` — only a person may apply it.` });
      }
      if (lbl.startsWith('stage:')) stageEmits.add(lbl);
    }
    if (stageEmits.size > 1) {
      lints.push({ code: 'competing-stage', severity: 'warning', nodeId: n.id,
        message: `\`${n.id}\` sets multiple stage labels: ${[...stageEmits].join(', ')}.` });
    }
  }

  // duplicate-listener (#826): two github-event triggers of one agent reacting to
  // the same (events, labelFilter). The poller has no origin filter, so both fire
  // on every matching event and wake the agent redundantly. Channel consolidation
  // (#826) removed the per-producer duplicates the derivation used to emit; this
  // lint catches what remains — chiefly a hand-authored trigger left standing
  // beside a derived channel/data-flow listener. A group made up SOLELY of
  // data-flow push triggers is skipped: those are intentional one-per-upstream
  // listeners, distinguished by their prompt rather than by (events, labelFilter).
  for (const n of nodes) {
    if (n.synthetic) continue;
    const bySig = new Map(); // "events|label" -> trigger views
    for (const t of (n.triggers || [])) {
      if (!t || t.type !== 'github-event') continue;
      const events = Array.isArray(t.events) ? t.events.slice().sort() : [];
      const label = typeof t.labelFilter === 'string' && t.labelFilter.trim() ? t.labelFilter.trim() : '';
      const sig = `${events.join(',')}|${label}`;
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(t);
    }
    for (const group of bySig.values()) {
      if (group.length < 2) continue;
      if (group.every(t => t.dataFlow)) continue; // intentional per-upstream push listeners
      const label = group[0].labelFilter;
      const ids = group.map(t => t.id).filter(Boolean);
      lints.push({
        code: 'duplicate-listener', severity: 'warning', nodeId: n.id,
        ...(label ? { label } : {}),
        triggerIds: ids,
        message: `\`${n.id}\` has ${group.length} inputs waiting on the same event`
          + `${label ? ` + label \`${label}\`` : 's'}${ids.length ? ` (${ids.map(i => `\`${i}\``).join(', ')})` : ''}`
          + ` — they fire redundantly.`,
      });
    }
  }

  // raw-trigger-nonconformant (#1006, concept §4.8). The raw layers (agent
  // self-managed triggers.json, direct file/API edits) may deviate from the
  // wiring rules — but VISIBLY, never silently: a multi-event github-event
  // trigger or a malformed claim surfaces as this advisory lint. Same rule
  // helper as the write-side validators, so the rule set cannot drift.
  for (const n of nodes) {
    if (n.synthetic) continue;
    for (const t of (n.triggers || [])) {
      // Derived channel/data-flow listeners are ENGINE-written (stripped and
      // regenerated on every port reconcile) — not a raw layer. Flagging them
      // would tell the operator to "edit it to conform" on a trigger the next
      // reconcile rewrites; if the derivation deviates (e.g. the unlabelled
      // PR-open event pair), the fix belongs in the expander, not per team
      // (#1008).
      if (t.channel || t.dataFlow) continue;
      const te = rawTriggerError(t);
      if (!te) continue;
      lints.push({
        code: 'raw-trigger-nonconformant', severity: 'info', nodeId: n.id,
        ...(t.id ? { triggerIds: [t.id] } : {}),
        // An invalid cron (#2626) is not a tolerated deviation: the agent's
        // scheduler skips it, so the lint must not claim it still runs.
        message: t.type === 'cron'
          ? `\`${n.id}\` trigger ${t.id ? `\`${t.id}\`` : '(unnamed)'} never fires: ${te}. Fix the schedule.`
          : `\`${n.id}\` trigger ${t.id ? `\`${t.id}\`` : '(unnamed)'} deviates from the wiring rules: ${te}. It still runs — edit it to conform.`,
      });
    }
  }

  // unclaimed-listener (#958, concept §3.5). A label listener without a `claim`
  // never turns its wake label into a visible work-in-progress state, so the
  // three stall modes (wake never arrived / run died mid-flight / ran but never
  // emitted) stay indistinguishable on GitHub — a reconciliation blind spot.
  //
  // ADVISORY (`info`) on purpose: hand-authored listeners are legitimately
  // unclaimed (the author may have opted out), and the shipped-bundle guard in
  // process-template-registry.test.js fails on error/warning lints only. Raising
  // this to a warning would turn every not-yet-migrated curated template red.
  for (const n of nodes) {
    if (n.synthetic) continue;
    for (const t of (n.triggers || [])) {
      if (!t || t.type !== 'github-event') continue;
      const label = typeof t.labelFilter === 'string' ? t.labelFilter.trim() : '';
      if (!label) continue;                       // raw event listener — nothing to claim
      if (label.endsWith(CLAIM_SUFFIX)) continue; // a claim-label listener claims nothing
      if (claimView(t)) continue;                 // already claimed
      lints.push({
        code: 'unclaimed-listener', severity: 'info', nodeId: n.id, label,
        ...(t.id ? { triggerIds: [t.id] } : {}),
        message: `\`${n.id}\` waits on \`${label}\` without a claim — a stalled run`
          + ` cannot be told apart from a wake that never arrived.`,
      });
    }
  }

  // Outcome-port lints (#830, concept §8). These read the AUTHORED `outcomes`
  // port that buildProcessGraph surfaces on a node only when authored — a legacy
  // flat-`emits` agent has no `n.outcomes`, so none of these fire and its
  // dead-end-emitter / gate-violation output stays byte-identical (AC3). The
  // `outcome-without-consumer` case is derived from the dead-end edges above; the
  // per-node inspection below covers the switch/branch shape checks that have no
  // edge to hang off.
  for (const n of nodes) {
    if (n.synthetic) continue;
    const oc = n.outcomes;
    if (!oc || !Array.isArray(oc.options)) continue;

    // switch-with-one-option (info): an `exactlyOne` switch with fewer than two
    // options isn't a branch at all.
    if (oc.mode === 'exactlyOne' && oc.options.length < 2) {
      lints.push({ code: 'switch-with-one-option', severity: 'info', nodeId: n.id,
        message: `\`${n.id}\` has an exactlyOne switch with ${oc.options.length} option${oc.options.length === 1 ? '' : 's'} — not a branch.` });
    }

    // human-label-as-outcome (error): an outcome action may not set a human-GATE
    // label — only a human may. Extends `gate-violation` to the outcomes port (the
    // label is filtered out of `n.emits` by the projection, so `gate-violation`
    // cannot catch it — this covers imported/legacy data). Flag-based (#928), and
    // brake labels are deliberately exempt: a brake is agent-applied (the reworker
    // setting `human-decision-required` to pause the loop for a human decision).
    for (const o of oc.options) {
      for (const a of (Array.isArray(o.actions) ? o.actions : [])) {
        if (a && a.type === 'setLabel' && typeof a.label === 'string'
            && isHumanGate(a.label.trim())) {
          lints.push({ code: 'human-label-as-outcome', severity: 'error', nodeId: n.id, label: a.label.trim(), outcome: o.id,
            message: `\`${n.id}\` outcome \`${o.id}\` sets gate label \`${a.label.trim()}\` — only humans may set it.` });
        }
      }
    }

    // same-label-multiple-outcomes (warning): under `exactlyOne`, two options
    // that set the same label leave consumers unable to tell the branches apart.
    // (Gate labels are excluded here — those are the human-label-as-outcome
    // error above.)
    if (oc.mode === 'exactlyOne') {
      const optionsByLabel = new Map(); // label -> Set(optionId)
      for (const o of oc.options) {
        for (const a of (Array.isArray(o.actions) ? o.actions : [])) {
          if (!a || a.type !== 'setLabel' || typeof a.label !== 'string') continue;
          const lbl = a.label.trim();
          if (!lbl || isHumanGate(lbl)) continue;
          if (!optionsByLabel.has(lbl)) optionsByLabel.set(lbl, new Set());
          optionsByLabel.get(lbl).add(o.id);
        }
      }
      for (const [lbl, ids] of optionsByLabel) {
        if (ids.size > 1) {
          lints.push({ code: 'same-label-multiple-outcomes', severity: 'warning', nodeId: n.id, label: lbl,
            message: `\`${n.id}\` sets \`${lbl}\` from ${ids.size} exactlyOne options (${[...ids].map(i => `\`${i}\``).join(', ')})`
              + ` — consumers can't distinguish the branches.` });
        }
      }
    }
  }

  return lints;
}

module.exports = { buildProcessGraph, computeLints, computeHumanTouchpoints, compareHumanTouchpoints, listenKeys, classifyKind, makeLabelClassifier, humanNode, normalizeConsumes };
