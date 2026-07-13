import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';

export default function SdlcCatalogPage() {
  const navigate = useNavigate();

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <button onClick={() => navigate('/patterns')} style={backBtnStyle}>
          <ArrowLeft size={16} />
          Back to Catalogs
        </button>
        <div style={titleGroupStyle}>
          <h1 style={titleStyle}>SDLC Catalog</h1>
          <p style={subtitleStyle}>
            End-to-end view of the trigger- and label-driven team — pick roles based on which lanes you want to staff.
          </p>
        </div>
        <a
          href="/aee-workflow-diagram.html"
          target="_blank"
          rel="noopener noreferrer"
          style={openTabStyle}
          title="Open in a new tab"
        >
          <ExternalLink size={14} />
          Open in new tab
        </a>
      </div>

      <div style={iframeWrapStyle}>
        <iframe
          src="/aee-workflow-diagram.html"
          title="AEE Agent Workflow Diagram"
          style={iframeStyle}
        />
      </div>
    </div>
  );
}

const pageStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  gap: 'var(--eb-space-4)',
  boxSizing: 'border-box',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--eb-space-4)',
  flexShrink: 0,
};

const backBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const titleGroupStyle = {
  flex: 1,
};

const titleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-xl)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
};

const subtitleStyle = {
  marginTop: 4,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-secondary)',
  lineHeight: 1.4,
};

const openTabStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  fontSize: 'var(--eb-text-sm)',
  textDecoration: 'none',
  background: 'transparent',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const iframeWrapStyle = {
  flex: 1,
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  overflow: 'hidden',
  minHeight: 0,
};

const iframeStyle = {
  width: '100%',
  height: '100%',
  border: 'none',
  background: '#f8f9fb',
};
