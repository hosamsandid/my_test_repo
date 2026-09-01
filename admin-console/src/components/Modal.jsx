import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { focusTrapTarget, backdropDismisses } from './modal-view.js';

/**
 * Modal — reusable, keyboard-accessible centred overlay dialog (#1802).
 *
 * A dimmed backdrop with a card centred over the whole app. Dismissible via the
 * ✕ button, the Escape key and a backdrop click. Focus is moved inside on open,
 * trapped while open (Tab / Shift+Tab cycle within the card), and returned to
 * the element that had focus before opening when it closes. The body is
 * scrollable when its content is taller than the viewport.
 *
 * Props:
 *   open      — boolean, whether the modal is visible
 *   onClose   — () => void, called on ✕ / Escape / backdrop dismiss
 *   title     — string, the dialog title (also its accessible name)
 *   children  — modal body content
 *   maxWidth  — number, max card width in px (default 560)
 *   footer    — optional ReactNode pinned below the scrollable body
 */
export default function Modal({ open, onClose, title, children, maxWidth = 560, footer }) {
  const cardRef = useRef(null);
  const previouslyFocused = useRef(null);
  // Tracks whether a backdrop press STARTED on the overlay, so a drag that
  // begins inside the card (e.g. selecting text) and releases on the backdrop
  // does not count as a dismiss click.
  const pressedOverlay = useRef(false);

  const focusables = () => {
    const card = cardRef.current;
    if (!card) return [];
    // Only natural Tab stops count for the trap. A roving-tabindex widget (e.g.
    // SettingsModal's section rail) gives its non-selected buttons tabIndex=-1;
    // those match `button` but are NOT reachable by forward Tab, so counting
    // them would put the "last focusable" past the real final tab stop and let
    // Tab escape the modal (AC4). Exclude [tabindex="-1"] from every arm.
    const sel = 'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
    // Skip elements that are not currently rendered/visible (offsetParent null),
    // but keep the active element so the trap can reason about where focus is.
    return Array.from(card.querySelectorAll(sel))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  };

  // Move focus inside on open (AC4); restore it to the trigger on close/unmount.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    // Defer one frame so the card children are mounted before we focus.
    const id = requestAnimationFrame(() => {
      const list = focusables();
      if (list.length) list[0].focus();
      else cardRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      const el = previouslyFocused.current;
      if (el && typeof el.focus === 'function') el.focus();
    };
  }, [open]);

  // Escape closes; Tab is trapped inside the card.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) { e.preventDefault(); return; }
        const activeIndex = list.indexOf(document.activeElement);
        const target = focusTrapTarget(activeIndex, list.length, e.shiftKey);
        if (target !== null) {
          e.preventDefault();
          list[target]?.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  function handleOverlayMouseDown(e) {
    pressedOverlay.current = e.target === e.currentTarget;
  }
  function handleOverlayClick(e) {
    const releasedOverlay = e.target === e.currentTarget;
    const dismiss = backdropDismisses(pressedOverlay.current, releasedOverlay);
    pressedOverlay.current = false;
    if (dismiss) onClose?.();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={overlayStyle}
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      <div ref={cardRef} tabIndex={-1} style={{ ...cardStyle, maxWidth }}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={titleStyle}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
            style={closeBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={bodyStyle}>
          {children}
        </div>

        {footer != null && <div style={footerStyle}>{footer}</div>}
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
  padding: 'var(--eb-space-4)',
  zIndex: 9999,
};

const cardStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  width: '100%',
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: 'var(--eb-shadow-xl)',
  outline: 'none',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-3)',
  padding: 'var(--eb-space-4) var(--eb-space-5)',
  borderBottom: '1px solid var(--eb-border-default)',
  flexShrink: 0,
};

const titleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-lg)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const closeBtnStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  padding: 'var(--eb-space-1)',
  borderRadius: 'var(--eb-radius-md)',
  transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
};

const bodyStyle = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 0,
};

const footerStyle = {
  padding: 'var(--eb-space-4) var(--eb-space-5)',
  borderTop: '1px solid var(--eb-border-default)',
  flexShrink: 0,
};
