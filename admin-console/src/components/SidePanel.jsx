import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * SidePanel — Slide-in detail panel from the right.
 *
 * Props:
 *   open     — boolean
 *   onClose  — () => void
 *   title    — string
 *   children — panel content
 *   width    — optional override (default: var(--eb-side-panel-width))
 */
export default function SidePanel({ open, onClose, title, children, width }) {
  const panelRef = useRef(null);

  /* ── Escape to close ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  /* ── Click outside to close ──────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'oklch(0 0 0 / 0.3)',
      }} />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={title}
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
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--eb-shadow-xl)',
          animation: 'slideInRight 200ms ease',
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
        <div style={{
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
