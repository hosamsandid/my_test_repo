import React, { useEffect } from 'react';
import { X, ExternalLink } from 'lucide-react';

/**
 * WorkflowDiagramModal — full-screen modal that embeds the AEE Agent Workflow
 * diagram (admin-console/public/aee-workflow-diagram.html). An iframe is used
 * for hard style isolation so the diagram's page-level CSS cannot leak into
 * the admin console.
 */
export default function WorkflowDiagramModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AEE Agent Workflow Diagram"
      onClick={onClose}
      style={overlayStyle}
    >
      <div onClick={(e) => e.stopPropagation()} style={dialogStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <h2 style={titleStyle}>AEE Agent Workflow</h2>
            <span style={subtitleStyle}>
              End-to-end view of the trigger- and label-driven team — pick roles
              below based on which lanes you want to staff.
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexShrink: 0 }}>
            <a
              href="/aee-workflow-diagram.html"
              target="_blank"
              rel="noopener noreferrer"
              style={openInTabStyle}
              title="Open in a new tab"
            >
              <ExternalLink size={14} />
              Open in new tab
            </a>
            <button
              onClick={onClose}
              aria-label="Close diagram"
              style={closeBtnStyle}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <iframe
          src="/aee-workflow-diagram.html"
          title="AEE Agent Workflow Diagram"
          style={iframeStyle}
        />
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'oklch(0 0 0 / 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  padding: 'var(--eb-space-4)',
};

const dialogStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  boxShadow: 'var(--eb-shadow-xl)',
  width: 'min(1400px, 95vw)',
  height: 'min(900px, 92vh)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-4)',
  padding: 'var(--eb-space-4)',
  borderBottom: '1px solid var(--eb-border-default)',
  flexShrink: 0,
};

const titleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-lg)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const subtitleStyle = {
  marginTop: 4,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.4,
};

const closeBtnStyle = {
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
};

const openInTabStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 'var(--eb-space-1) var(--eb-space-3)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  fontSize: 'var(--eb-text-sm)',
  textDecoration: 'none',
  background: 'transparent',
};

const iframeStyle = {
  flex: 1,
  width: '100%',
  border: 'none',
  background: '#f8f9fb',
};
