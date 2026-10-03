// review-gate.js — the review gate as ONE editable object (#1005, concept
// §4.3–§4.5): pure discovery of the S3 triangle from any of its edges, and the
// submit paths the four create dialogs share. All writes compose wiring-engine
// ops, so every path converges on the same persisted state (§4.5) and cleanup
// stays symmetric.
//
// Pure + framework-free; the JSX dialogs are thin shells over these functions.

import {
  wireReviewGate, unwireReviewGate, wireHumanDelivery, wireHumanGate, wireChannel,
  deriveClaim,
} from './wiring-engine.js';

const isHumanNode = (n) => !!n && n.kind === 'human';

// ── discovery ───────────────────────────────────────────────────────────────

/**
 * Identify the review-gate triangle a clicked edge belongs to. Accepts the
 * delivery edge (`on: 'github', audience: 'human'`), a gate edge (`on:
 * 'label'` originating at a human node), and works from the graph's nodes
 * (incl. `kind: 'human'` roles with `emits`/`consumes`).
 *
 * Returns `{ human, producer, artifact, gateLabel, gateTriggerId, consumer,
 * claim, rejectLabel, rejectTriggerId }` — fields null when that leg is not
 * wired — or null when the edge is not review-gate shaped at all.
 */
export function findReviewGate(edge, graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const byId = new Map(nodes.map(n => [n.id, n]));

  let humanId = null;
  let clickedLabel = null;
  // The clicked delivery edge names its producer + artifact, so a human with
  // two deliveries (#1036 edge case) edits/removes the one that was clicked
  // rather than always the first.
  let clickedFrom = null; let clickedArtifact = null;
  if (edge && edge.on === 'github' && edge.audience === 'human' && isHumanNode(byId.get(edge.to))) {
    humanId = edge.to;
    clickedFrom = edge.from || null;
    clickedArtifact = edge.artifact === 'issue' ? 'issue' : (edge.artifact === 'pr' ? 'pr' : null);
  } else if (edge && edge.on === 'label' && isHumanNode(byId.get(edge.from))) {
    humanId = edge.from;
    clickedLabel = edge.label || null;
  } else {
    return null;
  }

  const human = byId.get(humanId);
  const consumes = Array.isArray(human.consumes) ? human.consumes : [];
  const isArtifactConsume = (c) => c && (c.artifact === 'pr' || c.artifact === 'issue');
  const artifactConsume =
    (clickedFrom && consumes.find(c => isArtifactConsume(c)
      && c.from === clickedFrom && (!clickedArtifact || c.artifact === clickedArtifact)))
    || consumes.find(isArtifactConsume) || null;
  const producer = artifactConsume ? (byId.get(artifactConsume.from) || null) : null;
  const artifact = artifactConsume ? artifactConsume.artifact : null;

  // A listener for an emitted label on some agent. The PRODUCER's listener is
  // the rejection leg; any other agent's is the gate (forward) leg.
  const listenerFor = (label, nodeId) => {
    const n = byId.get(nodeId);
    return (n && Array.isArray(n.triggers) ? n.triggers : []).find(t =>
      t && t.type === 'github-event' && t.labelFilter === label) || null;
  };
  const emits = Array.isArray(human.emits) ? human.emits : [];

  let gateLabel = null; let gateTriggerId = null; let consumer = null; let claim = null;
  let rejectLabel = null; let rejectTriggerId = null;
  for (const label of emits) {
    for (const n of nodes) {
      if (isHumanNode(n) || n.id === humanId) continue;
      const t = listenerFor(label, n.id);
      if (!t) continue;
      if (producer && n.id === producer.id) {
        if (!rejectLabel) { rejectLabel = label; rejectTriggerId = t.id; }
      } else if (!gateLabel || label === clickedLabel) {
        gateLabel = label; gateTriggerId = t.id; consumer = n; claim = t.claim || null;
      }
    }
  }
  // The clicked gate label wins even when no listener exists yet.
  if (clickedLabel && !gateLabel) gateLabel = clickedLabel;

  return {
    human, producer, artifact, gateLabel, gateTriggerId,
    consumer, claim, rejectLabel, rejectTriggerId,
  };
}

/** Does this edge open the review-gate editor? (delivery to a person, or a
 * gate label edge originating at a named human role) */
