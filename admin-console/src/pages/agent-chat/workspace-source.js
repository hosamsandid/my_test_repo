// Pure helpers for the two sources the workspace tree can show (#1286):
//
//   • the agent's workspace — /workspace/agents/<id>/, served from the pool
//     volume this container can read directly;
//   • the read-only host context folder (#1283) — mounted at /context INSIDE
//     the agent's container and readable only through it.
//
// Both are rendered by one tree, so every node needs a key that says which
// source it belongs to. Workspace keys are ordinary relative paths ('' is the
// root, 'memory/log.md' a file). Context keys carry a LEADING SLASH ('/context',
// '/context/docs/note.md') — a relative workspace path can never start with one,
// so the two namespaces cannot collide even if the agent really does have a
// folder called `context`.
//
// React-free so it can be unit-tested with plain `node --test`.

export const CONTEXT_ROOT_KEY = '/context';

// Display name for the virtual root node.
export const CONTEXT_ROOT_NAME = 'context';

export function isContextKey(key) {
  const k = key == null ? '' : String(key);
  return k === CONTEXT_ROOT_KEY || k.startsWith(CONTEXT_ROOT_KEY + '/');
}

// The path RELATIVE to the mount root ('' for the root itself), or null when
// the key doesn't belong to the context source.
export function contextRelOf(key) {
  if (!isContextKey(key)) return null;
  return String(key).slice(CONTEXT_ROOT_KEY.length).replace(/^\/+/, '');
}

// The context folder is read-only end-to-end: no upload, no delete, no move,
// and no API route that could perform one. The UI must not offer the actions at
// all — an action that always fails is worse than an absent one.
export function isReadOnlyKey(key) {
  return isContextKey(key);
}

// Endpoint for a tree key. `kind` is one of 'tree' | 'file' | 'download' |
// 'image'; the two sources expose the same four, so callers never branch.
export function workspaceUrl(agentId, key, kind) {
  if (!agentId) return null;
  const ctx = isContextKey(key);
  const rel = ctx ? contextRelOf(key) : String(key == null ? '' : key);
  const base = ctx ? 'context' : 'workspace';
  return `/api/agents/${encodeURIComponent(agentId)}/${base}/${kind}?path=${encodeURIComponent(rel)}`;
}

// The virtual root entry for the mounted folder, shaped like any other listing
// item so the tree renders it with no special case beyond its `key`.
export function contextRootItem(status) {
  return {
    name: CONTEXT_ROOT_NAME,
    type: 'dir',
    size: 0,
    mtime: 0,
    hidden: false,
    key: CONTEXT_ROOT_KEY,
    readOnly: true,
    hostPath: (status && status.hostPath) || null,
  };
}

// Prepend the context root to the workspace root listing when the agent has a
// mount. Returns the input untouched otherwise (and for every other directory),
// so an agent without a mount sees exactly today's tree.
export function withContextRoot(items, status) {
  const list = Array.isArray(items) ? items : [];
  if (!status || !status.enabled) return list;
  if (list.some(i => i && i.key === CONTEXT_ROOT_KEY)) return list;
  return [contextRootItem(status), ...list];
}

// Child key for an item inside `parentKey`. Listing items from the context
// source carry no key of their own, so it is derived the same way as for the
// workspace — the parent's leading slash propagates to every descendant.
export function childKey(parentKey, item) {
  if (item && item.key) return item.key;
  const name = item && item.name != null ? String(item.name) : '';
  const parent = parentKey == null ? '' : String(parentKey);
  return parent ? `${parent}/${name}` : name;
}
