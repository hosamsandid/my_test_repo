import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findReviewGate, isReviewGateEdge,
  submitChannelWithApproval, submitAgentToPerson, submitPersonToAgent,
  setGateClaim, addRejectionPath, removeRejectionPath, renameGateLabel, deleteReviewGate,
} from './review-gate.js';
import { makeDraftLike, project, freshBundle } from './test-fakes.js';

// #1005 — the review gate as one object: triangle discovery from any edge,
// UI-level convergence of the create paths (§4.5/§5), symmetric cleanup (§4.4).

const projectBundle = (b) => project(Object.fromEntries(b.roles.map(r => [r.id, r])), b.humans);

// A graph shaped like /api/flows/graph output: agent nodes with triggers,
// human nodes with emits/consumes.
function graphOf(bundle) {
  return {
    nodes: [
      ...bundle.roles.map(r => ({ ...r, displayName: r.name || r.id })),
      ...(bundle.humans || []).map(h => ({ ...h, kind: 'human', displayName: h.name || h.id })),
    ],
  };
}

async function wireTriangle(bundle, extra = {}) {
  const ctx = makeDraftLike(bundle);
  await submitChannelWithApproval(ctx, {
    from: 'ba', to: 'dev', artifact: 'issue', label: 'ready', human: 'p', ...extra,
  });
  return ctx;
}

// ── discovery ───────────────────────────────────────────────────────────────

test('findReviewGate resolves the full triangle from the delivery edge AND the gate edge', async () => {
  const bundle = freshBundle();
  await wireTriangle(bundle);
  const graph = graphOf(bundle);

  const fromDelivery = findReviewGate({ on: 'github', audience: 'human', from: 'ba', to: 'p', artifact: 'issue' }, graph);
  const fromGate = findReviewGate({ on: 'label', from: 'p', to: 'dev', label: 'ready' }, graph);
  for (const g of [fromDelivery, fromGate]) {
    assert.equal(g.human.id, 'p');
    assert.equal(g.producer.id, 'ba');
    assert.equal(g.artifact, 'issue');
    assert.equal(g.gateLabel, 'ready');
    assert.equal(g.consumer.id, 'dev');
    assert.deepEqual(g.claim, { remove: 'ready', add: 'ready:wip' });
    assert.equal(g.rejectLabel, null);
  }
});

test('findReviewGate identifies the rejection leg (listener on the producer)', async () => {
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  await submitAgentToPerson(ctx, {
    from: 'ba', human: 'p', entry: { artifact: 'issue', from: 'ba' },
    wake: { to: 'dev', gateLabel: 'ready', rejectLabel: 'rework' },
  });
  const g = findReviewGate({ on: 'label', from: 'p', to: 'dev', label: 'ready' }, graphOf(bundle));
  assert.equal(g.gateLabel, 'ready');
  assert.equal(g.consumer.id, 'dev');
  assert.equal(g.rejectLabel, 'rework');
  assert.ok(g.rejectTriggerId);
});

test('non-gate edges are not review-gate shaped', () => {
  const graph = graphOf(freshBundle());
  assert.equal(isReviewGateEdge({ on: 'label', from: 'ba', to: 'dev', label: 'x' }, graph), false);
  assert.equal(isReviewGateEdge({ on: 'github', from: 'ba', to: 'dev', artifact: 'pr' }, graph), false);
  assert.equal(isReviewGateEdge({ on: 'dependency', from: 'ba', to: 'dev' }, graph), false);
});

// ── #1036: a PLAIN agent→human delivery (no gate) also reaches the editor ────

test('a plain agent→human delivery (no gate label / consumer) is review-gate shaped', async () => {
  // Just the delivery leg — the person reviews the PR, nothing wired downstream.
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  await submitAgentToPerson(ctx, { from: 'ba', human: 'p', entry: { artifact: 'pr', from: 'ba' } });

  const g = findReviewGate({ on: 'github', audience: 'human', from: 'ba', to: 'p', artifact: 'pr' }, graphOf(bundle));
  assert.ok(g, 'a plain delivery must open the human-aware editor, not the channel dialog');
  assert.equal(g.human.id, 'p');
  assert.equal(g.producer.id, 'ba');
  assert.equal(g.artifact, 'pr');
  assert.equal(g.gateLabel, null, 'no gate label on a plain delivery');
  assert.equal(g.consumer, null, 'no downstream consumer on a plain delivery');
});

