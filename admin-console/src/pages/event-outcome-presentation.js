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
  // #2693: the provisioning sweep's own rows. Not a dispatch at all — the sweep
  // cleaned up (or failed to clean up) an orphaned instance — so neither can
  // fall through to `dropped`. A reap is housekeeping that worked (muted
  // marker); a failed reap is retried next tick but worth a look (warning).
  reaped: { marker: '□', markerColor: 'var(--eb-text-muted)', textColor: 'var(--eb-text-primary)' },
  reapFailed: { marker: '■', markerColor: 'var(--eb-status-warning)', textColor: 'var(--eb-text-primary)' },
};

// #2693: the status an outcome is SHOWN as. The poller records a folded burst
// as `status: 'delivered'` plus `digest: true` (orchestrator/github-poller.js),
// so a digest is read from the flag; a literal `status: 'digest'` stays
// accepted. Every UI consumer keys on this instead of `outcome.status`.
export function outcomeStatus(outcome) {
  if (!outcome || typeof outcome !== 'object') return undefined;
  if (outcome.status === 'delivered' && outcome.digest === true) return 'digest';
  return outcome.status;
}

// Label text is exactly the pre-#2524 chip wording (content is out of scope).
// wakeLabel is set when the subscriber's labelFilter matched (#1846). null
// means any-label listener; undefined means a legacy row or a drop before the
// label gate (history-horizon). Show it only when it's a real string.
// `refired` marks a delivery made by a manual "Fire again" (#2525).
// #2571: the readable reason of a producer-filter drop — who pushed (or that
// nobody the platform knows did: a human, a raw `git push`, a knowledge-base
// sync, a branch deletion).
// #2602: the readable reason of a knowledge-branch drop.
export const KNOWLEDGE_BRANCH_TEXT = 'knowledge-base branch — never wakes push triggers';

// #2822: why a comment-label drop happened, naming the required label when known.
export function commentLabelText(requireLabel) {
  return typeof requireLabel === 'string' && requireLabel
    ? `item lacks required label '${requireLabel}'`
    : 'item lacks the required label';
}

export function producerFilterText(producer) {
  return typeof producer === 'string' && producer
    ? `pushed by \`${producer}\`, not in producer filter`
    : 'producer unknown';
}

// #2596: a pooled role's per-ticket instance cannot take the work while the
// role itself is paused / draining / off; the orchestrator holds the dispatch
// with reason `pool-<state>`.
const POOL_HOLD_TEXT = { 'pool-paused': 'role paused', 'pool-draining': 'role draining', 'pool-off': 'role off' };

// #2795: a PR hand-off's readiness gate holds the wake until CI is green and
// the PR merges cleanly. `gates` is what the poller recorded (['ci','conflict']).
const GATE_WAIT_TEXT = { ci: 'CI', conflict: 'conflict-free' };
const GATE_FAIL_TEXT = { ci: 'CI failing', conflict: 'merge conflict' };
const GATE_CANCEL_TEXT = { closed: 'PR closed', 'label-removed': 'label removed', 'trigger-removed': 'trigger removed' };

export function gateWaitText(gates) {
  const g = (Array.isArray(gates) ? gates : []).filter(x => GATE_WAIT_TEXT[x]);
  return (g.length ? g : ['ci', 'conflict']).map(x => GATE_WAIT_TEXT[x]).join(' / ');
}

function gateDropText(o) {
  const gates = Array.isArray(o.gates) ? o.gates : [];
  if (o.reason === 'gate-failed') {
    const why = gates.map(x => GATE_FAIL_TEXT[x]).filter(Boolean).join(', ');
    return `gate failed${why ? `: ${why}` : ''}`;
  }
  if (o.reason === 'gate-timeout') return `gate timed out waiting for ${gateWaitText(gates)}`;
  if (o.reason === 'gate-cancelled') {
    const why = GATE_CANCEL_TEXT[o.cancelReason];
    return `gate cancelled${why ? `: ${why}` : ''}`;
  }
  return null;
}

