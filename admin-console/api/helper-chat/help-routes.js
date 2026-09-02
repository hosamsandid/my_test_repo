'use strict';

// ─── Context-help route topology (#1872, spec docs/context-help-system-concept.md §3.4) ──
//
// The single source of truth for *which* console routes the help system knows
// about and *how* each is covered. It mirrors the route table in
// admin-console/src/App.jsx — a route that exists there but is absent here (or
// vice-versa) is a drift the coverage test (help-coverage.test.js) turns into a
// CI failure, so a future new page cannot ship silently help-less.
//
// Two ways a route is "covered":
//   • PAGE_ROUTES  — a page that shows help. It renders its own authored topic
//                    when one exists, else the always-present Overview fallback
//                    (concept §2 — "Overview is the fallback content of the
//                    This page face"). Both states are legitimate coverage, so a
//                    page route needs no per-route topic to be considered covered
//                    at the foundation stage; the extraction tickets (E1–E15)
//                    author the specific topics later.
//   • ALLOWLIST    — a structural route that intentionally has NO page help of
//                    its own: redirect sources, the /wizard/team alias, dynamic
//                    child routes that inherit their parent's help, and stubs.
//                    These never auto-open the panel (concept §4, C2).
//
// This module is pure data + three tiny resolvers (aliases / redirects / dynamic
// collapse) shared by help-registry.js. The parallel client-side copy lives in
// admin-console/src/context/page-help-view.js (the api runtime image cannot
// import from src/, and the browser cannot require this CommonJS module — the
// duplication is by design, kept small and guarded by tests on both sides).

// Alias routes render the same page as their target and resolve to its topic.
const ALIASES = {
  '/wizard/team': '/team-setup',
};

// Redirect sources (App.jsx <Navigate to=…>). A user never lingers on these, but
// resolving them to the destination's topic keeps help correct if one is hit
// directly. `/process/:teamId` is handled by the dynamic collapse below.
const REDIRECTS = {
  '/': '/chats',
  '/blueprints': '/agents',
  '/briefings': '/flows',
  '/process': '/flows',
};

// Dynamic routes collapse to a canonical parent for topic resolution, exactly as
// admin-console/src/components/breadcrumbs.js resolves them for the breadcrumb.
// Each entry: { match(pathname) -> boolean, canonical: <route|null> }. A null
// canonical means "no topic" (the plugin viewer is allowlisted, concept §3.4).
const DYNAMIC = [
  { match: (p) => /^\/chats\/[^/]+$/.test(p), canonical: '/chats' },
  { match: (p) => /^\/plugins\/[^/]+\/view$/.test(p), canonical: null },
  { match: (p) => /^\/process\/[^/]+$/.test(p), canonical: '/flows' },
];

// Every content route that shows page help (own topic or Overview fallback).
// Mirrors the non-structural routes in App.jsx. `/getting-started` and
// `/plugin-system` are still page routes here — G1 (#1874) and E5 (#1879)
// remove them and this list drops them in the same commit.
const PAGE_ROUTES = new Set([
  '/agents',
  '/chats',
  '/create',
  '/quickstart',
  '/team-setup',
  '/environments',
  '/ssh-keys',
  '/github-tokens',
  '/my-credentials',
  '/skills',
  '/role-templates',
  '/github-events',
  '/token-usage',
  '/models',
  '/mcp',
  '/plugins',
  '/maintenance-mode',
  '/teams',
  '/users',
  '/flows',
  '/knowledge',
  '/getting-started',
  '/plugin-system',
  '/about',
]);

// Structural routes with no page help of their own (redirects, alias, dynamic
// children, the orchestrator-wizard stub). Kept explicit so the coverage test
// forces every new route to be classified as page-or-structural on purpose.
const ALLOWLIST = new Set([
  '/',
  '/blueprints',
  '/briefings',
  '/process',
  '/process/:teamId',
  '/chats/:agentId',
  '/plugins/:id/view',
  '/wizard/team',
  '/orchestrator-wizard',
]);

// The full set of routes the help system knows about — every App.jsx path must
// be in here (as a page or a structural allowlist entry) and nothing else.
const KNOWN_ROUTE_PATHS = new Set([...PAGE_ROUTES, ...ALLOWLIST]);

// Collapse a concrete pathname to the canonical route key used for topic lookup:
// apply the dynamic-route collapse, then the alias, then the redirect. Returns
// null when a dynamic route explicitly has no topic (the plugin viewer).
function canonicalRoute(pathname) {
  if (typeof pathname !== 'string' || !pathname) return null;
  for (const d of DYNAMIC) {
    if (d.match(pathname)) return d.canonical;
  }
  if (ALIASES[pathname]) return ALIASES[pathname];
  if (REDIRECTS[pathname]) return REDIRECTS[pathname];
  return pathname;
}

// Extract every `<Route path="…">` string from an App.jsx source. Pure so the
// coverage test parses the real file the same way tooling would. Deliberately
// simple (the routes are authored as plain string literals).
function extractAppRoutes(appJsxSource) {
  const out = new Set();
  const re = /path="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(appJsxSource || ''))) !== null) out.add(m[1]);
  return [...out];
}

module.exports = {
  ALIASES,
  REDIRECTS,
  DYNAMIC,
  PAGE_ROUTES,
  ALLOWLIST,
  KNOWN_ROUTE_PATHS,
  canonicalRoute,
  extractAppRoutes,
};