test('the delivery edge must carry `audience` to reach the editor (the #1036 hit-payload contract)', () => {
  // The canvas hit payload (flow-graph-render.js) MUST copy `audience` from the
  // source-of-truth edge; without it the click falls through to the agent→agent
  // EditChannelDialog and Remove is a silent no-op.
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  // wire a delivery so the human actually consumes ba's PR
  return submitAgentToPerson(ctx, { from: 'ba', human: 'p', entry: { artifact: 'pr', from: 'ba' } }).then(() => {
    const graph = graphOf(bundle);
    assert.equal(
      isReviewGateEdge({ on: 'github', from: 'ba', to: 'p', artifact: 'pr' }, graph), false,
      'without `audience` the delivery is indistinguishable from an agent→agent channel',
    );
    assert.equal(
      isReviewGateEdge({ on: 'github', audience: 'human', from: 'ba', to: 'p', artifact: 'pr' }, graph), true,
      'with `audience:human` the delivery routes to the human-aware editor',
    );
  });
});

test('deleteReviewGate on a plain delivery removes only that delivery — a second one survives', async () => {
  // Human with two deliveries (pr·ba and pr·dev); removing one leaves the other.
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  await submitAgentToPerson(ctx, { from: 'ba', human: 'p', entry: { artifact: 'pr', from: 'ba' } });
  await submitAgentToPerson(ctx, { from: 'dev', human: 'p', entry: { artifact: 'pr', from: 'dev' } });

  // Each edge resolves ITS OWN producer, not just the first consume.
  const gBa = findReviewGate({ on: 'github', audience: 'human', from: 'ba', to: 'p', artifact: 'pr' }, graphOf(bundle));
  const gDev = findReviewGate({ on: 'github', audience: 'human', from: 'dev', to: 'p', artifact: 'pr' }, graphOf(bundle));
  assert.equal(gBa.producer.id, 'ba');
  assert.equal(gDev.producer.id, 'dev', 'the clicked delivery disambiguates the producer');

  await deleteReviewGate(ctx, gDev);

  const p = bundle.humans.find(h => h.id === 'p');
  assert.deepEqual(p.consumes, [{ artifact: 'pr', from: 'ba' }], 'only the clicked delivery is gone');
  assert.equal(p.emits, undefined, 'no gate emits touched');
});

// ── UI-level convergence (§4.5 / §5) ────────────────────────────────────────

test('S3 convergence: one-dialog (channel+approver) ≡ one-dialog (delivery+wake) ≡ two drags', async () => {
  // Path A1: agent→agent channel dialog with a named approver.
  const a1 = freshBundle();
  await submitChannelWithApproval(makeDraftLike(a1), { from: 'ba', to: 'dev', artifact: 'issue', label: 'ready', human: 'p' });

  // Path A2: agent→person dialog with the inline "on approval, wake…".
  const a2 = freshBundle();
  await submitAgentToPerson(makeDraftLike(a2), {
    from: 'ba', human: 'p', entry: { artifact: 'issue', from: 'ba' },
    wake: { to: 'dev', gateLabel: 'ready' },
  });

  // Path B: two gestures — delivery first, then the person→agent gate.
  const b = freshBundle();
  const cb = makeDraftLike(b);
  await submitAgentToPerson(cb, { from: 'ba', human: 'p', entry: { artifact: 'issue', from: 'ba' } });
  await submitPersonToAgent(cb, { human: 'p', to: 'dev', label: 'ready', kind: 'issues' });

  assert.deepEqual(projectBundle(a2), projectBundle(a1), 'delivery+wake diverged from channel+approver');
  assert.deepEqual(projectBundle(b), projectBundle(a1), 'two-drag path diverged from one-dialog path');
});

test('channel dialog without a named approver degrades to the anonymously gated channel', async () => {
  const bundle = freshBundle();
  await submitChannelWithApproval(makeDraftLike(bundle), { from: 'ba', to: 'dev', artifact: 'pr', label: 'ok', human: null, gate: true });
  const dev = bundle.roles.find(r => r.id === 'dev');
  assert.deepEqual(dev.channels, [{ artifact: 'pr', from: 'ba', label: 'ok', gate: 'human' }]);
  assert.equal(bundle.humans.find(h => h.id === 'p').emits, undefined, 'no human leg wired');
});

