/**
 * The console's error-containment layer (#1974).
 *
 * Why this exists: an uncaught throw during render unmounts the tree up to the
 * nearest boundary. Before this file the console had exactly two boundaries,
 * both wrapping only the markdown body of a single chat message — so any throw
 * anywhere else unmounted everything up to `#root` and the user got a blank
 * white page. We had shipped point-fixes for individual triggers (#1857, #506,
 * #481) and the white screen kept returning with a new trigger. This is the
 * containment those fixes were missing: three layers, so an unknown future
 * throw is survivable instead of fatal.
 *
 *   1. `RouteErrorBoundary` — wraps the page area inside `Shell`, so a page
 *      crash leaves the navigation usable and shows a recoverable card.
 *   2. `EventErrorBoundary` — wraps one chat/log row, so a single malformed
 *      event degrades to an inline placeholder and the rest keeps streaming.
 *   3. `SafeMarkdown` / `SkillMarkdown` stay the innermost layer — now built on
 *      `markdown-safe.js`, which degrades a throwing markdown pipeline to a
 *      plain-text render that cannot itself throw (so a bad body degrades in
 *      place instead of escaping to these boundaries as a #185 loop).
 *
 * WHY THIS FILE IS `.js` AND USES `React.createElement`: the CI job that runs
 * `node --test` over the src test glob cannot parse JSX, so a `.jsx` component
 * is only reachable by the source-reading drift guards (#651). This is the one
 * component whose own behaviour must be tested — it is the thing standing
 * between a bad payload and a white screen — so it is authored JSX-free and
 * `ErrorBoundary.test.js` exercises the real class. All deterministic logic
 * lives in the pure `error-boundary-view.js`; this file is the thin adapter.
 */

import React from 'react';
import { useLocation } from 'react-router';
import {
  APP_FALLBACK_COPY,
  EVENT_FALLBACK_TEXT,
  CLIENT_ERROR_ENDPOINT,
  buildErrorReport,
  createReportGate,
  errorMessage,
  shouldResetOnKeyChange,
} from './error-boundary-view.js';

const h = React.createElement;

/**
 * One gate for the whole tab, shared by every boundary instance: the cap has to
 * be global or 200 row boundaries each get their own budget and the flood the
 * cap exists to prevent happens anyway.
 */
const sharedGate = createReportGate();

/**
 * Post a report, best-effort. A bare `fetch` on purpose, NOT the shared
 * `apiCall`: a 401 there dispatches UNAUTHORIZED_EVENT and would bounce the
 * user to the login screen because their chat row failed to render. `keepalive`
 * lets the report survive a navigation away from the broken page, and every
 * failure is swallowed — a crash reporter must never itself throw.
 */
