import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesListener,
  wireLabelHandoff, updateLabelHandoff, unwireLabelHandoff,
  wireChannel, unwireChannel,
  wireHumanDelivery, unwireHumanDelivery, moveHumanDelivery,
  wireHumanGate, wireReviewGate, unwireReviewGate,
  wireEscalation, unwireEscalation,
  wireArtifactFlow, unwireArtifactFlow,
  wireWakeHandoff, updateWakeHandoff, unwireWakeHandoff,
} from './wiring-engine.js';
import {
  makeDraftLike, makeLiveLike, project, freshBundle, freshStore, onBoth, clone, artKey,
} from './test-fakes.js';

// #1002 — the wiring engine: every convention exactly once, convergence and
// idempotence over both adapter shapes (§4.5, §8.3 rule 2).

// ── label hand-off ──────────────────────────────────────────────────────────

test('wireLabelHandoff: single-event claimed listener + outcome, idempotent', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'ready', prompt: 'go' });
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'ready', prompt: 'go' }); // re-run: no-op
  });
  const dev = state.roles.dev;
  assert.equal(dev.triggers.length, 1, 'exactly one listener after two identical wires');
  const t = dev.triggers[0];
  assert.deepEqual(t.events, ['issues.labeled']);
  assert.equal(t.labelFilter, 'ready');
  assert.deepEqual(t.claim, { remove: 'ready', add: 'ready:wip' });
  const ba = state.roles.ba;
  assert.equal(ba.outcomes.options.length, 1);
  assert.deepEqual(ba.outcomes.options[0].actions, [{ type: 'setLabel', label: 'ready' }]);
});

test('wireLabelHandoff: claim rules — opt-out, unlabeled, PR kind', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'a', autoClaim: false, prompt: 'x' });
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'b', action: 'unlabeled', prompt: 'x' });
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'c', target: 'pull_request', prompt: 'x' });
  });
  const [ta, tb, tc] = ['a', 'b', 'c'].map(l => state.roles.dev.triggers.find(t => t.labelFilter === l));
  assert.equal('claim' in ta, false, 'autoClaim: false leaves no claim');
  assert.equal('claim' in tb, false, 'an unlabeled listener has no wake label to claim');
  assert.deepEqual(tc.events, ['pull_request.labeled']);
  assert.deepEqual(tc.claim, { remove: 'c', add: 'c:wip' });
});

test('wireLabelHandoff: a gate/brake label wires the listener only (no agent emit)', async () => {
  const labels = [{ name: 'approved', humanGate: true }];
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'approved', labels, prompt: 'x' });
  });
  assert.equal(state.roles.ba.outcomes, null, 'no outcome recorded for a human-set label');
  const t = state.roles.dev.triggers[0];
  assert.equal(t.description, 'Wait for human gate `approved`');
  assert.deepEqual(t.claim, { remove: 'approved', add: 'approved:wip' });
});

test('wireLabelHandoff reuses a template-preset listener instead of duplicating (§8.3 rule 2)', async () => {
  const preset = {
    type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready',
    enabled: true, prompt: 'template preset', id: 'preset-1',
  };
  const bundle = freshBundle();
  bundle.roles[1].triggers = [clone(preset)];
  const ctx = makeDraftLike(bundle);
  await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'ready', prompt: 'new text' });
  assert.equal(bundle.roles[1].triggers.length, 1, 'preset reused, not duplicated');
  assert.equal(bundle.roles[1].triggers[0].prompt, 'template preset', 'preset left untouched');
});

test('updateLabelHandoff renames listener and keeps the source outcomes in sync', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'old', prompt: 'x' });
    const [t] = await ctx.ops.listTriggers('dev');
    await updateLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: t.id, label: 'old', newLabel: 'new', prompt: 'x' });
  });
  assert.equal(state.roles.dev.triggers[0].labelFilter, 'new');
  assert.deepEqual(state.roles.ba.outcomes.options[0].actions, [{ type: 'setLabel', label: 'new' }]);
  assert.equal(state.roles.ba.outcomes.options[0].id, 'new');
});

