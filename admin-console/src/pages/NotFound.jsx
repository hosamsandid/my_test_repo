import React from 'react';
import { Link, useLocation } from 'react-router';
import { useHelperChat } from '../context/HelperChatContext';
import { NOT_FOUND_COPY, HOME_ROUTE, requestedPathLabel } from './not-found-view.js';

// Catch-all page for a URL that matches no route (#2615). Before this, React
// Router rendered nothing and the content area stayed blank, so a mistyped link
// looked like a page that was still loading. Card styling mirrors the
// RouteErrorBoundary fallback (ErrorBoundary.js) so the two "this page can't be
// shown" states read alike.

const btnBase = {
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  cursor: 'pointer',
  border: '1px solid var(--eb-border-default)',
  background: 'transparent',
  color: 'var(--eb-text-primary)',
  textDecoration: 'none',
};

export default function NotFound() {
  const { pathname, search } = useLocation();
  const { openHelpFor } = useHelperChat();

  return (
    <div data-testid="not-found" style={{ padding: 'var(--eb-space-6)', maxWidth: 640 }}>
      <div style={{
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderLeft: '3px solid var(--eb-status-warning)',
        borderRadius: 'var(--eb-radius-lg)',
        padding: 'var(--eb-space-5)',
      }}>
        <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)' }}>{NOT_FOUND_COPY.title}</h2>
        <p style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          {NOT_FOUND_COPY.body}
        </p>
        <pre style={{
          margin: '0 0 var(--eb-space-4)',
          padding: 'var(--eb-space-2)',
          background: 'var(--eb-bg-app)',
          borderRadius: 'var(--eb-radius-sm)',
          fontSize: 'var(--eb-text-xs)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {requestedPathLabel(pathname, search)}
        </pre>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
          <Link
            to={HOME_ROUTE}
            style={{
              ...btnBase,
              background: 'var(--eb-accent-primary)',
              borderColor: 'var(--eb-accent-primary)',
              color: '#fff',
            }}
          >
            {NOT_FOUND_COPY.home}
          </Link>
          <button type="button" onClick={() => openHelpFor()} style={btnBase}>
            {NOT_FOUND_COPY.help}
          </button>
        </div>
        <p style={{ margin: 'var(--eb-space-4) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>
          {NOT_FOUND_COPY.hint}
        </p>
      </div>
    </div>
  );
}
