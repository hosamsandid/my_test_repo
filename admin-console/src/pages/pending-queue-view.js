// Pure view helpers for the pending-triggers dispatch-queue section of the
// GitHub Event Log page (#724). React-free so they can be unit-tested with
// `node --test` without a DOM / node_modules (the JSX itself is only
// parse-checked in this repo).

// The friendly event-name map the Processed events tab and the trigger editor
// already share (#2101 AC5). Explicit `.js` extension: these pure modules are
// exercised by bare `node --test`, which does not do Vite's extensionless
// resolution — the convention every other pure sibling import follows.
import { eventLabel } from './agent-chat/trigger-summary.js';

// Human-readable label for a queue entry kind. An unknown kind falls through to
// the raw string, which is what a leftover `bp-event-batch` entry (#1964
// removed its label; #1962 removed the producer) now renders as.
//
// #2101 AC8: every kind a producer can currently WRITE has an entry here, and
// `pending-queue-wiring.test.js` enumerates the producer call sites to keep it
// that way — a kind that renders as a raw token with the tooltip "An
// unrecognised queue entry" is a bug the next new kind should not be able to
// reintroduce. `bp-event-batch` is deliberately still absent: #1962 removed its
// producer and #1964 removed its label on purpose, so it is not producer-side
// and a leftover entry keeps falling through to its own raw kind string.
const KIND_LABELS = {
  github: 'GitHub event',
  'github-digest': 'GitHub digest',
  'throttle-warning': 'Throttle warning',
  'session-reset': 'Session reset',
  'session-set': 'Session resume',
  trigger: 'Trigger',
  // #2032: a direct agent-to-agent hand-off (#2030). Registered here — and in
  // KIND_TOOLTIPS / entryDetail below — or the row reads "wake-agent — An
  // unrecognised queue entry", which is how `handover-dm` read until #2101.
  'wake-agent': 'Direct hand-off',
  // #2101: the two live kinds that were still reading as raw tokens.
  // `handover-dm` is the BP-instance hand-off dialog's structured message,
  // queued rather than DM'd so it cannot race the target's first Matrix sync
  // (admin-console/api/api.js); `loop-verify` is a loop iteration routed to a
  // sibling agent for a verdict (agent-entrypoint.py).
  'handover-dm': 'Hand-over message',
  'loop-verify': 'Loop verification',
  unknown: 'Unknown',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || 'Unknown';
}

// One-line "what is this" tooltip for each pending-queue entry kind (#1149).
// Surfaced as the KindBadge `title` so an operator can tell a normal digest
// from a throttle warning without leaving the page.
const KIND_TOOLTIPS = {
  github: 'A GitHub event waiting to be delivered to this agent — it drains within seconds unless maintenance mode is active.',
  'github-digest': 'A burst of GitHub events on one conversation, folded into a single lossless summary wake.',
  'throttle-warning': "A heads-up that this agent's per-conversation rate cap was hit and further events were dropped.",
  'session-reset': "A queued request to reset this room's Claude session.",
  'session-set': 'A queued request to resume a specific Claude session in this room.',
  trigger: 'A queued trigger invocation waiting to run.',
  'wake-agent': 'Another agent on this team handed work over directly — no label, no issue or PR. It drains within seconds unless maintenance mode is active or a loop holds the workspace.',
  'handover-dm': 'A hand-over message the console composed for this agent — queued rather than sent as a chat message so it cannot arrive before the agent has finished starting up.',
  'loop-verify': "Another agent's loop iteration, waiting for this agent to review it and return a verdict. The loop is blocked until it does.",
  unknown: 'An unrecognised queue entry.',
};

export function kindTooltip(kind) {
  return KIND_TOOLTIPS[kind] || KIND_TOOLTIPS.unknown;
}

// The two mechanical claim suffixes a flow label can carry, decoded into a
// state word (#2101 AC7). `:wip` is stamped when a run claims its wake label
// and `:completed` when that run finishes (process-template.js CLAIM_SUFFIX /
// COMPLETED_SUFFIX, mirrored in agent-entrypoint.py and
// flow-anomaly-detector.js) — they are runtime bookkeeping, never authored, and
// `:completed` had zero occurrences anywhere in admin-console/src before this.
// Words rather than the flow canvas's `⇥ wip` glyph (open question 2): the
// glyph reads only to someone who has seen that canvas, and this page is where
// an operator who has not lands.
const CLAIM_STATES = [
  { suffix: ':wip', state: 'in progress' },
  { suffix: ':completed', state: 'done' },
];