export function outcomeLabel(outcome, { refired = false } = {}) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  const wakeSuffix = typeof o.wakeLabel === 'string' ? ` (${o.wakeLabel})` : '';
  const target = o.agentName || o.agentId;
  const status = outcomeStatus(o);
  if (status === 'delivered') {
    // #2596: a pooled delivery names the per-ticket instance that ran it
    // ("Developer · #2562"), falling back to its id while no name is known.
    const ran = typeof o.instanceId === 'string' && o.instanceId ? (o.instanceName || o.instanceId) : target;
    const cleared = o.reason === 'gate-released' ? ' · gate cleared' : '';
    return `delivered${refired ? ' · fired again' : ''}${cleared}${wakeSuffix} → ${ran}`;
  }
  if (status === 'digest') return `digested${wakeSuffix} → ${target}`;
  if (status === 'reaped') return `reaped → ${target}`;
  if (status === 'reap-failed') return `reap failed → ${target}`;
  // `held (WIP n)` — the limit that is holding it, so the operator can act on
  // the row without opening another view. A missing wipLimit degrades to a bare
  // `held (WIP)` rather than printing "undefined".
  if (status === 'held') {
    if (POOL_HOLD_TEXT[o.reason]) return `held (${POOL_HOLD_TEXT[o.reason]})${wakeSuffix} → ${target}`;
    if (o.reason === 'readiness-gate') return `held — waiting for ${gateWaitText(o.gates)}${wakeSuffix} → ${target}`;
    const wip = o.wipLimit != null ? ` ${o.wipLimit}` : '';
    return `held (WIP${wip})${wakeSuffix} → ${target}`;
  }
  if (o.reason === 'producer-filter') return `dropped (${producerFilterText(o.producer)}) → ${target}`;
  // #2602: built in and not configurable, so it reads as a rule, not a filter.
  if (o.reason === 'knowledge-branch') return `dropped (${KNOWLEDGE_BRANCH_TEXT}) → ${target}`;
  // #2822: name the label the comment filter wanted.
  if (o.reason === 'comment-label') return `dropped (${commentLabelText(o.requireLabel)}) → ${target}`;
  const gate = gateDropText(o);
  if (gate) return `not woken (${gate})${wakeSuffix} → ${target}`;
  return `dropped (${o.reason || 'unknown'})${wakeSuffix} → ${target}`;
}

export function outcomeTone(outcome) {
  const status = outcomeStatus(outcome);
  if (status === 'delivered') return 'delivered';
  if (status === 'digest') return 'digest';
  if (status === 'held') return 'held';
  if (status === 'reaped') return 'reaped';
  if (status === 'reap-failed') return 'reapFailed';
  return 'dropped';
}

export function outcomePresentation(outcome, opts) {
  const tone = outcomeTone(outcome);
  return { tone, label: outcomeLabel(outcome, opts), ...OUTCOME_TONES[tone] };
}

export const NO_MATCH_LABEL = "nobody's listening";

// #2693: search text for the Outcomes column, so the table filter answers
// "which events woke or dropped agent X?". Each outcome contributes the line it
// renders plus the raw agent / instance ids and the raw reason (the line shows
// display names and readable reasons, which can differ). A no-subscriber row
// contributes its "nobody's listening" line.
export function outcomesFilterText(outcomes, row) {
  if (row && row.noMatchingTrigger) return NO_MATCH_LABEL;
  const refired = !!(row && row.source === 'manual-refire');
  const parts = [];
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || typeof o !== 'object') continue;
    parts.push(outcomeLabel(o, { refired }));
    for (const v of [o.agentName, o.agentId, o.instanceName, o.instanceId, o.reason]) {
      if (typeof v === 'string' && v) parts.push(v);
    }
  }
  return [...new Set(parts)].join(' ');
}
