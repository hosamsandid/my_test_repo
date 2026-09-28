/* ── Outcomes column presentation (#2524) ──────────────────────────────
   Pure mapping from one recorded outcome to how the GitHub Event Log's
   Outcomes column shows it. Since #2524 outcomes are plain text lines (no pill
   border/background — a pill cannot contain multi-line text), so the status is
   carried by a small leading marker whose SHAPE and colour differ per status,
   while the text itself stays in a readable text colour in both themes.

   Semantics (unchanged from the #469 chips): delivered = success, digest =
   info (bundled, not lost), dropped = muted (a protection layer did its job on
   purpose, not an error), no matching trigger = warning. */

export const OUTCOME_TONES = {
  delivered: { marker: '●', markerColor: 'var(--eb-status-success)', textColor: 'var(--eb-text-primary)' },
  digest: { marker: '◆', markerColor: 'var(--eb-status-info)', textColor: 'var(--eb-text-primary)' },
  dropped: { marker: '○', markerColor: 'var(--eb-text-muted)', textColor: 'var(--eb-text-secondary)' },
  noMatch: { marker: '⚠', markerColor: 'var(--eb-status-warning)', textColor: 'var(--eb-text-primary)' },
};

// Label text is exactly the pre-#2524 chip wording (content is out of scope).
// wakeLabel is set when the subscriber's labelFilter matched (#1846). null
// means any-label listener; undefined means a legacy row or a drop before the
// label gate (history-horizon). Show it only when it's a real string.
export function outcomeLabel(outcome) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  const wakeSuffix = typeof o.wakeLabel === 'string' ? ` (${o.wakeLabel})` : '';
  const target = o.agentName || o.agentId;
  if (o.status === 'delivered') return `delivered${wakeSuffix} → ${target}`;
  if (o.status === 'digest') return `digested${wakeSuffix} → ${target}`;
  return `dropped (${o.reason || 'unknown'})${wakeSuffix} → ${target}`;
}

export function outcomeTone(outcome) {
  const status = outcome && typeof outcome === 'object' ? outcome.status : undefined;
  if (status === 'delivered') return 'delivered';
  if (status === 'digest') return 'digest';
  return 'dropped';
}

export function outcomePresentation(outcome) {
  const tone = outcomeTone(outcome);
  return { tone, label: outcomeLabel(outcome), ...OUTCOME_TONES[tone] };
}

export const NO_MATCH_LABEL = "nobody's listening";