test('unwireLabelHandoff removes listener and emit symmetrically; last option clears the port', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'ready', prompt: 'x' });
    const [t] = await ctx.ops.listTriggers('dev');
    await unwireLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: t.id, label: 'ready' });
  });
  assert.deepEqual(state.roles.dev.triggers, []);
  assert.equal(state.roles.ba.outcomes, null, 'empty outcomes port cleared, not left as {options: []}');
});

// ── channel ─────────────────────────────────────────────────────────────────

test('wireChannel: producer outcome (badge projection source) + channel port, idempotent', async () => {
  const state = await onBoth(async (ctx) => {
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr', label: 'ready', gate: 'human' });
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr', label: 'ready', gate: 'human' });
  });
  // #1003: the produce badge is a projection of the outcome — no github write.
  assert.equal(state.roles.ba.github, null, 'engine never writes github.produces*');
  assert.deepEqual(state.roles.ba.outcomes.options, [
    { id: 'opens-pr', title: 'Opens PR', actions: [{ type: 'openPr' }] },
  ]);
  assert.deepEqual(state.roles.dev.channels, [{ artifact: 'pr', from: 'ba', label: 'ready', gate: 'human' }]);
});

test('wireChannel reuses an existing outcome carrying the action, whatever its id', async () => {
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', {
      mode: 'anyOf',
      options: [{ id: 'ticket', title: 'Files a ticket', actions: [{ type: 'openIssue' }] }],
    });
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'issue' });
  });
  assert.equal(state.roles.ba.outcomes.options.length, 1, 'authored outcome reused, not duplicated');
  assert.equal(state.roles.ba.outcomes.options[0].id, 'ticket');
});

test('unwireChannel removes the port; the producer outcome (and its badge) stays', async () => {
  const state = await onBoth(async (ctx) => {
    await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'issue', label: 'go' });
    await unwireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'issue' });
  });
  assert.deepEqual(state.roles.dev.channels, []);
  assert.ok(state.roles.ba.outcomes.options.some(o => o.actions.some(a => a.type === 'openIssue')),
    'what a role opens is authored on the role, not implied by consumers');
});

// ── human delivery ──────────────────────────────────────────────────────────

test('wireHumanDelivery: PR/issue ensures the producer outcome, file does not; move + unwire', async () => {
  const state = await onBoth(async (ctx) => {
    await wireHumanDelivery(ctx, { human: 'p', entry: { artifact: 'issue', from: 'ba' } });
    await wireHumanDelivery(ctx, { human: 'p', entry: { artifact: 'file', name: 'report' } });
    await moveHumanDelivery(ctx, { entry: { artifact: 'file', name: 'report' }, fromHuman: 'p', toHuman: 'p' }); // same → no-op
    await unwireHumanDelivery(ctx, { human: 'p', entry: { artifact: 'file', name: 'report' } });
  });
  assert.equal(state.roles.ba.github, null);
  assert.ok(state.roles.ba.outcomes.options.some(o => o.actions.some(a => a.type === 'openIssue')));
  assert.deepEqual(state.humans[0].consumes, [{ artifact: 'issue', from: 'ba' }]);
});

test('#1197: wireHumanDelivery with a {label} entry records a plain consume, no producer outcome, idempotent + unwire', async () => {
  const state = await onBoth(async (ctx) => {
    await wireHumanDelivery(ctx, { human: 'p', entry: { label: 'ready-for-review' } });
    await wireHumanDelivery(ctx, { human: 'p', entry: { label: 'ready-for-review' } }); // re-run: dedup
  });
  // A label consume is NOT a PR/issue delivery — the producer gets no openPr/openIssue outcome.
  assert.equal(state.roles.ba.github, null);
  assert.ok(!state.roles.ba.outcomes, 'no artifact outcome is forced for a label-only delivery');
  assert.deepEqual(state.humans[0].consumes, [{ label: 'ready-for-review' }]);

  const after = await onBoth(async (ctx) => {
    await wireHumanDelivery(ctx, { human: 'p', entry: { label: 'ready-for-review' } });
    await unwireHumanDelivery(ctx, { human: 'p', entry: { label: 'ready-for-review' } });
  });
  assert.equal(after.humans[0]?.consumes, undefined);
});

