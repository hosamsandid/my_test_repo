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
// `/agents` joined them in #1930, and took `/blueprints` with it — that alias
// used to point AT `/agents`. Both resolve to the Agent Chat topic, which
// absorbed the removed page's content.
export const REDIRECTS = {
  '/': '/chats',
  '/agents': '/chats',
  '/blueprints': '/chats',
  '/briefings': '/flows',
  '/getting-started': '/chats',
  '/process': '/flows',
  // `/teams` joined them in #2085: the Access page is dissolved (D10) and its
  // topic content lives in the Administration topic the destination owns.
  '/teams': '/users',
};

// Dynamic routes collapse to a canonical parent for topic resolution. A null
// canonical means "no topic" (the plugin viewer is allowlisted).
const DYNAMIC = [
  { match: (p) => /^\/chats\/[^/]+$/.test(p), canonical: '/chats' },
  { match: (p) => /^\/plugins\/[^/]+\/view$/.test(p), canonical: null },
  { match: (p) => /^\/process\/[^/]+$/.test(p), canonical: '/flows' },
];

// ─── Non-route help contexts (E17 #1892, docs/helper-chat-concept.md §3.2) ───
//
// Not every help-worthy surface is a route: the Settings dialog is an overlay on
// top of one, the first-run setup wizard is rendered *instead of* the Shell, and
// a wizard step is a sub-state of a single route. So the panel's context widens
// from a bare pathname to `{ route, overlay, step }`, and a topic claims a
// namespaced key (`modal:settings`, `/team-setup#process`) in the very same
// `routes:` front-matter list it claims a pathname in.
//
// Mirrors CONTEXT_KEYS in help-routes.js (see the note above about the
// deliberate duplication) — the parity test diffs both copies.
export const CONTEXT_KEYS = {
  'modal:settings': { label: 'Settings dialog' },
  'modal:settings#behavior': { label: 'Settings · Behavior' },
  'modal:settings#model': { label: 'Settings · Model' },
  'modal:settings#display': { label: 'Settings · Display' },
  'wizard:setup': { label: 'First-run setup' },
  'wizard:setup#llm': { label: 'First-run · Model Provider', alias: '/models' },
  'wizard:setup#ssh-key': { label: 'First-run · SSH Key', alias: '/ssh-keys' },
  'wizard:setup#gh-token': { label: 'First-run · GitHub Token', alias: '/github-tokens' },
  '/team-setup#process': { label: 'Agent Team Wizard · Process' },
  '/team-setup#environment': { label: 'Agent Team Wizard · Working Environment' },
  '/team-setup#team': { label: 'Agent Team Wizard · Team' },
  '/team-setup#knowledge': { label: 'Agent Team Wizard · Knowledge' },
  '/team-setup#review': { label: 'Agent Team Wizard · Review' },
  // The two Skills-page surfaces that render *over* the page (#1990). Neither
  // claims a topic — the resolver falls through to the `/skills` route topic, so
  // their "?" opens the page's own chapters. They are registered purely so the
  // published subject is a known key and the panel lifts above them (a side
  // panel is z-index 60/61, the merge dialog 1000; the panel's own 50 would put
  // help *behind* the surface it explains).
  'modal:skill-detail': { label: 'Skill detail' },
  'modal:skills-merge': { label: 'Merge skills' },
  // The two Knowledge-page side panels that render *over* the page (#1985) —
  // same story: no topic of their own, registered so their published subject is
  // a known key and the panel lifts above them (both are z-index 60/61).
  'modal:knowledge-config': { label: 'Team knowledge configuration' },
  'modal:knowledge-skill': { label: 'Knowledge · skill inspector' },
  // The MCP Servers page's two create panels (#1989) — same story again: no
  // topic of their own, registered so their published subject is a known key
  // and the panel lifts above them (both are z-index 60/61).
  'modal:mcp-server': { label: 'New MCP server' },
  'modal:mcp-credential': { label: 'New MCP credential' },
  // The Flow editor's seven overlay surfaces (#1984) — same story once more, on
  // the page #1990 flagged the latent bug on. None claims a topic of its own;
  // resolution falls through to `/flows`. They exist so the panel lifts above
  // the side panel that hosts the "?", not to say anything new.
  'modal:flow-edge': { label: 'Flows · hand-off chooser' },
  'modal:flow-labels': { label: 'Flows · label registry' },
  'modal:flow-humans': { label: 'Flows · human roles' },
  'modal:flow-stages': { label: 'Flows · stages' },
  'modal:flow-node': { label: 'Flows · agent inspector' },
  'modal:flow-anomalies': { label: 'Flows · anomalies' },
  'modal:flow-improvements': { label: 'Flows · improvements' },
  // The draft Share panel (#2068) — an eighth Flows overlay, same story: a
  // `SidePanel` at 60/61 hosting a "?" that deep-links into the `/flows`
  // sharing chapter, so without the lift the help would open behind it.
  'modal:draft-share': { label: 'Flows · share a draft' },
  // The team Share panel in the Agent Chat rail (#2082). Same 60/61 SidePanel
  // story; it claims no topic of its own, so resolution falls through to
  // `/chats`, whose sharing chapter its "?" deep-links into.
  'modal:team-share': { label: 'Agent Chat · share a team' },
  // The Plugins page's two confirm dialogs (#1986) — same story again, one layer
  // higher: a ConfirmDialog is the shared Modal at z-index 9999, so a "?" inside
  // one needs the lift to open beside the decision it explains rather than
  // behind it. Neither claims a topic — resolution falls through to `/plugins`.
  'modal:plugin-install': { label: 'Install plugin' },
  'modal:plugin-uninstall': { label: 'Uninstall plugin' },
  // The Model Providers create/edit form (#1988) — same story again: a shared
  // `SidePanel` (z-index 60/61) hosting the auth-type, OAuth-box and probe "?"
  // buttons that deep-link into the `/models` chapters, so without the lift the
  // panel would open *behind* the form it explains. Named rather than counted,
  // matching the `help-routes.js` mirror — a total in a comment is exactly what
  // drifts. No topic of its own — resolution falls through to `/models`.
  'modal:model-provider': { label: 'Model provider form' },
  // The Working Environments page's create/edit form and its System-Admin
  // toolchain registry (#1987) — same story again: no topic of their own,
  // registered so their published subject is a known key and the panel lifts
  // above them (both are z-index 60/61).
  'modal:environment-form': { label: 'Working Environment form' },
  'modal:toolchains': { label: 'Agent toolchains' },
  // The four small-page overlays (#1996) — same story once more: no topic of
  // their own (resolution falls through to `/teams`, `/users`,
  // `/role-templates`), registered so the panel lifts above the surface that
  // hosts the "?". Three are SidePanels (60/61); `modal:user-delete` is a
  // ConfirmDialog at 9999, so it needs the lift most.
  'modal:team-delete': { label: 'Administration · delete team' },
  'modal:user-edit': { label: 'Administration · edit user' },
  'modal:user-delete': { label: 'Administration · delete user' },
  'modal:agent-template': { label: 'Agent Templates · editor' },
  // The save-time propagation offer (#2066) — no topic of its own
  // (resolution falls through to `/environments`), and a full-screen dialog
  // at 9999, so it needs the lift for the same reason `modal:user-delete`
  // does: help beside the decision, never behind it.
  'modal:env-propagation': { label: 'Working Environments · bring agents up to date' },
};

