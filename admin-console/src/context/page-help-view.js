// ─── Context-help client decisions (#1872, spec docs/context-help-system-concept.md §3.3) ──
//
// Pure, React-free core the "This page" panel face runs against the topic set
// fetched once from GET /api/helper/page-help. It:
//   • resolves the current route → its topic (dynamic / alias / redirect aware),
//   • decides the Overview fallback when a route has no dedicated topic, and
//   • shapes an askPrompt into the hand-off to the Ask face.
//
// The route-collapse maps mirror the server-side admin-console/api/helper-chat/
// help-routes.js (the api runtime cannot import from src/, the browser cannot
// require that CommonJS module — the small duplication is by design and both
// copies are unit-tested). Keep them in step when a route alias/redirect is
// added. The JSX face renderer (C2, #1873) stays uncovered per the #651
// convention; this module holds every decision it makes.

// Alias routes render the same page as their target and resolve to its topic.
export const ALIASES = {
  '/wizard/team': '/team-setup',
};

// Redirect sources → their destination (App.jsx <Navigate to=…>). `/getting-started`
// is one since G1 (#1874) retired the page — an old bookmark lands on the app home,
// whose topic-less route resolves to the Overview that now carries its content.
export const REDIRECTS = {
  '/': '/chats',
  '/blueprints': '/agents',
  '/briefings': '/flows',
  '/getting-started': '/chats',
  '/process': '/flows',
};

// Dynamic routes collapse to a canonical parent for topic resolution. A null
// canonical means "no topic" (the plugin viewer is allowlisted).
const DYNAMIC = [
  { match: (p) => /^\/chats\/[^/]+$/.test(p), canonical: '/chats' },
  { match: (p) => /^\/plugins\/[^/]+\/view$/.test(p), canonical: null },
  { match: (p) => /^\/process\/[^/]+$/.test(p), canonical: '/flows' },
];

// Collapse a concrete pathname to the canonical route key used for topic lookup.
export function canonicalRoute(pathname) {
  if (typeof pathname !== 'string' || !pathname) return null;
  for (const d of DYNAMIC) {
    if (d.match(pathname)) return d.canonical;
  }
  if (ALIASES[pathname]) return ALIASES[pathname];
  if (REDIRECTS[pathname]) return REDIRECTS[pathname];
  return pathname;
}

// Normalize the /api/helper/page-help payload into { topics, overviewId }.
// Forgiving: accepts a bare array of topics or the wrapped object.
export function normalizePageHelp(payload) {
  if (Array.isArray(payload)) return { topics: payload, overviewId: 'overview' };
  const topics = payload && Array.isArray(payload.topics) ? payload.topics : [];
  const overviewId = (payload && typeof payload.overviewId === 'string') ? payload.overviewId : 'overview';
  return { topics, overviewId };
}

// Build a route → topic index (first topic to claim a route wins, matching the
// server registry).
function indexByRoute(topics) {
  const byRoute = new Map();
  for (const t of topics || []) {
    for (const r of (t.routes || [])) {
      if (!byRoute.has(r)) byRoute.set(r, t);
    }
  }
  return byRoute;
}

// The Overview topic from the set (by id), or null.
export function overviewTopic(payload) {
  const { topics, overviewId } = normalizePageHelp(payload);
  return topics.find((t) => t && t.id === overviewId) || null;
}

// Resolve a pathname to its dedicated topic, or null when the route has none
// (the caller then shows the Overview fallback).
export function resolvePageTopic(payload, pathname) {
  const { topics } = normalizePageHelp(payload);
  const byRoute = indexByRoute(topics);
  if (byRoute.has(pathname)) return byRoute.get(pathname);
  const canon = canonicalRoute(pathname);
  if (canon && byRoute.has(canon)) return byRoute.get(canon);
  return null;
}

// The full render decision for the "This page" face:
//   { topic, isOverview, overview }
// `topic` is what to render (the page topic, or the Overview topic as fallback);
// `isOverview` tells the face to show the Overview home rather than a page topic
// (so it can hide the "← Overview" home link, which would be a no-op there).
export function pageHelpState(payload, pathname) {
  const overview = overviewTopic(payload);
  const topic = resolvePageTopic(payload, pathname);
  if (topic) return { topic, isOverview: topic === overview, overview };
  return { topic: overview, isOverview: true, overview };
}

// True when the route has its own dedicated topic (drives first-run auto-open in
// C2 — routes with only the Overview fallback do not auto-open, concept §4).
export function hasDedicatedTopic(payload, pathname) {
  return resolvePageTopic(payload, pathname) !== null;
}