// ── human gate ──────────────────────────────────────────────────────────────

test('wireHumanGate: kind defaults from what the person reviews; idempotent; emit recorded', async () => {
  const state = await onBoth(async (ctx) => {
    await wireHumanDelivery(ctx, { human: 'p', entry: { artifact: 'pr', from: 'ba' } });
    await wireHumanGate(ctx, { human: 'p', to: 'dev', label: 'approved' }); // no kind → from consumes → PR
    await wireHumanGate(ctx, { human: 'p', to: 'dev', label: 'approved' }); // re-run: no duplicate
  });
  assert.equal(state.roles.dev.triggers.length, 1);
  const t = state.roles.dev.triggers[0];
  assert.deepEqual(t.events, ['pull_request.labeled']);
  assert.deepEqual(t.claim, { remove: 'approved', add: 'approved:wip' });
  assert.deepEqual(state.humans[0].emits, ['approved']);
});

// ── review gate: the S3 triangle ────────────────────────────────────────────

test('wireReviewGate wires the whole triangle in one call (+ rejection leg)', async () => {
  const state = await onBoth(async (ctx) => {
    await wireReviewGate(ctx, { from: 'ba', human: 'p', to: 'dev', artifact: 'issue', gateLabel: 'ready', rejectLabel: 'rework' });
  });
  // A: artifact outcome (whose projection is the produce badge — no flag write).
  assert.ok(state.roles.ba.outcomes.options.some(o => o.actions.some(a => a.type === 'openIssue')));
  assert.equal(state.roles.ba.github, null);
  // P: reviews the issue, owns the gate + rejection labels.
  assert.deepEqual(state.humans[0].consumes, [{ artifact: 'issue', from: 'ba' }]);
  assert.deepEqual(state.humans[0].emits, ['ready', 'rework']);
  // B: claimed single-event listener on the gate label.
  const gate = state.roles.dev.triggers.find(t => t.labelFilter === 'ready');
  assert.deepEqual(gate.events, ['issues.labeled']);
  assert.deepEqual(gate.claim, { remove: 'ready', add: 'ready:wip' });
  // A: rejection listener, same artifact kind, also claimed.
  const rej = state.roles.ba.triggers.find(t => t.labelFilter === 'rework');
  assert.deepEqual(rej.events, ['issues.labeled']);
  assert.deepEqual(rej.claim, { remove: 'rework', add: 'rework:wip' });
});

test('convergence (§4.5): assembly orders and re-runs produce identical persisted state', async () => {
  const spec = { from: 'ba', human: 'p', to: 'dev', artifact: 'pr', gateLabel: 'ship-it' };

  // Order 1: the one-call triangle.
  const b1 = freshBundle();
  await wireReviewGate(makeDraftLike(b1), spec);

  // Order 2: legs first (delivery, then gate), then the triangle call on top.
  const b2 = freshBundle();
  const c2 = makeDraftLike(b2);
  await wireHumanDelivery(c2, { human: 'p', entry: { artifact: 'pr', from: 'ba' } });
  await wireHumanGate(c2, { human: 'p', to: 'dev', label: 'ship-it' });
  await wireReviewGate(c2, spec);

  // Order 3: gate before delivery, triangle twice (idempotence on top).
  const b3 = freshBundle();
  const c3 = makeDraftLike(b3);
  await wireHumanGate(c3, { human: 'p', to: 'dev', label: 'ship-it', kind: 'pull_request' });
  await wireReviewGate(c3, spec);
  await wireReviewGate(c3, spec);

  const p = (b) => project(Object.fromEntries(b.roles.map(r => [r.id, r])), b.humans);
  assert.deepEqual(p(b2), p(b1), 'legs-then-triangle diverged from one-call triangle');
  assert.deepEqual(p(b3), p(b1), 'gate-first + double triangle diverged from one-call triangle');
});

