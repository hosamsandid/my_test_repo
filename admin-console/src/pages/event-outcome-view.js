// Pure view helpers for the outcome chips on the GitHub Event Log's
// "Processed events" tab (#1149). React-free so they can be unit-tested with
// `node --test` without a DOM / node_modules (the JSX itself is only
// parse-checked in this repo).
//
// Each chip renders a raw `status` / `reason` from the poller's event-
// transparency log (orchestrator/github-poller.js). Operators had no way to
// tell whether a wall of "dropped" chips was healthy loop-protection or a
// misconfiguration, so every chip now carries an explanation + a "what to do"
// line, and the page shows the same set as a collapsible legend.

// The legend, in the order it reads best top-to-bottom: the two success
// states first, then the drop reasons a protection layer can stamp, then the
// no-subscriber case. `key` is stable for React lists and tests; `term` is the
// chip wording (agent name elided as "<agent>"); `meaning` is one plain
// sentence; `whatToDo` tells the operator whether to worry.
export const OUTCOME_LEGEND = [
  {
    key: 'delivered',
    term: 'delivered → <agent>',
    meaning: 'The event matched a trigger and woke that agent — a session ran.',
    whatToDo: 'Nothing to do. Click a delivered chip to open the session it started.',
  },
  {
    key: 'digest',
    term: 'digested → <agent>',
    meaning: 'Part of a burst was folded into one summary wake, so a spike of events becomes a single session instead of many.',
    whatToDo: 'Nothing to do — no event is lost; the agent still receives every event inside the digest.',
  },
  {
    key: 'held',
    term: 'held (WIP) → <agent>',
    meaning: "The event matched a trigger, but the flow's Work-in-Progress limit was full, so the dispatch is waiting for a free slot rather than running yet.",
    whatToDo: 'Nothing is lost — it fires automatically as capacity frees. To see or force it, open the Pending queue tab or the Flow Control board. Raise the flow’s WIP limit in Team Settings if work is waiting too long.',
  },
  {
    key: 'throttle',
    term: 'dropped (throttle)',
    meaning: "The per-conversation rate cap was hit (default 5 events/hour), so further reactions on this PR / issue / branch were dropped.",
    whatToDo: "Usually healthy loop-protection — expected when an agent's own actions keep re-triggering it. Only investigate if a genuinely new event failed to wake the agent.",
  },
  {
    key: 'history-horizon',
    term: 'dropped (horizon)',
    meaning: "The event is older than the trigger's subscription window (its activation time plus a short grace).",
    whatToDo: 'Expected right after wiring or reactivating a trigger; a brand-new agent never reacts to activity that predates it. Persistent drops mean the event is simply older than the subscriber.',
  },
  {
    key: 'label-filter',
    term: 'dropped (label-filter)',
    meaning: "The event carried a label the trigger does not subscribe to.",
    whatToDo: 'Normal label-routing — the trigger only wakes on its configured label. No action needed unless the label wiring itself is wrong.',
  },
  {
    key: 'wake-already-armed',
    term: 'dropped (wake-already-armed)',
    meaning: 'The agent was already woken for this label on this item; a repeat of the same label is ignored until the label is removed and re-applied.',
    whatToDo: "Usually healthy — it stops an agent's own claim swap from waking it twice. If a real hand-off was lost, use Fire again on the agent's Events tab in Agent Chat.",
  },
  {
    key: 'internal-dedup',
    term: 'dropped (internal-dedup)',
    meaning: 'The console or supervisor already woke the agent for this label directly, so the poller skipped its own copy of the same event.',
    whatToDo: 'Nothing to do — the wake was delivered once already.',
  },
  {
    key: 'self-claim-label',
    term: 'dropped (self-claim-label)',
    meaning: "The label is an agent's own ':wip' claim label, not a hand-off.",
    whatToDo: 'Nothing to do.',
  },
  {
    key: 'push-duplicate',
    term: 'dropped (push-duplicate)',
    meaning: 'A duplicate of a push the poller had already seen.',
    whatToDo: 'Nothing to do.',
  },
  {
    key: 'no-match',
    term: "nobody's listening",
    meaning: 'No trigger subscribed to this event type at all, so nobody was woken.',
    whatToDo: 'If this event should have woken an agent, add or fix a github-event trigger on the target agent.',
  },
];

const LEGEND_BY_KEY = OUTCOME_LEGEND.reduce((m, e) => { m[e.key] = e; return m; }, {});

// Map one recorded outcome to its legend key. `delivered`/`digest` come straight
// from `status`; every other status is a drop keyed by its `reason`, falling
// back to a generic drop when the reason is unfamiliar.
export function outcomeLegendKey(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  if (outcome.status === 'delivered') return 'delivered';
  if (outcome.status === 'digest') return 'digest';
  if (outcome.status === 'held') return 'held';
  const reason = outcome.reason || '';
  if (LEGEND_BY_KEY[reason]) return reason;
  return 'drop-unknown';
}

// Tooltip string ("meaning · whatToDo") for an outcome chip. Empty string for
// junk input so the caller can drop the attribute entirely.
export function outcomeTooltip(outcome) {
  const key = outcomeLegendKey(outcome);
  if (!key) return '';
  if (key === 'drop-unknown') {
    const reason = (outcome && outcome.reason) || 'unknown';
    return `Dropped by a protection layer (${reason}). Not one of the standard reasons — check the orchestrator logs if unexpected.`;
  }
  const entry = LEGEND_BY_KEY[key];
  return `${entry.meaning} ${entry.whatToDo}`;
}

// Tooltip for the "nobody's listening" badge (no subscriber matched at all).
// The list.length === 0 case is recorded as `noMatchingTrigger`, not an
// outcome row, so we synthesise the same key the legend uses.
export function noMatchTooltip() {
  const entry = LEGEND_BY_KEY['no-match'];
  return `${entry.meaning} ${entry.whatToDo}`;
}

// A row written by "Fire again" on an agent's Events tab (#2525): the sentence
// the delivered chip's tooltip leads with, naming who re-fired which drop.
// Null for every other row.
export function refireNote(entry) {
  if (!entry || entry.source !== 'manual-refire') return null;
  const by = entry.refiredBy ? ` by ${entry.refiredBy}` : '';
  const of = entry.refireOf && entry.refireOf.reason ? ` after a ${entry.refireOf.reason} drop` : '';
  return `Fired again${by}${of}.`;
}
