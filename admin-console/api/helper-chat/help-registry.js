'use strict';

// ─── Context-help topic registry (#1872, spec docs/context-help-system-concept.md §3) ──
//
// The server-side, pure core of the unified help system. It:
//   • parses help-topic markdown files (front-matter + body, §3.1),
//   • builds a route → topic index and resolves a pathname to its topic
//     (dynamic / alias / redirect aware, mirroring breadcrumbs.js — §3.3),
//   • folds the concatenated topic bodies into a grounding block for the chat
//     corpus (single source, §3.2 — no vendoring, no parity test), and
//   • exposes a baseline-topic template helper so thin pages (E16) get real help.
//
// The topic files are the SINGLE SOURCE read by both consumers — the
// GET /api/helper/page-help endpoint and corpus.js chat grounding — so there is
// no parity drift to police (unlike the repo-root docs/** copies in corpus.js).
//
// Parsing + resolution are pure functions over already-loaded topics; the only
// I/O is loadTopics(dir), kept fail-soft so a missing/broken topic never takes
// the API down (mirrors tour-manifest-loader.js).

const fs = require('fs');
const path = require('path');

const { canonicalRoute, helpContextKeys, contextAlias } = require('./help-routes');

const HELP_TOPICS_DIR = path.join(__dirname, 'help-topics');
const OVERVIEW_ID = 'overview';

// ── front-matter parsing ─────────────────────────────────────────────────────

function stripQuotes(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Parse an inline array scalar: `["/a", "/b"]` or `[]`. Returns a string[].
function parseInlineArray(value) {
  const inner = String(value).trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((x) => stripQuotes(x)).filter((x) => x.length > 0);
}

// Parse an inline object list item: `{ label: "X", to: "/y" }`. Returns
// { label, to } (missing keys → undefined). Forgiving key: value extraction so
// authors don't have to quote perfectly.
function parseInlineObject(value) {
  const inner = String(value).trim().replace(/^\{/, '').replace(/\}$/, '');
  const obj = {};
  // Split on commas that separate top-level key:value pairs (no nesting here).
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = stripQuotes(part.slice(idx + 1));
    if (key) obj[key] = val;
  }
  return obj;
}

// Parse a `actions:` list item into a normalized call-to-action, or null when it
// is not actionable (#1874, concept §5). A CTA either navigates (`to`) or invokes
// a panel verb (`action`, currently only `tour` → useHelperChat().openTour()); a
// label is mandatory, since a nameless button is not a CTA. `primary: true` marks
// the one accented button (the former Getting Started page had exactly one).
const CTA_ACTIONS = new Set(['tour']);

function parseCtaObject(value) {
  const obj = parseInlineObject(value);
  const label = (obj.label || '').trim();
  const to = (obj.to || '').trim();
  const action = (obj.action || '').trim();
  if (!label) return null;
  if (!to && !CTA_ACTIONS.has(action)) return null;
  const cta = { label, to, action: to ? '' : action };
  if (obj.primary === 'true') cta.primary = true;
  return cta;
}

// Parse a help-topic markdown string into a normalized topic object. Never
// throws on a well-formed-enough file; a topic with no front-matter returns
// null (the loader skips it). `id` defaults to the passed fallback (the filename
// stem) when the front-matter omits it.
function parseTopic(raw, fallbackId) {
  const text = String(raw || '').replace(/^﻿/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;

  const topic = {
    id: fallbackId || '',
    routes: [],
    title: '',
    summary: '',
    seeAlso: [],
    askPrompts: [],
    actions: [],
    body: (body || '').trim(),
  };

  const lines = fm.split(/\r?\n/);
  let listKey = null; // 'seeAlso' | 'actions' | 'askPrompts' | 'routes' while inside a block list
  for (const line of lines) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s+-\s*(.*)$/);
    if (listItem && listKey) {
      const item = listItem[1].trim();
      if (listKey === 'seeAlso') {
        const obj = item.startsWith('{') ? parseInlineObject(item) : { label: stripQuotes(item), to: '' };
        if (obj.label || obj.to) topic.seeAlso.push({ label: obj.label || '', to: obj.to || '' });
      } else if (listKey === 'actions') {
        const act = item.startsWith('{') ? parseCtaObject(item) : null;
        if (act) topic.actions.push(act);
      } else {
        topic[listKey].push(stripQuotes(item));
      }
      continue;
    }
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value === '') {
      // A block key (its items follow on indented lines).
      if (key === 'seeAlso' || key === 'askPrompts' || key === 'routes' || key === 'actions') listKey = key;
      else listKey = null;
      continue;
    }
    listKey = null;
    switch (key) {
      case 'id': topic.id = stripQuotes(value); break;
      case 'title': topic.title = stripQuotes(value); break;
      case 'summary': topic.summary = stripQuotes(value); break;
      case 'routes': topic.routes = parseInlineArray(value); break;
      default: break; // unknown scalar keys are ignored (forward-compatible)
    }
  }
  if (!topic.id) return null;
  return topic;
}