test('unwireReviewGate cleans up all legs — no leftovers', async () => {
  const state = await onBoth(async (ctx) => {
    await wireReviewGate(ctx, { from: 'ba', human: 'p', to: 'dev', artifact: 'issue', gateLabel: 'ready', rejectLabel: 'rework' });
    const gate = (await ctx.ops.listTriggers('dev')).find(t => t.labelFilter === 'ready');
    const rej = (await ctx.ops.listTriggers('ba')).find(t => t.labelFilter === 'rework');
    await unwireReviewGate(ctx, {
      from: 'ba', human: 'p', to: 'dev', artifact: 'issue',
      gateLabel: 'ready', gateTriggerId: gate.id,
      rejectLabel: 'rework', rejectTriggerId: rej.id,
    });
  });
  assert.deepEqual(state.roles.dev.triggers, []);
  assert.deepEqual(state.roles.ba.triggers, []);
  assert.equal(state.humans[0].consumes, undefined);
  assert.equal(state.humans[0].emits, undefined);
  // The producer's outcome stays — the gate is gone, what BA opens is not.
  assert.ok(state.roles.ba.outcomes.options.some(o => o.actions.some(a => a.type === 'openIssue')));
});

// ── escalation ──────────────────────────────────────────────────────────────

test('wireEscalation binds the outcome\'s brake label to the person; unwire removes it', async () => {
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', {
      mode: 'anyOf',
      options: [{ id: 'stuck', title: 'Stuck', actions: [{ type: 'setLabel', label: 'needs-decision' }] }],
    });
    const label = await wireEscalation(ctx, { from: 'ba', human: 'p', outcomeId: 'stuck' });
    assert.equal(label, 'needs-decision');
  });
  assert.deepEqual(state.humans[0].consumes, [{ label: 'needs-decision' }]);
  await onBoth(async (ctx) => {
    await ctx.humanOps.wireHumanConsume('p', { label: 'x' });
    await unwireEscalation(ctx, { human: 'p', label: 'x' });
  });
});

test('wireEscalation rejects an outcome without a label', async () => {
  const ctx = makeDraftLike(freshBundle());
  await ctx.ops.setRoleOutcomes('ba', { mode: 'anyOf', options: [{ id: 'done', actions: [{ type: 'openPr' }] }] });
  await assert.rejects(() => wireEscalation(ctx, { from: 'ba', human: 'p', outcomeId: 'done' }), /no label to bind/);
});

// ── data flow ───────────────────────────────────────────────────────────────

test('wireArtifactFlow: named, path-keyed and plain-dependency variants; idempotent; unwire', async () => {
  const state = await onBoth(async (ctx) => {
    await wireArtifactFlow(ctx, { from: 'ba', to: 'dev', name: 'design', hint: 'docs/design.md' });
    await wireArtifactFlow(ctx, { from: 'ba', to: 'dev', name: 'design', hint: 'docs/design.md' }); // no-op
    await wireArtifactFlow(ctx, { from: 'ba', to: 'dev', name: '', hint: 'out/report.md' });        // path-keyed
    await wireArtifactFlow(ctx, { from: 'ba', to: 'dev' });                                          // plain dependency
  });
  assert.deepEqual(state.roles.ba.outputs.map(artKey), ['design', 'out/report.md']);
  assert.deepEqual(state.roles.dev.inputs.map(artKey), ['design', 'out/report.md']);
  assert.deepEqual(state.roles.dev.dependsOn, ['ba']);

  const after = await onBoth(async (ctx) => {
    await wireArtifactFlow(ctx, { from: 'ba', to: 'dev', name: 'design' });
    await unwireArtifactFlow(ctx, { from: 'ba', to: 'dev', name: 'design' });
  });
  assert.deepEqual(after.roles.ba.outputs, []);
  assert.deepEqual(after.roles.dev.inputs, []);
});

