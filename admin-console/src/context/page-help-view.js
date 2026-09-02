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

// Redirect sources → their destination (App.jsx <Navigate to=…>).
export const REDIRECTS = {
  '/': '/chats',
  '/blueprints': '/agents',
  '/briefings': '/flows',
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
