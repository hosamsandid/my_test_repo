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
//   • PAGE_ROUTES  — a page that shows help. Since E16 (#1891) every page route
//                    must resolve to an authored topic; the Overview fallback is
//                    no longer accepted as permanent coverage, so a route whose
//                    topic is still owned by an in-flight ticket has to say so
//                    explicitly in TOPIC_PENDING below. That is the "works for
//                    all pages" guarantee of concept §3.4 — a page can only be
//                    help-less on purpose, with an owner named.
//   • ALLOWLIST    — a structural route that intentionally has NO page help of
//                    its own: redirect sources, dynamic child routes that
//                    inherit their parent's help, and stubs. These never
//                    auto-open the panel (concept §4, C2).
//
// This module is pure data + three tiny resolvers (aliases / redirects / dynamic
// collapse) shared by help-registry.js. The parallel client-side copy lives in
// admin-console/src/context/page-help-view.js (the api runtime image cannot
// import from src/, and the browser cannot require this CommonJS module — the
// duplication is by design, kept small and guarded by tests on both sides).

// Alias routes render the same page as their target and resolve to its topic.
// `/wizard/team` and `/team-setup` are literally the same element in App.jsx, so
// the alias is what registers the team-setup topic for both (E16 #1891, AC2) —
// the topic itself only has to declare the canonical route.
const ALIASES = {
  '/wizard/team': '/team-setup',
};

// Redirect sources (App.jsx <Navigate to=…>). A user never lingers on these, but
// resolving them to the destination's topic keeps help correct if one is hit
// directly. `/process/:teamId` is handled by the dynamic collapse below.
// `/getting-started` joined them in G1 (#1874): the page is gone and its content
// is the Overview face, so an old bookmark degrades to the app home — where the
// topic-less route resolves to that very Overview.
const REDIRECTS = {
  '/': '/chats',
  '/blueprints': '/agents',
  '/briefings': '/flows',
  '/getting-started': '/chats',
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
// Mirrors the non-structural routes in App.jsx. Two routes have already left
// this list: `/getting-started` in G1 (#1874) — the page is gone and it is now a
// redirect source above — and `/plugin-system` in E5 (#1879), removed outright
// (no redirect, concept §9) with its content folded into the Plugins topic.
// `/wizard/team` lives here rather than in ALLOWLIST since E16 (#1891): it is not
// a structural route at all — it renders the whole Agent Team Wizard and shows
// that page's help through the alias above, so classifying it as "no help of its
// own" was the one place the topology mis-described what a user sees.
const PAGE_ROUTES = new Set([
  '/agents',
  '/chats',
  '/create',
  '/quickstart',
  '/team-setup',
  '/wizard/team',
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
  '/about',
]);

// Structural routes with no page help of their own (redirects, dynamic children,
// the orchestrator-wizard stub). Kept explicit so the coverage test
// forces every new route to be classified as page-or-structural on purpose.
const ALLOWLIST = new Set([
  '/',
  '/blueprints',
  '/briefings',
  '/getting-started',
  '/process',
  '/process/:teamId',
  '/chats/:agentId',
  '/plugins/:id/view',
  '/orchestrator-wizard',
]);

// ── the shrinking exception list (E16 #1891, concept §3.4) ───────────────────
//
// A page route with no authored topic yet, mapped to the ticket that owns it.
// The coverage test requires every OTHER page route to resolve to a real topic,
// so this list is the only way a page can stay on the Overview fallback — and
// each entry names who is fixing that. **Delete the entry when the topic lands**
// (a stale entry does not fail CI, but it silently lowers the bar).
//
// Phase-3 extraction tickets in flight at the time of writing; each has an open
// PR authoring exactly these routes' topic.
const TOPIC_PENDING = {
  '/chats': '#1889 (E15 Agent Chat side-panels)',
  '/create': '#1888 (E14 Creation & onboarding)',
  '/quickstart': '#1888 (E14 Creation & onboarding)',
  '/team-setup': '#1888 (E14 Creation & onboarding)',
  '/wizard/team': '#1888 (E14 Creation & onboarding) — via the /team-setup alias',
  '/role-templates': '#1888 (E14 Creation & onboarding)',
  '/ssh-keys': '#1884 (E10 Credentials & GitHub access)',
  '/github-tokens': '#1884 (E10 Credentials & GitHub access)',
  '/my-credentials': '#1884 (E10 Credentials & GitHub access)',
};

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

// Classify an App.jsx source against this module's route topology. Pure, so the
// CI guard runs it on the real file and its own regression test runs it on a
// synthetic source that proves the guard actually fires (E16 #1891, AC4 — an
// assertion nobody has ever seen fail is not a guard).
//   • unclassified — routes App.jsx renders that are in neither PAGE_ROUTES nor
//                    ALLOWLIST (a new page shipping help-less).
//   • stale        — routes this module still lists that App.jsx no longer has.
function classifyAppRoutes(appJsxSource) {
  const live = extractAppRoutes(appJsxSource);
  const liveSet = new Set(live);
  return {
    routes: live,
    unclassified: live.filter((r) => !KNOWN_ROUTE_PATHS.has(r)),
    stale: [...KNOWN_ROUTE_PATHS].filter((r) => !liveSet.has(r)),
  };
}

module.exports = {
  ALIASES,
  REDIRECTS,
  DYNAMIC,
  PAGE_ROUTES,
  ALLOWLIST,
  TOPIC_PENDING,
  KNOWN_ROUTE_PATHS,
  canonicalRoute,
  extractAppRoutes,
  classifyAppRoutes,
};