// ── registry over already-parsed topics (pure) ───────────────────────────────

// Build the resolver surface from a list of parsed topics. Pure — the same
// object powers the endpoint (real topics) and the unit tests (fixture topics).
function buildRegistry(topics, pluginTopics = []) {
  const list = (topics || []).filter(Boolean);
  const plugins = (pluginTopics || []).filter(Boolean);
  const byId = new Map(list.map((t) => [t.id, t]));
  const byRoute = new Map();
  for (const t of list) {
    for (const r of t.routes || []) {
      if (!byRoute.has(r)) byRoute.set(r, t); // first topic to claim a route wins
    }
  }
  const overview = byId.get(OVERVIEW_ID) || null;

  // Resolve a concrete pathname to its topic, or null when the route has no
  // dedicated topic (the caller then renders the Overview fallback). Handles
  // dynamic collapse, aliases and redirects via canonicalRoute().
  function topicForRoute(pathname) {
    if (byRoute.has(pathname)) return byRoute.get(pathname);
    const canon = canonicalRoute(pathname);
    if (canon && byRoute.has(canon)) return byRoute.get(canon);
    return null;
  }

  // Resolve a full help context — `{ route, overlay, step }`, or a bare pathname
  // — to its topic (E17 #1892). Walks the ordered candidate keys most-specific
  // first; a candidate matches when a topic claims that exact key, or when the
  // key aliases a route whose topic answers it. Returns { topic, key } so a
  // caller can tell *which* context won, or null when nothing resolves.
  function resolveHelpContext(context) {
    for (const key of helpContextKeys(context)) {
      if (byRoute.has(key)) return { topic: byRoute.get(key), key };
      const alias = contextAlias(key);
      if (alias) {
        const aliased = topicForRoute(alias);
        if (aliased) return { topic: aliased, key };
      }
    }
    return null;
  }

  // The topic for a help context, or null — the `topicForRoute` sibling that
  // understands overlays and wizard steps.
  function topicForContext(context) {
    const hit = resolveHelpContext(context);
    return hit ? hit.topic : null;
  }

  const registry = {
    all: list,
    // Plugin-contributed topics (see loadPluginTopics): grounding neighbours
    // only — deliberately NOT in byRoute, so they never answer a page.
    pluginTopics: plugins,
    byId,
    overview,
    topicForRoute,
    resolveHelpContext,
    topicForContext,
    foldTopics: () => foldTopics(list),
  };
  // Route-scoped grounding (#2006) — the fold the chat corpus actually uses.
  registry.foldForContext = (context) => foldTopicsForContext(registry, context);
  return registry;
}

// Concatenate topic bodies into one grounding block for the chat corpus (§3.2).
// Each topic is headed by its title + the routes it answers for so the model can
// tie an answer to a page.
function foldTopics(topics) {
  return (topics || [])
    .filter(Boolean)
    .map((t) => {
      const where = (t.routes && t.routes.length) ? ` (routes: ${t.routes.join(', ')})` : '';
      const head = `## ${t.title || t.id}${where}`;
      const summary = t.summary ? `${t.summary}\n\n` : '';
      return `${head}\n\n${summary}${t.body}`.trim();
    })
    .join('\n\n---\n\n');
}

// ── route-scoped grounding fold (#2006) ──────────────────────────────────────
//
// foldTopics(list) above concatenates whatever it is handed; the chat corpus used
// to hand it EVERY topic on every request, so one global char ceiling absorbed
// the growth of every page's help at once (raised three times: 180k → 260k →
// 300k → 340k) while the assistant is almost always asked about the page the user
// is on. The fold is therefore scoped to the resolved help context: that page's
// topic plus the topics its `seeAlso` links point at, which is what keeps the
// common cross-page pairs ("how does Skills relate to Knowledge?") answerable.
//
// The scoping rule is deliberately the SAME resolution the panel uses, so the
// grounding and the "This page" face can never disagree about which topic
// answers a context: `resolveHelpContext` (overlay → step → route → canonical
// route, alias-aware), and the Overview topic when nothing resolves — exactly the
// panel's documented Overview fallback (§3.4/§4).

