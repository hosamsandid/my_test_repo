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

// ── Row actions (#2102) ─────────────────────────────────────────────────────
//
// The row has two actions now, so per the house rule (#1925/#1938 D3, #2053 D4)
// they live in a kebab context menu rather than a second icon button.

// The row's menu, in the shared RowContextMenu descriptor shape.
//
// `Reassign` is offered on EVERY row but disabled with a reason where it does
// not apply, rather than omitted: an operator who has just been told an entry
// is stuck needs to know that handing it on is not an option here and why —
// a missing entry answers that with silence. Whether it applies is the SERVER's
// `reassignable` flag (stamped by `pending-queue.isReassignable`), never a
// kind list re-derived on the client, so the two cannot drift.
export function pendingRowMenu(row, { busy = false } = {}) {
  const reassignable = !!(row && row.reassignable);
  return [
    {
      key: 'reassign',
      label: 'Reassign to…',
      disabled: busy || !reassignable,
      title: reassignable
        ? 'Hand this entry to another agent on the same team'
        : notReassignableReason(row),
    },
    {
      key: 'cancel',
      label: busy ? 'Cancelling…' : 'Cancel',
      danger: true,
      separated: true,
      disabled: busy,
      title: 'Remove this entry from the queue before it is delivered',
    },
  ];
}

// Why this row cannot be handed on. Mirrors the three conditions
// `isReassignable` checks, in the same order, so the sentence an operator reads
// is the actual reason the server refused to flag it.
export function notReassignableReason(row) {
  const kind = (row && row.kind) || 'unknown';
  if (kind !== 'github') {
    return `Only queued GitHub events can be reassigned — this is a ${kindLabel(kind).toLowerCase()} entry.`;
  }
  if (!row || !row.triggerId) {
    return 'This entry carries no trigger, so no trigger could be re-resolved on another agent.';
  }
  return 'This entry carries no event details, so no target agent could be matched against it.';
}

// What the target picker shows. An empty target list is NOT an error state — it
// is the common, informative answer ("nobody else on this team listens for
// this"), so it gets its own sentence plus, where the server said why, the
// per-agent refusals (#2102 AC10's "what happens when no eligible target
// exists").
export function reassignPickerState(data) {
  if (!data) return { loading: true, targets: [], refused: [], notice: '' };
  if (data.ok === false) {
    return {
      loading: false, targets: [], refused: [],
      notice: pendingReassignError(data),
    };
  }
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const refused = Array.isArray(data.refused) ? data.refused : [];
  return {
    loading: false,
    targets,
    refused,
    notice: targets.length
      ? ''
      : 'No other agent on this team has an enabled trigger that would accept this event. '
        + 'Reassigning it anywhere else would look successful and then do nothing, so it is not offered.',
  };
}

// One-line label for a target in the picker: who, and which of their triggers
// would take it — the label being the thing an operator recognises.
export function reassignTargetLabel(target) {
  if (!target) return '';
  const name = target.agentName || target.agentId;
  return target.labelFilter ? `${name} — on “${target.labelFilter}”` : `${name} — any label`;
}

// Operator-readable copy for every refusal the reassign route can return.
// Keyed on the server's `code`, so a new refusal is a missing case here rather
// than a silent fallthrough to a generic failure.
const REASSIGN_ERRORS = {
  'entry-gone': 'That entry is no longer in the queue — it was drained or cancelled. Nothing was moved.',
  'already-fired': 'That entry fired while you were choosing a target, so it was not moved. '
    + 'The original agent has it.',
  'kind-not-reassignable': 'That kind of queue entry cannot be reassigned.',
  'no-matching-trigger': 'That agent has no enabled trigger that would accept this event, '
    + 'so the entry was left where it is.',
  'target-not-a-candidate': 'That agent is not an eligible target — it may have been disabled '
    + 'or moved to another team. The entry was left where it is.',
  'cross-team': 'An entry can only be handed to an agent on the same team. Nothing was moved.',
  'self-target': 'That entry is already queued for that agent. Nothing was moved.',
  'unknown-target': 'That agent no longer exists. The entry was left where it is.',
  'no-team': 'The team could not be resolved for one of the two agents, so nothing was moved.',
  'source-write-failed': 'The queue could not be written, so nothing was moved.',
};

// Accepts either a 200 response body or the shape lifted off a thrown apiCall
// error (`{code, error}`) — the refusals ride a 409, so most of the time this
// sees the latter.
export function pendingReassignError(result) {
  const code = result && result.code;
  // AC8: the one outcome that is NOT a routine "no". The entry was removed and
  // never re-queued, so the event exists in no queue at all and the only
  // recovery is a human re-applying the label on GitHub. The message therefore
  // has to name the work item — and the server composes that sentence, because
  // only it has the entry in hand at the moment the enqueue fails.
  if (code === 'enqueue-failed') {
    if (result.error) return result.error;
    const w = result.workItem || {};
    return 'The entry was removed from the original agent but could NOT be queued for the target — '
      + `it is now in no queue. Re-apply ${w.label ? `the “${w.label}” label` : 'the label'} `
      + `on ${w.text || 'the queued event'} to run it again.`;
  }
  if (code && REASSIGN_ERRORS[code]) return REASSIGN_ERRORS[code];
  return (result && result.error)
    ? `Reassign failed: ${result.error}`
    : 'Reassign failed.';
}

// The success sentence, naming both ends so the operator can see it went where
// they meant it to.
export function pendingReassignSuccess(result) {
  if (!result || !result.ok) return '';
  const what = (result.workItem && result.workItem.text) || 'the entry';
  return `Moved ${what} to ${result.to}.`;
}

// Total entries across all agent groups (defensive against a partial payload).
export function totalPending(data) {
  if (!data) return 0;
  if (typeof data.total === 'number') return data.total;
  if (!Array.isArray(data.agents)) return 0;
  return data.agents.reduce((n, g) => n + (Array.isArray(g.entries) ? g.entries.length : 0), 0);
}
