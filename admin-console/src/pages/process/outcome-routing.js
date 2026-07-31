// outcome-routing.js — pure specs for the per-row consumer picker (#1003,
// concept §4.2): an outcome no longer only *says* what it sets, it can pick
// WHO receives it. These helpers decide, per outcome row, what wiring a picked
// target needs (label listener vs. channel) and how an existing consumer is
// unwired — the OutcomeRow UI feeds the specs to the wiring engine.
//
// Pure + framework-free (node:test-able). `peers` are flow-graph nodes
// (`{ id, kind?, displayName?, triggers?, channels? }`).

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
