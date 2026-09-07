// outcome-routing.js — pure specs for the per-row consumer picker (#1003,
// concept §4.2): an outcome no longer only *says* what it sets, it can pick
// WHO receives it. These helpers decide, per outcome row, what wiring a picked
// target needs (label listener vs. channel) and how an existing consumer is
// unwired — the OutcomeRow UI feeds the specs to the wiring engine.
//
// Pure + framework-free (node:test-able). `peers` are flow-graph nodes
// (`{ id, kind?, displayName?, triggers?, channels? }`).

/**
 * The open-end marker (#1004, concept §4.7) an outcome option carries, as the
 * subset of persisted fields — `{ terminal: true }`, `{ external: {note?} }`, or
 * `{}` (no marker). Used by both the load hydrator and the save serializer in
 * RoutingSection so the marker round-trips (it was previously dropped on both
 * sides — #1037).
 *
 * `terminal` and `external` are mutually exclusive; `terminal` wins if both are
 * somehow present, mirroring the row's marker derivation. `external.note` is
 * trimmed, and an empty note collapses to `{ external: {} }` (still a valid
 * declared endpoint per the server's validateOutcomes).
 */
export function openEndMarker(option) {
  if (option?.terminal === true) return { terminal: true };
  const ext = option?.external;
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    const note = typeof ext.note === 'string' ? ext.note.trim() : '';
    return { external: note ? { note } : {} };
  }
  return {};
}

// The labels an outcome sets and the first GitHub artifact it opens.
export function rowLabels(option) {
  return (Array.isArray(option?.actions) ? option.actions : [])
    .filter(a => a && a.type === 'setLabel' && typeof a.label === 'string' && a.label.trim())
    .map(a => a.label.trim());
}

export function rowArtifact(option) {
  for (const a of (Array.isArray(option?.actions) ? option.actions : [])) {
    if (a && a.type === 'openPr') return 'pr';
    if (a && a.type === 'openIssue') return 'issue';
  }
  return null;
}

// Agent peers a consumer picker may offer (people are wired via the reviewer
// picker / delivery, never as signal consumers here).
export function consumerCandidates(node, peers) {
  return (Array.isArray(peers) ? peers : [])
    .filter(p => p && p.id && p.id !== node?.id && p.kind !== 'human')
    .map(p => ({ id: p.id, name: p.displayName || p.id }));
}

/**
 * What wiring does picking `targetId` on this row need?
 *   setLabel action  → a label hand-off (listener on the target; the emit
 *                      already exists — it IS this outcome).
 *   openPr/openIssue → a channel port on the target.
 * A row with both prefers the label — the explicit signal. `null` for a
 * terminal row (nothing to wire).
 */
export function wireConsumerSpec(option) {
  const labels = rowLabels(option);
  if (labels.length) return { kind: 'label', label: labels[0] };
  const artifact = rowArtifact(option);
  if (artifact) return { kind: 'channel', artifact };
  return null;
}

/**
 * Which dialog does a pre-typed outcome-port drag (#1005/#828) onto `toNode`
 * open? (#1035) The `outcome` here is the resolved drag payload the renderer
 * emits — `{ artifact: 'pr'|'issue'|null, label }` — not a raw option.
 *   • human target      → 'person': the agent-to-person delivery dialog, the
 *                         same branch the generic ● port takes. The channel /
 *                         hand-off forms below resolve consumers via
 *                         `bundle.roles` only, so a human (living in
 *                         `bundle.humans`) throws `role <id> not found`.
 *   • openPr/openIssue  → 'channel' (CreateChannelDialog, artifact-locked).
 *   • otherwise         → 'handoff' (setLabel → CreateHandoffDialog).
 */
export function outcomeDropDialog(outcome, toNode) {
  if (toNode && toNode.kind === 'human') return 'person';
  if (outcome && outcome.artifact) return 'channel';
  return 'handoff';
}

/**
 * How is `targetNode` currently consuming this row's signal? Returns the
 * unwire spec — `{kind: 'label', triggerId, label}` for a matching label
 * listener, `{kind: 'channel', artifact, label?}` for a channel from this
 * producer — or null when the target does not consume it.
 */
export function unwireConsumerSpec(option, node, targetNode) {
  const labels = rowLabels(option);
  for (const t of (targetNode?.triggers || [])) {
    if (t && t.type === 'github-event' && typeof t.labelFilter === 'string' && labels.includes(t.labelFilter)) {
      return { kind: 'label', triggerId: t.id, label: t.labelFilter };
    }
  }
  const artifact = rowArtifact(option);
  if (artifact) {
    const c = (targetNode?.channels || []).find(x => x && x.artifact === artifact && x.from === node?.id);
    if (c) return { kind: 'channel', artifact, ...(c.label ? { label: c.label } : {}) };
  }
  return null;
}

// The peers currently consuming this row's signal, with their unwire specs —
// the chips the row renders. Uses the same matching as `consumersFor` (display)
// so chip set and text never disagree.
export function currentConsumers(option, node, peers) {
  const out = [];
  for (const p of (Array.isArray(peers) ? peers : [])) {
    if (!p || p.id === node?.id || p.kind === 'human') continue;
    const spec = unwireConsumerSpec(option, node, p);
    if (spec) out.push({ id: p.id, name: p.displayName || p.id, spec });
  }
  return out;
}

// #1192: which target a canvas edge click opens. An outcome-keyed edge focuses
// the producer's Outcomes panel (#828) — EXCEPT a label hand-off edge, which
// opens the hand-off edit dialog (Delivery, label, wake prompt, delete) so
// editing an edge is symmetric with creating it (drag → CreateHandoffDialog
// already exposes Delivery). That dialog links back to the producing outcome
// for the richer when/action editing. Non-label outcome edges (opens-PR/issue)
// keep focusing the Outcomes directly. Pure so the routing rule is unit-tested.
//
// #2031 adds the second exception, for the same reason as the first: a direct
// hand-off ALWAYS carries an `outcome` (it is what edgeId keys on), so without
// this a wake edge could never open its own Edit-hand-off dialog — every click
// would jump to the Routing tab and the dialog would be unreachable code. And
// unlike an opens-PR/issue edge, a hand-off has per-edge state to edit (its
// target and its note), which is exactly what that dialog is for.
const OWN_EDIT_DIALOG = new Set(['label', 'wake']);
export function edgeOpensProducerOutcome(edge) {
  return !!(edge && edge.outcome && edge.from && !OWN_EDIT_DIALOG.has(edge.on));
}

// #1195: does a label edge have its own backing consumer listener trigger? A
// fan-in / feedback edge — a 2nd emitter of a label the consumer already listens
// on via a channel or another listener — is synthesized WITHOUT a triggerId (see
// the channel-label loop in process-graph.js). It has no per-edge trigger, so the
// hand-off editor must not try to update one (`updateTrigger(to, undefined)` →
// "Trigger not found"); it shows an explanatory panel instead. Pure + tested.
export function labelEdgeHasListener(edge) {
  return !!(edge && edge.triggerId);
}
