// Pure view model for the Agent Chat "Events" tab (#2525).
//
// The tab lists every GitHub event that reached THIS agent's subscriptions —
// one row per (event, trigger), from GET /api/agents/:agentId/github-events —
// and offers "Fire again" on the three drops a protection layer may have
// swallowed a real wake with. React-free so `node --test` covers it; the JSX in
// EventsPanel.jsx only renders what these helpers return.

import { buildTriggerCorrelationId } from '../github-event-session.js';
import { producerFilterText, outcomeStatus } from '../event-outcome-presentation.js';

// The only drops a human may override (mirrors orchestrator/github-refire.js
// REFIRABLE_REASONS — the server re-checks, this only decides whether to offer).
export const REFIRABLE_REASONS = Object.freeze(['wake-already-armed', 'throttle', 'internal-dedup']);

// Selectable time windows (AC2). The log keeps 7 days, so that is the widest.
export const EVENT_RANGES = Object.freeze([
  { key: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
]);
export const DEFAULT_EVENT_RANGE = '24h';

// `since` ISO string for a range key; unknown keys fall back to the default.
export function rangeSince(key, now = Date.now()) {
  const r = EVENT_RANGES.find((x) => x.key === key) || EVENT_RANGES.find((x) => x.key === DEFAULT_EVENT_RANGE);
  return new Date(now - r.ms).toISOString();
}

// The tab is shown only for an agent with at least one GitHub-event trigger
// (AC1). Data-flow triggers are GitHub `push` subscriptions under the hood and
// land in the same log, so they count too.
export function hasGithubEventTrigger(triggers) {
  return Array.isArray(triggers) && triggers.some(
    (t) => t && (t.type === 'github-event' || t.type === 'data-flow'),
  );
}

function q(label) {
  return label ? `'${label}'` : 'the label';
}

// The pushed branch / tag named by a push row's `ref` (#2570).
function refText(ref) {
  if (typeof ref !== 'string' || !ref) return 'this branch';
  if (ref.startsWith('refs/heads/')) return `branch '${ref.slice('refs/heads/'.length)}'`;
  if (ref.startsWith('refs/tags/')) return `tag '${ref.slice('refs/tags/'.length)}'`;
  return `'${ref}'`;
}

// Human-readable drop reason (AC3). `row.label` is the label the event carried
// (the one a label-filter / self-claim drop ignored); `row.wakeLabel` is the
// trigger's wake label.
export function dropReasonText(row) {
  const reason = row && row.reason;
  const label = row && row.label;
  const wake = (row && row.wakeLabel) || label;
  switch (reason) {
    case 'wake-already-armed':
      return `Already woken for ${q(wake)} on this item — a repeat of the same label is ignored until it is removed and re-applied.`;
    case 'label-filter':
      return `Label ${q(label)} is not the one this trigger listens for, so it was ignored.`;
    case 'branch-filter': {
      const what = refText(row.ref);
      return `${what.charAt(0).toUpperCase()}${what.slice(1)} is not in this trigger's branch filter, so the push was ignored.`;
    }
    case 'throttle':
      return 'Too many events on this item within the hour — the rate cap dropped this one.';
    case 'internal-dedup':
      return `Already delivered once for ${q(wake)} (the console or supervisor woke the agent directly) — the poller's copy was skipped.`;
    case 'self-claim-label':
      return `Label ${q(label)} is the agent's own claim label (':wip'), not a hand-off, so it was ignored.`;
    case 'history-horizon':
      return 'The event is older than this trigger — it happened before the trigger was activated.';
    case 'push-duplicate':
      return 'A duplicate of a push already seen, so it was ignored.';
    case 'knowledge-branch': {
      const what = refText(row.ref);
      return `${what.charAt(0).toUpperCase()}${what.slice(1)} is a knowledge-base branch — pushes to it never wake push triggers.`;
    }
    case 'producer-filter': {
      const why = producerFilterText(row && row.producer);
      return `${why.charAt(0).toUpperCase()}${why.slice(1)} — this trigger only wakes on pushes by the agents it names.`;
    }
    default:
      return reason ? `Dropped (${reason}).` : 'Dropped.';
  }
}

// `{ tone, text }` for the outcome cell. `tone` is one of success / info /
// muted / warning — the panel maps it to a small marker, keeping the text in
// the primary/secondary text colours (low-contrast status tokens on white).
export function outcomeView(row) {
  if (!row) return { tone: 'muted', text: '' };
  const status = outcomeStatus(row);
  if (status === 'delivered') {
    return { tone: 'success', text: row.source === 'manual-refire' ? 'delivered (fired again)' : 'delivered' };
  }
  if (status === 'digest') return { tone: 'info', text: 'digested' };
  // #2693: a provisioning-sweep row, not a drop.
  if (status === 'reaped') return { tone: 'muted', text: 'reaped (orphaned instance cleaned up)' };
  if (status === 'reap-failed') return { tone: 'warning', text: 'reap failed' };
  return { tone: isRefirable(row) ? 'warning' : 'muted', text: `dropped · ${row.reason || 'unknown'}` };
}

export function isRefirable(row) {
  return !!(row && row.status === 'dropped' && REFIRABLE_REASONS.includes(row.reason));
}

// Whether to OFFER Fire again (AC5/AC7): a refirable drop, not yet re-fired,
// with a work item to wake on, for a caller who may manage the agent. The
// server enforces every one of these again.
export function canRefire(row, { canManage } = {}) {
  if (!canManage || !isRefirable(row)) return false;
  if (row.refired) return false;
  return !!(row.workItem && row.workItem.number != null && row.triggerId && row.eventId);
}

// The delivered row's session correlationId (AC4), or null.
export function sessionCorrelationId(row) {
  if (outcomeStatus(row) !== 'delivered') return null;
  return buildTriggerCorrelationId(row.triggerId, row.eventId);
}

// Work-item cell text: "#42 Title".
export function workItemText(row) {
  const wi = row && row.workItem;
  if (!wi || wi.number == null) return '';
  return wi.title ? `#${wi.number} ${wi.title}` : `#${wi.number}`;
}

// The confirm dialog (AC5a): names the reason in plain language; for
// internal-dedup it says the event was already processed once and hands back
// the earlier session to link when known.
export function refireDialog(row) {
  const item = workItemText(row) || 'this item';
  const wake = (row && (row.wakeLabel || row.label)) || null;
  let why;
  switch (row && row.reason) {
    case 'wake-already-armed':
      why = `This event was dropped because the agent had already been woken for ${q(wake)} on ${item}, and the label was never removed and re-applied since.`;
      break;
    case 'throttle':
      why = `This event was dropped by the rate cap: ${item} had too many events within the hour.`;
      break;
    case 'internal-dedup':
      why = `This event was already processed once — the console or supervisor woke the agent for ${q(wake)} on ${item} directly, so the poller skipped its own copy.`;
      break;
    default:
      why = 'This event was dropped.';
  }
  const twin = row && row.reason === 'internal-dedup' && row.twin
    ? { correlationId: buildTriggerCorrelationId(row.twin.triggerId, row.twin.eventId), ts: row.twin.ts || null }
    : null;
  return {
    title: 'Fire again?',
    why,
    what: 'Fire again wakes the agent now with the same trigger prompt, as if the event had just arrived. A new session starts. Later repeats of the same label are still dropped as usual.',
    twin,
  };
}

// "Fired again by ana · 2026-09-28 11:00" (AC6).
export function refiredText(row, formatTime = (ts) => ts) {
  const r = row && row.refired;
  if (!r) return '';
  const by = r.by ? ` by ${r.by}` : '';
  const at = r.at ? ` · ${formatTime(r.at)}` : '';
  return `Fired again${by}${at}`;
}