test('person→agent rejection path wires the second gate leg', async () => {
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  await ctx.humanOps.wireHumanConsume('p', { artifact: 'pr', from: 'ba' });
  await submitPersonToAgent(ctx, { human: 'p', to: 'dev', label: 'ship-it', kind: 'pull_request', reject: { to: 'ba', label: 'rework' } });
  const ba = bundle.roles.find(r => r.id === 'ba');
  const rej = ba.triggers.find(t => t.labelFilter === 'rework');
  assert.deepEqual(rej.events, ['pull_request.labeled']);
  assert.deepEqual(bundle.humans.find(h => h.id === 'p').emits, ['ship-it', 'rework']);
});

// ── editor operations ───────────────────────────────────────────────────────

test('setGateClaim toggles the listener claim; renameGateLabel rewires the gate leg', async () => {
  const bundle = freshBundle();
  const ctx = await wireTriangle(bundle);
  let g = findReviewGate({ on: 'label', from: 'p', to: 'dev', label: 'ready' }, graphOf(bundle));

  await setGateClaim(ctx, { to: 'dev', triggerId: g.gateTriggerId, label: 'ready', on: false });
  const t = bundle.roles.find(r => r.id === 'dev').triggers[0];
  assert.equal(t.claim, null);
  await setGateClaim(ctx, { to: 'dev', triggerId: g.gateTriggerId, label: 'ready', on: true });
  assert.deepEqual(bundle.roles.find(r => r.id === 'dev').triggers[0].claim, { remove: 'ready', add: 'ready:wip' });

  await renameGateLabel(ctx, { human: 'p', to: 'dev', oldLabel: 'ready', oldTriggerId: g.gateTriggerId, newLabel: 'approved', kind: 'issues' });
  g = findReviewGate({ on: 'github', audience: 'human', from: 'ba', to: 'p', artifact: 'issue' }, graphOf(bundle));
  assert.equal(g.gateLabel, 'approved');
  assert.deepEqual(bundle.humans.find(h => h.id === 'p').emits, ['approved']);
  assert.equal(bundle.roles.find(r => r.id === 'dev').triggers.length, 1, 'old listener replaced, not duplicated');
});

test('rejection path add/remove is symmetric', async () => {
  const bundle = freshBundle();
  const ctx = await wireTriangle(bundle);
  await addRejectionPath(ctx, { human: 'p', producerId: 'ba', label: 'rework', kind: 'issues' });
  let g = findReviewGate({ on: 'label', from: 'p', to: 'dev', label: 'ready' }, graphOf(bundle));
  assert.equal(g.rejectLabel, 'rework');
  await removeRejectionPath(ctx, { human: 'p', producerId: 'ba', label: 'rework', triggerId: g.rejectTriggerId });
  g = findReviewGate({ on: 'label', from: 'p', to: 'dev', label: 'ready' }, graphOf(bundle));
  assert.equal(g.rejectLabel, null);
  assert.deepEqual(bundle.roles.find(r => r.id === 'ba').triggers, []);
});

test('deleteReviewGate cleans all three sides — no orphaned writes (§4.4)', async () => {
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  await submitAgentToPerson(ctx, {
    from: 'ba', human: 'p', entry: { artifact: 'issue', from: 'ba' },
    wake: { to: 'dev', gateLabel: 'ready', rejectLabel: 'rework' },
  });
  const g = findReviewGate({ on: 'label', from: 'p', to: 'dev', label: 'ready' }, graphOf(bundle));
  await deleteReviewGate(ctx, g);

  const p = bundle.humans.find(h => h.id === 'p');
  assert.equal(p.emits, undefined, 'no orphaned human emits');
  assert.equal(p.consumes, undefined, 'no orphaned delivery consume');
  assert.deepEqual(bundle.roles.find(r => r.id === 'dev').triggers, [], 'no orphaned gate listener');
  assert.deepEqual(bundle.roles.find(r => r.id === 'ba').triggers, [], 'no orphaned rejection listener');
  // The producer's outcome (what it opens) stays — authored on the role (#1003).
  assert.ok(bundle.roles.find(r => r.id === 'ba').outcomes.options.some(o => o.actions.some(a => a.type === 'openIssue')));
});
