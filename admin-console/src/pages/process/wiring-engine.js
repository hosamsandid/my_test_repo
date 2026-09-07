// wiring-engine.js — the ONE composite-ops module for every hand-off write
// (#1002, concept §4.1/§4.5; Phase 1 of the flow-wiring UX unification).
//
// Structural diagnosis (concept §2): every wiring dialog used to re-implement
// the multi-write hand-off sequence locally, so conventions (single event,
// claim stamping, produce flags, registry updates, cleanup) existed N times and
// every new dialog generation missed some — the #987 regression was the fourth
// instance of that bug class. This module encodes each convention exactly once:
//
//   * one event per trigger, picked from artifact context — never both kinds;
//   * claim auto-stamp `deriveClaim(label)` on `.labeled` listeners, with an
//     `autoClaim: false` opt-out (mirrors the server's channel expander);
//   * produce-flag / outcome consistency (flags never silently dropped, orphan
//     flags cleaned up on unwire);
//   * gate/brake classification from the label registry, never the label name;
//   * dedupe/reuse keying so re-running a gesture is idempotent and template-
//     preset listeners are reused, never duplicated (§8.3 rule 2).
//
// Every function takes the mode's adapters (`ops`, `humanOps`) as its first
// argument and never branches on draft/live/BP mode — the adapter contract is
// unchanged. Pure + framework-free so the convergence guarantee (§4.5: all
// assembly orders produce identical persisted state) is unit-testable.

import { deriveClaim, defaultGateKind, buildGateListener } from './human-gate-ops.js';
import { isGateLabel, isBrakeLabel } from './label-flags.js';
import { defaultListenerPrompt, handoffVerb, handoffTargetNoun } from './handoff-prompt.js';

export { deriveClaim, defaultGateKind };

// ── shared keying ───────────────────────────────────────────────────────────

// The listener reuse predicate: one label listener per (label, event) on a
// node. Template-preset triggers match the same key, so wiring a hand-off onto
// a role whose template already ships the listener reuses it (§8.3 rule 2).
export function matchesListener(t, { label, event }) {
  return !!t && t.type === 'github-event'
    && t.labelFilter === label
    && Array.isArray(t.events) && t.events.includes(event);
}

async function findListener(ops, roleId, key) {
  const triggers = await ops.listTriggers(roleId);
  return (Array.isArray(triggers) ? triggers : []).find(t => matchesListener(t, key)) || null;
}

// A `.labeled` listener claims its wake label unless the author opted out; an
// `.unlabeled` listener has no wake label to take over. The claim shape itself
// comes from `deriveClaim` (client mirror of api/process-template.js).
function claimFor(event, label, autoClaim) {
  if (autoClaim === false) return null;
  if (!String(event || '').endsWith('.labeled')) return null;
  return deriveClaim(label);
}

// `github.produces*` is a pure projection of `openPr`/`openIssue` outcome
// actions (#1003, finishes #784 decision 3): the engine records what a role
// opens as an OUTCOME — the badge, channel-recommendation tiles, prompt blocks
// and graph edges all read the projection (`outcomesToGithub` server-side).
// No UI path writes the flags directly anymore.

// Upsert a setLabel outcome on the producer — the structured successor to flat
// `emits`. Keyed on the label (option id = label, matching every existing
// creation path), so re-wiring the same label is a no-op.
async function ensureLabelOutcome(ops, roleId, label) {
  if (!ops.getRoleOutcomes || !ops.setRoleOutcomes) return;
  const cur = (await ops.getRoleOutcomes(roleId)) || { mode: 'anyOf', options: [] };
  const has = (cur.options || []).some(o =>
    (o.actions || []).some(a => a && a.type === 'setLabel' && a.label === label));
  if (has) return;
  await ops.setRoleOutcomes(roleId, {
    ...cur,
    options: [...(cur.options || []), { id: label, title: label, actions: [{ type: 'setLabel', label }] }],
  });
}

// Upsert an openPr/openIssue outcome on the producer. Reuses any option that
// already carries the action (whatever its id), so template-authored outcomes
// are never duplicated.
async function ensureArtifactOutcome(ops, roleId, artifact) {
  if (!ops.getRoleOutcomes || !ops.setRoleOutcomes) return;
  const action = artifact === 'pr' ? 'openPr' : 'openIssue';
  const cur = (await ops.getRoleOutcomes(roleId)) || { mode: 'anyOf', options: [] };
  const has = (cur.options || []).some(o => (o.actions || []).some(a => a && a.type === action));
  if (has) return;
  const id = artifact === 'pr' ? 'opens-pr' : 'opens-issue';
  const title = artifact === 'pr' ? 'Opens PR' : 'Opens issue';
  await ops.setRoleOutcomes(roleId, {
    ...cur,
    options: [...(cur.options || []), { id, title, actions: [{ type: action }] }],
  });
}

