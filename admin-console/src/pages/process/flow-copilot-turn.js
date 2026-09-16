// flow-copilot-turn.js — pure, React-free decisions for a Flow Copilot turn
// that OUTLIVES the panel that started it (#2087).
//
// Before this module the whole turn lived in FlowCopilotPanel's local state, so
// three ordinary actions destroyed it: navigating away from /flows, closing the
// panel, and selecting another flow (which remounts ProcessGraphPanel via
// `key={proc}`). Ownership now sits in the app-level FlowCopilotProvider
// (mounted above the router, the #1296/#1735 precedent) and the panel is a
// renderer over it. Everything deterministic lives here so it can be
// unit-tested without a DOM — the provider and the panel/indicator JSX stay
// thin, per the #651 convention. `composer-action.js` is the shape mirrored for
// the send/stop decision, including its `stopBusy` double-press rule.
//
// A turn is bound to the SCOPE it was started for (`draft:<id>` or a live team
// id, the same strings ProcessCanvas' `scope` prop and Flows' `?proc=` carry),
// so a proposal can never be offered against a different bundle (AC5).

// The transient import-preview scope is never persisted in `?proc=`, so a turn
// started there could never be returned to. It is refused up front rather than
// leaving an unreachable pending proposal behind.
export const TRANSIENT_SCOPE = 'import';

/** A scope a turn may be bound to: a live team id or `draft:<id>`, never the
 *  transient import preview and never empty. */
export function isBindableScope(scope) {
  return typeof scope === 'string' && !!scope && scope !== TRANSIENT_SCOPE;
}

/** Same-scope comparison. Both must be real scopes — two unbound turns are not
 *  "the same scope", which keeps `null` from matching `null` by accident. */
export function isSameScope(a, b) {
  return isBindableScope(a) && isBindableScope(b) && a === b;
}

// ── the composer's primary action (AC4, AC8, AC10) ───────────────────────────

/** Reason a send is refused while another flow's turn holds the tab (AC4). */
export function busyElsewhereRefusal(flowName) {
  const name = typeof flowName === 'string' && flowName.trim() ? flowName.trim() : 'another flow';
  return `A Copilot turn is still running for ${name}. Wait for it to finish, or stop it first — only one turn runs at a time.`;
}

/**
 * Send vs Stop for the Copilot composer, mirroring `composer-action.js`.
 *
 * Inputs:
 *   scope     — the scope this panel is bound to.
 *   turnScope — the scope of the tab's running turn (null when idle).
 *   flowName  — display name of that running turn's flow (for the refusal).
 *   stopping  — a stop is already in flight (gates Stop only, AC10).
 *   hasText   — the trimmed composer value is non-empty (gates Send only).
 *   canSend   — draft mode with a bundle loaded (gates Send only).
 *
 * Returns { mode: 'send' | 'stop', enabled, refusal }. `refusal` is non-null
 * only when a send is blocked for a STATED reason (AC4) rather than merely
 * being empty-handed — an empty composer needs no explanation.
 */
export function decideCopilotAction({ scope, turnScope, flowName, stopping, hasText, canSend } = {}) {
  if (isSameScope(scope, turnScope)) {
    // Our own turn is running: the button is Stop, inert once pressed (AC10).
    // Deliberately independent of `canSend`/`hasText` — the point is to abort.
    return { mode: 'stop', enabled: !stopping, refusal: null };
  }
  if (isBindableScope(turnScope)) {
    // Someone else's turn holds the single per-tab slot (AC4).
    return { mode: 'send', enabled: false, refusal: busyElsewhereRefusal(flowName) };
  }
  return { mode: 'send', enabled: !!canSend && !!hasText, refusal: null };
}

// ── the global running-turn indicator (AC12, AC13) ───────────────────────────

/**
 * Should the every-route indicator be visible, and what does it say?
 *
 * `panelScope` is the scope of the currently-mounted Copilot panel (null when
 * no panel is open anywhere) — the panel registers it with the provider while
 * mounted, the `useHelpSubject` shape.
 *
 * AC13: hidden when the user is looking at the originating flow WITH the panel
 * open, because that surface already shows the live phase and two progress
 * displays for one turn is a defect. It deliberately stays visible when the
 * panel is closed on that same flow — nothing else on the canvas says a turn is
 * running — and it disappears on completion or Stop (AC12), which is also the
 * answer to "turn finishes while the user is on the originating flow with the
 * panel closed": no indicator, and reopening the panel finds the proposal.
 */
export function indicatorState({ turn, panelScope, pendingByScope } = {}) {
  const hidden = { visible: false, mode: null, scope: null, flowName: '', jumpTo: null, phase: null };
  // A running turn is the live work and wins the single indicator slot.
  if (turn && turn.status === 'running' && isBindableScope(turn.scope)) {
    // AC13: hidden on the originating flow WHILE its panel is open — that
    // surface already shows the live phase. Visible everywhere else, including
    // the same flow with the panel closed.
    if (isSameScope(panelScope, turn.scope)) return hidden;
    return {
      visible: true,
      mode: 'running',
      scope: turn.scope,
      flowName: turnFlowName(turn),
      jumpTo: jumpToFlowPath(turn.scope),
      phase: turn.phase || null,
    };
  }
  // No live turn: a turn that FINISHED while the user was away leaves a pending
  // proposal in the provider (D4). Without surfacing it the running indicator
  // simply vanishes on completion and the proposal sits unreviewed on a flow the
  // user is no longer looking at — which reads as "the proposal just
  // disappeared" (#2087 follow-up). Keep the indicator alive as a "ready to
  // review" card until the user opens that flow, where Apply / Discard live, and
  // resolving the proposal clears it.
  const ready = pendingToReview(pendingByScope, panelScope);
  if (ready) {
    return {
      visible: true,
      mode: 'ready',
      scope: ready.scope,
      flowName: turnFlowName(ready),
      jumpTo: jumpToFlowPath(ready.scope),
      phase: null,
    };
  }
  return hidden;
}

