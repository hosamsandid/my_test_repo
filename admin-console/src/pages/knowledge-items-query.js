// Paged knowledge-items requests for the Knowledge page (#2921).
//
// The page no longer downloads every entry of a team with the graph (6.4 MB /
// ~81k DOM nodes for ~5,000 entries); it asks GET /api/knowledge/items for one
// page at a time, filtered and sorted server-side. These pure helpers build
// that request from the page's filter bar + per-view state.

export const ITEMS_PAGE_SIZE = 100;
// The server's per-request cap: a reload re-fetches at most this many rows.
export const ITEMS_RELOAD_MAX = 500;

// The table's Last-used column state (null | 'desc' | 'asc') → the server sort.
export function itemsSortFor(usageSort) {
  if (usageSort === 'desc') return 'used-desc';
  if (usageSort === 'asc') return 'used-asc';
  return 'created';
}

// Everything that selects WHICH rows are in view (not how many) — a change
// resets the list to its first page.
export function itemsQueryKey(teamId, { filters = {}, agent = null, sort = 'created' } = {}) {
  return JSON.stringify([
    teamId || '',
    (filters.q || '').trim().toLowerCase(),
    filters.kind || 'all',
    !!filters.convergedOnly,
    !!filters.today,
    !!filters.showArchived,
    agent || '',
    sort || 'created',
  ]);
}

export function itemsQueryUrl(teamId, { filters = {}, agent = null, sort = 'created', offset = 0, limit = ITEMS_PAGE_SIZE } = {}) {
  const p = new URLSearchParams();
  p.set('team', teamId || '');
  p.set('offset', String(Math.max(0, offset | 0)));
  p.set('limit', String(Math.min(ITEMS_RELOAD_MAX, Math.max(1, limit | 0))));
  const q = (filters.q || '').trim();
  if (q) p.set('q', q);
  if (filters.kind && filters.kind !== 'all') p.set('kind', filters.kind);
  if (filters.convergedOnly) p.set('converged', '1');
  if (filters.today) p.set('today', '1');
  if (filters.showArchived) p.set('includeArchived', '1');
  if (agent) p.set('agent', agent);
  if (sort && sort !== 'created') p.set('sort', sort);
  return `/api/knowledge/items?${p.toString()}`;
}

// Append a "show more" page to the rows already in view, skipping any id the
// list already holds (an entry harvested in between shifts the offsets).
export function appendItemsPage(prev, page) {
  const list = Array.isArray(prev) ? prev : [];
  const seen = new Set(list.map(i => i.id));
  const more = (Array.isArray(page) ? page : []).filter(i => i && !seen.has(i.id));
  return more.length ? list.concat(more) : list;
}
