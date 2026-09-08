/**
 * row-context-menu-view.js — the pure core of the shared `RowContextMenu`.
 *
 * `RowContextMenu` was built for the Agent-Chat left rail (#1928) and lived in
 * `pages/agent-chat/`. #2053 gives the Flows left list the same interaction
 * model (right-click / hover kebab / `Menu`-key on both draft and team rows), so
 * the component moved to `src/components/` — and its two pure dependencies moved
 * with it, because a component under `components/` reaching back into a `pages/`
 * folder is the import direction this tree does not have anywhere else.
 *
 * Both helper families are unchanged, and their original homes re-export them so
 * every existing importer and its tests keep working:
 *
 *  - `clampMenuPosition` came from `pages/agent-chat/rail-lifecycle.js`
 *  - `firstEnabledIndex` / `lastEnabledIndex` / `nextEnabledIndex` came from
 *    `pages/agent-chat/header-overflow-menu.js` (#1810), where they were written
 *    for the agent-header `…` overflow menu and are still used by it.
 *
 * Dependency-free and unit-tested per the #651 convention; the JSX in
 * `RowContextMenu.jsx` is a thin renderer over them.
 *
 * `items` is an array of `{ disabled?: boolean }`-shaped objects (any extra
 * fields are ignored).
 */

/** Index of the first enabled item, or -1 when every item is disabled/empty. */
export function firstEnabledIndex(items) {
  if (!Array.isArray(items)) return -1;
  return items.findIndex((it) => !it?.disabled);
}

/** Index of the last enabled item, or -1 when every item is disabled/empty. */
export function lastEnabledIndex(items) {
  if (!Array.isArray(items)) return -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

/**
 * The next enabled index moving `delta` (+1 = down, -1 = up) from `current`,
 * wrapping at the ends and skipping disabled items. When `current` is -1 (no
 * item focused yet) a +1 lands on the first enabled item and a -1 on the last.
 * Returns -1 when no item is enabled.
 */
export function nextEnabledIndex(items, current, delta) {
  if (!Array.isArray(items) || items.length === 0) return -1;
  if (!items.some((it) => !it?.disabled)) return -1;
  const n = items.length;
  const step = delta >= 0 ? 1 : -1;
  // Start from `current` and walk at most n slots looking for the next enabled
  // one. When unfocused (current < 0), seed the cursor so the first candidate is
  // slot 0 going down and slot n-1 going up.
  let idx = current;
  if (idx < 0 || idx >= n) idx = step > 0 ? -1 : n;
  for (let hops = 0; hops < n; hops++) {
    idx = ((idx + step) % n + n) % n;
    if (!items[idx]?.disabled) return idx;
  }
  return current;
}

/**
 * Place a popup menu near a click point, kept fully inside the viewport.
 *
 * Both rails are scrolling containers, so the menu is portaled and positioned in
 * *viewport* coordinates. Preferred placement is below-right of the pointer; a
 * menu that would overflow flips to the other side of the point rather than
 * being merely nudged, so it never covers the row it belongs to.
 */
export function clampMenuPosition({
  x, y, width, height, viewportWidth, viewportHeight, margin = 8,
}) {
  let left = x;
  if (left + width > viewportWidth - margin) left = x - width;          // flip left
  if (left < margin) left = Math.max(margin, viewportWidth - width - margin);

  let top = y;
  if (top + height > viewportHeight - margin) top = y - height;         // flip up
  if (top < margin) top = Math.max(margin, viewportHeight - height - margin);

  return { left: Math.round(left), top: Math.round(top) };
}
