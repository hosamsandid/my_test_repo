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
  // A dispatch the flow's WIP lane HELD: neither delivered (no session ran) nor
  // dropped (nothing is lost — it fires when capacity frees), so it needs its
  // own tone rather than falling through to `dropped`, which would read as
  // "gone". Warning-coloured like `noMatch` because both mean "look at this",
  // but a distinct marker shape — since #2524 the shape is the primary carrier
  // of status, so sharing a colour costs no legibility. Half-filled reads as
  // "recorded, not yet run".
  held: { marker: '◐', markerColor: 'var(--eb-status-warning)', textColor: 'var(--eb-text-primary)' },
};

// Label text is exactly the pre-#2524 chip wording (content is out of scope).
// wakeLabel is set when the subscriber's labelFilter matched (#1846). null
// means any-label listener; undefined means a legacy row or a drop before the
// label gate (history-horizon). Show it only when it's a real string.
// `refired` marks a delivery made by a manual "Fire again" (#2525).
// #2571: the readable reason of a producer-filter drop — who pushed (or that
// nobody the platform knows did: a human, a raw `git push`, a knowledge-base
// sync, a branch deletion).
export function producerFilterText(producer) {
  return typeof producer === 'string' && producer
    ? `pushed by \`${producer}\`, not in producer filter`
    : 'producer unknown';
}

export function outcomeLabel(outcome, { refired = false } = {}) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  const wakeSuffix = typeof o.wakeLabel === 'string' ? ` (${o.wakeLabel})` : '';
  const target = o.agentName || o.agentId;
  if (o.status === 'delivered') return `delivered${refired ? ' · fired again' : ''}${wakeSuffix} → ${target}`;
  if (o.status === 'digest') return `digested${wakeSuffix} → ${target}`;
  // `held (WIP n)` — the limit that is holding it, so the operator can act on
  // the row without opening another view. A missing wipLimit degrades to a bare
  // `held (WIP)` rather than printing "undefined".
  if (o.status === 'held') {
    const wip = o.wipLimit != null ? ` ${o.wipLimit}` : '';
    return `held (WIP${wip})${wakeSuffix} → ${target}`;
  }
  if (o.reason === 'producer-filter') return `dropped (${producerFilterText(o.producer)}) → ${target}`;
  return `dropped (${o.reason || 'unknown'})${wakeSuffix} → ${target}`;
}

export function outcomeTone(outcome) {
  const status = outcome && typeof outcome === 'object' ? outcome.status : undefined;
  if (status === 'delivered') return 'delivered';
  if (status === 'digest') return 'digest';
  if (status === 'held') return 'held';
  return 'dropped';
}

export function outcomePresentation(outcome, opts) {
  const tone = outcomeTone(outcome);
  return { tone, label: outcomeLabel(outcome, opts), ...OUTCOME_TONES[tone] };
}

export const NO_MATCH_LABEL = "nobody's listening";