// The overlay ids the app publishes, as constants so a call site cannot typo one.
export const OVERLAY_SETTINGS = 'modal:settings';
export const OVERLAY_SETUP_WIZARD = 'wizard:setup';
export const OVERLAY_SKILL_DETAIL = 'modal:skill-detail';
export const OVERLAY_SKILLS_MERGE = 'modal:skills-merge';
export const OVERLAY_KNOWLEDGE_CONFIG = 'modal:knowledge-config';
export const OVERLAY_KNOWLEDGE_SKILL = 'modal:knowledge-skill';
export const OVERLAY_MCP_SERVER = 'modal:mcp-server';
export const OVERLAY_MCP_CREDENTIAL = 'modal:mcp-credential';
export const OVERLAY_FLOW_EDGE = 'modal:flow-edge';
export const OVERLAY_FLOW_LABELS = 'modal:flow-labels';
export const OVERLAY_FLOW_HUMANS = 'modal:flow-humans';
export const OVERLAY_FLOW_STAGES = 'modal:flow-stages';
export const OVERLAY_FLOW_NODE = 'modal:flow-node';
export const OVERLAY_FLOW_ANOMALIES = 'modal:flow-anomalies';
export const OVERLAY_FLOW_IMPROVEMENTS = 'modal:flow-improvements';
export const OVERLAY_DRAFT_SHARE = 'modal:draft-share';
export const OVERLAY_TEAM_SHARE = 'modal:team-share';
export const OVERLAY_PLUGIN_INSTALL = 'modal:plugin-install';
export const OVERLAY_PLUGIN_UNINSTALL = 'modal:plugin-uninstall';
export const OVERLAY_MODEL_PROVIDER = 'modal:model-provider';
export const OVERLAY_ENVIRONMENT_FORM = 'modal:environment-form';
export const OVERLAY_TOOLCHAINS = 'modal:toolchains';
export const OVERLAY_TEAM_DELETE = 'modal:team-delete';
export const OVERLAY_USER_EDIT = 'modal:user-edit';
export const OVERLAY_USER_DELETE = 'modal:user-delete';
export const OVERLAY_AGENT_TEMPLATE = 'modal:agent-template';
export const OVERLAY_ENV_PROPAGATION = 'modal:env-propagation';

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