// ── label hand-off: A → label → B ───────────────────────────────────────────

/**
 * Wire "A sets a label that wakes B": single-event listener (+claim) on B and
 * a setLabel outcome on A. A gate/brake label (per the registry) wires the
 * listener only — no agent emits those (#333/#928). `emitSource: false` skips
 * the outcome (outcome-port drags already declare the emit, #828). Idempotent:
 * an existing matching listener/outcome is reused, never duplicated.
 */
export async function wireLabelHandoff({ ops }, { from, to, label, target = 'issues', action = 'labeled', prompt, labels, emitSource = true, autoClaim, repo, fromName, toName, transport }) {
  const l = String(label || '').trim();
  if (!l) throw new Error('label is required');
  const event = `${target}.${action}`;
  const humanLabel = isGateLabel(labels, l) || isBrakeLabel(labels, l);

  const existing = await findListener(ops, to, { label: l, event });
  if (!existing) {
    const claim = humanLabel ? deriveClaim(l) : claimFor(event, l, autoClaim);
    await ops.createTrigger(to, {
      type: 'github-event',
      events: [event],
      ...(repo ? { repo } : {}),
      labelFilter: l,
      enabled: true,
      ...(claim ? { claim } : {}),
      // Internal-channel delivery (#1174): the listener is excluded from the
      // poller and woken by /internal/flow-emit (the producer runs `aee-emit`).
      // Never offered for human gates/brakes — a person sets those on GitHub.
      ...(transport === 'internal' && !humanLabel ? { transport: 'internal' } : {}),
      description: humanLabel
        ? `Wait for human gate \`${l}\``
        : `Wake when \`${l}\` is ${handoffVerb(action)} ${handoffTargetNoun(target)} (from ${fromName || from})`,
      prompt: prompt || defaultListenerPrompt({
        label: l, verb: handoffVerb(action), targetNoun: handoffTargetNoun(target),
        repo: '', fromLabel: fromName || from, toLabel: toName || to,
      }),
    });
  }
  if (!humanLabel && emitSource) await ensureLabelOutcome(ops, from, l);
}

/**
 * Edit an existing label hand-off listener (kind/label/prompt) and keep the
 * source's outcomes in sync on a label rename. `humanSource` marks a human-set
 * label — there is no emitter to rewrite.
 */
export async function updateLabelHandoff({ ops }, { from, to, triggerId, label, newLabel, target = 'issues', action = 'labeled', prompt, humanSource, transport }) {
  const next = String(newLabel || '').trim();
  if (!next) throw new Error('label is required');
  const event = `${target}.${action}`;
  // Delivery toggle (#1174): an explicit 'github' is written (not omitted) so
  // flipping internal → github actually clears the exclusion on the merged
  // trigger; absent = caller didn't touch delivery, leave the field alone.
  await ops.updateTrigger(to, triggerId, {
    events: [event], labelFilter: next, prompt,
    ...(transport === 'internal' || transport === 'github' ? { transport } : {}),
  });
  if (next !== label && !humanSource && ops.getRoleOutcomes && ops.setRoleOutcomes) {
    const cur = await ops.getRoleOutcomes(from);
    if (cur) {
      await ops.setRoleOutcomes(from, {
        ...cur,
        options: (cur.options || []).map(o => ({
          ...o,
          actions: (o.actions || []).map(a =>
            a.type === 'setLabel' && a.label === label ? { ...a, label: next } : a),
          id: o.id === label ? next : o.id,
          title: o.title === label ? next : o.title,
        })),
      });
    }
  }
}

/**
 * Remove a label hand-off symmetrically: the listener on B and/or the setLabel
 * outcome on A. Stripping the last outcome option clears the whole port (never
 * a dangling `{options: []}`).
 */