// The topics a help context is grounded on, most relevant first: the resolved
// topic (or the Overview fallback), then its `seeAlso` neighbours in authored
// order. A `seeAlso` entry pointing at a route with no topic (yet) is skipped
// rather than failing, and a duplicate (a neighbour that is also the primary, or
// listed twice) appears once.
function contextTopics(registry, context) {
  const hit = registry.resolveHelpContext(context);
  const pluginTopics = pluginTopicsForContext(registry.pluginTopics, context);
  // A route that NO built-in topic claims but a plugin DOES — a plugin's own UI
  // page, e.g. /plugins/jira/view — must not inherit the Overview fallback's
  // seeAlso expansion. The Overview topic links to ~every page, so that fold is
  // the whole console help (~141k chars); hanging it behind one plugin page buys
  // nothing and is pure weight against SYSTEM_PROMPT_CHAR_LIMIT. Such a page
  // grounds on the plugin's own topic(s) plus the Overview topic itself (general
  // orientation), and stops there. (A route WITH a built-in topic keeps the full
  // page + seeAlso + plugin fold below.)
  if (!hit && pluginTopics.length) {
    const picked = [];
    if (registry.overview) picked.push(registry.overview);
    for (const t of pluginTopics) if (!picked.includes(t)) picked.push(t);
    return picked;
  }
  const primary = (hit && hit.topic) || registry.overview || null;
  if (!primary) return [];
  const picked = [primary];
  for (const link of primary.seeAlso || []) {
    const to = (link && typeof link.to === 'string') ? link.to.trim() : '';
    if (!to) continue;
    const neighbour = registry.topicForRoute(to);
    if (neighbour && !picked.includes(neighbour)) picked.push(neighbour);
  }
  for (const t of pluginTopics) {
    if (!picked.includes(t)) picked.push(t);
  }
  return picked;
}

// ── plugin-contributed topics ────────────────────────────────────────────────
//
// An installed plugin may ship `help/*.md` topics in the built-in format (the
// Jira plugin explains its events and payload fields there). The platform's own
// corpus cannot carry them: it is vocabulary-blind by design (jira-plugin-plan
// D5) and budget-bound (SYSTEM_PROMPT_CHAR_LIMIT — every always-on doc costs on
// every page). So a plugin topic rides along ONLY on the contexts it names, as a
// neighbour folded after the page's own topic and its seeAlso, and never claims
// a route as its primary topic — the "This page" face, the coverage ratchet and
// every other page's budget stay exactly what the built-in topics make them.
// Uninstalling the plugin removes its directory, and with it the topic.

// The plugin topics that name this context, matched with the same
// overlay → route → canonical-route walk the primary resolution uses.
function pluginTopicsForContext(pluginTopics, context) {
  const list = (pluginTopics || []).filter(Boolean);
  if (!list.length) return [];
  const wanted = new Set();
  for (const key of helpContextKeys(context)) {
    wanted.add(key);
    const alias = contextAlias(key);
    if (alias) wanted.add(alias);
    const canon = canonicalRoute(key);
    if (canon) wanted.add(canon);
  }
  return list.filter((t) => (t.routes || []).some((r) => wanted.has(r)));
}

// Read every installed plugin's `help/*.md` under the operator registry
// (`/workspace/plugins/<id>/help/`). Fail-soft like loadTopics: a missing
// registry, a plugin without help, or one broken file never takes the chat down.
// `_`-prefixed entries are registry bookkeeping (`_secret`, `_credentials`),
// not plugins. Each topic is tagged with its `pluginId`.
function loadPluginTopics(pluginsDir) {
  let ids;
  try {
    ids = fs.readdirSync(pluginsDir).filter((d) => !d.startsWith('_') && !d.startsWith('.'));
  } catch {
    return [];
  }
  const out = [];
  for (const pluginId of ids.sort()) {
    for (const t of loadTopics(path.join(pluginsDir, pluginId, 'help'))) {
      out.push({ ...t, pluginId });
    }
  }
  return out;
}

// The grounding block for one help context (the string corpus.js splices in).
function foldTopicsForContext(registry, context) {
  return foldTopics(contextTopics(registry, context));
}

