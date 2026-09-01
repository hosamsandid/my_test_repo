/**
 * header-overflow-menu.js — pure keyboard-navigation helpers for the agent-header
 * overflow menu (#1810).
 *
 * The `…` menu groups the rare, destructive session actions (Reset Session /
 * Clear History). A proper `role="menu"` supports arrow-key traversal, so these
 * helpers compute which item receives focus next while **skipping disabled
 * items** (a disabled Reset/Clear must never be the arrow target) and wrapping
 * around the ends. Kept dependency-free and unit-tested per the #651 convention;
 * the JSX in HeaderOverflowMenu.jsx is a thin renderer over them.
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
