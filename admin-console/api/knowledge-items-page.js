'use strict';

// Paged, server-filtered view of a team's knowledge items (#2921).
//
// The Knowledge page used to download the team's whole graph — one node per KB
// entry, ~6.4 MB for ~5,000 entries — and render every entry at once (~81k DOM
// nodes, multi-second main-thread blocks). It now loads the graph WITHOUT its
// item nodes (graphWithoutItems: agents, skills, counts stay) and fetches the
// entry list one page at a time (selectItemsPage), filtered + sorted here the
// way the page used to do it client-side. Pure: operates on an already built
// (cached) graph and never mutates it — the cached graph is shared by every
// caller (knowledge-graph-cache.js).

const ITEMS_PAGE_DEFAULT = 100;
const ITEMS_PAGE_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRY_KINDS = new Set(['fact', 'entity', 'convention']);
const SORTS = new Set(['created', 'used-desc', 'used-asc']);

function intParam(raw, fallback, min, max) {
  const n = Number.parseInt(typeof raw === 'string' ? raw : String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function flagParam(raw) {
  return raw === '1' || raw === 'true' || raw === true;
}

// Normalise the query string of GET /api/knowledge/items. Unknown / malformed
// values fall back to the unfiltered default instead of erroring.
function parseItemsQuery(query = {}) {
  const q = query || {};
  const kind = typeof q.kind === 'string' && ENTRY_KINDS.has(q.kind) ? q.kind : 'all';
  const sort = typeof q.sort === 'string' && SORTS.has(q.sort) ? q.sort : 'created';
  return {
    offset: intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: intParam(q.limit, ITEMS_PAGE_DEFAULT, 1, ITEMS_PAGE_MAX),
    q: typeof q.q === 'string' ? q.q.trim().toLowerCase().slice(0, 200) : '',
    kind,
    convergedOnly: flagParam(q.converged),
    today: flagParam(q.today),
    agent: typeof q.agent === 'string' ? q.agent.trim() : '',
    sort,
  };
}

// Just the fields the item card / table row render (no full provenance, no
// edges) — the drill-down still fetches the whole entry from /api/knowledge/item.
function slimItem(node) {
  const out = {
    id: String(node.id).slice(5), // strip "item:"
    entryKind: node.entryKind,
    text: node.text || '',
    createdAt: node.createdAt || null,
    convergence: Array.isArray(node.convergence) ? node.convergence : [],
    convergenceCount: node.convergenceCount || 0,
    converged: !!node.converged,
    archived: !!node.archived,
    provenance: { originAgent: (node.provenance && node.provenance.originAgent) || null },
  };
  if (node.displaySummary && node.displaySummary !== out.text) out.displaySummary = node.displaySummary;
  if (node.expired) out.expired = true;
  if (node.validTo) out.validTo = node.validTo;
  if (Array.isArray(node.loadTriggers) && node.loadTriggers.length) out.loadTriggers = node.loadTriggers;
  if (node.lastUsedAt) out.lastUsedAt = node.lastUsedAt;
  if (node.usageCount) out.usageCount = node.usageCount;
  return out;
}

// Same ordering as the page's former client-side sort: newest first; the
// Last-used column sorts most-recently-used first ('used-desc', never-used
// last) or the reverse ('used-asc', never-used first — the retire candidates).
function compareLastUsed(a, b) {
  const la = (a && typeof a.lastUsedAt === 'string' && a.lastUsedAt) || '';
  const lb = (b && typeof b.lastUsedAt === 'string' && b.lastUsedAt) || '';
  if (la === lb) return 0;
  if (!la) return 1;
  if (!lb) return -1;
  return la < lb ? 1 : -1;
}

function compareCreatedDesc(a, b) {
  return (b.createdAt || '').localeCompare(a.createdAt || '') || String(a.id).localeCompare(String(b.id));
}

function matchesFilters(n, f, nowMs) {
  if (f.kind !== 'all' && n.entryKind !== f.kind) return false;
  if (f.convergedOnly && !n.converged) return false;
  if (f.today) {
    const t = n.createdAt ? Date.parse(n.createdAt) : NaN;
    if (Number.isNaN(t) || nowMs - t >= DAY_MS) return false;
  }
  if (f.agent && !(Array.isArray(n.convergence) && n.convergence.includes(f.agent))) return false;
  if (f.q) {
    const hay = `${n.displaySummary || ''} ${n.text || ''}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/**
 * One page of a graph's item nodes, filtered and sorted.
 * @returns {{ total, offset, limit, items, retrievalStats }}
 */
function selectItemsPage(graph, filters, nowMs = Date.now()) {
  const f = filters && typeof filters === 'object' ? filters : parseItemsQuery({});
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  const matched = nodes.filter((n) => n && n.kind === 'item' && matchesFilters(n, f, nowMs));
  matched.sort(compareCreatedDesc);
  if (f.sort === 'used-desc') matched.sort(compareLastUsed);
  else if (f.sort === 'used-asc') matched.sort((a, b) => -compareLastUsed(a, b));
  const items = matched.slice(f.offset, f.offset + f.limit).map(slimItem);
  return {
    total: matched.length,
    offset: f.offset,
    limit: f.limit,
    items,
    retrievalStats: !!(graph && graph.retrievalStats),
  };
}

// The graph minus its per-entry item nodes and the edges touching them — what
// the team view needs for its header, agents column and skills column. A new
// object: the (cached) input graph is left untouched.
function graphWithoutItems(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return graph;
  const isItemRef = (id) => typeof id === 'string' && id.startsWith('item:');
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n && n.kind !== 'item'),
    edges: (Array.isArray(graph.edges) ? graph.edges : []).filter((e) => !isItemRef(e.from) && !isItemRef(e.to)),
    itemsOmitted: true,
  };
}

// Lesson texts of the graph's live items, oldest first, for the domain
// bootstrap (the page no longer holds every entry to send them itself).
function lessonTexts(graph, max = 200) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  const out = [];
  for (const n of nodes) {
    if (out.length >= max) break;
    if (n && n.kind === 'item' && !n.archived && !n.expired && n.text) out.push(n.text);
  }
  return out;
}

module.exports = {
  ITEMS_PAGE_DEFAULT,
  ITEMS_PAGE_MAX,
  parseItemsQuery,
  slimItem,
  selectItemsPage,
  graphWithoutItems,
  lessonTexts,
};
