// Tests for flow-copilot-turn.js (#2087) — the decisions that make a running
// Copilot turn survive navigation, a panel close and a flow switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSIENT_SCOPE,
  isBindableScope,
  isSameScope,
  busyElsewhereRefusal,
  decideCopilotAction,
  indicatorState,
  turnFlowName,
  jumpToFlowPath,
  pendingForScope,
  putPending,
  dropPending,
  dropPendingById,
  rekeyTurn,
  rekeyPending,
  applyFailureNotice,
  indicatorPhaseLabel,
} from './flow-copilot-turn.js';

// ── scope binding ────────────────────────────────────────────────────────────

test('isBindableScope accepts drafts and team ids, refuses the transient import scope', () => {
  assert.equal(isBindableScope('draft:abc'), true);
  assert.equal(isBindableScope('my-team'), true);
  assert.equal(isBindableScope(TRANSIENT_SCOPE), false, 'import is never persisted in ?proc=');
  assert.equal(isBindableScope(''), false);
  assert.equal(isBindableScope(null), false);
  assert.equal(isBindableScope(undefined), false);
  assert.equal(isBindableScope(42), false);
});

test('isSameScope never matches two unbound scopes', () => {
  assert.equal(isSameScope('draft:a', 'draft:a'), true);
  assert.equal(isSameScope('draft:a', 'draft:b'), false);
  assert.equal(isSameScope(null, null), false, 'no turn + no panel is not "the same flow"');
  assert.equal(isSameScope(undefined, undefined), false);
  assert.equal(isSameScope(TRANSIENT_SCOPE, TRANSIENT_SCOPE), false);
});

// ── send / stop decision (AC4, AC8, AC10) ────────────────────────────────────

test('our own running turn turns the button into Stop, inert once pressed (AC8/AC10)', () => {
  const running = decideCopilotAction({ scope: 'draft:a', turnScope: 'draft:a', hasText: false, canSend: false });
  assert.deepEqual(running, { mode: 'stop', enabled: true, refusal: null });

  const pressed = decideCopilotAction({ scope: 'draft:a', turnScope: 'draft:a', stopping: true, hasText: true, canSend: true });
  assert.equal(pressed.mode, 'stop');
  assert.equal(pressed.enabled, false, 'a double press must not fire two aborts');
});

test('Stop ignores canSend/hasText — a turn is abortable while the composer is disabled', () => {
  const d = decideCopilotAction({ scope: 'draft:a', turnScope: 'draft:a', hasText: false, canSend: false });
  assert.equal(d.enabled, true);
});

test('a turn on another flow refuses a send with a stated reason (AC4)', () => {
  const d = decideCopilotAction({
    scope: 'draft:b', turnScope: 'draft:a', flowName: 'Intake flow', hasText: true, canSend: true,
  });
  assert.equal(d.mode, 'send', 'never a Stop for someone else\'s turn');
  assert.equal(d.enabled, false);
  assert.match(d.refusal, /Intake flow/);
  assert.match(d.refusal, /one turn runs at a time/);
});

test('busyElsewhereRefusal degrades to a generic subject with no name', () => {
  assert.match(busyElsewhereRefusal(''), /another flow/);
  assert.match(busyElsewhereRefusal('   '), /another flow/);
  assert.match(busyElsewhereRefusal(undefined), /another flow/);
});

test('idle: send is gated on text AND a sendable panel, with no refusal text', () => {
  assert.deepEqual(
    decideCopilotAction({ scope: 'draft:a', turnScope: null, hasText: true, canSend: true }),
    { mode: 'send', enabled: true, refusal: null },
  );
  // An empty composer needs no explanation — only a genuine block gets one.
  assert.deepEqual(
    decideCopilotAction({ scope: 'draft:a', turnScope: null, hasText: false, canSend: true }),
    { mode: 'send', enabled: false, refusal: null },
  );
  assert.deepEqual(
    decideCopilotAction({ scope: 'draft:a', turnScope: null, hasText: true, canSend: false }),
    { mode: 'send', enabled: false, refusal: null },
  );
});

test('after a stop the panel is immediately sendable again (AC8)', () => {
  // The provider clears the turn on stop, so the panel sees turnScope: null.
  const d = decideCopilotAction({ scope: 'draft:a', turnScope: null, hasText: true, canSend: true });
  assert.deepEqual(d, { mode: 'send', enabled: true, refusal: null });
});