// The ordered lookup keys for a help context, most specific first:
//   overlay#step → overlay → route#step → canonicalRoute#step → route → canonicalRoute
// The overlay leads because it is literally on top of the page; the route
// candidates still follow, so an overlay with no topic of its own falls back to
// the page underneath — and closing the overlay just drops the first candidates,
// returning the panel to the page's own topic (AC1). Accepts a bare pathname for
// call-site convenience. Mirrors helpContextKeys() in help-routes.js.
export function helpContextKeys(context) {
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

// The route a context key delegates to, or '' — how the first-run wizard's steps
// reuse the topics the console pages already own (no duplicate prose, AC2).
export function contextAlias(key) {
  const entry = CONTEXT_KEYS[String(key || '')];
  return (entry && typeof entry.alias === 'string') ? entry.alias : '';
}

// Resolve a full help context to { topic, key }, or null when nothing claims any
// candidate (the caller then shows the Overview fallback). A candidate matches
// when a topic claims that exact key, or when the key aliases a route whose
// topic answers it. Sibling of the server-side registry.resolveHelpContext.
export function resolveHelpContext(payload, context) {
  const { topics } = normalizePageHelp(payload);
  const byRoute = indexByRoute(topics);
  for (const key of helpContextKeys(context)) {
    if (byRoute.has(key)) return { topic: byRoute.get(key), key };
    const alias = contextAlias(key);
    if (alias) {
      const canon = canonicalRoute(alias);
      if (byRoute.has(alias)) return { topic: byRoute.get(alias), key };
      if (canon && byRoute.has(canon)) return { topic: byRoute.get(canon), key };
    }
  }
  return null;
}

// The full render decision for the "This page" face:
//   { topic, isOverview, overview, contextKey }
// `topic` is what to render (the page topic, or the Overview topic as fallback);
// `isOverview` tells the face to show the Overview home rather than a page topic
// (so it can hide the "← Overview" home link, which would be a no-op there);
// `contextKey` is which candidate won — the overlay/step key when a non-route
// context resolved it, so the face can label what it is showing help for.
// Accepts a bare pathname (the pre-#1892 signature) or a context object.
export function pageHelpState(payload, context) {
  const overview = overviewTopic(payload);
  const hit = resolveHelpContext(payload, context);
  if (hit) return { topic: hit.topic, isOverview: hit.topic === overview, overview, contextKey: hit.key };
  return { topic: overview, isOverview: true, overview, contextKey: '' };
}

// ── the subject stack (E17 #1892) ────────────────────────────────────────────
//
// A route is always known (the router owns it), but an overlay or a wizard step
// is known only to the component that renders it. Those components *publish* a
// subject `{ overlay, step }` while mounted and retract it on unmount, and the
// most recently published one wins: open Settings on top of the Agent Team
// Wizard and help follows the dialog; close it and help falls back to the step
// underneath. Keeping it a stack rather than a single slot is what makes that
// hand-back automatic instead of a co-ordination problem between two components.

// Add or replace a subject, keeping insertion order and moving a re-published id
// to the top (its content changed, so it is the freshest intent). Never mutates.
export function upsertSubject(stack, id, subject) {
  const rest = (Array.isArray(stack) ? stack : []).filter((s) => s && s.id !== id);
  const overlay = (subject && typeof subject.overlay === 'string') ? subject.overlay.trim() : '';
  const step = (subject && typeof subject.step === 'string') ? subject.step.trim() : '';
  if (!id || (!overlay && !step)) return rest; // nothing to say → not a subject
  return [...rest, { id, overlay, step }];
}

// Remove a subject by id (idempotent). Never mutates.
export function removeSubject(stack, id) {
  return (Array.isArray(stack) ? stack : []).filter((s) => s && s.id !== id);
}

// The winning subject — the top of the stack, or a blank one when it is empty.
export function topSubject(stack) {
  const list = Array.isArray(stack) ? stack.filter(Boolean) : [];
  const top = list.length ? list[list.length - 1] : null;
  return { overlay: (top && top.overlay) || '', step: (top && top.step) || '' };
}

// The label the face shows when help resolved through a non-route context, so it
// is visible that the panel is answering for the dialog/step rather than the page
// behind it. Empty for a plain route (the topic title already says where you are).
export function contextLabel(key) {
  const s = String(key || '');
  if (!s || !CONTEXT_KEYS[s]) return '';
  return CONTEXT_KEYS[s].label || '';
}

// The panel's z-index. It normally sits BELOW modals and side panels (50 vs
// 60/61/9999) so a closed-over-content panel never covers a dialog — but help
// *for* an open dialog has to be visible next to it, so an active overlay
// context lifts the panel above the Modal layer. Pure decision, so the one place
// this rule lives is unit-tested rather than buried in a style object.
export const PANEL_Z_INDEX = 50;
export const PANEL_Z_INDEX_OVER_MODAL = 10000;

export function panelZIndex(context) {
  const overlay = (context && typeof context === 'object' && typeof context.overlay === 'string')
    ? context.overlay.trim() : '';
  return overlay ? PANEL_Z_INDEX_OVER_MODAL : PANEL_Z_INDEX;
}

// ─── Chapter deep-linking (#1972) ────────────────────────────────────────────
//
// A "?" next to one surface of a page should land on the chapter that explains
// *that* surface, not at the top of a long topic. openHelpFor() therefore takes
// an optional `section` — the slug of the chapter heading to scroll to — and the
// face resolves it against the headings it just rendered.
//
// Matching on the *heading text* rather than an authored anchor keeps the topic
// a plain markdown file (no `{#id}` syntax react-markdown would render
// literally, no rehype-slug dependency, no second list to keep in step). The
// cost — a reworded heading silently breaks its "?" — is paid by a drift-guard
// test that asserts every slug a call site uses is a heading in the topic.
//
// An unmatched slug is never an error: the face just renders the topic from the
// top, which is exactly the behaviour of a "?" whose surface has no chapter.

// The slug of a heading: lowercased, markdown decoration stripped, runs of
// anything that is not a letter/digit collapsed to a single hyphen.
export function sectionSlug(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The `##`/`###` headings of a topic body as { level, text, slug } rows, in
// document order. Used by the drift guard; the face reads the rendered DOM
// instead, so both sides agree only if the slug rule is the same one — which is
// why it lives here rather than in either consumer.
export function topicSections(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ level: m[1].length, text: m[2], slug: sectionSlug(m[2]) });
  }
  return out;
}

// Which of the rendered headings a section request points at: the index of the
// first heading whose slug matches, or -1 for "no target — stay at the top".
// `headings` is the list of heading texts as they appear on screen.
export function findSectionIndex(headings, section) {
  const want = sectionSlug(section);
  if (!want) return -1;
  const list = Array.isArray(headings) ? headings : [];
  return list.findIndex((h) => sectionSlug(h) === want);
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