export async function unwireLabelHandoff({ ops }, { from, to, triggerId, label, removeListener = true, removeEmit = true, humanSource }) {
  if (removeListener && triggerId) await ops.deleteTrigger(to, triggerId);
  if (removeEmit && !humanSource && ops.getRoleOutcomes && ops.setRoleOutcomes) {
    const cur = await ops.getRoleOutcomes(from);
    if (cur) {
      const filtered = (cur.options || []).filter(o =>
        !(o.actions || []).some(a => a.type === 'setLabel' && a.label === label));
      await ops.setRoleOutcomes(from, filtered.length ? { ...cur, options: filtered } : null);
    }
  }
}

// ── direct hand-off: A wakes B inside the platform (#2031) ──────────────────
//
// The whole hand-off is ONE `wakeAgent` action on the producer's outcomes port.
// There is deliberately no consumer-side write here — unlike a label hand-off,
// whose listener this engine creates with `ops.createTrigger`, the target's
// `wake-agent` listener is DERIVED server-side by `expandWakeHandoffs` on the
// same outcomes-port save (#2031). Creating one here would race that derivation
// and, because a consumer's instruction is one-per-agent, would be the trigger
// the runner picks and the reconciler then strips.
//
// Keyed on (action type, `to`) so re-wiring the same pair is a no-op — the
// action-keyed shape of `ensureArtifactOutcome`, not the label-keyed shape of
// `ensureLabelOutcome`: a hand-off has no label to name its option after.

// The option id/title for a fresh hand-off. Distinct per target so a producer
// handing off to two agents gets two readable options rather than a collision
// that `finalize()` would silently suffix (`hand-off-2`).
function wakeOptionId(to) { return `hand-off-${to}`; }

async function ensureWakeOutcome(ops, roleId, to, note) {
  if (!ops.getRoleOutcomes || !ops.setRoleOutcomes) return;
  const target = String(to || '').trim();
  if (!target) throw new Error('a target role is required');
  const cur = (await ops.getRoleOutcomes(roleId)) || { mode: 'anyOf', options: [] };
  const has = (cur.options || []).some(o =>
    (o.actions || []).some(a => a && a.type === 'wakeAgent' && a.to === target));
  if (has) return;
  const n = String(note || '').trim();
  await ops.setRoleOutcomes(roleId, {
    ...cur,
    options: [...(cur.options || []), {
      id: wakeOptionId(target),
      title: `Hand off to ${target}`,
      actions: [{ type: 'wakeAgent', to: target, ...(n ? { note: n } : {}) }],
    }],
  });
}

/**
 * Wire "A hands off directly to B": a `wakeAgent` outcome action on A. The
 * target's wake listener is derived server-side, so this is a single write.
 * Idempotent — an existing hand-off to the same target is reused, never doubled.
 */
export async function wireWakeHandoff({ ops }, { from, to, note }) {
  await ensureWakeOutcome(ops, from, to, note);
}

/**
 * Re-point and/or re-note an existing hand-off. Matches on the CURRENT target
 * (`to`) rather than the outcome option id, because the option may have been
 * renamed by hand since it was wired and the action is what the edge is built
 * from. A blank `note` CLEARS it (the key is dropped, never written as '') —
 * "no note" and "an empty note" must not be two states.
 */
export async function updateWakeHandoff({ ops }, { from, to, newTo, note }) {
  if (!ops.getRoleOutcomes || !ops.setRoleOutcomes) return;
  const next = String(newTo == null ? to : newTo).trim();
  if (!next) throw new Error('a target role is required');
  const cur = await ops.getRoleOutcomes(from);
  if (!cur) return;
  const n = String(note || '').trim();
  await ops.setRoleOutcomes(from, {
    ...cur,
    options: (cur.options || []).map(o => ({
      ...o,
      actions: (o.actions || []).map(a => (a && a.type === 'wakeAgent' && a.to === to
        ? { type: 'wakeAgent', to: next, ...(n ? { note: n } : {}) }
        : a)),
    })),
  });
}

/**
 * Remove a hand-off: strip the `wakeAgent` action aimed at `to`. An option left
 * with no actions at all is dropped, and emptying the port clears it entirely
 * (never a dangling `{options: []}`) — the `unwireLabelHandoff` discipline. An
 * option that ALSO sets a label keeps its remaining actions: §11 allows the two
 * mechanisms in one option, so removing the wake must not remove the label with
 * it. The target's derived listener disappears on its own once the last hand-off
 * to it is gone (expandWakeHandoffs strips what it no longer derives).
 */
