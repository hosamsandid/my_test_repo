// Arrow-key navigation over the Workspace tab's file tree (#2950).
//
// Pure: the tree component derives the flat list of VISIBLE rows from the same
// state it renders (dirCache + expanded + the context mounts) and asks
// `navigateTree` what an arrow key does. The keyboard cursor is just a tree key
// (a workspace-relative path, or a `/context…` key); nothing here touches the
// DOM, fetches, or knows about the file viewer.

import { withContextRoot, childKey } from './workspace-source.js';

/**
 * The rows the tree currently renders, top to bottom, mirroring DirNode /
 * DirContents: the root is always open, a directory's children are visible only
 * while it is expanded AND its listing has loaded without error (a loading,
 * failed or empty listing renders a placeholder, not rows).
 *
 * @returns {{ key: string, type: 'dir'|'file', parent: string, depth: number }[]}
 */
export function visibleTreeRows(dirCache, expanded, contextStatus) {
  const rows = [];
  const walk = (dirKey, depth) => {
    const cache = dirCache && dirCache.get(dirKey);
    if (!cache || cache.loading || cache.error) return;
    const items = dirKey === '' ? withContextRoot(cache.items, contextStatus) : (cache.items || []);
    for (const item of items) {
      if (!item) continue;
      const key = childKey(dirKey, item);
      const type = item.type === 'dir' ? 'dir' : 'file';
      rows.push({ key, type, parent: dirKey, depth });
      if (type === 'dir' && expanded && expanded.has(key)) walk(key, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/**
 * The cursor as it should be shown: the stored key when that row is visible,
 * else its nearest visible ancestor (a deleted/moved file, a directory collapsed
 * with the mouse, a listing that is reloading), else null. Derived rather than
 * written back, so a refresh that briefly empties the tree does not lose the
 * position once the listing returns.
 */
export function effectiveCursor(rows, cursor) {
  if (cursor == null || !Array.isArray(rows) || rows.length === 0) return null;
  const keys = new Set(rows.map(r => r.key));
  let k = String(cursor);
  while (k) {
    if (keys.has(k)) return k;
    const i = k.lastIndexOf('/');
    k = i > 0 ? k.slice(0, i) : '';
  }
  return null;
}

export const TREE_NAV_KEYS = Object.freeze(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * What one arrow key does.
 *
 * @param rows      visibleTreeRows(...)
 * @param cursor    the effective cursor key (or null when there is none yet)
 * @param key       KeyboardEvent.key
 * @param expanded  Set of expanded directory keys
 * @returns {{ cursor: string|null, toggle: string|null } | null}
 *          null = no-op. `cursor` is the new cursor key (unchanged when only a
 *          directory is expanded/collapsed); `toggle` names the directory whose
 *          expanded state flips (the same toggle a click does).
 */
export function navigateTree(rows, cursor, key, expanded) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const idx = cursor == null ? -1 : rows.findIndex(r => r.key === cursor);

  if (idx < 0) {
    // No cursor yet: the first ↓/↑ enters the tree at its first row.
    if (key === 'ArrowDown' || key === 'ArrowUp') return { cursor: rows[0].key, toggle: null };
    return null;
  }

  const row = rows[idx];
  const isOpen = row.type === 'dir' && !!expanded && expanded.has(row.key);

  switch (key) {
    case 'ArrowDown':
      return idx + 1 < rows.length ? { cursor: rows[idx + 1].key, toggle: null } : null;
    case 'ArrowUp':
      return idx > 0 ? { cursor: rows[idx - 1].key, toggle: null } : null;
    case 'ArrowRight': {
      if (row.type !== 'dir') return null;
      if (!isOpen) return { cursor: row.key, toggle: row.key };
      // Expanded: the first child is the next row only once the listing has
      // loaded with entries; empty, loading or failed → stay put.
      const next = rows[idx + 1];
      return next && next.parent === row.key ? { cursor: next.key, toggle: null } : null;
    }
    case 'ArrowLeft':
      if (isOpen) return { cursor: row.key, toggle: row.key };
      return row.parent ? { cursor: row.parent, toggle: null } : null;
    default:
      return null;
  }
}
