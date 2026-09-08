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
//                    inherit their parent's help, and stubs.
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
// `/agents` joined them in #1930 for the same reason, and took `/blueprints`
// with it: that alias used to point AT `/agents`, so re-pointing it was part of
// removing the page rather than a separate decision. Both now resolve to the
// Agent Chat topic, which is where the page's capabilities went (#1928, #1929).
const REDIRECTS = {
  '/': '/chats',
  '/agents': '/chats',
  '/blueprints': '/chats',
  '/briefings': '/flows',
  '/getting-started': '/chats',
  '/process': '/flows',
  // #2085 (D10): the Access page is dissolved and `/teams` redirects to the
  // Administration surface, whose topic absorbed `access-users.md`. Same shape
  // as `/agents` → `/chats` in #1930 — an old link keeps its help instead of
  // falling back to the Overview.
  '/teams': '/users',
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
// `/agents` left in #1930, the third route to do so: the page is gone, its
// capabilities are the Agent Chat rail's, and its topic was folded into
// `agent-chat.md` rather than retired — the concepts it carried (the roles, the
// lifecycle states, Disable vs Reset to stub vs Delete, what the form fields
// control) all describe surfaces that still exist, just elsewhere.
// `/teams` left in #2085 (epic #2076 P6, D10), the fourth route to do so and the
// second by the same mechanism: the Access page is dissolved, its two
// System-Admin halves are tabs on `/users`, and `access-users.md` was folded
// into that page's topic rather than retired — an access scope is still what a
// resource's team tier names, so its concepts describe a live surface.
const PAGE_ROUTES = new Set([
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
  '/users',
  '/flows',
  '/knowledge',
  '/about',
]);

// Structural routes with no page help of their own (redirects, dynamic
// children). Kept explicit so the coverage test forces every new route to be
// classified as page-or-structural on purpose.
const ALLOWLIST = new Set([
  '/',
  '/agents',
  '/teams',
  '/blueprints',
  '/briefings',
  '/getting-started',
  '/process',
  '/process/:teamId',
  '/chats/:agentId',
  '/plugins/:id/view',
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
  // Discharged as their topics landed: E10 (#1884) covers /ssh-keys,
  // /github-tokens and /my-credentials (credentials.md), E14 (#1888) covers
  // /create + /quickstart (create.md), /team-setup (team-setup.md, with
  // /wizard/team as its alias) and /role-templates (role-templates.md), and
  // E15 (#1889) covers /chats (agent-chat.md, which /chats/:agentId collapses
  // onto) — the last route that owed a topic. Empty is the goal state: every
  // page route now resolves to an authored topic, so the coverage test accepts
  // no Overview fallback at all.
};

// The full set of routes the help system knows about — every App.jsx path must
// be in here (as a page or a structural allowlist entry) and nothing else.
const KNOWN_ROUTE_PATHS = new Set([...PAGE_ROUTES, ...ALLOWLIST]);

// ── non-route help contexts (E17 #1892, docs/helper-chat-concept.md §3.2) ──
//
// Three help-worthy surfaces are not routes at all, so a pathname cannot address
// them: the **Settings dialog** (an overlay on top of whatever page you are on),
// the **first-run setup wizard** (rendered *instead of* the Shell, before any
// route exists) and the **individual steps inside a wizard** (sub-states of one
// route). The help context therefore widens from a bare pathname to
// `{ route, overlay, step }`, and a topic can claim any of these keys in the same
// `routes:` front-matter list it claims a pathname in.
//
// A context key is namespaced so it can never collide with a pathname (which
// always starts with `/`):
//   `<kind>:<name>`   an overlay          — `modal:settings`, `wizard:setup`
//   `<base>#<state>`  a sub-state of a route or of an overlay — `/team-setup#process`
//
// Every key is listed here for the same reason every route is listed above: so a
// key can only be typo'd or orphaned on purpose. `alias` points a key at the
// route whose topic already answers it — that is how the first-run wizard gets
// help "sourced from the same topic content used elsewhere" (#1892 AC2) without
// a second copy of the prose.
const OVERLAY_KEYS = {
  'modal:settings': 'The Settings dialog (account menu → Settings).',
  'wizard:setup': 'The first-run setup wizard, rendered before the Shell exists.',
  'modal:skill-detail': 'The skill detail side panel on the Skills page.',
  'modal:skills-merge': 'The Merge skills dialog on the Skills page.',
  'modal:knowledge-config': 'The Team knowledge configuration side panel on the Knowledge page.',
  'modal:knowledge-skill': 'The skill inspector side panel in the Knowledge page\'s Skills column.',
  'modal:mcp-server': 'The New MCP server side panel on the MCP Servers page.',
  'modal:mcp-credential': 'The New MCP credential side panel on the MCP Servers page.',
  'modal:flow-edge': 'The hand-off chooser and the edge dialogs on the Flows canvas.',
  'modal:flow-labels': 'The Label registry side panel in the Flow editor.',
  'modal:flow-humans': 'The Human roles side panel in the Flow editor.',
  'modal:flow-stages': 'The Stages side panel in the Flow editor.',
  'modal:flow-node': 'The agent inspector side panel in the Flow editor (Details / Routing).',
  'modal:flow-anomalies': 'The Flow anomalies side panel of a live team.',
  'modal:flow-improvements': 'The Improvements side panel of a live team.',
  'modal:draft-share': 'The Share side panel of a draft on the Flows rail.',
  'modal:team-share': 'The Share side panel of an Agent Team in the Agent Chat rail.',
  'modal:plugin-install': 'The install confirmation dialog on the Plugins page.',
  'modal:plugin-uninstall': 'The uninstall confirmation dialog on the Plugins page.',
  'modal:model-provider': 'The create/edit provider side panel on the Model Providers page.',
  'modal:environment-form': 'The create/edit side panel on the Working Environments page.',
  'modal:toolchains': 'The System-Admin Toolchains side panel on the Working Environments page.',
  'modal:team-delete': 'The delete-team confirmation on the Administration page\u2019s All Teams tab.',
  'modal:user-edit': 'The Edit side panel on the Administration page\u2019s Users tab.',
  'modal:user-delete': 'The delete/offboarding confirmation on the Administration page\u2019s Users tab.',
  'modal:agent-template': 'The template editor side panel on the Agent Templates page.',
  'modal:env-propagation': 'The repositories-changed / catch-up dialog on the Working Environments page.',
};

const CONTEXT_KEYS = {
  'modal:settings': { label: 'Settings dialog' },
  // The dialog's three sections. Optional coverage, exactly like the wizard steps
  // below: while no topic claims one, the resolver falls back to the dialog's own
  // topic, so the section keys are an extension point rather than a debt.
  'modal:settings#behavior': { label: 'Settings · Behavior' },
  'modal:settings#model': { label: 'Settings · Model' },
  'modal:settings#display': { label: 'Settings · Display' },
  'wizard:setup': { label: 'First-run setup' },
  // The first-run wizard's three steps reuse the topics the corresponding
  // console pages already own — no duplicate prose (AC2). All three resolve:
  // `/models` (E8) and the credentials topic E10 (#1884) gave `/ssh-keys` +
  // `/github-tokens`. A step whose aliased topic is ever missing renders no help
  // box rather than an empty one.
  'wizard:setup#llm': { label: 'First-run · Model Provider', alias: '/models' },
  'wizard:setup#ssh-key': { label: 'First-run · SSH Key', alias: '/ssh-keys' },
  'wizard:setup#gh-token': { label: 'First-run · GitHub Token', alias: '/github-tokens' },
  // Agent Team Wizard steps (AC3). A step key is *optional* coverage by design:
  // while no topic claims it the resolver falls through to the wizard's own
  // route topic, so the panel is never emptier than it is today. #1888 owns the
  // wizard's topic content and may claim these keys to make a step's help
  // step-specific.
  '/team-setup#process': { label: 'Agent Team Wizard · Process' },
  '/team-setup#environment': { label: 'Agent Team Wizard · Working Environment' },
  '/team-setup#team': { label: 'Agent Team Wizard · Team' },
  '/team-setup#knowledge': { label: 'Agent Team Wizard · Knowledge' },
  '/team-setup#review': { label: 'Agent Team Wizard · Review' },
  // Skills page overlays (#1990). Registered without a topic of their own: the
  // resolver falls through to `/skills`, whose chapters are what their "?"
  // buttons deep-link into. What the registration buys is `panelZIndex` — the
  // panel has to sit ABOVE a side panel (60/61) or the merge dialog (1000) to be
  // visible next to the surface it is explaining.
  'modal:skill-detail': { label: 'Skill detail' },
  'modal:skills-merge': { label: 'Merge skills' },
  // Knowledge page overlays (#1985), registered for the same reason: both are
  // shared `SidePanel`s (z-index 60/61) and both host a "?" that deep-links into
  // the `/knowledge` chapters, so without the lift the help panel would open
  // *behind* the very surface it explains. Neither claims a topic of its own.
  'modal:knowledge-config': { label: 'Team knowledge configuration' },
  'modal:knowledge-skill': { label: 'Knowledge · skill inspector' },
  // The MCP Servers page's two create panels (#1989), registered for the same
  // reason: both are shared `SidePanel`s (z-index 60/61) and both host a "?"
  // that deep-links into the `/mcp` chapters, so without the lift the help
  // panel would open *behind* the form it explains. Neither claims a topic of
  // its own — resolution falls through to `/mcp`.
  'modal:mcp-server': { label: 'New MCP server' },
  'modal:mcp-credential': { label: 'New MCP credential' },
  // The four small-page overlays (#1996). Same story once more: none claims a
  // topic of its own — resolution falls through to `/teams`, `/users` and
  // `/role-templates` respectively — they exist so the panel lifts above the
  // surface hosting the "?". Three are shared `SidePanel`s (60/61); the fourth,
  // `modal:user-delete`, is a `ConfirmDialog` at 9999, which is exactly why it
  // needs the lift most: without it the help would open BEHIND the decision it
  // is there to inform.
  'modal:team-delete': { label: 'Administration · delete team' },
  'modal:user-edit': { label: 'Administration · edit user' },
  'modal:user-delete': { label: 'Administration · delete user' },
  'modal:agent-template': { label: 'Agent Templates · editor' },
  // The save-time propagation offer (#2066). No topic of its own either —
  // resolution falls through to `/environments` — and it is the third
  // full-screen dialog in the tree (9999), so like `modal:user-delete` it
  // needs the lift most: the help must be readable BESIDE a decision that
  // writes into other agents' workspaces, not behind it.
  'modal:env-propagation': { label: 'Working Environments · bring agents up to date' },
  // The Flow editor's seven overlay surfaces (#1984). Same story once more, and
  // this is the page #1990 flagged the latent bug on: EdgeDialogs already
  // rendered a "?" inside a `SidePanel` with no subject, so pressing it opened
  // the help panel BEHIND the dialog it explains. None of these claims a topic
  // of its own — resolution falls through to `/flows`, which is the point: they
  // exist so the panel lifts above the surface, not to say anything new.
  'modal:flow-edge': { label: 'Flows · hand-off chooser' },
  'modal:flow-labels': { label: 'Flows · label registry' },
  'modal:flow-humans': { label: 'Flows · human roles' },
  'modal:flow-stages': { label: 'Flows · stages' },
  'modal:flow-node': { label: 'Flows · agent inspector' },
  'modal:flow-anomalies': { label: 'Flows · anomalies' },
  'modal:flow-improvements': { label: 'Flows · improvements' },
  // The draft Share panel (#2068) — an eighth Flows overlay, registered for the
  // same reason as the seven above: it is a `SidePanel` at 60/61, so a "?"
  // inside it must lift the help panel to be visible beside it. No topic of its
  // own; resolution falls through to `/flows`, whose sharing chapter it
  // deep-links into.
  'modal:draft-share': { label: 'Flows · share a draft' },
  // The team Share panel in the Agent Chat rail (#2082) — registered for the
  // same reason: a `SidePanel` at 60/61 hosting a "?". No topic of its own;
  // resolution falls through to `/chats`.
  'modal:team-share': { label: 'Agent Chat · share a team' },
  // The Plugins page's install and uninstall confirms (#1986). Same reason as
  // every overlay above, one layer higher: a ConfirmDialog is the shared Modal
  // at z-index 9999, so a "?" inside one has to lift the help panel to 10000 to
  // be visible beside the decision it explains. Neither claims a topic —
  // resolution falls through to `/plugins`, whose chapters they deep-link into.
  'modal:plugin-install': { label: 'Install plugin' },
  'modal:plugin-uninstall': { label: 'Uninstall plugin' },
  // The Model Providers create/edit form (#1988), registered for the same
  // reason: it is a shared `SidePanel` (z-index 60/61) hosting the auth-type,
  // OAuth-box and probe "?" buttons that deep-link into the `/models` chapters,
  // so without the lift the help panel would open *behind* the form it
  // explains. No topic of its own — resolution falls through to `/models`.
  'modal:model-provider': { label: 'Model provider form' },
  // The Working Environments page's two side panels (#1987) — the create/edit
  // form and the System-Admin toolchain registry. Registered for the same
  // reason as the MCP pair: both are shared `SidePanel`s (z-index 60/61) and
  // both host a "?" that deep-links into the `/environments` chapters, so
  // without the lift the help panel would open *behind* the surface it
  // explains. Neither claims a topic of its own — resolution falls through to
  // `/environments`. This page keeps THREE of its five "?" inside the form
  // panel (repositories, Sync, token), which is why one subject covers them.
  'modal:environment-form': { label: 'Working Environment form' },
  'modal:toolchains': { label: 'Agent toolchains' },
};

// `/quickstart` deliberately has NO step keys: it is a single-page form, not a
// stepped wizard, so its route topic *is* its step help. Recorded here so a
// later reader does not mistake it for an omission.
const SINGLE_STEP_PAGES = new Set(['/quickstart']);

// Split a sub-state key into its base and state (`/team-setup#process` →
// ['/team-setup', 'process']). Returns [key, ''] for a key with no sub-state.
function splitContextKey(key) {
  const s = String(key || '');
  const i = s.indexOf('#');
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

// True for a key that addresses a non-route help context (an overlay, or any
// key carrying a `#state` sub-state). A plain pathname is not one.
function isContextKey(key) {
  const s = String(key || '');
  if (!s) return false;
  return s.includes('#') || !s.startsWith('/');
}

// Every key the help system knows about: a classified route, or a listed context
// key. Used by the content guard so a topic cannot claim a key nobody registered.
function isKnownHelpKey(key) {
  const s = String(key || '');
  if (KNOWN_ROUTE_PATHS.has(s)) return true;
  return Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, s);
}

// The ordered lookup keys for a help context, most specific first:
//   overlay#step → overlay → route#step → canonicalRoute#step → route → canonicalRoute
// The overlay comes first because it is literally on top of the page; the route
// candidates still follow it, so an overlay with no topic of its own falls back
// to the page underneath rather than to a bare Overview — and closing the
// overlay simply drops the first candidates, returning the panel to the page
// (#1892 AC1). Duplicates are removed, order preserved.
function helpContextKeys(context) {
  const ctx = (context && typeof context === 'object') ? context : { route: context };
  const route = typeof ctx.route === 'string' ? ctx.route : '';
  const overlay = typeof ctx.overlay === 'string' ? ctx.overlay.trim() : '';
  const step = typeof ctx.step === 'string' ? ctx.step.trim() : '';
  const out = [];
  const push = (k) => { if (k && !out.includes(k)) out.push(k); };
  if (overlay) {
    if (step) push(`${overlay}#${step}`);
    push(overlay);
  }
  if (route) {
    const canon = canonicalRoute(route);
    if (step) {
      push(`${route}#${step}`);
      if (canon) push(`${canon}#${step}`);
    }
    push(route);
    if (canon) push(canon);
  }
  return out;
}

// Follow a context key's `alias` to the route whose topic answers it, or '' when
// the key has none. One hop only — an alias always points at a route.
function contextAlias(key) {
  const entry = CONTEXT_KEYS[String(key || '')];
  return (entry && typeof entry.alias === 'string') ? entry.alias : '';
}

// Classify the keys a set of topics claims against this module's topology, so a
// key that no longer exists (or was mistyped) fails CI exactly like an
// unclassified route does. Pure, so the guard runs it on the shipped topics and
// its own regression test runs it on synthetic ones.
function classifyTopicKeys(topics) {
  const claimed = [];
  for (const t of topics || []) {
    for (const k of (t && t.routes) || []) if (!claimed.includes(k)) claimed.push(k);
  }
  return {
    claimed,
    unknown: claimed.filter((k) => !isKnownHelpKey(k)),
    contextKeys: claimed.filter((k) => isContextKey(k)),
  };
}

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
  OVERLAY_KEYS,
  CONTEXT_KEYS,
  SINGLE_STEP_PAGES,
  canonicalRoute,
  splitContextKey,
  isContextKey,
  isKnownHelpKey,
  helpContextKeys,
  contextAlias,
  classifyTopicKeys,
  extractAppRoutes,
  classifyAppRoutes,
};
