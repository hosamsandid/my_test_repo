import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Sparkles, Loader2, Square, ArrowRight, Check } from 'lucide-react';
import { useFlowCopilot } from '../context/FlowCopilotContext.jsx';
import { indicatorState, indicatorPhaseLabel } from '../pages/process/flow-copilot-turn.js';

// Global Flow Copilot indicator (#2087, D5).
//
// Rendered once inside Shell (so it is inside the router and can navigate back
// to the originating flow) and portaled to document.body so it floats above
// every page — the TranscriptionOverlay precedent, and it sits below that card
// so the two never overlap when both are up.
//
// Two states, one card, both from the pure `indicatorState`:
//   • running — a turn takes 20–60 s and survives navigation, so without this the
//     user cannot tell one is still running once they leave /flows.
//   • ready — a turn that FINISHES while the user is away leaves an unreviewed
//     proposal in the provider (D4). The running indicator vanishes on
//     completion, so without a hand-off the proposal reads as lost: the user is
//     on another page and nothing says it is ready to Apply/Discard. The card
//     stays as a "review" nudge until they open that flow and resolve it.
//
// AC13's rule holds for both: hidden while the Copilot panel is open on the
// originating flow, which already shows the phase (running) or the card (ready).

const CARD_STYLE = {
  position: 'fixed',
  right: 'var(--eb-space-4)',
  // Above the Meeting Note-Taker card's bottom edge (it is ~variable height at
  // the same corner) so a running turn and a running dictation stack rather
  // than cover each other.
  bottom: 'calc(var(--eb-space-4) + 190px)',
  zIndex: 1000, // same layer as TranscriptionOverlay: above side panels + sidebar
  width: 300,
  maxWidth: 'calc(100vw - 2 * var(--eb-space-4))',
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-accent-primary)',
  borderRadius: 'var(--eb-radius-lg)',
  boxShadow: 'var(--eb-shadow-lg, 0 8px 24px rgba(0,0,0,0.24))',
  padding: 'var(--eb-space-3)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
};

const BTN_STYLE = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  height: 28, padding: '0 10px',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)',
  fontWeight: 'var(--eb-font-medium)', flexShrink: 0,
};

export default function FlowCopilotIndicator() {
  const ctx = useFlowCopilot();
  const navigate = useNavigate();

  if (!ctx) return null;
  const state = indicatorState({ turn: ctx.turn, panelScope: ctx.panelScope, pendingByScope: ctx.pendingByScope });
  if (!state.visible) return null;

  const ready = state.mode === 'ready';

  return createPortal(
    <div style={CARD_STYLE} role="status" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Sparkles size={15} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <span style={{ fontWeight: 'var(--eb-font-semibold)', flex: 1, minWidth: 0 }}>Flow Copilot</span>
        {ready
          ? <Check size={15} style={{ color: 'var(--eb-status-success, #16a34a)', flexShrink: 0 }} />
          : <Loader2 size={14} style={{ color: 'var(--eb-text-muted)', animation: 'eb-copilot-ind-spin 1s linear infinite' }} />}
      </div>
      {/* Name the flow — a turn (or a finished proposal) that outlives its panel
          is otherwise an unattributed card on a page that has nothing to do with
          it. The ready copy states the action (Apply/Discard) so the user knows
          the proposal is waiting, not lost. */}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
        {ready ? (
          <>Proposal ready for{' '}
            <strong style={{ color: 'var(--eb-text-primary)' }}>{state.flowName}</strong>
            {' '}— review to apply or discard it.</>
        ) : (
          <>{indicatorPhaseLabel(state.phase)}{' '}
            <strong style={{ color: 'var(--eb-text-primary)' }}>{state.flowName}</strong></>
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <button
          onClick={() => { if (state.jumpTo) navigate(state.jumpTo); }}
          title={ready ? `Review the proposal for ${state.flowName}` : `Open ${state.flowName} and its Copilot`}
          style={{
            ...BTN_STYLE, borderColor: 'var(--eb-accent-primary)',
            background: ready ? 'var(--eb-accent-primary)' : 'none',
            color: ready ? 'var(--eb-text-inverted)' : 'var(--eb-accent-primary)',
          }}
        >{ready ? 'Review proposal' : 'Go to flow'} <ArrowRight size={12} /></button>
        {!ready && (
          <button
            onClick={ctx.stopTurn}
            disabled={ctx.stopping}
            title="Stop this Copilot turn"
            style={{
              ...BTN_STYLE, background: 'none', color: 'var(--eb-status-error)',
              borderColor: 'var(--eb-status-error)',
              cursor: ctx.stopping ? 'not-allowed' : 'pointer', opacity: ctx.stopping ? 0.5 : 1,
            }}
          ><Square size={11} /> Stop</button>
        )}
      </div>
      <style>{'@keyframes eb-copilot-ind-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
    </div>,
    document.body,
  );
}
