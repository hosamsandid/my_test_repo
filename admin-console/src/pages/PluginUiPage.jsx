import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';

// The console shell for a UI-bearing plugin (Network Plan epic #1554, Phase 2).
// It renders nothing but a chrome header and an <iframe> onto the plugin's own
// UI, served + governed by the console proxy at `/plugins/:id/ui`
// (docs/network-plan-plugin-concept.md §7). No React injection — the iframe
// boundary IS the contract (§4.8): the plugin inherits no console state, and
// its viewer identity arrives at the sidecar as signed headers set by the
// proxy, never from anything this page passes in.
export default function PluginUiPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState(id);

  // Best-effort nicer title from the manifest; the iframe works regardless.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/plugins')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const p = (body.installed || []).find((x) => x.id === id);
        const ui = p && p.manifest && p.manifest.ui;
        if (ui && (ui.title || p.manifest.name)) setTitle(ui.title || p.manifest.name);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  // Trailing slash is load-bearing: the plugin UI is a directory, so the served
  // index.html can reference its assets ("app.js") and data API ("api/board")
  // with relative paths. Without it the browser resolves those against ".../ui"
  // as a *file* — "app.js" becomes ".../app.js" (outside the /ui proxy mount,
  // so it 404s) and the board never loads. See docs/network-plan-plugin-concept §7.
  const uiSrc = `/plugins/${encodeURIComponent(id)}/ui/`;

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <button onClick={() => navigate(-1)} style={backBtnStyle}>
          <ArrowLeft size={16} />
          Back
        </button>
        <div style={titleGroupStyle}>
          <h1 style={titleStyle}>{title}</h1>
          <p style={subtitleStyle}>
            Served from the plugin's own sidecar and proxied by the console. Your identity and role
            are forwarded as signed headers; the plugin enforces access again on its side.
          </p>
        </div>
        <a href={uiSrc} target="_blank" rel="noopener noreferrer" style={openTabStyle} title="Open in a new tab">
          <ExternalLink size={14} />
          Open in new tab
        </a>
      </div>

      <div style={iframeWrapStyle}>
        <iframe src={uiSrc} title={`${title} plugin UI`} style={iframeStyle} />
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

const titleGroupStyle = { flex: 1, minWidth: 0 };

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
  background: 'var(--eb-bg-surface)',
};
