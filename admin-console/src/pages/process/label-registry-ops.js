// label-registry-ops.js — pure helper for the label-registry editor (#981),
// shared by the live and draft adapters (edit-adapters.js). Separate module so
// it stays node:test-able (edit-adapters imports the browser-only useApi hook).

// Set/clear the gate/brake flags of one label. Only FLAGGED labels are stored —
// an entry whose flags are both cleared is dropped (an unflagged label is a
// plain agent label, no registry entry needed; port-referenced labels survive
// export regardless).
export function labelsAfterSet(cur, name, { humanGate, brake } = {}) {
  const key = String(name || '').trim();
  const list = (Array.isArray(cur) ? cur : []).filter(l =>
    l && typeof l.name === 'string' && l.name.trim() && l.name.trim() !== key);
  if (!key) return list;
  if (humanGate || brake) {
    list.push({ name: key, ...(humanGate ? { humanGate: true } : {}), ...(brake ? { brake: true } : {}) });
  }
  return list;
}

// Delete registry entries (#2716): drop every entry whose trimmed name is in
// `names` (blank/malformed entries are dropped too, as in labelsAfterSet).
export function labelsAfterRemove(cur, names) {
  const drop = new Set((Array.isArray(names) ? names : [names])
    .map(n => String(n || '').trim()).filter(Boolean));
  return (Array.isArray(cur) ? cur : []).filter(l =>
    l && typeof l.name === 'string' && l.name.trim() && !drop.has(l.name.trim()));
}

// Save-time re-check (#2716): usage is decided server-side (`graph.unusedLabels`,
// built by the same rules as `graph.labels`), so both adapters refetch the
// graph right before writing and refuse to drop a label that became used in
// the meantime (Flow Copilot / another tab). Throws a user-facing Error.
export function assertLabelsUnused(names, unusedLabels) {
  const unused = new Set(Array.isArray(unusedLabels) ? unusedLabels : []);
  const inUse = (Array.isArray(names) ? names : [names])
    .map(n => String(n || '').trim()).filter(n => n && !unused.has(n));
  if (inUse.length) {
    throw new Error(`Not deleted — now used in the flow: ${inUse.join(', ')}. Reopen the registry to refresh.`);
  }
}

// Panel rows (#2716): graph.labels sorted by name, each carrying its gate/brake
// kind and whether the flow still uses it (graph.unusedLabels).
export function registryRows(labels, unusedLabels) {
  const unused = new Set(Array.isArray(unusedLabels) ? unusedLabels : []);
  return (Array.isArray(labels) ? labels : [])
    .filter(l => l && typeof l.name === 'string' && l.name.trim())
    .map(l => {
      const name = l.name.trim();
      return { name, kind: l.humanGate ? 'gate' : l.brake ? 'brake' : 'agent', unused: unused.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
