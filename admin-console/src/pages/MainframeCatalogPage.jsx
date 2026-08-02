import React, { useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useColorScheme } from '../hooks/useColorScheme';

export default function MainframeCatalogPage() {
  const navigate = useNavigate();
  const iframeRef = useRef(null);
  const scheme = useColorScheme();
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'set-theme', theme: scheme }, '*');
  }, [scheme]);

  const handleLoad = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'set-theme', theme: schemeRef.current }, '*');
  }, []);

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <button onClick={() => navigate('/patterns')} style={backBtnStyle}>
          <ArrowLeft size={16} />
          Back to Catalogs
        </button>
        <div style={titleGroupStyle}>
          <h1 style={titleStyle}>Mainframe Modernization Catalog</h1>
          <p style={subtitleStyle}>
            Pattern catalog for COBOL, JCL, DB2, IMS and related mainframe modernization strategies.
          </p>
        </div>
        <a
          href="/pattern-catalog.html"
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
          ref={iframeRef}
          onLoad={handleLoad}
          src="/pattern-catalog.html"
          title="Mainframe Modernization Pattern Catalog"
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
};
