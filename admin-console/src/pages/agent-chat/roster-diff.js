/**
 * Pure minimal-diff merge for the Agent Chat roster (#2311).
 *
 * `GET /api/matrix/agents` is now polled on an interval (see
 * `AgentRosterContext.jsx`) instead of fetched once. A naive "just setState the
 * fresh array every tick" would defeat the rail's existing memoization layering
 * (#1682/#1676 — `useMemo(() => buildGroups(agents), [agents])` and friends) on
 * *every* poll, and would hand `ChatPanel`'s DM-room-creation effect
 * (`[agent, roomId, onRoomCreated]`, ~line 253) a fresh `agent` object every 5s
 * forever, re-firing `POST /api/matrix/agents/:id/dm` on a stuck room (#2311 AC8).
 *
 * `mergeRoster` fixes both: it reuses the previous per-agent object reference
 * whenever an agent's fields are unchanged, and reports `changed: false` (with
 * the *original* list reference, untouched) when the fetched roster is a no-op
 * so the caller can skip `setState` entirely (AC6/AC7).
 *
 * Dependency-free and unit-tested per the #651 convention (mirrors
 * `agent-list-model.js`).
 */

/**
 * Shallow field-by-field equality for one `/api/matrix/agents` row. Every field
 * on that payload is a primitive (string/boolean/number/null) — see
 * `admin-console/api/api.js`'s `GET /api/matrix/agents` handler — so a plain
 * key-union comparison is exact, no deep-equal library needed.
 */
export function agentRowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Merge a freshly-fetched roster (`nextList`) against the roster currently held
 * in state (`prevList`).
 *
 * - An agent present in both with identical fields keeps its **previous object
 *   reference** in the result — so a memoized row/consumer keyed on that object
 *   never re-renders/re-fires for it.
 * - An added, removed, or field-changed agent means the merge is reported as
 *   `changed: true` and `list` is a fresh array (in `nextList`'s order).
 * - A roster that is a pure reorder of the exact same rows (same ids, same
 *   fields, different position — e.g. a non-deterministic directory listing
 *   order server-side) is **not** considered a change: grouping/sorting is
 *   entirely up to `agent-list-model.js` downstream, so array position here
 *   carries no meaning, and reporting it as unchanged avoids a pointless
 *   re-group on every tick.
 * - `changed: false` always returns `list === prevList` (the exact same
 *   reference), which is what lets a caller do
 *   `setAgents(prev => { const {list, changed} = mergeRoster(prev, fetched); return changed ? list : prev; })`
 *   and have React bail out of the update.
 *
 * @param {object[]|null} prevList
 * @param {object[]|null} nextList
 * @returns {{ list: object[], changed: boolean }}
 */
export function mergeRoster(prevList, nextList) {
  const prev = Array.isArray(prevList) ? prevList : [];
  const next = Array.isArray(nextList) ? nextList : [];

  const prevById = new Map(prev.map(agent => [agent.id, agent]));
  let changed = prev.length !== next.length;

  const merged = next.map(agent => {
    const old = prevById.get(agent.id);
    if (old && agentRowEqual(old, agent)) return old;
    changed = true;
    return agent;
  });

  if (!changed) return { list: prev, changed: false };
  return { list: merged, changed: true };
}

/**
 * Reduce a freshly-fetched `/api/matrix/agents` payload against the roster state
 * AgentRosterContext currently holds, returning the next `agents` state value.
 *
 * The context seeds `agents` at `null` — the "never loaded yet" sentinel the
 * rail renders as its loading spinner. The FIRST successful fetch has to move
 * that to a concrete array EVEN WHEN THE ROSTER IS EMPTY: a caller with no
 * agents at all (a brand-new account, or one whose only teams are
 * private-by-default and unshared) gets `[]`, which is exactly what makes the
 * rail render its "No agents yet." empty state instead of a permanent blank
 * column. `mergeRoster` can't decide this alone — it normalises a null prev to
 * an empty roster, so an empty first payload diffs as `changed: false` and a
 * caller doing `changed ? list : prev` would keep `null` forever (the blank-rail
 * regression #2311 shipped).
 *
 * On every later tick `prevState` is already an array, so this defers to
 * `mergeRoster` and preserves its reference-reuse / no-op-skip guarantees
 * (AC6/AC7): a stable roster returns the exact same array reference.
 *
 * @param {object[]|null} prevState - current `agents` state (null = unloaded).
 * @param {object[]|null} fetched - the just-fetched roster payload.
 * @returns {object[]} the next `agents` state (always an array once called).
 */
export function nextRosterState(prevState, fetched) {
  const next = Array.isArray(fetched) ? fetched : [];
  if (prevState === null) return next; // first load adopts the roster, empty or not
  const { list, changed } = mergeRoster(prevState, next);
  return changed ? list : prevState;
}
