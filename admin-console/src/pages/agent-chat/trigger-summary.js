// Pure, framework-free helpers for rendering a human-readable summary of what a
// GitHub-event trigger listens for. Shared by the chat Triggers panel
// (`TriggerRow` in TriggersPanel.jsx) and the Flow/Process canvas trigger
// readout (`TemplateReadonly` in NodeInspector.jsx) so the friendly event
// wording has a single source of truth (#778).

// Subset of GitHub Events API event types most useful for agent workflows.
// (The Events API does not emit every webhook action — e.g. pull_request
// has opened/closed/reopened but not synchronize. It also splits closed
// PRs: `closed` for non-merged closes, `merged` for merged ones — so a
// "react to merge" trigger MUST subscribe to `pull_request.merged` even
// though webhooks call it `closed` with `merged: true`.)
export const GITHUB_EVENT_OPTIONS = [
  { value: 'push',                                  label: 'Push' },
  { value: 'pull_request.opened',                   label: 'PR opened' },
  { value: 'pull_request.closed',                   label: 'PR closed (without merge)' },
  { value: 'pull_request.merged',                   label: 'PR merged' },
  { value: 'pull_request.reopened',                 label: 'PR reopened' },
  { value: 'pull_request.labeled',                  label: 'PR labeled' },
  { value: 'pull_request.unlabeled',                label: 'PR unlabeled' },
  { value: 'pull_request_review.submitted',         label: 'PR review submitted' },
  { value: 'pull_request_review_comment.created',   label: 'PR review comment' },
  { value: 'issue_comment.created',                 label: 'Issue / PR comment' },
  { value: 'issues.opened',                         label: 'Issue opened' },
  { value: 'issues.closed',                         label: 'Issue closed' },
  { value: 'issues.labeled',                        label: 'Issue labeled' },
  { value: 'issues.unlabeled',                      label: 'Issue unlabeled' },
  { value: 'release.published',                     label: 'Release published' },
];

// Events that carry a `payload.label.name` GitHub sends — the only ones
// where a label-name filter makes sense. Used by the form to decide
// whether to show the label-name input, and by the card summary to decide
// whether to show the required-label portion.
export const LABEL_FILTERABLE_EVENTS = new Set([
  'issues.labeled',
  'issues.unlabeled',
  'pull_request.labeled',
  'pull_request.unlabeled',
]);

const EVENT_LABELS = new Map(GITHUB_EVENT_OPTIONS.map(o => [o.value, o.label]));

// Friendly label for a GitHub event key (e.g. `issues.labeled` → "Issue
// labeled"), falling back to the raw key for keys not in the map so an
// unknown/hand-edited event never renders blank.
export function eventLabel(value) {
  if (!value) return '';
  return EVENT_LABELS.get(value) || String(value);
}

// Whether any of the given event keys carries a `payload.label.name` that a
// label-name filter can match against — the guard for showing the required
// label on a card even when a stale `labelFilter` value lingers in the data.
export function eventsAreLabelFilterable(events) {
  return (Array.isArray(events) ? events : []).some(e => LABEL_FILTERABLE_EVENTS.has(e));
}

// Structured, human-readable summary of a github-event trigger's firing
// condition. Returns `{ events: string[] (friendly labels), label: string|null }`.
// The label is present only when a `labelFilter` is set AND at least one of the
// trigger's events is label-filterable (AC2/AC4/AC5).
export function summarizeGithubEventTrigger(trigger) {
  const raw = Array.isArray(trigger?.events) ? trigger.events : [];
  const events = raw.map(eventLabel).filter(Boolean);
  const label = trigger?.labelFilter && eventsAreLabelFilterable(raw)
    ? String(trigger.labelFilter)
    : null;
  return { events, label };
}