export async function unwireWakeHandoff({ ops }, { from, to }) {
  if (!ops.getRoleOutcomes || !ops.setRoleOutcomes) return;
  const cur = await ops.getRoleOutcomes(from);
  if (!cur) return;
  const options = (cur.options || [])
    .map(o => ({
      ...o,
      actions: (o.actions || []).filter(a => !(a && a.type === 'wakeAgent' && a.to === to)),
    }))
    .filter(o => (o.actions || []).length > 0);
  await ops.setRoleOutcomes(from, options.length ? { ...cur, options } : null);
}

// ── GitHub channel: A opens a PR/issue that wakes B ─────────────────────────

/**
 * Wire "A opens a PR/issue that wakes B": an openPr/openIssue outcome on A
 * (whose projection is the produce badge) + channel port on B (the backend
 * derives the listener, incl. the claim for labelled channels). Idempotent:
 * the channel port upserts on its (artifact, from, label) key and the outcome
 * is reused when one already carries the action.
 */
export async function wireChannel({ ops }, { from, to, artifact, label, gate, autoClaim, wakePrompt }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  await ensureArtifactOutcome(ops, from, art);
  await ops.addChannel(to, {
    artifact: art, from,
    ...(String(label || '').trim() ? { label: String(label).trim() } : {}),
    ...(gate === 'human' ? { gate: 'human' } : {}),
    ...(typeof wakePrompt === 'string' && wakePrompt.trim() ? { wakePrompt: wakePrompt.trim() } : {}),
    ...(autoClaim === false ? { autoClaim: false } : {}),
  });
}

/** Edit a channel port in place (same (artifact, from, label) key). */
export async function updateChannel({ ops }, { to, spec }) {
  await (ops.updateChannel || ops.addChannel)(to, spec);
}

/**
 * Remove a channel port. The producer's outcome (and thus its projected
 * produce badge) stays — what a role opens is authored on the role, not
 * implied by who consumes it; edit it in the Outcomes editor.
 */
export async function unwireChannel({ ops }, { from, to, artifact, label }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  await ops.removeChannel(to, { artifact: art, from, ...(label !== undefined ? { label } : {}) });
}

// ── human delivery: a person reviews A's PR / issue / file output ───────────

/**
 * Wire a delivery to a named human role: `P.consumes` gains the entry; a
 * PR/issue delivery also ensures A's openPr/openIssue outcome (whose
 * projection is the produce badge — mirrors the channel path).
 * `entry` is `{artifact: 'pr'|'issue', from}` or `{artifact: 'file', name}`.
 */
export async function wireHumanDelivery({ ops, humanOps }, { human, entry }) {
  if ((entry.artifact === 'pr' || entry.artifact === 'issue') && entry.from) {
    await ensureArtifactOutcome(ops, entry.from, entry.artifact);
  }
  await humanOps.wireHumanConsume(human, entry);
}

/** Remove a delivery binding from a human role. */
export async function unwireHumanDelivery({ humanOps }, { human, entry }) {
  await humanOps.unwireHumanConsume(human, entry);
}

/**
 * Move a delivery between human roles (the Routing-tab picker): unwire the
 * current holder, wire the next. Either side may be empty ("— nobody —").
 */
export async function moveHumanDelivery({ humanOps }, { entry, fromHuman, toHuman }) {
  if (fromHuman === toHuman) return;
  if (fromHuman) await humanOps.unwireHumanConsume(fromHuman, entry);
  if (toHuman) await humanOps.wireHumanConsume(toHuman, entry);
}

// ── human gate: P applies a label that wakes B ──────────────────────────────

/**
 * Wire "person P applies a label that wakes B" (#987/#1000): the label joins
 * P's `emits` (making it a gate) and B gets a single-event claimed listener.
 * `kind` defaults from the artifact P already reviews (`defaultGateKind`).
 * Idempotent: an existing matching listener is reused.
 */
export async function wireHumanGate({ ops, humanOps }, { human, to, label, kind }) {
  const l = String(label || '').trim();
  if (!l) throw new Error('label is required');
  let k = kind;
  if (!k && humanOps.getHuman) k = defaultGateKind(await humanOps.getHuman(human));
  // The payload construction (single event, derived claim) lives in the tested
  // #1000 builder — the engine adds the emit and the reuse keying around it.
  const trigger = buildGateListener({ label: l, kind: k });

  await humanOps.addHumanEmit(human, l);
  const existing = await findListener(ops, to, { label: l, event: trigger.events[0] });
  if (!existing) await ops.createTrigger(to, trigger);
}

