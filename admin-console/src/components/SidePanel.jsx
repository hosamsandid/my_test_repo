import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { focusTrapTarget, FOCUSABLE_SELECTOR } from './modal-view.js';
import {
  pushOpenPanel, removeOpenPanel, isTopPanel,
  panelTabAction, initialFocusTarget, canRestoreFocus,
} from './side-panel-view.js';

/**
 * SidePanel — Slide-in detail panel from the right.
 *
 * A modal dialog (#2960): focus moves into the panel on open (first focusable
 * field, else the close button), Tab / Shift+Tab cycle inside it while it is
 * open, and focus returns to the element that opened it on close.
 *
 * Props:
 *   open     — boolean
 *   onClose  — () => void
 *   title    — string
 *   children — panel content
 *   width    — optional override (default: var(--eb-side-panel-width))
 */
export default function SidePanel({ open, onClose, title, children, width, loading }) {
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const closeRef = useRef(null);

  /* ── Escape to close ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  /* ── Focus: move in on open, trap Tab, restore on close ──────────── */
  // Depends on `open` only, so a consumer's inline onClose does not re-run it.
  useEffect(() => {
    if (!open) return;
    const token = {};
    pushOpenPanel(token);
    const previouslyFocused = document.activeElement;

    const focusables = (root) => (root
      ? Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement)
      : []);

    // Defer one frame so the panel children are mounted before we focus.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const bodyList = focusables(bodyRef.current);
      const target = initialFocusTarget({
        activeInPanel: panel.contains(document.activeElement),
        bodyFocusableCount: bodyList.length,
      });
      if (target === 'body') bodyList[0].focus();
      else if (target === 'close') (closeRef.current || panel).focus();
    });

    function onKeyDown(e) {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement;
      const dialog = active?.closest?.('[role="dialog"], [role="alertdialog"]');
      // The top-level container the panel lives in (React's #root); popovers
      // portaled to <body> sit outside it and are left alone.
      let appRoot = panel;
      while (appRoot.parentElement && appRoot.parentElement !== document.body) {
        appRoot = appRoot.parentElement;
      }
      const action = panelTabAction({
        isTop: isTopPanel(token),
        inPanel: panel.contains(active),
        inOtherDialog: !!dialog && dialog !== panel,
        inAppRoot: appRoot.contains(active),
        onBody: !active || active === document.body,
      });
      if (action === 'ignore') return;
      const list = focusables(panel);
      if (list.length === 0) { e.preventDefault(); panel.focus(); return; }
      const index = action === 'trap' ? list.indexOf(active) : -1;
      const next = focusTrapTarget(index, list.length, e.shiftKey);
      if (next !== null) {
        e.preventDefault();
        list[next].focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      removeOpenPanel(token);
      if (canRestoreFocus(previouslyFocused)) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'oklch(0 0 0 / 0.3)',
        cursor: loading ? 'wait' : undefined,
      }} />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: width || 'var(--eb-side-panel-width)',
          maxWidth: '90vw',
          background: 'var(--eb-bg-surface)',
          borderLeft: '1px solid var(--eb-border-default)',
          zIndex: 61,
          cursor: loading ? 'wait' : undefined,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--eb-shadow-xl)',
          animation: 'slideInRight 200ms ease',
          outline: 'none',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--eb-space-4)',
          borderBottom: '1px solid var(--eb-border-default)',
          flexShrink: 0,
        }}>
          <h2 style={{
            fontSize: 'var(--eb-text-lg)',
            fontWeight: 'var(--eb-font-semibold)',
            margin: 0,
          }}>
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: 'none', border: 'none',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              padding: 'var(--eb-space-1)',
              borderRadius: 'var(--eb-radius-md)',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div ref={bodyRef} style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--eb-space-4)',
        }}>
          {children}
        </div>

        {/* Slide-in animation */}
        <style>{`
          @keyframes slideInRight {
            from { transform: translateX(100%); }
            to   { transform: translateX(0); }
          }
        `}</style>
      </div>
    </>
  );
}
