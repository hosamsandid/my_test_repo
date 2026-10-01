import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { resolveDismissHandler, backdropDismisses, escapeDismisses } from './confirm-dialog-view.js';

/**
 * ConfirmDialog -- Modal confirmation dialog replacing window.confirm/alert.
 *
 * Props:
 *   open       - boolean, whether the dialog is visible
 *   title      - string, dialog title
 *   message    - string OR ReactNode, confirmation message body. Strings are wrapped in a <p>;
 *                ReactNodes are rendered as-is so callers can include lists, emphasis, etc.
 *   variant    - 'danger' | 'warning' | 'info' (default: 'warning')
 *   confirmLabel - string (default: 'Confirm')
 *   cancelLabel  - string (default: 'Cancel')
 *   onConfirm  - function, called when user confirms
 *   onCancel   - function, called when user cancels or presses Escape
 *   alertOnly  - boolean, if true shows only an OK button (replaces window.alert)
 *   busy       - boolean (default: false), shows a spinner on the confirm button and
 *                disables both buttons while a caller's async action is in flight
 *   confirmDisabled - boolean (default: false), disables only the confirm button,
 *                e.g. while a form in `message` is not valid yet
 */
export default function ConfirmDialog({
  open,
  title = 'Confirm',
  message,
  variant = 'warning',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  alertOnly = false,
  maxWidth = 440,
  busy = false,
  confirmDisabled = false,
}) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  // Tracks whether a backdrop press STARTED on the overlay, so a drag that
  // begins inside the card (e.g. selecting the message text) and releases out
  // on the backdrop does not count as a dismiss click.
  const pressedOverlayRef = useRef(false);

  useEffect(() => {
    if (open && confirmRef.current) {
      confirmRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape' && escapeDismisses({ busy })) {
        resolveDismissHandler({ alertOnly, onConfirm, onCancel })?.();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, busy, alertOnly, onConfirm, onCancel]);

  if (!open) return null;

  // Dismiss on a click that both started and ended on the dimmed backdrop —
  // the instinctive "click outside to close" gesture. A confirmation cancels
  // (safe default); an alert acknowledges. Presses that originate on the card
  // never dismiss (guarded by the mousedown target check).
  function handleOverlayMouseDown(e) {
    pressedOverlayRef.current = e.target === e.currentTarget;
  }
  function handleOverlayClick(e) {
    const releasedOverlay = e.target === e.currentTarget;
    const shouldDismiss = backdropDismisses({ pressedOverlay: pressedOverlayRef.current, releasedOverlay, busy });
    pressedOverlayRef.current = false;
    if (shouldDismiss) resolveDismissHandler({ alertOnly, onConfirm, onCancel })?.();
  }

  const iconColor = variant === 'danger' ? 'var(--eb-status-error)'
    : variant === 'info' ? 'var(--eb-accent-primary)'
    : 'var(--eb-status-warning)';

  const confirmBtnBg = variant === 'danger' ? 'var(--eb-status-error)'
    : 'var(--eb-accent-primary)';

  const Icon = variant === 'info' ? Info : AlertTriangle;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={overlayStyle}
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      <div style={{ ...dialogStyle, maxWidth }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)' }}>
          <Icon size={20} style={{ color: iconColor, flexShrink: 0, marginTop: 2 }} />
          {/* `min-width: 0` is the classic fix for flex children whose
              content is wider than their flex track — without it the
              child's `min-width: auto` lets it grow past the dialog,
              and any inner overflow / text-ellipsis rules silently fail
              because there's no width constraint for them to act on. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              {title}
            </h3>
            {typeof message === 'string' ? (
              <p style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
                {message}
              </p>
            ) : (
              <div style={{ margin: 'var(--eb-space-2) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
                {message}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-4)' }}>
          {!alertOnly && (
            <button
              onClick={onCancel}
              disabled={busy}
              style={{ ...cancelBtnStyle, ...(busy ? disabledStyle : null) }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            style={{ ...confirmBtnStyle, background: confirmBtnBg, ...(busy || confirmDisabled ? disabledStyle : null) }}
          >
            {busy ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                {alertOnly ? 'OK' : confirmLabel}
              </span>
            ) : (
              alertOnly ? 'OK' : confirmLabel
            )}
          </button>
        </div>
      </div>
      {busy && <style>{'@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>}
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'oklch(0 0 0 / 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const dialogStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  padding: 'var(--eb-space-5, 20px)',
  maxWidth: 440,
  width: '90%',
  boxShadow: 'var(--eb-shadow-xl)',
};

const cancelBtnStyle = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const confirmBtnStyle = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const disabledStyle = {
  opacity: 0.6,
  cursor: 'not-allowed',
};
