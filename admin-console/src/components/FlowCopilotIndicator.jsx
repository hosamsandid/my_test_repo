import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Sparkles, Loader2, Square, ArrowRight } from 'lucide-react';
import { useFlowCopilot } from '../context/FlowCopilotContext.jsx';
import { indicatorState, indicatorPhaseLabel } from '../pages/process/flow-copilot-turn.js';

// Global running-turn indicator for the Flow Copilot (#2087, D5).
//
// Rendered once inside Shell (so it is inside the router and can navigate back
// to the originating flow) and portaled to document.body so it floats above
// every page — the TranscriptionOverlay precedent, and it sits below that card
// so the two never overlap when both are up.
//
// A turn takes 20–60 s and now survives navigation, so without this the user
// has no way to tell that one is still running once they leave /flows. Every
// visibility decision is the pure `indicatorState` — including AC13's rule that
// it stays hidden while the Copilot panel is open on the originating flow,
// which already shows the live phase.

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
  const state = indicatorState({ turn: ctx.turn, panelScope: ctx.panelScope });
  if (!state.visible) return null;

  return createPortal(
    <div style={CARD_STYLE} role="status" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Sparkles size={15} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <span style={{ fontWeight: 'var(--eb-font-semibold)', flex: 1, minWidth: 0 }}>Flow Copilot</span>
        <Loader2 size={14} style={{ color: 'var(--eb-text-muted)', animation: 'eb-copilot-ind-spin 1s linear infinite' }} />
      </div>
      {/* Name the flow (AC12) — a turn that outlives its panel is otherwise an
          unattributed spinner on a page that has nothing to do with it. */}
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
        {indicatorPhaseLabel(state.phase)}{' '}
        <strong style={{ color: 'var(--eb-text-primary)' }}>{state.flowName}</strong>
      </div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <button
          onClick={() => { if (state.jumpTo) navigate(state.jumpTo); }}
          title={`Open ${state.flowName} and its Copilot`}
          style={{ ...BTN_STYLE, background: 'none', color: 'var(--eb-accent-primary)', borderColor: 'var(--eb-accent-primary)' }}
        >Go to flow <ArrowRight size={12} /></button>
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
      </div>
      <style>{'@keyframes eb-copilot-ind-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
    </div>,
    document.body,
  );
}
