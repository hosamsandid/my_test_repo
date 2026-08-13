// id-field-view.js — pure, React-free helpers behind the shared `IdField`.
//
// Every create/edit form in the console derives a machine id (SSH key, GitHub
// token, MCP server + credential, model provider, team, template, draft,
// working environment, agent, scheduled job) from a display name and lets the
// operator override it. As the operator types, the console silently strips the
// value down to a safe slug (`sanitizeId`). That silent stripping is confusing
// on its own — a user types "Release Manager" and watches it become
// "releasemanager" with no explanation. These helpers turn that hidden
// behaviour into plain-language guidance the field can show, and give the whole
// app ONE consistent phrasing of the id-format rule (the per-form help text had
// drifted: "digits, hyphens" vs "digits and hyphens only" vs "digits, dashes").
//
// Kept dependency-free so it unit-tests under `node --test` (the #651
// convention); `IdField.jsx` is the thin renderer over it.

// The set every id is reduced to: lowercase letters, digits and hyphens.
// This mirrors the server-side id rules (SSH_KEY_ID_RE / GH_TOKEN_ID_RE /
// MCP_*_ID_RE / TEMPLATE_ID_RE / PLUGIN_ID_RE / DRAFT_ID_RE all constrain to
// `[a-z0-9-]`).
const SAFE_ID_CHARS = /[^a-z0-9-]/g;

// One canonical, human phrasing of the format rule — reuse it everywhere so the
// explanation is identical on every form.
export const ID_FORMAT_HINT =
  'Lowercase letters, numbers and hyphens only.';

/** Reduce a name to a slug: lowercase, spaces → hyphens, drop the rest. */
export function deriveIdFromName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(SAFE_ID_CHARS, '');
}

/**
 * Coerce a directly-typed id into the safe character set. Note this differs
 * from `deriveIdFromName`: it does NOT turn spaces into hyphens — spaces are
 * dropped — because a direct edit is character-by-character, not a re-slug.
 */
export function sanitizeId(value) {
  return String(value || '').toLowerCase().replace(SAFE_ID_CHARS, '');
}

/**
 * Given the RAW text the operator just typed into the id field, describe (in
 * plain language) what the console had to change to keep the id valid — or
 * `null` when nothing was changed. Lists only the categories actually present,
 * so the message is always accurate.
 */
export function describeIdAdjustment(raw) {
  const s = String(raw || '');
  if (!s) return null;
  if (sanitizeId(s) === s) return null; // already a clean id — nothing to say

  const changes = [];
  if (/[A-Z]/.test(s)) changes.push('capitals became lowercase');
  if (/\s/.test(s)) changes.push('spaces were removed (type a hyphen instead)');
  // Anything left that is not a letter, digit, whitespace or hyphen is a symbol.
  if (/[^a-zA-Z0-9\s-]/.test(s)) changes.push('symbols were removed');

  if (!changes.length) {
    // Defensive: something changed but matched no category above.
    return `Adjusted to a valid id — ${ID_FORMAT_HINT.toLowerCase()}`;
  }
  return `Adjusted to a valid id: ${joinList(changes)}.`;
}

/**
 * The notice to show under the field, given the raw text last typed and the
 * current (already-sanitized) field value. Returns `''` when there is nothing
 * to say. Gating on `sanitizeId(raw) === value` ensures a stale raw string
 * (e.g. after the id was re-derived from the Name field, or reset to auto)
 * never shows a false notice — the notice appears only when the current value
 * is exactly what sanitizing the operator's own keystrokes produced.
 */
export function idFieldNotice(raw, value) {
  if (!raw) return '';
  if (sanitizeId(raw) !== String(value ?? '')) return '';
  return describeIdAdjustment(raw) || '';
}

// "a" · "a and b" · "a, b and c"
function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