test('decideCopilotAction tolerates a call with no arguments', () => {
  assert.deepEqual(decideCopilotAction(), { mode: 'send', enabled: false, refusal: null });
});

// ── the global indicator (AC12, AC13) ────────────────────────────────────────

const runningTurn = { scope: 'draft:a', flowName: 'Intake flow', status: 'running', phase: { phase: 'validating' } };

test('the indicator shows on every other route while a turn runs (AC12)', () => {
  const s = indicatorState({ turn: runningTurn, panelScope: null });
  assert.equal(s.visible, true);
  assert.equal(s.flowName, 'Intake flow');
  assert.equal(s.jumpTo, '/flows?proc=draft%3Aa&copilot=1');
  assert.deepEqual(s.phase, { phase: 'validating' });
});

test('the indicator hides on the originating flow with the panel open (AC13)', () => {
  assert.equal(indicatorState({ turn: runningTurn, panelScope: 'draft:a' }).visible, false);
});

test('the indicator stays visible on the originating flow with the panel CLOSED', () => {
  // Nothing else on the canvas says a turn is running, so this is not the
  // two-concurrent-displays defect AC13 forbids.
  assert.equal(indicatorState({ turn: runningTurn, panelScope: null }).visible, true);
  assert.equal(indicatorState({ turn: runningTurn, panelScope: 'draft:b' }).visible, true);
});

test('the indicator disappears on completion, stop and error (AC12)', () => {
  for (const status of ['done', 'stopped', 'error']) {
    assert.equal(indicatorState({ turn: { ...runningTurn, status }, panelScope: null }).visible, false, status);
  }
});

test('the indicator is never armed by a scope-less or absent turn', () => {
  assert.equal(indicatorState({ turn: null, panelScope: null }).visible, false);
  assert.equal(indicatorState().visible, false);
  assert.equal(indicatorState({ turn: { ...runningTurn, scope: TRANSIENT_SCOPE } }).visible, false);
});

test('turnFlowName falls back to the scope, then to a generic subject', () => {
  assert.equal(turnFlowName({ flowName: ' Intake ', scope: 'draft:a' }), 'Intake');
  assert.equal(turnFlowName({ flowName: '', scope: 'draft:a' }), 'draft:a');
  assert.equal(turnFlowName({ scope: '' }), 'this flow');
  assert.equal(turnFlowName(null), 'this flow');
});

test('jumpToFlowPath reselects the flow and reopens the Copilot', () => {
  assert.equal(jumpToFlowPath('team-x'), '/flows?proc=team-x&copilot=1');
  assert.equal(jumpToFlowPath(TRANSIENT_SCOPE), null);
  assert.equal(jumpToFlowPath(null), null);
});

// ── pending proposals per scope (AC5, AC6) ───────────────────────────────────

test('a pending proposal is only ever offered against its own scope (AC5)', () => {
  const store = putPending({}, { scope: 'draft:a', summary: 'x' });
  assert.equal(pendingForScope(store, 'draft:a').summary, 'x');
  assert.equal(pendingForScope(store, 'draft:b'), null);
  assert.equal(pendingForScope(store, 'team-x'), null);
  assert.equal(pendingForScope(store, TRANSIENT_SCOPE), null);
  assert.equal(pendingForScope(null, 'draft:a'), null);
});

test('two flows can hold a pending proposal at once — neither is silently dropped', () => {
  let store = putPending({}, { scope: 'draft:a', summary: 'a' });
  store = putPending(store, { scope: 'draft:b', summary: 'b' });
  assert.equal(pendingForScope(store, 'draft:a').summary, 'a');
  assert.equal(pendingForScope(store, 'draft:b').summary, 'b');
});

test('putPending is immutable and refuses an unbindable proposal', () => {
  const before = { 'draft:a': { scope: 'draft:a' } };
  const after = putPending(before, { scope: TRANSIENT_SCOPE });
  assert.equal(after, before, 'a transient-scope turn leaves no pending proposal behind');
  const added = putPending(before, { scope: 'draft:b' });
  assert.notEqual(added, before);
  assert.deepEqual(Object.keys(before), ['draft:a'], 'input untouched');
});

test('dropPending removes exactly one scope and is a no-op otherwise', () => {
  const store = { 'draft:a': { scope: 'draft:a' }, 'draft:b': { scope: 'draft:b' } };
  assert.deepEqual(Object.keys(dropPending(store, 'draft:a')), ['draft:b']);
  assert.equal(dropPending(store, 'draft:z'), store);
  assert.equal(dropPending(store, null), store);
  assert.deepEqual(Object.keys(store), ['draft:a', 'draft:b'], 'input untouched');
});

