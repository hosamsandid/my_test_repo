import React, { useState } from 'react';
import { Repeat, ChevronRight, RotateCcw } from 'lucide-react';
import {
  buildLoopRecordModel,
  loopRecordToInitialValues,
} from './loop-run-view.js';

/**
 * Persistent record of a *finished* chat-launched loop (#1231).
 *
 * The finished-loop counterpart of the running `LoopSummaryCard`. A launched
 * loop self-removes on any terminal outcome (done / exhausted / paused /
 * stopped), so the running amber card unmounts and its configuration — most
 * importantly the full launch prompt — would otherwise vanish from the chat.
 * The runtime persists a structured `io.aee.loop-record` payload on the
 * terminal message; this card renders it as a normal, scrollable history entry
 * so the finished loop stays reviewable after a reload and can be re-run.
 *
 * Reuses `buildLoopRecordModel` (which reuses the running card's
 * `buildLoopSummaryModel`) so the persisted card and the running card show the
 * same fields. Carries a **Start again** button that opens the loop launcher
 * pre-filled with this loop's settings (via `onRelaunch`) — it does NOT start
 * the loop; the user confirms/edits in the dialog.
 *
 * @param {object}   record    the persisted `io.aee.loop-record` payload
 * @param {?Function} onRelaunch  called with the launcher `initialValues` when
 *                                "Start again" is pressed; absent → button hidden
 * @param {?React.ReactNode} details  optional rendered run-outcome narrative
 *                                    (the message body) shown in a collapsible
 * @param {?string}  time      formatted timestamp for the footer
 */
export default function LoopRecordCard({ record, onRelaunch, details = null, time = null }) {
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  if (!record || typeof record !== 'object') return null;

  const model = buildLoopRecordModel(record);
  const accent = TONE_ACCENT[model.outcomeMeta.tone] || TONE_ACCENT.neutral;

  const PROMPT_CAP = 240;
  const promptLong = model.prompt.length > PROMPT_CAP;
  const promptText = showFullPrompt || !promptLong
    ? model.prompt
    : model.prompt.slice(0, PROMPT_CAP) + '…';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-1) 0',
    }}>
      <div style={{
        width: 28, height: 28,
        borderRadius: '50%',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Repeat size={14} />
      </div>

      <div style={{
        flex: 1,
        minWidth: 0,
        maxWidth: 'min(720px, 85%)',
        border: '1px solid var(--eb-border-default)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 'var(--eb-radius-md)',
        background: 'var(--eb-bg-surface)',
        overflow: 'hidden',
      }}>
        {/* Header: outcome + iterations chip. */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
        }}>
          <span style={{
            fontWeight: 'var(--eb-font-semibold)',
            fontSize: 'var(--eb-text-sm)',
            color: 'var(--eb-text-primary)',
          }}>
            Loop finished
          </span>
          <span style={{
            marginLeft: 'auto',
            fontSize: 'var(--eb-text-xs)',
            fontVariantNumeric: 'tabular-nums',
            background: 'var(--eb-bg-elevated)',
            border: `1px solid ${accent}`,
            borderRadius: 'var(--eb-radius-sm)',
            padding: '1px 6px',
            color: accent,
            whiteSpace: 'nowrap',
          }}>
            {model.summary}
          </span>
        </div>

        <div style={{
          padding: '0 var(--eb-space-3) var(--eb-space-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-2)',
        }}>
          {/* Prompt (AC2) — fully recoverable via show all. */}
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
                  style={linkBtnStyle}
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

          {/* Optional run-outcome narrative (the terminal DM body). */}
          {details && (
            <div>
              <button
                type="button"
                onClick={() => setShowDetails(s => !s)}
                aria-expanded={showDetails}
                style={{ ...linkBtnStyle, marginLeft: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <ChevronRight
                  size={11}
                  style={{ transform: showDetails ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                />
                {showDetails ? 'Hide run details' : 'Show run details'}
              </button>
              {showDetails && (
                <div style={{ marginTop: 'var(--eb-space-1)', fontSize: 'var(--eb-text-sm)' }}>
                  {details}
                </div>
              )}
            </div>
          )}

          {/* Re-launch (AC7/AC8): open the launcher pre-filled; does NOT start. */}
          {onRelaunch && (
            <div>
              <button
                type="button"
                onClick={() => onRelaunch(loopRecordToInitialValues(record))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 'var(--eb-space-1)',
                  padding: 'var(--eb-space-1) var(--eb-space-3)',
                  background: 'var(--eb-bg-elevated)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)',
                  cursor: 'pointer',
                  color: 'var(--eb-text-primary)',
                  font: 'inherit',
                  fontSize: 'var(--eb-text-sm)',
                }}
              >
                <RotateCcw size={13} />
                Start again
              </button>
            </div>
          )}
        </div>

        {time && (
          <div style={{
            padding: '0 var(--eb-space-3) var(--eb-space-2)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
          }}>
            {time}
          </div>
        )}
      </div>
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

const TONE_ACCENT = {
  success: 'var(--eb-status-success, #16a34a)',
  warning: 'var(--eb-status-warning, #f59e0b)',
  neutral: 'var(--eb-text-muted)',
};

const valueCodeStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};

const linkBtnStyle = {
  marginLeft: 6,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--eb-accent-primary)',
  font: 'inherit',
  fontSize: 'var(--eb-text-xs)',
};
