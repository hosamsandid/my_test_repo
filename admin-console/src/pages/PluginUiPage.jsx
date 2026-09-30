import React, { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { documentTitleForPath } from '../route-title';
import { PLUGIN_MISSING_COPY, resolvePluginUi, pluginTitlesFor } from './plugin-ui-view.js';

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
  const { pathname } = useLocation();
  // `loading` until GET /api/plugins answers, then resolvePluginUi's state
  // (plugin-ui-view.js). The iframe is only mounted once the plugin is known to
  // serve a UI — or the lookup failed (best effort, as before) — so an unknown
  // id never flashes the proxy's raw 404 JSON (#2650).
  // The resolved state is tagged with its id, so switching from one plugin to
  // another reads as loading until the new lookup lands (no stale iframe).
  const [resolved, setResolved] = useState(null);
  const view = resolved && resolved.id === id ? resolved : { status: 'loading', title: id };

  useEffect(() => {
    let cancelled = false;
    fetch('/api/plugins')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => { if (!cancelled) setResolved({ ...resolvePluginUi(body, id), id }); });
    return () => { cancelled = true; };
  }, [id]);

  // The tab title follows the display name once it is known (#2650). App's
  // DocumentTitle sets the id-based title on navigation; this runs after the
  // lookup resolves, so the name wins.
  useEffect(() => {
    if (view.status === 'ready') document.title = documentTitleForPath(pathname, pluginTitlesFor(id, view.title));
  }, [view.status, view.title, pathname, id]);

  const title = view.title;

  if (view.status === 'loading') return <div style={pageStyle} />;

  if (view.status === 'missing') {
    return (
      <div data-testid="plugin-missing" style={{ padding: 'var(--eb-space-6)', maxWidth: 640 }}>
        <div style={missingCardStyle}>
          <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)' }}>{PLUGIN_MISSING_COPY.title}</h2>
          <p style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
            {PLUGIN_MISSING_COPY.body}
          </p>
          <pre style={idStyle}>{id}</pre>
          <Link to={view.back.to} style={backLinkStyle}>{view.back.label}</Link>
        </div>
      </div>
    );
  }

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

// "Not available" card — styled like the NotFound page (#2615) so the two
// "nothing to show here" states read alike.
const missingCardStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderLeft: '3px solid var(--eb-status-warning)',
  borderRadius: 'var(--eb-radius-lg)',
  padding: 'var(--eb-space-5)',
};

const idStyle = {
  margin: '0 0 var(--eb-space-4)',
  padding: 'var(--eb-space-2)',
  background: 'var(--eb-bg-app)',
  borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-xs)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const backLinkStyle = {
  display: 'inline-block',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  border: '1px solid var(--eb-accent-primary)',
  background: 'var(--eb-accent-primary)',
  color: '#fff',
  textDecoration: 'none',
};

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
