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
  TOPIC_PENDING,
  KNOWN_ROUTE_PATHS,
  extractAppRoutes,
  classifyAppRoutes,
} = require('./help-routes');
const { loadRegistry, OVERVIEW_ID } = require('./help-registry');

const APP_JSX = path.join(__dirname, '..', '..', 'src', 'App.jsx');

function appSource() {
  return fs.readFileSync(APP_JSX, 'utf8');
}

function appRoutes() {
  return extractAppRoutes(appSource());
}

test('extractAppRoutes finds every path="…" literal', () => {
  const routes = extractAppRoutes('<Route path="/a"/><Route path="/b/:id"/>');
  assert.deepEqual(routes.sort(), ['/a', '/b/:id']);
});

test('every App.jsx route is classified as a page or an allowlist entry', () => {
  const { unclassified } = classifyAppRoutes(appSource());
  assert.deepEqual(
    unclassified, [],
    `App.jsx routes not registered in help-routes.js: ${unclassified.join(', ')} — ` +
    'add each to PAGE_ROUTES (and author its topic) or ALLOWLIST (structural).',
  );
});

test('no registered route was removed from App.jsx (no stale entries)', () => {
  const { stale } = classifyAppRoutes(appSource());
  assert.deepEqual(stale, [], `help-routes.js lists routes absent from App.jsx: ${stale.join(', ')}`);
});

// ── the guard is verified, not just asserted (E16 #1891, AC4) ────────────────
//
// The two tests above only ever run against the real, currently-correct App.jsx,
// so a mistake that made them vacuous (a broken extractor, a swapped filter)
// would look exactly like success. These run the same pure classifier over a
// synthetic source and prove it actually reports both failure modes.

test('AC4: a new route with neither a topic nor an allowlist entry is reported', () => {
  const { unclassified } = classifyAppRoutes(
    '<Route path="/agents" element={<Agents/>} />'
    + '<Route path="/brand-new-page" element={<New/>} />',
  );
  assert.deepEqual(unclassified, ['/brand-new-page']);
});

test('AC4: a classified route is not reported, whichever bucket it is in', () => {
  const src = '<Route path="/agents"/><Route path="/blueprints"/><Route path="/wizard/team"/>';
  assert.deepEqual(classifyAppRoutes(src).unclassified, []);
});

test('AC4: a route dropped from App.jsx is reported as stale', () => {
  const { stale } = classifyAppRoutes('<Route path="/agents"/>');
  assert.ok(stale.includes('/knowledge'), 'every route missing from the source must be listed');
  assert.ok(!stale.includes('/agents'), 'a route the source still has is not stale');
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

// ── full coverage: a page may only be help-less on purpose (E16 #1891, AC1) ───

test('AC1: every page route resolves to its own topic, or names the ticket that owes one', () => {
  const reg = loadRegistry();
  const helpless = [...PAGE_ROUTES].filter((r) => !reg.topicForRoute(r) && !TOPIC_PENDING[r]);
  assert.deepEqual(
    helpless, [],
    `page routes falling back to Overview with no owner: ${helpless.join(', ')} — `
    + 'author help-topics/<id>.md with that route in its front-matter, or add a '
    + 'TOPIC_PENDING entry naming the ticket that will.',
  );
});

test('AC1: TOPIC_PENDING only excuses real page routes, and every entry names an owner', () => {
  for (const [route, owner] of Object.entries(TOPIC_PENDING)) {
    assert.ok(
      PAGE_ROUTES.has(route),
      `${route} is in TOPIC_PENDING but not a page route — an allowlisted or unknown route needs no excuse`,
    );
    assert.match(owner, /#\d+/, `TOPIC_PENDING["${route}"] must name the owning ticket`);
  }
});

test('AC2: the /wizard/team alias shows the same help as /team-setup', () => {
  const reg = loadRegistry();
  // The two paths render the identical element in App.jsx, so they must never
  // resolve to different help — including while the topic is still pending
  // (#1888), where "the same" is "both fall back to Overview".
  assert.equal(reg.topicForRoute('/wizard/team'), reg.topicForRoute('/team-setup'));
});

test('AC2: /about and /users resolve to their own topics (this ticket authored them)', () => {
  const reg = loadRegistry();
  assert.equal(reg.topicForRoute('/about')?.id, 'about');
  assert.equal(reg.topicForRoute('/users')?.id, 'users');
});
