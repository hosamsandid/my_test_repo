import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ExternalLink } from 'lucide-react';

// The console shell for a UI-bearing plugin (Network Plan epic #1554, Phase 2).
// It renders an <iframe> onto the plugin's own UI, served + governed by the
// console proxy at `/plugins/:id/ui` (docs/network-plan-plugin-concept.md §7).
// No React injection — the iframe boundary IS the contract (§4.8): the plugin
// inherits no console state, and its viewer identity arrives at the sidecar as
// signed headers set by the proxy, never from anything this page passes in.
//
// The host renders no chrome header (#1644): the plugin fills the whole padded,
// bordered content area on its own. Navigation stays with the Shell sidebar and
// the top-bar breadcrumb; the only host control kept is a small icon-only
// "open in a new tab" action above the iframe.
export default function PluginUiPage() {
  const { id } = useParams();
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
      <div style={toolbarStyle}>
        <a
          href={uiSrc}
          target="_blank"
          rel="noopener noreferrer"
          style={openTabStyle}
          title="Open in a new tab"
          aria-label={`Open ${title} plugin in a new tab`}
        >
          <ExternalLink size={16} />
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
  gap: 'var(--eb-space-2)',
  boxSizing: 'border-box',
};

// A minimal control strip that holds only the icon-only "open in new tab"
// action, right-aligned. It replaces the removed chrome header (#1644) and is
// kept intentionally slim so the iframe reclaims the freed vertical space.
const toolbarStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  flexShrink: 0,
};

const openTabStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  textDecoration: 'none',
  background: 'transparent',
  flexShrink: 0,
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
