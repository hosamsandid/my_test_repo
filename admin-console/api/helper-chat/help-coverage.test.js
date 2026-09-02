'use strict';

// ─── Route-coverage guard (#1872, spec §3.4 — the "works for all pages" guarantee) ──
//
// Every route reachable in admin-console/src/App.jsx must be KNOWN to the help
// system — either a PAGE route (shows its own topic or the Overview fallback) or
// an explicit structural ALLOWLIST entry (redirect, alias, dynamic child, stub).
// A new <Route> added to App.jsx without classifying it here FAILS CI, so no page
// can ship silently help-less and the coverage cannot rot as the app grows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  PAGE_ROUTES,
  ALLOWLIST,
  KNOWN_ROUTE_PATHS,
  extractAppRoutes,
} = require('./help-routes');
const { loadRegistry, OVERVIEW_ID } = require('./help-registry');

const APP_JSX = path.join(__dirname, '..', '..', 'src', 'App.jsx');

function appRoutes() {
  const src = fs.readFileSync(APP_JSX, 'utf8');
  return extractAppRoutes(src);
}

test('extractAppRoutes finds every path="…" literal', () => {
  const routes = extractAppRoutes('<Route path="/a"/><Route path="/b/:id"/>');
  assert.deepEqual(routes.sort(), ['/a', '/b/:id']);
});

test('every App.jsx route is classified as a page or an allowlist entry', () => {
  const missing = appRoutes().filter((r) => !KNOWN_ROUTE_PATHS.has(r));
  assert.deepEqual(
    missing, [],
    `App.jsx routes not registered in help-routes.js: ${missing.join(', ')} — ` +
    'add each to PAGE_ROUTES (it gets a topic or the Overview fallback) or ALLOWLIST (structural).',
  );
});

test('no registered route was removed from App.jsx (no stale entries)', () => {
  const live = new Set(appRoutes());
  const stale = [...KNOWN_ROUTE_PATHS].filter((r) => !live.has(r));
  assert.deepEqual(stale, [], `help-routes.js lists routes absent from App.jsx: ${stale.join(', ')}`);
});

test('PAGE_ROUTES and ALLOWLIST are disjoint (each route classified exactly once)', () => {
  const overlap = [...PAGE_ROUTES].filter((r) => ALLOWLIST.has(r));
  assert.deepEqual(overlap, [], `routes in both PAGE_ROUTES and ALLOWLIST: ${overlap.join(', ')}`);
});

test('the Overview fallback topic exists (so every page route has at least fallback help)', () => {
  const reg = loadRegistry();
  assert.ok(reg.byId.has(OVERVIEW_ID), 'help-topics/overview.md must define the Overview topic');
});

test('topicForRoute resolves without error for every known route', () => {
  const reg = loadRegistry();
  for (const r of KNOWN_ROUTE_PATHS) {
    assert.doesNotThrow(() => reg.topicForRoute(r), `topicForRoute threw on ${r}`);
  }
});