// ── review gate: the S3 triangle in one call ────────────────────────────────

/**
 * Wire "A opens a PR/issue, P reviews it, on `gateLabel` B wakes" — the whole
 * S3 triangle atomically (concept §4.4): an openPr/openIssue outcome on A,
 * `P.consumes {artifact, from: A}`, `gateLabel` on P's emits, a single-event
 * claimed listener on B, and optionally a rejection listener on A
 * (`rejectLabel`, same artifact kind, also claimed). Composed from the smaller
 * engine ops, so it converges with wiring the legs individually (§4.5).
 */
export async function wireReviewGate(ctx, { from, human, to, artifact, gateLabel, rejectLabel }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  const kind = art === 'pr' ? 'pull_request' : 'issues';
  await ensureArtifactOutcome(ctx.ops, from, art);
  await wireHumanDelivery(ctx, { human, entry: { artifact: art, from } });
  await wireHumanGate(ctx, { human, to, label: gateLabel, kind });
  if (String(rejectLabel || '').trim()) {
    await wireHumanGate(ctx, { human, to: from, label: String(rejectLabel).trim(), kind });
  }
}

/**
 * Remove a review gate symmetrically: the gate emit + listener, the delivery
 * consume, and optionally the rejection leg. The producer's outcome (and its
 * projected badge) stays — edit it in the Outcomes editor.
 */
export async function unwireReviewGate(ctx, { from, human, to, artifact, gateLabel, gateTriggerId, rejectLabel, rejectTriggerId }) {
  const art = artifact === 'issue' ? 'issue' : 'pr';
  if (gateTriggerId) await ctx.ops.deleteTrigger(to, gateTriggerId);
  if (ctx.humanOps.removeHumanEmit && String(gateLabel || '').trim()) {
    await ctx.humanOps.removeHumanEmit(human, String(gateLabel).trim());
  }
  if (rejectTriggerId) await ctx.ops.deleteTrigger(from, rejectTriggerId);
  if (ctx.humanOps.removeHumanEmit && String(rejectLabel || '').trim()) {
    await ctx.humanOps.removeHumanEmit(human, String(rejectLabel).trim());
  }
  await unwireHumanDelivery(ctx, { human, entry: { artifact: art, from } });
}

// ── escalation: a brake outcome bound to a person ───────────────────────────

/**
 * Bind an outcome that pauses the flow (its setLabel is a brake) to the named
 * person who decides it: `P.consumes {label}`. The outcome is looked up by id
 * on A; it must carry a setLabel action.
 */
export async function wireEscalation({ ops, humanOps }, { from, human, outcomeId }) {
  const cur = (await ops.getRoleOutcomes(from)) || { options: [] };
  const opt = (cur.options || []).find(o => o && o.id === outcomeId);
  const label = opt && (opt.actions || []).find(a => a && a.type === 'setLabel' && a.label)?.label;
  if (!label) throw new Error(`outcome ${outcomeId} has no label to bind`);
  await humanOps.wireHumanConsume(human, { label });
  return label;
}

/** Remove an escalation binding. */
export async function unwireEscalation({ humanOps }, { human, label }) {
  await humanOps.unwireHumanConsume(human, { label });
}

// ── data flow: A produces an artifact that B consumes ───────────────────────

/**
 * Wire a data-flow hand-off. With a name: a name-keyed artifact (output on A,
 * input on B — path is a hint). With only a path: a path-keyed artifact. With
 * neither: a plain ordering dependency. The artifact ports upsert on their
 * match key, so re-wiring is a no-op.
 */
export async function wireArtifactFlow({ ops }, { from, to, name, hint, description }) {
  const nm = String(name || '').trim();
  const h = String(hint || '').trim();
  if (!nm && !h) {
    await ops.addDependency(to, from);
  } else if (nm) {
    await ops.addArtifact(from, { direction: 'output', name: nm, hint: h, description });
    await ops.addArtifact(to, { direction: 'input', name: nm, hint: h, description });
  } else {
    await ops.addArtifact(from, { direction: 'output', path: h, description });
    await ops.addArtifact(to, { direction: 'input', path: h, description });
  }
}

/** Remove both sides of a data-flow hand-off (each side no-ops when absent). */
export async function unwireArtifactFlow({ ops }, { from, to, name, path }) {
  await ops.removeArtifact(from, { direction: 'output', name, path });
  await ops.removeArtifact(to, { direction: 'input', name, path });
}