test('Apply/Discard resolve a proposal by turn id, so a mid-apply rename cannot orphan it', () => {
  // Applying writes the draft, and the first generation proposes a NAME, so the
  // write can re-key the draft while the apply is in flight. Resolving by the
  // scope the panel started from would then miss and leave an already-applied
  // proposal sitting there as actionable.
  let store = putPending({}, { id: 'turn-7', scope: 'draft:old', summary: 'x' });
  store = rekeyPending(store, 'draft:old', 'draft:new');
  assert.equal(dropPending(store, 'draft:old'), store, 'the old scope no longer holds it');
  assert.deepEqual(dropPendingById(store, 'turn-7'), {}, 'the id still finds it');
});

test('dropPendingById leaves other proposals alone and is a no-op when unknown', () => {
  const store = {
    'draft:a': { id: 'turn-1', scope: 'draft:a' },
    'draft:b': { id: 'turn-2', scope: 'draft:b' },
  };
  assert.deepEqual(Object.keys(dropPendingById(store, 'turn-1')), ['draft:b']);
  assert.equal(dropPendingById(store, 'turn-9'), store);
  assert.equal(dropPendingById(store, null), store);
  assert.equal(dropPendingById(store, undefined), store);
  assert.deepEqual(dropPendingById(null, 'turn-1'), {});
  assert.deepEqual(Object.keys(store), ['draft:a', 'draft:b'], 'input untouched');
});

// ── following a rename ───────────────────────────────────────────────────────

test('a running turn follows its draft onto a new id (AC3 edge case)', () => {
  const turn = { scope: 'draft:old', status: 'running' };
  assert.equal(rekeyTurn(turn, 'draft:old', 'draft:new').scope, 'draft:new');
  // Another flow's turn is untouched — identity-stable so no re-render churn.
  assert.equal(rekeyTurn(turn, 'draft:other', 'draft:new'), turn);
  assert.equal(rekeyTurn(turn, 'draft:old', TRANSIENT_SCOPE), turn);
  assert.equal(rekeyTurn(null, 'draft:old', 'draft:new'), null);
});

test('a pending proposal follows its draft onto a new id', () => {
  const store = { 'draft:old': { scope: 'draft:old', summary: 'x' }, 'draft:keep': { scope: 'draft:keep' } };
  const moved = rekeyPending(store, 'draft:old', 'draft:new');
  assert.equal(pendingForScope(moved, 'draft:old'), null);
  assert.equal(moved['draft:new'].summary, 'x');
  assert.equal(moved['draft:new'].scope, 'draft:new', 'the proposal carries its new binding');
  assert.ok(moved['draft:keep'], 'unrelated proposals survive');
});

test('rekeyPending is a no-op when there is nothing to move', () => {
  const store = { 'draft:a': { scope: 'draft:a' } };
  assert.equal(rekeyPending(store, 'draft:missing', 'draft:new'), store);
  assert.equal(rekeyPending(store, 'draft:a', 'draft:a'), store);
  assert.equal(rekeyPending(store, 'draft:a', TRANSIENT_SCOPE), store);
  assert.deepEqual(rekeyPending(null, 'draft:a', 'draft:b'), {});
});

// ── notices ──────────────────────────────────────────────────────────────────

test('a deleted draft is named, not reported as a generic write failure', () => {
  assert.match(applyFailureNotice({ status: 404 }), /no longer exists/);
  assert.match(applyFailureNotice(new Error('Request failed (HTTP 404)')), /no longer exists/);
  assert.equal(applyFailureNotice(new Error('network down')), 'network down');
  assert.equal(applyFailureNotice(null), 'Apply failed');
  assert.equal(applyFailureNotice({}), 'Apply failed');
});

test('indicatorPhaseLabel names each phase and defaults to generating', () => {
  assert.equal(indicatorPhaseLabel({ phase: 'repairing', iteration: 1 }), 'Repairing the proposal…');
  assert.equal(indicatorPhaseLabel({ phase: 'validating' }), 'Validating…');
  assert.equal(indicatorPhaseLabel({ phase: 'generating' }), 'Generating…');
  assert.equal(indicatorPhaseLabel(null), 'Generating…');
});