// Decompose a carried label into the parts the row renders as a chip (#2101
// AC7): the bare token, the decoded claim state (null when the label carries no
// suffix), and the exact raw token for the hover.
//
// The bare token stays visible on purpose: it is the operator's shared
// vocabulary — what they read on the GitHub issue and what they type into a
// `labelFilter` — so it is never replaced by invented prose. What changed in
// #2101 is only that it stopped being the whole row.
export function labelChip(label) {
  if (typeof label !== 'string') return null;
  const raw = label.trim();
  if (!raw) return null;
  for (const { suffix, state } of CLAIM_STATES) {
    if (raw.length > suffix.length && raw.endsWith(suffix)) {
      return { token: raw.slice(0, -suffix.length), state, raw };
    }
  }
  return { token: raw, state: null, raw };
}

// Compact one-line detail string for the entry's kind-specific fields. Returns
// '' when there is nothing extra to show (kept out of the cell entirely).
export function entryDetail(entry) {
  if (!entry || typeof entry !== 'object') return '';
  switch (entry.kind) {
    case 'github': {
      const parts = [];
      // #2101 AC5/AC6: the friendly event name via the shared `eventLabel` map
      // (`pull_request.labeled` → "PR labeled"), which the Processed events tab
      // has always used and which falls back to the raw key rather than to
      // blank. Three fragments left this string in #2101: the repository (the
      // same long value on every row — #1827's reasoning for the other tab),
      // the GitHub event id (whose `#` sigil made an internal id read as a
      // ticket number, the single most misleading element on the page) and the
      // carried label, which is now rendered as a chip instead of as part of a
      // sentence. Repository and event id stay one hover away — see
      // entryHoverDetail.
      const friendly = eventLabel(entry.event);
      if (friendly) parts.push(friendly);
      if (entry.actor) parts.push(`@${entry.actor}`);
      return parts.join(' · ');
    }
    case 'github-digest':
      return [
        entry.count != null ? `${entry.count} events` : null,
        entry.convKey || null,
      ].filter(Boolean).join(' · ');
    case 'throttle-warning':
      return entry.convKey ? `conv ${entry.convKey}` : '';
    case 'session-reset':
    case 'session-set':
      return entry.roomId ? `room ${entry.roomId}` : '';
    case 'trigger':
      return entry.triggerId ? `trigger ${entry.triggerId}` : '';
    // #2032: producer first — "who handed this to me" is the one thing a
    // hand-off row must answer; the note (already previewed server-side)
    // follows. A hand-off carries no triggerId to show: the consumer resolves
    // its own `wake-agent` listener at drain time.
    case 'wake-agent':
      return [
        entry.from ? `from ${entry.from}` : null,
        entry.note ? `“${entry.note}”` : null,
      ].filter(Boolean).join(' · ');
    default:
      return '';
  }
}

// What the Details cell offers on hover (#2101 AC6). The repository and the
// GitHub event id left the visible string but stay reachable here, because
// support still needs the event id to find a delivery in the poller's log — and
// it is spelled out as what it is, deliberately WITHOUT a leading `#`: the sigil
// is GitHub's work-item reference syntax and using it on an internal id is the
// exact confusion this ticket removes. Returns '' when there is nothing extra,
// so the caller passes no `title` at all rather than an empty tooltip.
export function entryHoverDetail(entry) {
  if (!entry || typeof entry !== 'object' || entry.kind !== 'github') return '';
  const lines = [];
  if (entry.repo) lines.push(`Repository: ${entry.repo}`);
  if (entry.event) lines.push(`Event key: ${entry.event}`);
  if (entry.eventId) lines.push(`GitHub event id: ${entry.eventId} (not a PR or issue number)`);
  return lines.join('\n');
}

// Total entries across all agent groups (defensive against a partial payload).
export function totalPending(data) {
  if (!data) return 0;
  if (typeof data.total === 'number') return data.total;
  if (!Array.isArray(data.agents)) return 0;
  return data.agents.reduce((n, g) => n + (Array.isArray(g.entries) ? g.entries.length : 0), 0);
}
