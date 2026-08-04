// member-order-ops.js — pure transforms for the persisted display order of a
// team's member agents (#1279). The team agent carries an optional
// `memberOrder: string[]` of member agent ids (persisted on its config like
// `stages[]`); these helpers apply that order to the live member list and
// compute the next order after an up/down move. Kept pure (no React, no I/O)
// so the ordering semantics are unit-tested directly — the repo has no
// JSX/component test runner (#651), the same rationale as
// group-agents-by-team.js and stage-list-ops.js.

// Order `members` by the ids listed in `order`: members whose id appears in
// `order` come first, in that order; any remaining members (newly added, or
// never reordered) keep their incoming relative order and are appended after.
// Ids in `order` that no longer match a member are ignored. Never drops or
// duplicates a member — the output is always a permutation of the input.
export function applyMemberOrder(members, order) {
  const list = (Array.isArray(members) ? members : []).filter(Boolean);
  const orderIds = Array.isArray(order) ? order : [];
  const byId = new Map();
  for (const m of list) {
    if (m.id != null && !byId.has(m.id)) byId.set(m.id, m);
  }
  const out = [];
  const used = new Set();
  for (const id of orderIds) {
    if (byId.has(id) && !used.has(id)) {
      out.push(byId.get(id));
      used.add(id);
    }
  }
  for (const m of list) {
    if (!used.has(m.id)) {
      out.push(m);
      used.add(m.id);
    }
  }
  return out;
}

// Compute the next order array after moving `id` one slot in `direction`
// (negative = up / earlier, positive = down / later). `ids` is the caller's
// full current display order (every member id, in order). Returns a new array;
// a no-op — `id` absent, or already at the relevant boundary — returns a copy
// of the input unchanged.
export function orderAfterMove(ids, id, direction) {
  const keys = (Array.isArray(ids) ? ids : []).slice();
  const idx = keys.indexOf(id);
  if (idx < 0) return keys;
  const target = idx + (direction < 0 ? -1 : 1);
  if (target < 0 || target >= keys.length) return keys;
  [keys[idx], keys[target]] = [keys[target], keys[idx]];
  return keys;
}

// Normalize a raw memberOrder list to the canonical persisted shape: keep
// strings, trim, drop blanks, de-duplicate (first occurrence wins), preserve
// order. Matches the backend's persist rule so client and server agree on the
// stored shape (mirrors normalizeStages in stage-list-ops.js).
export function normalizeMemberOrder(order) {
  if (!Array.isArray(order)) return [];
  const out = [];
  const seen = new Set();
  for (const s of order) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}
