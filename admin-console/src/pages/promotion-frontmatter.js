// Pure view-model helpers for the PromotionDialog's SKILL.md frontmatter handling
// (#921). The dialog's *name* field is the single source of truth for the draft's
// frontmatter `name:` — these helpers keep the two in sync, spot a name collision
// with the target tier, and advisorily check for the import-grade header. The
// authoritative frontmatter parse/validation lives server-side
// (admin-console/api/skill-import.js validateSkillMd; knowledge-suggestions.js
// validatePromotion warns on a missing header) — this is a lightweight mirror, so
// keep the regexes in step with that module.

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// Does the body open with a frontmatter block carrying non-empty `name` and
// `description` keys? Advisory only — inline scalars and `>-`/`|` block scalars
// both count (a block-scalar key line itself is non-empty via its indicator, and
// its value lives on the indented lines the server-side parser collects).
export function hasFrontmatterMeta(skillMd) {
  const m = FRONTMATTER_RE.exec(String(skillMd == null ? '' : skillMd));
  if (!m) return false;
  const body = m[1];
  const keyFilled = (key) => {
    const km = new RegExp(`^${key}[ \\t]*:(.*)$`, 'm').exec(body);
    if (!km) return false;
    const inline = km[1].trim();
    if (inline !== '' && !/^[|>][+-]?\d*$/.test(inline)) return true;
    // block scalar / empty inline: any indented continuation line counts
    const after = body.slice(km.index + km[0].length);
    return /^\r?\n[ \t]+\S/.test(after);
  };
  return keyFilled('name') && keyFilled('description');
}

// Rewrite the frontmatter `name:` value of a draft to `name` (the dialog field).
// No leading frontmatter block, no `name:` line in it, or an empty new name →
// returned unchanged (never invents a header the operator didn't draft).
export function syncFrontmatterName(skillMd, name) {
  const md = String(skillMd == null ? '' : skillMd);
  const n = String(name == null ? '' : name).trim();
  if (!n) return md;
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return md;
  const body = m[1];
  if (!/^name[ \t]*:/m.test(body)) return md;
  const newBody = body.replace(/^name[ \t]*:.*$/m, `name: ${n}`);
  if (newBody === body) return md;
  return md.slice(0, m.index) + m[0].replace(body, newBody) + md.slice(m.index + m[0].length);
}

// Suggest the first free `<name>-N` (N ≥ 2) not present in `takenNames`.
// `takenNames` is any iterable of existing skill names in the target tier.
export function suggestFreeName(name, takenNames) {
  const base = String(name == null ? '' : name).trim();
  if (!base) return '';
  const taken = new Set([...(takenNames || [])].map((s) => String(s)));
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now() % 1000}`;
}