// ── shared helpers ──────────────────────────────────────────────────────────

test('matchesListener keys on (label, event) over github-event triggers only', () => {
  const t = { type: 'github-event', labelFilter: 'x', events: ['issues.labeled'] };
  assert.equal(matchesListener(t, { label: 'x', event: 'issues.labeled' }), true);
  assert.equal(matchesListener(t, { label: 'x', event: 'pull_request.labeled' }), false);
  assert.equal(matchesListener({ ...t, type: 'cron' }, { label: 'x', event: 'issues.labeled' }), false);
  assert.equal(matchesListener(null, { label: 'x', event: 'issues.labeled' }), false);
});

test('the engine never calls setGithubProduces — produces* is a projection (#1003)', async () => {
  const bundle = freshBundle();
  const ctx = makeDraftLike(bundle);
  let flagWrites = 0;
  ctx.ops.setGithubProduces = async () => { flagWrites++; };
  await wireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr' });
  await wireHumanDelivery(ctx, { human: 'p', entry: { artifact: 'issue', from: 'ba' } });
  await wireReviewGate(ctx, { from: 'ba', human: 'p', to: 'dev', artifact: 'pr', gateLabel: 'ok' });
  await unwireChannel(ctx, { from: 'ba', to: 'dev', artifact: 'pr' });
  assert.equal(flagWrites, 0);
});

// ── #1174: internal-channel delivery on label hand-offs ─────────────────────

test('wireLabelHandoff: transport internal lands on the listener; default writes none', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'ready', prompt: 'go', transport: 'internal' });
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'plain', prompt: 'go' });
  });
  const internal = state.roles.dev.triggers.find(t => t.labelFilter === 'ready');
  const plain = state.roles.dev.triggers.find(t => t.labelFilter === 'plain');
  assert.equal(internal.transport, 'internal');
  assert.equal('transport' in plain, false, 'default delivery writes no transport field');
  // Claim coexists — the runner swap works on internally delivered wakes too.
  assert.deepEqual(internal.claim, { remove: 'ready', add: 'ready:wip' });
});

test('wireLabelHandoff: a human gate never becomes internal (person sets it on GitHub)', async () => {
  const labels = [{ name: 'approved', humanGate: true }];
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'approved', labels, prompt: 'x', transport: 'internal' });
  });
  assert.equal('transport' in state.roles.dev.triggers[0], false);
});

test('updateLabelHandoff: toggles internal on and back off via an explicit github', async () => {
  const state = await onBoth(async (ctx) => {
    await wireLabelHandoff(ctx, { from: 'ba', to: 'dev', label: 'ready', prompt: 'go' });
    const tid = (await ctx.ops.listTriggers('dev'))[0].id;
    await updateLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: tid, label: 'ready', newLabel: 'ready', prompt: 'go', transport: 'internal' });
    const mid = (await ctx.ops.listTriggers('dev'))[0];
    assert.equal(mid.transport, 'internal', 'toggle on');
    await updateLabelHandoff(ctx, { from: 'ba', to: 'dev', triggerId: tid, label: 'ready', newLabel: 'ready', prompt: 'go', transport: 'github' });
  });
  assert.equal(state.roles.dev.triggers[0].transport, 'github', 'explicit github clears the poller exclusion');
});

// ── direct hand-off (#2031) ─────────────────────────────────────────────────

