/**
 * Pure reordering helper for the Agent Chat sidebar drag & drop (#1304).
 *
 * The sidebar already persists a manual order via up/down arrows
 * (`AgentList.jsx` → `moveGroup`/`moveSingle`/`moveMember`), each of which
 * swaps two adjacent keys in one of the three ordered key arrays stored under
 * the `agentChat.sidebarOrder` localStorage record (`{ groups, singles,
 * members }`). Drag & drop is additive: it relocates a key in one gesture
 * instead of N single-step swaps, writing to the exact same key arrays so a
 * drag-produced order and an arrow-produced order are indistinguishable after a
 * reload (AC5).
 *
 * This module holds the only non-trivial logic — turning a "dropped
 * `fromKey` <before|after> `toKey`" gesture into the new key order — so it can
 * be unit-tested in the `admin-console-src` CI job. The JSX only wires DOM drag
 * events (and the drag-scope guard for AC4) to this function.
 */

/**
 * Compute the new key order after dropping `fromKey` relative to `toKey`.
 *
 * Reordering is always **within one list** — the caller passes only the keys
 * of a single scope (groups, singles, or one group's members) and rejects
 * cross-scope drops before ever calling here, matching the arrow controls
 * which never move an item out of its own list (AC4).
 *
 * @param {string[]} keys              current ordered keys for one scope
 * @param {string} fromKey            the dragged item's key
 * @param {string} toKey             the drop-target item's key
 * @param {'before'|'after'} position where the item lands relative to `toKey`
 * @returns {string[]|null}          the new order, or `null` when nothing
 *                                   changes — dropped on itself, an unknown
 *                                   key, or a position that resolves to the
 *                                   identical order (so the caller can skip a
 *                                   spurious persist / re-render, per the
 *                                   "drop on original position" edge case)
 */
export function computeReorder(keys, fromKey, toKey, position = 'before') {
  if (!Array.isArray(keys)) return null;
  if (fromKey === toKey) return null;

  if (keys.indexOf(fromKey) === -1) return null;
  if (keys.indexOf(toKey) === -1) return null;

  const without = keys.filter(k => k !== fromKey);
  let insertAt = without.indexOf(toKey);
  if (insertAt === -1) return null;
  if (position === 'after') insertAt += 1;

  const next = [...without.slice(0, insertAt), fromKey, ...without.slice(insertAt)];
  return arraysEqual(next, keys) ? null : next;
}

/**
 * Given the mouse Y within a row's bounding rect, decide whether the drop lands
 * before (top half) or after (bottom half) that row.
 *
 * @param {number} clientY  pointer Y (viewport coords)
 * @param {{top:number, height:number}} rect  the row's bounding rect
 * @returns {'before'|'after'}
 */
export function dropPosition(clientY, rect) {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