// Every context the fold can be asked to scope to: the no-route fallback (null)
// plus every key a topic claims. This is what makes the budget guard measure a
// REAL assembled prompt — the largest one the mechanism can actually produce —
// instead of the hypothetical all-topics fold nothing sends any more.
function groundingContexts(registry) {
  const out = [null];
  for (const t of [...(registry.all || []), ...(registry.pluginTopics || [])]) {
    for (const key of t.routes || []) if (!out.includes(key)) out.push(key);
  }
  return out;
}

// The worst case over those contexts, as `{ context, length }`. Pure over an
// injected registry, so the guard can run it on the shipped topics and a test can
// run it on a synthetic set (e.g. "what does one more page topic cost?").
function worstCaseFold(registry) {
  let worst = { context: null, length: -1 };
  for (const context of groundingContexts(registry)) {
    const length = foldTopicsForContext(registry, context).length;
    if (length > worst.length) worst = { context, length };
  }
  return worst;
}

// A one-line grounding pointer at the topic for the current route (used by the
// chat handler to say "you are here"). Empty string when nothing resolves.
function routeGroundingPointer(registry, pathname) {
  if (!pathname) return '';
  const t = registry.topicForRoute(pathname);
  if (!t) return '';
  const summary = t.summary ? ` — ${t.summary}` : '';
  return `\n\nThe page the user is on maps to the help topic "${t.title || t.id}"${summary} Prefer that topic when answering page-specific questions.\n`;
}

// ── baseline-topic template (§3.4) ───────────────────────────────────────────
//
// Every topic must satisfy: what-it-is · 2–3 key tasks · seeAlso · askPrompts.
// E16 authors thin pages against this so no page gets a stub with no real help.
// Returns a topic-shaped object; callers serialize it to a .md file or use it
// directly.
function baselineTopic({ id, routes = [], title, summary = '', keyTasks = [], seeAlso = [], askPrompts = [] } = {}) {
  if (!id || !title) throw new Error('baselineTopic requires id and title');
  const tasks = (keyTasks.length ? keyTasks : ['Review what this page shows.']).slice(0, 3);
  const bodyTasks = tasks.map((t) => `- ${t}`).join('\n');
  const body = `## What is ${title}?\n\n${summary || `${title} — see the tasks below.`}\n\n## Key tasks\n\n${bodyTasks}`;
  return {
    id,
    routes,
    title,
    summary,
    seeAlso,
    askPrompts,
    actions: [],
    body,
  };
}

// Assert a topic meets the baseline shape (used by tests + E16 authoring). Returns
// a string[] of problems (empty = valid).
function baselineProblems(topic) {
  const problems = [];
  if (!topic || typeof topic !== 'object') return ['not an object'];
  if (!topic.id) problems.push('missing id');
  if (!topic.title) problems.push('missing title');
  if (!topic.body || !topic.body.trim()) problems.push('empty body (what-it-is)');
  if (!Array.isArray(topic.seeAlso)) problems.push('seeAlso must be an array');
  if (!Array.isArray(topic.askPrompts) || topic.askPrompts.length === 0) problems.push('needs at least one askPrompt');
  return problems;
}

// ── I/O (fail-soft) ──────────────────────────────────────────────────────────

// Load + parse every *.md under a help-topics dir. Never throws — a missing dir
// yields [], and a single unparseable file is skipped (logged to stderr) rather
// than failing the whole set, so the API boots on a partial checkout.
function loadTopics(dir = HELP_TOPICS_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const topic = parseTopic(raw, f.replace(/\.md$/, ''));
      if (topic) out.push(topic);
    } catch (err) {
      // Best-effort: skip a broken topic, keep the rest.
      // eslint-disable-next-line no-console
      console.warn(`[help-registry] skipping ${f}: ${err.message}`);
    }
  }
  return out;
}

// Convenience: the live registry over the on-disk topics.
function loadRegistry(dir = HELP_TOPICS_DIR) {
  return buildRegistry(loadTopics(dir));
}

module.exports = {
  HELP_TOPICS_DIR,
  OVERVIEW_ID,
  CTA_ACTIONS,
  parseTopic,
  buildRegistry,
  foldTopics,
  contextTopics,
  foldTopicsForContext,
  groundingContexts,
  worstCaseFold,
  routeGroundingPointer,
  baselineTopic,
  baselineProblems,
  loadTopics,
  loadRegistry,
  loadPluginTopics,
  pluginTopicsForContext,
};
