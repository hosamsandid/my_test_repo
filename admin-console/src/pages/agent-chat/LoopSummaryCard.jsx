import React, { useState } from 'react';
import { Repeat, ChevronRight } from 'lucide-react';
import { buildLoopSummaryModel, progressLabel } from './loop-run-view.js';

/**
 * At-a-glance summary of the loop currently running for this agent (#1155).
 *
 * Rendered inside the composer, immediately above the input row and next to the
 * Stop control, whenever a chat-launched loop is running. Collapsed by default:
 * one line with a live progress chip. Expanding reveals the loop's full
 * configuration — the prompt, the stop conditions that were configured, and the
 * verification setting — so the user can review what they are about to cancel
 * without leaving the chat. Everything shown comes from `trigger` (the full
 * launched-loop trigger the ChatPanel already holds) and `progress` (derived
 * from the numbered `trigger.fired` session-log rows); no config field needs a
 * backend round-trip.
 *
 * @param {object} trigger    the running launched-loop trigger (`activeLoop`)
 * @param {?object} progress  `{ iteration, maxIterations|null }` or null (neutral)
 */
export default function LoopSummaryCard({ trigger, progress = null }) {
  const [open, setOpen] = useState(false);
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  if (!trigger) return null;

  const model = buildLoopSummaryModel(trigger, progress);
  const chip = progressLabel(model.progress);
  const PROMPT_CAP = 240;
  const promptLong = model.prompt.length > PROMPT_CAP;
  const promptText = showFullPrompt || !promptLong
    ? model.prompt
    : model.prompt.slice(0, PROMPT_CAP) + '…';

  return (
    <div style={{
      border: '1px solid var(--eb-status-warning, #f59e0b)',
      borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-status-warning-bg, #fffbeb)',
      marginBottom: 'var(--eb-space-2)',
      overflow: 'hidden',
    }}>
      {/* Collapsed header — always visible; the whole row toggles expansion. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={open ? 'Hide running loop details' : 'Show running loop details'}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--eb-status-warning-text)',
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <ChevronRight
          size={13}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        />
        <Repeat size={13} style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-sm)' }}>
          Loop running
        </span>
        <span style={{
          marginLeft: 'auto',
          fontSize: 'var(--eb-text-xs)',
          fontVariantNumeric: 'tabular-nums',
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          padding: '1px 6px',
          color: 'var(--eb-text-secondary)',
          whiteSpace: 'nowrap',
        }}>
          {chip}
        </span>
      </button>

      {open && (
        <div style={{
          padding: '0 var(--eb-space-3) var(--eb-space-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-2)',
        }}>
          {/* Prompt (AC2) */}
          <Field label="Prompt">
            <div style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              lineHeight: 1.4,
            }}>
              {promptText || <span style={{ color: 'var(--eb-text-muted)' }}>(no prompt)</span>}
              {promptLong && (
                <button
                  type="button"
                  onClick={() => setShowFullPrompt(s => !s)}
                  style={{
                    marginLeft: 6,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    color: 'var(--eb-accent-primary)',
                    font: 'inherit',
                    fontSize: 'var(--eb-text-xs)',
                  }}
                >
                  {showFullPrompt ? 'show less' : 'show all'}
                </button>
              )}
            </div>
          </Field>

          {/* Stop conditions (AC3) */}
          {model.stop.map(row => (
            <Field key={row.key} label={row.label}>
              <code style={valueCodeStyle}>{row.value}</code>
            </Field>
          ))}

          {/* Verify (AC4) */}
          <Field label={model.verify.label}>
            <code style={valueCodeStyle}>{model.verify.value}</code>
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'baseline' }}>
      <span style={{
        flexShrink: 0,
        minWidth: 96,
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
      }}>
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const valueCodeStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};
