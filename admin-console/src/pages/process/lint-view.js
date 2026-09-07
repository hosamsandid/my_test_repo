// Pure view helpers for the Flows lint panel (#1122). Dependency-free so it
// unit-tests under `node --test` (the JSX LintsPanel cannot be imported there).
//
// The graph linter (`admin-console/api/process-graph.js` computeLints) returns
// lints as `{ code, severity, message, nodeId?, ... }`. The raw `code` is an
// opaque slug (`gate-violation`, `producer-unconsumed`, …) and the message only
// states the symptom, never the remedy; severity is conveyed by colour alone.
// This module maps each lint to render-ready view data: a plain-language title,
// a severity word (Error/Warning/Info), a severity colour token, and a one-line
// "To fix" hint. The raw slug is preserved (as a support tooltip in the UI).

// Per-code presentation: plain title + one-line remediation. Keyed on the exact
// slugs emitted by computeLints. A code not listed here falls back to the slug
// as its title and no fix line, so a newly-added lint never renders blank.
const LINT_INFO = {
  'orphan-listener': { title: 'Input never wakes', fix: 'Have an upstream outcome set this label, or remove the input waiting on it.' },
  'dead-end-emitter': { title: 'Signal goes nowhere', fix: 'Wire a consumer that reacts to this label, or drop the outcome that sets it.' },
  'outcome-without-consumer': { title: 'Outcome nobody reacts to', fix: 'Add a consumer for this label, or mark the outcome terminal/external if the flow ends here.' },
  'unbound-gate': { title: 'Approval gate has no human', fix: 'Add a human role that applies this gate label.' },
  'unbound-brake': { title: 'Brake has no decider', fix: 'Wire a human role to decide this brake.' },
  'unbound-delivery': { title: 'Delivery has no reviewer', fix: 'Wire a human role to review the PRs/issues this agent opens.' },
  'producer-unconsumed': { title: 'Output nobody consumes', fix: 'Add an agent or human role that consumes these PRs/issues, or mark the outcome terminal/external.' },
  'channel-from-non-producer': { title: 'Channel from a non-producer', fix: 'Point the channel at an agent that actually opens that PR/issue, or mark the source as a producer.' },
  'gate-violation': { title: 'Agent claims a human-only gate', fix: 'Remove this gate label from the agent — only a person may apply it.' },
  'competing-stage': { title: 'Conflicting stage labels', fix: 'Have the agent set a single stage label so its progress stays unambiguous.' },
  'duplicate-listener': { title: 'Redundant inputs', fix: 'Remove the duplicate trigger so the agent wakes once per event.' },
  'raw-trigger-nonconformant': { title: 'Trigger bends the wiring rules', fix: 'Edit the trigger to match the wiring rules — it still runs meanwhile.' },
  'unclaimed-listener': { title: 'Listener without a claim', fix: 'Add a claim so a stalled run stays distinguishable from a wake that never arrived.' },
  // Direct hand-off (#2032, docs/direct-agent-handoff-concept.md §12 P3).
  'wake-target-unresolved': { title: 'Hand-off names no reachable agent', fix: 'Point the hand-off at another agent on this team — a person has no queue, and an agent cannot hand off to itself.' },
  'wake-target-disabled': { title: 'Hand-off target cannot receive it', fix: "Re-enable the target's hand-off input, or the wake is queued and then dropped." },
  'wake-without-note': { title: 'Hand-off carries no context', fix: 'Add a sentence of context — it is what the target and the event log get instead of a label.' },
  'direct-handoff-candidate': { title: 'Label only routes one pair', fix: 'Consider a direct hand-off instead — unless a person tracks this label on the issue/PR.' },
};

const SEVERITY_WORD = { error: 'Error', warning: 'Warning', info: 'Info' };

// CSS var for the severity accent — matches the FlowAnomaliesPanel palette
// (error/warning use the status tokens; info is muted).
function severityColor(severity) {
  if (severity === 'error') return 'var(--eb-status-error)';
  if (severity === 'warning') return 'var(--eb-status-warning)';
  return 'var(--eb-text-muted)';
}

// Map one lint object to render-ready view data. `message` is passed through
// untouched (the caller strips backtick ticks for display).
function lintView(l) {
  const lint = l || {};
  const info = LINT_INFO[lint.code] || {};
  return {
    slug: lint.code,
    title: info.title || lint.code,
    fix: info.fix || null,
    severityWord: SEVERITY_WORD[lint.severity] || 'Info',
    severityColor: severityColor(lint.severity),
    message: lint.message || '',
  };
}

export { LINT_INFO, lintView, severityColor };