/**
 * The finished-but-unreviewed proposal the user should be nudged back to: any
 * pending proposal that is NOT on the flow whose Copilot panel is currently open
 * (that surface shows its own card, so a second display would be the AC13
 * defect). When more than one flow holds a proposal, the most recently finished
 * one wins the single indicator slot.
 */
export function pendingToReview(pendingByScope, panelScope) {
  if (!pendingByScope) return null;
  const away = Object.values(pendingByScope).filter(
    (p) => p && isBindableScope(p.scope) && !isSameScope(p.scope, panelScope),
  );
  if (!away.length) return null;
  return away.reduce((best, p) => ((p.finishedAt || 0) > (best.finishedAt || 0) ? p : best));
}

/** Display name for a turn — the flow's own name, else its scope as authored. */
export function turnFlowName(turn) {
  const name = turn && typeof turn.flowName === 'string' ? turn.flowName.trim() : '';
  if (name) return name;
  const scope = turn && typeof turn.scope === 'string' ? turn.scope : '';
  return scope || 'this flow';
}

/** The route that reselects a turn's flow and reopens the Copilot on it. */
export function jumpToFlowPath(scope) {
  if (!isBindableScope(scope)) return null;
  return `/flows?proc=${encodeURIComponent(scope)}&copilot=1`;
}

// ── per-scope pending proposals (AC5, AC6) ───────────────────────────────────
// A finished turn is kept as an UNAPPLIED proposal (D4) until the user applies
// or discards it. Keyed by scope rather than held in a single slot: finishing a
// turn on one draft and starting one on another must not silently drop the
// first proposal before anybody reviewed it.

/** The pending proposal bound to `scope`, or null. */
export function pendingForScope(pendingByScope, scope) {
  if (!pendingByScope || !isBindableScope(scope)) return null;
  return pendingByScope[scope] || null;
}

/** Store a pending proposal under its own scope (immutably). */
export function putPending(pendingByScope, pending) {
  const base = pendingByScope || {};
  if (!pending || !isBindableScope(pending.scope)) return base;
  return { ...base, [pending.scope]: pending };
}

/** Drop the pending proposal for one scope — a Stop, or a superseding turn. */
export function dropPending(pendingByScope, scope) {
  const base = pendingByScope || {};
  if (!isBindableScope(scope) || !(scope in base)) return base;
  const next = { ...base };
  delete next[scope];
  return next;
}

/**
 * Drop a pending proposal by its own TURN ID, wherever it is filed.
 *
 * This is what Apply and Discard use, deliberately not `dropPending(scope)`:
 * applying a proposal writes the draft, and the first Copilot generation
 * proposes a NAME, so that write can re-key the draft (#581) and `rekeyScope`
 * moves the proposal to the new scope while the apply is still in flight.
 * Resolving by the scope the panel started from would then miss, leaving a
 * proposal the user already applied still sitting there as actionable.
 */
export function dropPendingById(pendingByScope, id) {
  const base = pendingByScope || {};
  if (!id) return base;
  const scope = Object.keys(base).find(k => base[k] && base[k].id === id);
  if (!scope) return base;
  const next = { ...base };
  delete next[scope];
  return next;
}

// ── following a scope rename (edge case: draft saved under a new id) ─────────
// ProcessCanvas navigates to `draft:<newId>` after a save that re-keys the
// draft (#581), so the scope a turn was bound to changes underneath it. The
// binding FOLLOWS the rename rather than silently mismatching — the same draft
// file, a new id — which is what keeps a running turn and its proposal
// reachable instead of orphaned under a scope nothing can select any more.

/** Re-key a turn bound to `from` onto `to`. Other turns are returned as-is. */
export function rekeyTurn(turn, from, to) {
  if (!turn || !isSameScope(turn.scope, from) || !isBindableScope(to)) return turn;
  return { ...turn, scope: to };
}

/** Re-key a pending proposal from one scope onto another. */
export function rekeyPending(pendingByScope, from, to) {
  const base = pendingByScope || {};
  if (!isBindableScope(from) || !isBindableScope(to) || from === to) return base;
  const moving = base[from];
  if (!moving) return base;
  const next = { ...base };
  delete next[from];
  next[to] = { ...moving, scope: to };
  return next;
}

// ── notices ──────────────────────────────────────────────────────────────────

/**
 * What to say when applying a finished proposal fails because its draft is
 * gone (edge case: the draft was deleted while its turn ran). A 404 has no
 * recovery — the proposal has nowhere to go — so it is named as such instead of
 * reading like a transient write failure, and the draft is never recreated.
 */
export function applyFailureNotice(err) {
  const status = err && (err.status || err.statusCode);
  const message = err && typeof err.message === 'string' ? err.message.trim() : '';
  if (status === 404 || /\b404\b/.test(message)) {
    return 'This flow no longer exists — it was deleted while the Copilot was working, so there is nothing to apply the proposal to.';
  }
  return message || 'Apply failed';
}

/** One-line status for the indicator card: the phase, in plain language. */
export function indicatorPhaseLabel(phase) {
  if (phase && phase.phase === 'repairing') return 'Repairing the proposal…';
  if (phase && phase.phase === 'validating') return 'Validating…';
  return 'Generating…';
}
