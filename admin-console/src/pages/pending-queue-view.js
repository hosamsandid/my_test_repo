// Pure view helpers for the pending-triggers dispatch-queue section of the
// GitHub Event Log page (#724). React-free so they can be unit-tested with
// `node --test` without a DOM / node_modules (the JSX itself is only
// parse-checked in this repo).

// Human-readable label for a queue entry kind.
const KIND_LABELS = {
  github: 'GitHub event',
  'github-digest': 'GitHub digest',
  'throttle-warning': 'Throttle warning',
  'bp-event-batch': 'Briefing-pack event',
  'session-reset': 'Session reset',
  'session-set': 'Session resume',
  trigger: 'Trigger',
  unknown: 'Unknown',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || 'Unknown';
}

// Compact one-line detail string for the entry's kind-specific fields. Returns
// '' when there is nothing extra to show (kept out of the cell entirely).
export function entryDetail(entry) {
  if (!entry || typeof entry !== 'object') return '';
  switch (entry.kind) {
    case 'github': {
      const parts = [];
      if (entry.event) parts.push(entry.event);
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