// Shape an askPrompt chip click into the hand-off to the Ask face: switch mode
// and pre-seed the question. Kept as data so the JSX just applies it.
export function askHandoff(prompt) {
  const question = typeof prompt === 'string' ? prompt.trim() : '';
  return { mode: 'ask', question };
}

// Normalize a topic's seeAlso list into safe { label, to } link rows (drops
// entries missing a destination).
export function seeAlsoLinks(topic) {
  if (!topic || !Array.isArray(topic.seeAlso)) return [];
  return topic.seeAlso
    .filter((s) => s && s.to)
    .map((s) => ({ label: s.label || s.to, to: s.to }));
}

// Normalize a topic's `actions` into safe call-to-action rows (#1874, concept §5)
// — the "where to go next" buttons the retired Getting Started page carried.
// Each row is either a navigation (`to`) or a panel verb (`action: 'tour'`, which
// the face wires to openTour()); a row missing a label or both targets is dropped
// so a malformed topic can never render a dead button. `to` wins over `action`.
export const TOPIC_CTA_ACTIONS = ['tour'];

export function topicActions(topic) {
  if (!topic || !Array.isArray(topic.actions)) return [];
  const out = [];
  for (const a of topic.actions) {
    if (!a || typeof a !== 'object') continue;
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const to = typeof a.to === 'string' ? a.to.trim() : '';
    const action = typeof a.action === 'string' ? a.action.trim() : '';
    if (!label) continue;
    if (to) out.push({ label, to, action: '', primary: a.primary === true });
    else if (TOPIC_CTA_ACTIONS.includes(action)) out.push({ label, to: '', action, primary: a.primary === true });
  }
  return out;
}

// Normalize a topic's askPrompts into a de-duplicated, non-empty string list.
export function askPromptChips(topic) {
  if (!topic || !Array.isArray(topic.askPrompts)) return [];
  const seen = new Set();
  const out = [];
  for (const p of topic.askPrompts) {
    const q = typeof p === 'string' ? p.trim() : '';
    if (q && !seen.has(q)) { seen.add(q); out.push(q); }
  }
  return out;
}

// ─── First-run auto-open (#1873, concept §4/§9) ──────────────────────────────
//
// The panel auto-opens on the "This page" face the FIRST time a user lands on a
// route that has a dedicated topic — once, dismissible, never re-fought. The
// "seen" set is a per-user list of route keys persisted in localStorage; the
// browser-side effect owns the read/write, these pure helpers own every
// decision (which key, whether to open, the next seen list).

// The per-user localStorage key holding the set of routes whose first-run nudge
// has already fired. A blank/absent username collapses to a shared 'anon' key
// (the env single-admin has no user record) so the nudge still fires once.
export function seenRoutesKey(username) {
  const u = (typeof username === 'string' && username.trim()) ? username.trim() : 'anon';
  return `help.seenRoutes.${u}`;
}

// The canonical key a route's first-run nudge is recorded under — the same
// collapse used for topic resolution, so /chats/<id> and /chats share one nudge.
// null when the route has no dedicated topic (Overview-only routes never
// auto-open, concept §4).
export function autoOpenRouteKey(payload, pathname) {
  if (!hasDedicatedTopic(payload, pathname)) return null;
  return canonicalRoute(pathname) || pathname;
}

// The first-run auto-open decision for a route:
//   { open, routeKey }
// `open` is true only when the route has a dedicated topic (routeKey non-null)
// AND that key has not been seen yet. `routeKey` is what to persist as seen when
// the nudge fires (non-null even when open is false-because-already-seen, so a
// caller never needs to recompute it; null only when the route has no topic).
export function autoOpenPlan(payload, pathname, seenRoutes) {
  const routeKey = autoOpenRouteKey(payload, pathname);
  if (!routeKey) return { open: false, routeKey: null };
  const seen = Array.isArray(seenRoutes) ? seenRoutes : [];
  return { open: !seen.includes(routeKey), routeKey };
}

// Add a routeKey to the seen list, returning a NEW de-duplicated array (the
// input is never mutated). A blank routeKey is a no-op passthrough.
export function markSeen(seenRoutes, routeKey) {
  const seen = Array.isArray(seenRoutes) ? seenRoutes.slice() : [];
  if (routeKey && !seen.includes(routeKey)) seen.push(routeKey);
  return seen;
}

// Parse the raw localStorage value for the seen-routes set into a string array,
// fail-soft (bad JSON / non-array → []). Keeps the browser effect a one-liner.
export function parseSeenRoutes(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