test('wireWakeHandoff: one wakeAgent action on the producer, idempotent, no consumer write', async () => {
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'mind step 3' });
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'mind step 3' }); // re-run: no-op
  });
  const ba = state.roles.ba;
  assert.equal(ba.outcomes.options.length, 1, 'exactly one option after two wires to the same target');
  assert.deepEqual(ba.outcomes.options[0].actions, [{ type: 'wakeAgent', to: 'dev', note: 'mind step 3' }]);
  assert.equal(ba.outcomes.options[0].id, 'hand-off-dev');
  // The target's wake listener is DERIVED server-side by expandWakeHandoffs on
  // the same save. Creating one here would race that derivation and, because a
  // consumer's instruction is one-per-agent, would be the trigger the runner
  // picks and the reconciler then strips.
  assert.deepEqual(state.roles.dev.triggers, [], 'no listener is written client-side');
});

test('wireWakeHandoff: two targets get two distinct options', async () => {
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
    await wireWakeHandoff(ctx, { from: 'ba', to: 'qa' });
  });
  assert.deepEqual(state.roles.ba.outcomes.options.map(o => o.id), ['hand-off-dev', 'hand-off-qa']);
});

test('wireWakeHandoff: a note-less hand-off writes no note key', async () => {
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
  });
  assert.deepEqual(state.roles.ba.outcomes.options[0].actions, [{ type: 'wakeAgent', to: 'dev' }]);
});

test('wireWakeHandoff: a blank target is refused rather than written', async () => {
  await assert.rejects(
    () => onBoth(async (ctx) => { await wireWakeHandoff(ctx, { from: 'ba', to: '   ' }); }),
    /target role is required/,
  );
});

test('updateWakeHandoff: re-points the target and clears a note with a blank', async () => {
  const repointed = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'first' });
    await updateWakeHandoff(ctx, { from: 'ba', to: 'dev', newTo: 'qa', note: 'second' });
  });
  assert.deepEqual(repointed.roles.ba.outcomes.options[0].actions,
    [{ type: 'wakeAgent', to: 'qa', note: 'second' }]);

  const cleared = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'first' });
    await updateWakeHandoff(ctx, { from: 'ba', to: 'dev', note: '  ' });
  });
  // "no note" and "an empty note" must not be two states — the key is dropped.
  assert.deepEqual(cleared.roles.ba.outcomes.options[0].actions, [{ type: 'wakeAgent', to: 'dev' }]);
});

test('updateWakeHandoff: matches the CURRENT target, not the option id', async () => {
  // The option may have been renamed by hand since it was wired, and the action
  // is what the canvas edge is built from.
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', { mode: 'anyOf', options: [
      { id: 'renamed-by-hand', title: 'Ship it', actions: [{ type: 'wakeAgent', to: 'dev' }] },
    ] });
    await updateWakeHandoff(ctx, { from: 'ba', to: 'dev', newTo: 'qa' });
  });
  const [o] = state.roles.ba.outcomes.options;
  assert.equal(o.id, 'renamed-by-hand', 'the hand-given id survives');
  assert.deepEqual(o.actions, [{ type: 'wakeAgent', to: 'qa' }]);
});

test('unwireWakeHandoff: strips the action, drops an emptied option, clears an emptied port', async () => {
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
    await unwireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
  });
  assert.ok(!state.roles.ba.outcomes || !(state.roles.ba.outcomes.options || []).length,
    'the last hand-off leaves no dangling { options: [] }');
});

test('unwireWakeHandoff: an option that ALSO sets a label keeps the label', async () => {
  // §11: the two mechanisms may sit in one outcome option. Removing the wake
  // must not remove the label hand-off with it.
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', { mode: 'anyOf', options: [
      { id: 'shipped', actions: [{ type: 'setLabel', label: 'ready' }, { type: 'wakeAgent', to: 'dev' }] },
    ] });
    await unwireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
  });
  assert.deepEqual(state.roles.ba.outcomes.options,
    [{ id: 'shipped', actions: [{ type: 'setLabel', label: 'ready' }] }]);
});

