// Pure view helpers for the pending-triggers dispatch-queue section of the
// GitHub Event Log page (#724). React-free so they can be unit-tested with
// `node --test` without a DOM / node_modules (the JSX itself is only
// parse-checked in this repo).

// Human-readable label for a queue entry kind. An unknown kind falls through to
// the raw string, which is what a leftover `bp-event-batch` entry (#1964
// removed its label; #1962 removed the producer) now renders as.
const KIND_LABELS = {
  github: 'GitHub event',
  'github-digest': 'GitHub digest',
  'throttle-warning': 'Throttle warning',
  'session-reset': 'Session reset',
  'session-set': 'Session resume',
  trigger: 'Trigger',
  // #2032: a direct agent-to-agent hand-off (#2030). Registered here — and in
  // KIND_TOOLTIPS / entryDetail below — or the row reads "wake-agent — An
  // unrecognised queue entry", which is how `handover-dm` still reads today.
  'wake-agent': 'Direct hand-off',
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
  unknown: 'An unrecognised queue entry.',
};

export function kindTooltip(kind) {
  return KIND_TOOLTIPS[kind] || KIND_TOOLTIPS.unknown;
}

// Compact one-line detail string for the entry's kind-specific fields. Returns
// '' when there is nothing extra to show (kept out of the cell entirely).
export function entryDetail(entry) {
  if (!entry || typeof entry !== 'object') return '';
  switch (entry.kind) {
    case 'github': {
      const parts = [];
      // For a *.labeled / *.unlabeled event, append the carried label in the
      // same `event (label)` form the Processed events tab uses (#1649). Absent
      // label → unchanged, no empty artifact.
      if (entry.event) parts.push(entry.label ? `${entry.event} (${entry.label})` : entry.event);
      else if (entry.label) parts.push(`(${entry.label})`);
      if (entry.repo) parts.push(entry.repo);
      if (entry.actor) parts.push(`@${entry.actor}`);
      if (entry.eventId) parts.push(`#${entry.eventId}`);
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

// Total entries across all agent groups (defensive against a partial payload).
export function totalPending(data) {
  if (!data) return 0;
  if (typeof data.total === 'number') return data.total;
  if (!Array.isArray(data.agents)) return 0;
  return data.agents.reduce((n, g) => n + (Array.isArray(g.entries) ? g.entries.length : 0), 0);
}
