import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Mic, Pause, Play, Square, X, Loader2, Copy, RotateCcw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranscriptionSession } from '../context/TranscriptionSessionContext.jsx';
import { formatElapsed } from '../context/transcription-session.js';

// Persistent Meeting Note-Taker overlay (#1296). Rendered once inside Shell (so
// it is inside the router and can navigate back to the originating chat) and
// portaled to document.body so it floats above every page. It reads the whole
// session lifecycle from the app-level TranscriptionSessionProvider — the card
// stays put while the user navigates anywhere in Agent Studio.

const CARD_STYLE = {
  position: 'fixed',
  right: 'var(--eb-space-4)',
  bottom: 'var(--eb-space-4)',
  zIndex: 1000, // above side-panel columns (zIndex 5–10) + sidebar (50)
  width: 300,
  maxWidth: 'calc(100vw - 2 * var(--eb-space-4))',
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  boxShadow: 'var(--eb-shadow-lg, 0 8px 24px rgba(0,0,0,0.24))',
  padding: 'var(--eb-space-3)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
};

function iconBtn(bg, color) {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 30, padding: '0 10px',
    background: bg, color,
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)',
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)',
    fontWeight: 'var(--eb-font-medium)', flexShrink: 0,
  };
}

export default function TranscriptionOverlay() {
  const ctx = useTranscriptionSession();
  const navigate = useNavigate();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!ctx) return null;
  const { session, recovery, stop, pause, resume, cancel, retryDelivery, copyTranscript, deliverRecovery, discardRecovery } = ctx;

  if (!session && !recovery) return null;

  const status = session?.status || null;
  const agentName = session?.agentName || session?.agentId || '';

  const goToChat = () => {
    if (session?.agentId) navigate(`/chats/${encodeURIComponent(session.agentId)}`);
  };

  const doCopy = async () => {
    const ok = await copyTranscript();
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };

  const dotColor = status === 'paused'
    ? 'var(--eb-status-warning, #b45309)'
    : 'var(--eb-status-error-text, #dc2626)';

  const overlay = (
    <div>
      <style>{'@keyframes tx-pulse { 0%,100%{opacity:1;} 50%{opacity:0.35;} } @keyframes tx-spin { to { transform: rotate(360deg); } }'}</style>

      {/* Recovery banner — a prior interrupted session's transcribed portion. */}
      {recovery && (
        <div style={{ ...CARD_STYLE, bottom: session ? 'calc(var(--eb-space-4) + 190px)' : 'var(--eb-space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontWeight: 'var(--eb-font-semibold)' }}>
            <AlertTriangle size={15} style={{ color: 'var(--eb-status-warning, #b45309)' }} />
            Recover transcript?
          </div>
          <div style={{ color: 'var(--eb-text-secondary)', marginBottom: 10, lineHeight: 1.4 }}>
            A recording for <strong>{recovery.agentName}</strong> was interrupted. The already-transcribed portion can still be delivered.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={deliverRecovery} style={iconBtn('var(--eb-accent-primary)', 'var(--eb-text-inverted)')}>
              <Mic size={13} /> Deliver
            </button>
            <button onClick={discardRecovery} style={iconBtn('transparent', 'var(--eb-text-secondary)')}>
              <X size={13} /> Discard
            </button>
          </div>
        </div>
      )}

      {/* Transient microphone error (no session held). */}
      {status === 'error' && (
        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--eb-status-error-text, #dc2626)' }}>
            <AlertTriangle size={15} /> {session.error || 'Microphone error'}
          </div>
        </div>
      )}

      {/* Live / delivering session card. */}
      {session && status !== 'error' && (
        <div style={CARD_STYLE} role="status" aria-live="polite">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            {(status === 'recording' || status === 'paused') ? (
              <span style={{
                width: 10, height: 10, borderRadius: '50%', background: dotColor, flexShrink: 0,
                animation: status === 'recording' ? 'tx-pulse 1.4s ease-in-out infinite' : 'none',
              }} />
            ) : (
              <Loader2 size={14} style={{ color: 'var(--eb-accent-primary)', animation: 'tx-spin 0.9s linear infinite', flexShrink: 0 }} />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <button
                onClick={goToChat}
                title={`Go to ${agentName}`}
                style={{
                  all: 'unset', cursor: 'pointer', display: 'block',
                  fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-accent-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
                }}
              >
                {agentName}
              </button>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                {statusLabel(session)}
              </div>
            </div>
            {(status === 'recording' || status === 'paused') && (
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', flexShrink: 0 }}>
                {formatElapsed(session.elapsedSec)}
              </span>
            )}
          </div>

          {/* Recording / paused controls */}
          {(status === 'recording' || status === 'paused') && (
            confirmCancel ? (
              <div>
                <div style={{ color: 'var(--eb-text-secondary)', marginBottom: 8 }}>Discard this recording? Nothing will be sent.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { setConfirmCancel(false); cancel(); }} style={iconBtn('var(--eb-status-error-bg, #fef2f2)', 'var(--eb-status-error-text, #dc2626)')}>
                    Discard
                  </button>
                  <button onClick={() => setConfirmCancel(false)} style={iconBtn('transparent', 'var(--eb-text-secondary)')}>
                    Keep recording
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                {status === 'recording' ? (
                  <button onClick={pause} style={iconBtn('var(--eb-bg-elevated)', 'var(--eb-text-primary)')}>
                    <Pause size={13} /> Pause
                  </button>
                ) : (
                  <button onClick={resume} style={iconBtn('var(--eb-bg-elevated)', 'var(--eb-text-primary)')}>
                    <Play size={13} /> Resume
                  </button>
                )}
                <button onClick={stop} style={iconBtn('var(--eb-accent-primary)', 'var(--eb-text-inverted)')}>
                  <Square size={12} /> Stop
                </button>
                <button onClick={() => setConfirmCancel(true)} title="Cancel — discard" style={iconBtn('transparent', 'var(--eb-text-secondary)')}>
                  <X size={13} />
                </button>
              </div>
            )
          )}

          {/* Delivery-failed controls */}
          {status === 'delivery-failed' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--eb-status-error-text, #dc2626)', marginBottom: 8 }}>
                <AlertTriangle size={14} /> Couldn’t send the transcript.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={retryDelivery} style={iconBtn('var(--eb-accent-primary)', 'var(--eb-text-inverted)')}>
                  <RotateCcw size={13} /> Retry
                </button>
                <button onClick={doCopy} style={iconBtn('var(--eb-bg-elevated)', 'var(--eb-text-primary)')}>
                  {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
                </button>
                <button onClick={cancel} title="Discard the transcript" style={iconBtn('transparent', 'var(--eb-text-secondary)')}>
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return createPortal(overlay, document.body);
}

function statusLabel(session) {
  switch (session.status) {
    case 'recording': return 'Recording…';
    case 'paused': return 'Paused';
    case 'stopping':
    case 'delivering': {
      const total = session.segsTotal || 0;
      const done = session.segsDone || 0;
      return total ? `Transcribing… (${done}/${total} segments)` : 'Transcribing…';
    }
    case 'delivery-failed': return 'Delivery failed';
    default: return '';
  }
}