export function isReviewGateEdge(edge, graph) {
  return findReviewGate(edge, graph) != null;
}

// ── create paths (the dialogs' submits — all engine-composed) ───────────────

/**
 * Path A (§5): the agent→agent channel dialog with "a person approves first"
 * and a NAMED person → the full triangle in one call. Without a person the
 * spec degrades to a plain (optionally anonymously gated) channel.
 */
export async function submitChannelWithApproval(ctx, { from, to, artifact, label, human, gate, readiness }) {
  const l = String(label || '').trim();
  if (human && l) {
    await wireReviewGate(ctx, { from, human, to, artifact, gateLabel: l });
    return { kind: 'review-gate' };
  }
  await wireChannel(ctx, { from, to, artifact, label: l, ...(gate ? { gate: 'human' } : {}), ...(readiness ? { readiness } : {}) });
  return { kind: 'channel' };
}

/**
 * Path B leg 1 (§5): "P reviews A's work" — a delivery, optionally completed
 * to the full triangle when a consumer + gate label are picked inline.
 */
export async function submitAgentToPerson(ctx, { from, human, entry, wake }) {
  if (wake && wake.to && String(wake.gateLabel || '').trim()
    && (entry.artifact === 'pr' || entry.artifact === 'issue')) {
    await wireReviewGate(ctx, {
      from, human, to: wake.to, artifact: entry.artifact,
      gateLabel: String(wake.gateLabel).trim(),
      ...(String(wake.rejectLabel || '').trim() ? { rejectLabel: String(wake.rejectLabel).trim() } : {}),
    });
    return { kind: 'review-gate' };
  }
  await wireHumanDelivery(ctx, { human, entry });
  return { kind: 'delivery' };
}

/**
 * Path B leg 2 (§5): "P approves → B wakes" — the gate leg, with the optional
 * rejection path (off by default, concept §9 Q1).
 */
export async function submitPersonToAgent(ctx, { human, to, label, kind, reject }) {
  await wireHumanGate(ctx, { human, to, label, kind });
  if (reject && reject.to && String(reject.label || '').trim()) {
    await wireHumanGate(ctx, { human, to: reject.to, label: String(reject.label).trim(), kind });
  }
  return { kind: 'gate' };
}

// ── editor operations ───────────────────────────────────────────────────────

/** Toggle the gate listener's claim (the autoClaim opt-out, #958). */
export async function setGateClaim({ ops }, { to, triggerId, label, on }) {
  await ops.updateTrigger(to, triggerId, { claim: on ? deriveClaim(label) : null });
}

/** Add the rejection leg to an existing gate. */
export async function addRejectionPath(ctx, { human, producerId, label, kind }) {
  await wireHumanGate(ctx, { human, to: producerId, label, kind });
}

/** Remove the rejection leg symmetrically (listener + emit). */
export async function removeRejectionPath({ ops, humanOps }, { human, producerId, label, triggerId }) {
  if (triggerId) await ops.deleteTrigger(producerId, triggerId);
  if (humanOps.removeHumanEmit) await humanOps.removeHumanEmit(human, label);
}

/** Rename the gate label: the old leg is unwired (listener + emit) and the
 * new one wired via the engine — listener regenerated with the derived claim. */
export async function renameGateLabel(ctx, { human, to, oldLabel, oldTriggerId, newLabel, kind }) {
  const next = String(newLabel || '').trim();
  if (!next || next === oldLabel) return;
  if (oldTriggerId) await ctx.ops.deleteTrigger(to, oldTriggerId);
  if (ctx.humanOps.removeHumanEmit && oldLabel) await ctx.humanOps.removeHumanEmit(human, oldLabel);
  await wireHumanGate(ctx, { human, to, label: next, kind });
}

/** Delete the whole triangle — all three sides, no leftovers (§4.4). */
export async function deleteReviewGate(ctx, gate) {
  await unwireReviewGate(ctx, {
    from: gate.producer ? gate.producer.id : undefined,
    human: gate.human.id,
    to: gate.consumer ? gate.consumer.id : undefined,
    artifact: gate.artifact || 'pr',
    gateLabel: gate.gateLabel || undefined,
    gateTriggerId: gate.gateTriggerId || undefined,
    rejectLabel: gate.rejectLabel || undefined,
    rejectTriggerId: gate.rejectTriggerId || undefined,
  });
}
