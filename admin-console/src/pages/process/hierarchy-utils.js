// hierarchy-utils.js — pure helpers for the parent-child hierarchy that the
// process draft editor edits (#378). Kept dependency-free so they can be unit
// tested with node --test (unlike edit-adapters.js, which pulls in the React
// API hook). Mirror buildUnifiedGraph's effectiveStage + a cycle guard for
// setParent.

// True if making `parentId` the parent of `childId` would create a cycle —
// i.e. `childId` is already an ancestor of `parentId` (or they're the same).
export function wouldCreateCycle(roles, childId, parentId) {
  if (!parentId || parentId === childId) return parentId === childId;
  const byId = new Map((roles || []).map(r => [r.id, r]));
  const seen = new Set();
  let cur = byId.get(parentId);
  while (cur && !seen.has(cur.id)) {
    if (cur.id === childId) return true;
    seen.add(cur.id);
    cur = cur.parent ? byId.get(cur.parent) : null;
  }
  return false;
}

// The stage a role inherits from its parent chain: own stage wins, else the
// nearest ancestor's stage, else '' (cycle-safe).
export function resolveInheritedStage(roles, role) {
  if (!role) return '';
  if (role.stage) return role.stage;
  const byId = new Map((roles || []).map(r => [r.id, r]));
  const seen = new Set([role.id]);
  let cur = role.parent ? byId.get(role.parent) : null;
  while (cur && !seen.has(cur.id)) {
    if (cur.stage) return cur.stage;
    seen.add(cur.id);
    cur = cur.parent ? byId.get(cur.parent) : null;
  }
  return '';
}
