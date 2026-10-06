// #2858 — a live team's label editors show the editable BASE of a team label
// plus its suffix as a read-only chip (`ready-for-review` [-k3f9]). The editors
// still keep and save the PHYSICAL name (`ready-for-review-k3f9`); this pure
// module is the one place that splits and joins the two, mirroring the server's
// `isTeamLabel` (admin-console/api/label-suffix.js).
//
// A label is a TEAM label when it ends in `-<suffix>` and is not one of the
// team's exempt labels (template labels that already ended in the suffix at
// creation, `labelSuffixExempt`). Everything else is FOREIGN: shown as-is, no
// chip, never stamped (AC4).

import { SUFFIX_RE } from './launch-team.js';

/** The suffix context for a team config, or null when the team has none (AC5). */
export function labelSuffixContextFor(teamCfg) {
  const suffix = teamCfg && typeof teamCfg.labelSuffix === 'string' ? teamCfg.labelSuffix : '';
  if (!suffix || !SUFFIX_RE.test(suffix)) return null;
  const exempt = Array.isArray(teamCfg.labelSuffixExempt)
    ? teamCfg.labelSuffixExempt.filter(l => typeof l === 'string')
    : [];
  return { suffix, exempt };
}

export function isTeamLabel(label, ctx) {
  if (!ctx || typeof label !== 'string') return false;
  const tail = `-${ctx.suffix}`;
  return label.length > tail.length && label.endsWith(tail) && !ctx.exempt.includes(label);
}

/**
 * Split a physical label into `{ base, suffix, tail, team }`. A claim add
 * (`foo-k3f9:wip`) splits into base `foo`, suffix `k3f9`, tail `:wip`. A foreign
 * label comes back whole as `base` with `team: false`.
 */
export function splitTeamLabel(label, ctx) {
  const s = typeof label === 'string' ? label : '';
  if (isTeamLabel(s, ctx)) {
    return { base: s.slice(0, s.length - ctx.suffix.length - 1), suffix: ctx.suffix, tail: '', team: true };
  }
  const colon = s.lastIndexOf(':');
  if (ctx && colon > 0 && isTeamLabel(s.slice(0, colon), ctx)) {
    const head = s.slice(0, colon);
    return { base: head.slice(0, head.length - ctx.suffix.length - 1), suffix: ctx.suffix, tail: s.slice(colon), team: true };
  }
  return { base: s, suffix: '', tail: '', team: false };
}

/**
 * Normalise what a person typed or pasted into the base field: trimmed, and a
 * trailing `-<suffix>` (one or more) stripped, so `x-k3f9` becomes `x` (AC3).
 */
export function normaliseBase(text, ctx) {
  let s = String(text == null ? '' : text).trim();
  if (!ctx) return s;
  const tail = `-${ctx.suffix}`;
  while (s.length > tail.length && s.endsWith(tail)) s = s.slice(0, -tail.length);
  return s;
}

/** The physical label for a base: `<base>-<suffix><tail>`; empty stays empty (AC2). */
export function joinTeamLabel(base, ctx, tail = '') {
  const b = normaliseBase(base, ctx);
  if (!b) return '';
  return ctx ? `${b}-${ctx.suffix}${tail}` : `${b}${tail}`;
}

/**
 * Comma-list editors (a human role's emits): the text shows team labels by
 * their base and foreign labels as-is.
 */
export function labelListToText(labels, ctx) {
  return (Array.isArray(labels) ? labels : []).map(l => splitTeamLabel(l, ctx).base).join(', ');
}

/**
 * And back: an entry that names one of the list's foreign labels keeps it
 * as-is (never silently stamped); every other entry becomes a team label.
 */
export function labelListFromText(text, ctx, original = []) {
  const foreign = new Set((Array.isArray(original) ? original : []).filter(l => !isTeamLabel(l, ctx)));
  const out = [];
  for (const raw of String(text == null ? '' : text).split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const label = !ctx || foreign.has(t) ? t : joinTeamLabel(t, ctx);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * The settings control's summary for a dry-run preview of a suffix change
 * (AC9): how many labels and agents it touches, and what GitHub will see.
 */
export function suffixChangeSummary(preview) {
  const labels = Array.isArray(preview?.renames) ? preview.renames.length : 0;
  const agents = Array.isArray(preview?.agents) ? preview.agents.length : 0;
  const from = preview?.oldSuffix ? `-${preview.oldSuffix}` : 'no suffix';
  const to = preview?.newSuffix ? `-${preview.newSuffix}` : 'no suffix';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return {
    labels,
    agents,
    headline: `Change the label suffix from ${from} to ${to}?`,
    body: `This renames ${plural(labels, 'label')} across ${plural(agents, 'agent')} — triggers, hand-offs, outcomes, the label and people registries and prompt text.`,
    warning: 'The labels are renamed in place on GitHub, so open issues and pull requests keep them. Anyone or anything outside this team that relies on the old names will stop matching. Running sessions pick up the new prompts on their next run.',
  };
}

/** A human-readable message for a failed suffix change (409 collisions included). */
export function suffixChangeError(status, body) {
  const collisions = Array.isArray(body?.collisions) ? body.collisions : [];
  if (status === 409 && collisions.length) {
    const names = collisions.map(c => c.label).join(', ');
    const own = collisions.some(c => c.owner === 'this-team');
    return `The new suffix would produce label names that are already in use${own ? ' (including labels of this team that carry no suffix)' : ' by another team on the same repository'}: ${names}. Pick a different suffix.`;
  }
  return (body && body.error) || `Changing the label suffix failed (${status}).`;
}
