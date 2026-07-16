// stage-list-ops.js — pure transforms for the ordered stage list (#674).
//
// The live stage-management ops (liveOps in edit-adapters.js) read the team
// agent's current `stages[]`, compute the next list here, then PUT it. Keeping
// the list math pure (no I/O) lets us unit-test the semantics — trim, dedupe,
// order preservation, rename cascade targeting — independently of the HTTP
// layer, and mirrors the draft ops' semantics in makeDraftOps.

// Normalize a raw stage list: keep strings, trim, drop blanks, de-duplicate
// (first occurrence wins), preserve order. Matches the backend's persist rule
// so the client and server agree on the canonical shape.
export function normalizeStages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Append a new stage (no-op if blank or already present).
export function stagesAfterAdd(cur, name) {
  const s = String(name || '').trim();
  const base = normalizeStages(cur);
  if (!s || base.includes(s)) return base;
  return [...base, s];
}

// Rename oldName → newName, preserving position, de-duplicating on collision.
// Blank/unchanged newName is a no-op.
export function stagesAfterRename(cur, oldName, newName) {
  const s = String(newName || '').trim();
  const base = normalizeStages(cur);
  if (!s || s === oldName) return base;
  return normalizeStages(base.map(x => (x === oldName ? s : x)));
}

// Remove a stage by name.
export function stagesAfterRemove(cur, name) {
  return normalizeStages(cur).filter(x => x !== name);
}

// Reorder: trust the caller's order but keep only stages that still exist.
export function stagesAfterReorder(cur, names) {
  const existing = new Set(normalizeStages(cur));
  return (Array.isArray(names) ? names : [])
    .map(n => String(n || '').trim())
    .filter(n => existing.has(n));
}

// The members a rename/remove must cascade to: those parented to this team
// whose per-agent `stage` equals the affected name (#674 AC4).
export function membersToCascade(agents, teamId, stageName) {
  if (!stageName) return [];
  return (Array.isArray(agents) ? agents : [])
    .filter(a => a && a.parentTeamId === teamId && a.stage === stageName);
}
