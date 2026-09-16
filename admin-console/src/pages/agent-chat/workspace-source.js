// Pure helpers for the sources the workspace tree can show (#1286):
//
//   • the agent's workspace — /workspace/agents/<id>/, served from the pool
//     volume this container can read directly;
//   • the host context folder(s) (#1283, multiple folders #1290) — bind-mounted
//     INSIDE the agent's container and readable only through it.
//
// All are rendered by one tree, so every node needs a key that says which source
// it belongs to. Workspace keys are ordinary relative paths ('' is the root,
// 'memory/log.md' a file). Context keys carry a LEADING SLASH — the mount root
// key ('/context', or '/context/<slug>' for a folder in a multi-folder set) and
// its descendants ('/context/docs/note.md', '/context/<slug>/a.txt'). A relative
// workspace path can never start with one, so the two namespaces cannot collide
// even if the agent really does have a folder called `context`. The path passed
// to the browse API is the key with the leading `/context` stripped — for a
// multi-folder root that leaves `<slug>/…`, which the browse program resolves
// under /context with no per-folder branch (#1290).
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

// The mounts an agent has, normalised to `[{ key, readWrite, hostPath }]` — one
// per folder. Uses status.mounts when present (multi-folder, #1290), else the
// legacy single `/context` root synthesised from the top-level status fields.
// Empty when the agent has no mount.
export function contextMounts(status) {
  if (!status || !status.enabled) return [];
  if (Array.isArray(status.mounts) && status.mounts.length) {
    return status.mounts.map((m) => ({
      key: (m && m.key) || CONTEXT_ROOT_KEY,
      readWrite: !!(m && m.readWrite),
      hostPath: (m && m.hostPath) || null,
    }));
  }
  return [{ key: CONTEXT_ROOT_KEY, readWrite: !!status.readWrite, hostPath: status.hostPath || null }];
}

// The mount a context key belongs to (its root or any descendant), or null for
// a workspace key / an unknown context key. Longest matching root wins so a
// `/context/<slug>` mount is preferred over a legacy `/context` if both appear.
export function mountForKey(key, status) {
  if (!isContextKey(key)) return null;
  const k = String(key);
  let best = null;
  for (const m of contextMounts(status)) {
    if (k === m.key || k.startsWith(m.key + '/')) {
      if (!best || m.key.length > best.key.length) best = m;
    }
  }
  return best;
}

// Whether a key is read-only for WRITING. Workspace keys are always writable.
// A context key is writable only when it belongs to a read-write mount; when the
// mount status is unknown (status omitted) a context key is treated read-only —
// fail-closed, so a caller that forgot to thread status never enables a write.
export function isReadOnlyKey(key, status) {
  if (!isContextKey(key)) return false;
  const mount = mountForKey(key, status);
  return !(mount && mount.readWrite);
}

// Whether `a` and `b` live in the same writable source, so a drag-move between
// them is a plain rename (one filesystem) rather than a cross-source copy. True
// for two workspace keys (today's behaviour) or two keys under the SAME
// read-write context mount; never across workspace↔context or two mounts.
export function sameWritableSource(a, b, status) {
  const aCtx = isContextKey(a);
  const bCtx = isContextKey(b);
  if (aCtx !== bCtx) return false;
  if (!aCtx) return true; // both workspace
  const ma = mountForKey(a, status);
  const mb = mountForKey(b, status);
  return !!(ma && mb && ma.key === mb.key && ma.readWrite);
}

// The write API base + path for a key. Workspace keys keep today's
// `/workspace/...` routes with their bare relative path; context keys route to
// `/context/...` with the path RELATIVE to the mount root (leading `/context`
// stripped). Callers append `/file`, `/move` or `/upload`.
export function writeApiBase(agentId, key) {
  const base = isContextKey(key) ? 'context' : 'workspace';
  return `/api/agents/${encodeURIComponent(agentId)}/${base}`;
}

export function apiRelOf(key) {
  return isContextKey(key) ? contextRelOf(key) : String(key == null ? '' : key);
}

// Endpoint for a tree key. `kind` is one of 'tree' | 'file' | 'download' |
// 'image' | 'zip'; the sources expose the same set, so callers never branch.
// ('zip' is the per-directory ZIP download, #2318 — only ever called for a
// real workspace directory, never a `/context` mount, per D3.)
export function workspaceUrl(agentId, key, kind) {
  if (!agentId) return null;
  const ctx = isContextKey(key);
  const rel = ctx ? contextRelOf(key) : String(key == null ? '' : key);
  const base = ctx ? 'context' : 'workspace';
  return `/api/agents/${encodeURIComponent(agentId)}/${base}/${kind}?path=${encodeURIComponent(rel)}`;
}

// The virtual root entry for one mounted folder, shaped like any other listing
// item so the tree renders it with no special case beyond its `key`. Accepts a
// mount entry `{ name, hostPath, key, readWrite }` (from status.mounts) — or a
// legacy `{ hostPath }` / null, which resolves to the bare `/context` root. The
// bare root keeps the display name `context` for continuity (#1286); a
// multi-folder root shows its label (#1290).
export function contextRootItem(mount) {
  const key = (mount && mount.key) ? mount.key : CONTEXT_ROOT_KEY;
  const name = key === CONTEXT_ROOT_KEY
    ? CONTEXT_ROOT_NAME
    : ((mount && (mount.name || mount.slug)) || key.slice(CONTEXT_ROOT_KEY.length + 1) || CONTEXT_ROOT_NAME);
  return {
    name,
    type: 'dir',
    size: 0,
    mtime: 0,
    hidden: false,
    key,
    readOnly: true,
    hostPath: (mount && mount.hostPath) || null,
    readWrite: !!(mount && mount.readWrite),
  };
}

// Prepend one read-only context root PER mounted folder to the workspace root
// listing when the agent has any (#1290 AC3). Uses status.mounts when present
// (one entry per folder), else falls back to the legacy single `/context` root
// synthesised from status.hostPath. Returns the input untouched when there is no
// mount (and for every other directory), so an agent without a mount sees exactly
// today's tree. Idempotent: a root already in the list is not added again.
export function withContextRoot(items, status) {
  const list = Array.isArray(items) ? items : [];
  if (!status || !status.enabled) return list;
  const mounts = (Array.isArray(status.mounts) && status.mounts.length)
    ? status.mounts
    : [{ key: CONTEXT_ROOT_KEY, hostPath: status.hostPath || null, readWrite: !!status.readWrite }];
  const present = new Set(list.map(i => i && i.key));
  const roots = [];
  for (const m of mounts) {
    const item = contextRootItem(m);
    if (present.has(item.key) || roots.some(r => r.key === item.key)) continue;
    roots.push(item);
  }
  return roots.length ? [...roots, ...list] : list;
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