function postClientErrorReport(report) {
  try {
    fetch(CLIENT_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* no transport (offline, blocked, no fetch) — the console.warn below stands in */
  }
}

/**
 * Generic containment boundary.
 *
 * Props:
 *  - `renderFallback(error, reset)` → the element to show instead of children.
 *  - `resetKey` — when it changes while a fallback is showing, the error is
 *    cleared (AC3). Omit it for a boundary that should stay in its fallback.
 *  - `context` — `{ scope, route, agentId, sessionId, eventId }` merged into
 *    the telemetry report.
 *  - `reportError` / `gate` — injection seams for the tests; production uses
 *    the module defaults.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.warn('[error-boundary] contained a render error:', errorMessage(error));
    const ctx = this.props.context || {};
    let route = ctx.route;
    if (route === undefined) {
      route = typeof window !== 'undefined' && window.location ? window.location.pathname : '';
    }
    const report = buildErrorReport({
      error,
      componentStack: info && info.componentStack,
      scope: ctx.scope,
      route,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      eventId: ctx.eventId,
    });
    const gate = this.props.gate || sharedGate;
    const send = this.props.reportError || postClientErrorReport;
    if (gate.allow(report.fingerprint)) send(report);
  }

  componentDidUpdate(prevProps) {
    if (shouldResetOnKeyChange(prevProps.resetKey, this.props.resetKey, this.state.error)) {
      this.setState({ error: null });
    }
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return this.props.renderFallback
        ? this.props.renderFallback(this.state.error, this.reset)
        : null;
    }
    // Healthy path returns children untouched — no wrapper element, so adding
    // a boundary cannot disturb any parent's layout or child measurement.
    // `?? null` because a class render() may not return undefined, and a row
    // renderer is allowed to produce nothing for an event it chooses to hide.
    return this.props.children ?? null;
  }
}

const btnBase = {
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  cursor: 'pointer',
  border: '1px solid var(--eb-border-default)',
  background: 'transparent',
  color: 'var(--eb-text-primary)',
};

/** The app-level recovery card (AC1). Shown in the content area; Shell chrome stays mounted. */
export function renderAppFallback(error, reset) {
  return h(
    'div',
    {
      role: 'alert',
      'data-testid': 'app-error-fallback',
      style: { padding: 'var(--eb-space-6)', maxWidth: 640 },
    },
    h(
      'div',
      {
        style: {
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderLeft: '3px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-lg)',
          padding: 'var(--eb-space-5)',
        },
      },
      h('h2', { style: { margin: 0, fontSize: 'var(--eb-text-lg)' } }, APP_FALLBACK_COPY.title),
      h(
        'p',
        { style: { color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' } },
        APP_FALLBACK_COPY.body,
      ),
      // The raw message is shown deliberately: an operator reporting this is
      // far more useful with the message than with "an error occurred".
      h(
        'pre',
        {
          style: {
            margin: '0 0 var(--eb-space-4)',
            padding: 'var(--eb-space-2)',
            background: 'var(--eb-status-error-bg)',
            borderRadius: 'var(--eb-radius-sm)',
            fontSize: 'var(--eb-text-xs)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        },
        errorMessage(error),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' } },
        h(
          'button',
          {
            type: 'button',
            onClick: reset,
            style: {
              ...btnBase,
              background: 'var(--eb-accent-primary)',
              borderColor: 'var(--eb-accent-primary)',
              color: '#fff',
            },
          },
          APP_FALLBACK_COPY.retry,
        ),
        h(
          'button',
          {
            type: 'button',
            // history.back() changes the location, which changes the route
            // resetKey, which clears the fallback — no manual reset needed.
            onClick: () => { if (typeof window !== 'undefined') window.history.back(); },
            style: btnBase,
          },
          APP_FALLBACK_COPY.back,
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => { if (typeof window !== 'undefined') window.location.reload(); },
            style: btnBase,
          },
          APP_FALLBACK_COPY.reload,
        ),
      ),
    ),
  );
}

/** The inline per-row placeholder (AC4) — one row degrades, the stream continues. */
export function renderEventFallback() {
  return h(
    'div',
    {
      role: 'note',
      'data-testid': 'event-error-fallback',
      style: {
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        border: '1px dashed var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        color: 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
        fontStyle: 'italic',
      },
    },
    EVENT_FALLBACK_TEXT,
  );
}

/**
 * App/route-level boundary (AC2, AC3). Mounted inside `Shell` around
 * `Suspense`/`Routes`, so the nav survives a page crash.
 *
 * It reads the location itself rather than taking it from `App` on purpose:
 * calling `useLocation()` in `App` would re-render Shell and the whole page
 * tree on every navigation.
 */
export function RouteErrorBoundary({ children }) {
  const location = useLocation();
  return h(
    ErrorBoundary,
    {
      resetKey: location.pathname,
      renderFallback: renderAppFallback,
      context: { scope: 'app', route: location.pathname },
    },
    children,
  );
}

/**
 * Per-row boundary for the chat transcript and the session log (AC4).
 *
 * No `resetKey`: a malformed event is still malformed on the next render, so
 * re-trying it would just re-throw. It recovers naturally when the row scrolls
 * out of the virtualized window and is remounted.
 */
export function EventErrorBoundary({ children, agentId, sessionId, eventId }) {
  return h(
    ErrorBoundary,
    {
      renderFallback: renderEventFallback,
      context: { scope: 'event', agentId, sessionId, eventId },
    },
    children,
  );
}

export default ErrorBoundary;
