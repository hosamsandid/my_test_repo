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
