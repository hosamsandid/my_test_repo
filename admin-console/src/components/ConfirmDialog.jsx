import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

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
}) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    if (open && confirmRef.current) {
      confirmRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onCancel?.();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

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
            <button onClick={onCancel} style={cancelBtnStyle}>
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            style={{ ...confirmBtnStyle, background: confirmBtnBg }}
          >
            {alertOnly ? 'OK' : confirmLabel}
          </button>
        </div>
      </div>
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
