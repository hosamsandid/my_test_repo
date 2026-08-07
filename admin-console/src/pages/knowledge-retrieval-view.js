// Pure view helpers for the read-side retrieval telemetry (#915): how an item's
// "last used" state renders on the Knowledge page (item cards + overview table)
// and how the sortable Last-used column orders rows. The data comes from the
// graph augmentation (`lastUsedAt` / `usageCount` on item nodes, sourced from
// the orchestrator's per-team aggregate); `graph.retrievalStats` marks that the
// stats endpoint answered — only then does an unmarked entry truly mean
// "never used" (vs. "telemetry unreachable", which renders nothing).

// Relative "used …" label. `nowMs` is injected for testability.
export function lastUsedLabel(item, nowMs, retrievalOn = true) {
  const last = item && typeof item.lastUsedAt === 'string' ? item.lastUsedAt : '';
  if (!last) return retrievalOn ? 'never used' : '';
  const t = Date.parse(last);
  if (Number.isNaN(t)) return retrievalOn ? 'never used' : '';
  const diff = nowMs - t;
  let rel;
  if (diff < 60 * 60 * 1000) rel = 'just now';
  else if (diff < 24 * 60 * 60 * 1000) rel = `${Math.floor(diff / (60 * 60 * 1000))}h ago`;
  else if (diff < 30 * 24 * 60 * 60 * 1000) rel = `${Math.floor(diff / (24 * 60 * 60 * 1000))}d ago`;
  else rel = last.slice(0, 10);
  const n = Number.isInteger(item.usageCount) && item.usageCount > 1 ? `${item.usageCount}× · ` : '';
  return `used ${n}${rel}`;
}

// Sort comparator for the Last-used column: most recently used first,
// never-used rows last (stable among themselves — caller pre-sorts by created).
export function compareLastUsed(a, b) {
  const la = (a && typeof a.lastUsedAt === 'string' && a.lastUsedAt) || '';
  const lb = (b && typeof b.lastUsedAt === 'string' && b.lastUsedAt) || '';
  if (la === lb) return 0;
  if (!la) return 1;
  if (!lb) return -1;
  return la < lb ? 1 : -1;
}