test('unwireWakeHandoff: removes only the named target', async () => {
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
    await wireWakeHandoff(ctx, { from: 'ba', to: 'qa' });
    await unwireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
  });
  assert.deepEqual(state.roles.ba.outcomes.options.map(o => o.id), ['hand-off-qa']);
});

// ── #2031 review findings: the ops must scope to the clicked hand-off ───────

test('updateWakeHandoff: scoped to `outcome`, so a sibling hand-off is untouched', async () => {
  // The canvas draws TWO edges here (edgeId keys wake edges on the outcome) and
  // wakeChipText disambiguates them — so a click on one that rewrote both would
  // be a silent data loss on an edge the user never touched.
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', { mode: 'anyOf', options: [
      { id: 'approved', actions: [{ type: 'wakeAgent', to: 'dev', note: 'looks good' }] },
      { id: 'second-look', actions: [{ type: 'wakeAgent', to: 'dev', note: 'needs eyes' }] },
    ] });
    await updateWakeHandoff(ctx, { from: 'ba', to: 'dev', outcome: 'approved', newTo: 'qa', note: 'looks good' });
  });
  const byId = Object.fromEntries(state.roles.ba.outcomes.options.map(o => [o.id, o.actions]));
  assert.deepEqual(byId.approved, [{ type: 'wakeAgent', to: 'qa', note: 'looks good' }]);
  assert.deepEqual(byId['second-look'], [{ type: 'wakeAgent', to: 'dev', note: 'needs eyes' }],
    'the sibling keeps its target AND its note');
});

test('unwireWakeHandoff: scoped to `outcome`, so a sibling hand-off survives', async () => {
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', { mode: 'anyOf', options: [
      { id: 'approved', actions: [{ type: 'wakeAgent', to: 'dev' }] },
      { id: 'second-look', actions: [{ type: 'wakeAgent', to: 'dev' }] },
    ] });
    await unwireWakeHandoff(ctx, { from: 'ba', to: 'dev', outcome: 'approved' });
  });
  assert.deepEqual(state.roles.ba.outcomes.options.map(o => o.id), ['second-look']);
});

test('#2031: with no `outcome` the ops fall back to matching every hand-off to the target', async () => {
  // The legacy / imported-data path: without an outcome there is nothing else to
  // match on, so "this hand-off" honestly means all of them.
  const state = await onBoth(async (ctx) => {
    await ctx.ops.setRoleOutcomes('ba', { mode: 'anyOf', options: [
      { id: 'a', actions: [{ type: 'wakeAgent', to: 'dev' }] },
      { id: 'b', actions: [{ type: 'wakeAgent', to: 'dev' }] },
    ] });
    await unwireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
  });
  assert.ok(!state.roles.ba.outcomes || !(state.roles.ba.outcomes.options || []).length);
});

test('#2031: re-wiring an existing hand-off APPLIES a supplied note instead of dropping it', async () => {
  // The edge chooser's one-click tile for an already-wired hand-off is titled
  // "edit the note it hands over" and pre-fills it; a bare idempotent return
  // accepted the edit, closed the panel with no error, and discarded it.
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'first' });
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'second' });
  });
  assert.equal(state.roles.ba.outcomes.options.length, 1, 'still exactly one option');
  assert.deepEqual(state.roles.ba.outcomes.options[0].actions,
    [{ type: 'wakeAgent', to: 'dev', note: 'second' }]);
});

test('#2031: re-wiring with NO note leaves an existing note alone', async () => {
  // Clearing a note is the Edit dialog's job (it passes one explicitly); a plain
  // re-wire must not wipe a note nobody was editing.
  const state = await onBoth(async (ctx) => {
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev', note: 'keep me' });
    await wireWakeHandoff(ctx, { from: 'ba', to: 'dev' });
  });
  assert.deepEqual(state.roles.ba.outcomes.options[0].actions,
    [{ type: 'wakeAgent', to: 'dev', note: 'keep me' }]);
});
