// humans-registry-ops.js — pure helpers for the named-human-role registry
// (#987), shared by the live and draft adapters (edit-adapters.js). Kept in its
// own module so it stays node:test-able (edit-adapters imports the browser-only
// useApi hook). Mirrors label-registry-ops.js.
//
// A human role: { id, name, description?, stage?, emits?[], consumes?[] }.
// `consumes` entries are one of { label } | { artifact:'pr'|'issue', from } |
// { artifact:'file', name }. The backend re-normalizes on persist; these helpers
// only keep the list well-shaped and unique-by-id so the optimistic UI matches.

function cleanEmits(emits) {
  const out = [];
  const seen = new Set();
  for (const e of (Array.isArray(emits) ? emits : [])) {
    const s = typeof e === 'string' ? e.trim() : '';
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function cleanConsumes(consumes) {
  const out = [];
  for (const c of (Array.isArray(consumes) ? consumes : [])) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.label === 'string' && c.label.trim()) out.push({ label: c.label.trim() });
    else if ((c.artifact === 'pr' || c.artifact === 'issue') && typeof c.from === 'string' && c.from.trim()) {
      out.push({ artifact: c.artifact, from: c.from.trim() });
    } else if (c.artifact === 'file' && typeof c.name === 'string' && c.name.trim()) {
      out.push({ artifact: 'file', name: c.name.trim() });
    }
  }
  return out;
}

// Normalize one human role to the persisted shape (or null when it has no id).
export function normalizeHumanRole(h) {
  if (!h || typeof h !== 'object') return null;
  const id = typeof h.id === 'string' ? h.id.trim() : '';
  if (!id) return null;
  const entry = { id, name: (typeof h.name === 'string' && h.name.trim()) ? h.name.trim() : id };
  if (typeof h.description === 'string' && h.description.trim()) entry.description = h.description.trim();
  if (typeof h.stage === 'string' && h.stage.trim()) entry.stage = h.stage.trim();
  const emits = cleanEmits(h.emits);
  if (emits.length) entry.emits = emits;
  const consumes = cleanConsumes(h.consumes);
  if (consumes.length) entry.consumes = consumes;
  return entry;
}

// Add or replace a human role by id (id match wins; order preserved, new
// entries appended). A falsy/invalid role is a no-op.
export function humansAfterUpsert(cur, human) {
  const norm = normalizeHumanRole(human);
  const list = (Array.isArray(cur) ? cur : []).map(normalizeHumanRole).filter(Boolean);
  if (!norm) return list;
  const i = list.findIndex(h => h.id === norm.id);
  if (i >= 0) list[i] = norm; else list.push(norm);
  return list;
}

// Remove a human role by id.
export function humansAfterRemove(cur, id) {
  const key = String(id || '').trim();
  return (Array.isArray(cur) ? cur : []).map(normalizeHumanRole).filter(Boolean).filter(h => h.id !== key);
}

// Slugify a display name into a candidate role id (lower-case, non-alnum → '-',
// trimmed). Returns '' for an empty/pure-punctuation name.
export function slugifyHumanId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// ─── consume/emit wiring helpers (#987) ──────────────────────────────────────
// Stable string key for a consume entry so add/remove dedupe consistently.
export function consumeKey(c) {
  if (!c || typeof c !== 'object') return '';
  if (typeof c.label === 'string' && c.label.trim()) return `label:${c.label.trim()}`;
  if ((c.artifact === 'pr' || c.artifact === 'issue') && typeof c.from === 'string' && c.from.trim()) {
    return `${c.artifact}:${c.from.trim()}`;
  }
  if (c.artifact === 'file' && typeof c.name === 'string' && c.name.trim()) return `file:${c.name.trim()}`;
  return '';
}

// Return the human role with `entry` added to its `consumes` (dedup by key). A
// malformed entry is a no-op; the role is normalized on the way out.
export function humanAfterConsumeAdd(human, entry) {
  const norm = normalizeHumanRole(human) || (human && human.id ? { id: human.id, name: human.id } : null);
  if (!norm) return human;
  const key = consumeKey(entry);
  if (!key) return norm;
  const list = Array.isArray(norm.consumes) ? norm.consumes.slice() : [];
  if (!list.some(c => consumeKey(c) === key)) list.push(entry);
  return normalizeHumanRole({ ...norm, consumes: list });
}

// Return the human role with any consume matching `entry`'s key removed.
export function humanAfterConsumeRemove(human, entry) {
  const norm = normalizeHumanRole(human);
  if (!norm) return human;
  const key = consumeKey(entry);
  const list = (Array.isArray(norm.consumes) ? norm.consumes : []).filter(c => consumeKey(c) !== key);
  return normalizeHumanRole({ ...norm, consumes: list });
}

// Return the human role with `label` added to its `emits` (dedup, trimmed).
export function humanAfterEmitAdd(human, label) {
  const norm = normalizeHumanRole(human) || (human && human.id ? { id: human.id, name: human.id } : null);
  if (!norm) return human;
  const s = String(label || '').trim();
  if (!s) return norm;
  const list = Array.isArray(norm.emits) ? norm.emits.slice() : [];
  if (!list.includes(s)) list.push(s);
  return normalizeHumanRole({ ...norm, emits: list });
}

// Return the human role with `label` removed from its `emits`.
export function humanAfterEmitRemove(human, label) {
  const norm = normalizeHumanRole(human);
  if (!norm) return human;
  const s = String(label || '').trim();
  const list = (Array.isArray(norm.emits) ? norm.emits : []).filter(e => e !== s);
  return normalizeHumanRole({ ...norm, emits: list });
}
