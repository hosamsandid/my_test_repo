// flow-copilot-view.js — pure view logic for the Flow Copilot chat panel
// (#1069, spec #1047). Everything here is renderer-free and unit-tested:
// mapping the session-local chat history to the stateless endpoint's message
// list, the proposal-card change/lint presentation, and the error taxonomy
// (provider-missing vs retryable transport). FlowCopilotPanel.jsx consumes it.

// Starter prompts shown as clickable chips in the empty state (#1047 UX spec).
export const STARTER_PROMPTS = [
  'An issue-triage agent labels new issues `req:refine`; a Business Analyst refines them; '
    + 'a human approves with `ready`; a Developer implements and opens a PR; a Code Reviewer '
    + 'either requests revisions or labels `ready-to-merge`; a Merger merges.',
  'Add a security reviewer that also reviews every PR.',
  'Insert a human approval gate before the dispatcher.',
];

/**
 * Map the panel's chat entries to the stateless endpoint's `messages` array.
 * The server only accepts `{role: 'user'|'assistant', content: string}`:
 * error rows are client-side furniture and are dropped; an assistant turn is
 * resent as its summary — the authoritative bundle state travels separately in
 * the request's `bundle` field, so replaying whole proposal JSON would only
 * burn context.
 */
export function toApiMessages(entries) {
  const out = [];
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e) continue;
    if (e.role === 'user' && typeof e.content === 'string') {
      out.push({ role: 'user', content: e.content });
    } else if (e.role === 'assistant') {
      const content = typeof e.summary === 'string' && e.summary.trim()
        ? e.summary
        : '(proposal without summary)';
      out.push({ role: 'assistant', content });
    }
  }
  return out;
}

// Change-kind → { verb, noun } for the proposal card's change list. Kinds come
// from computeChanges in api/flow-copilot.js.
const CHANGE_TEXT = {
  'role-added': 'Role added',
  'role-removed': 'Role removed',
  'role-modified': 'Role modified',
  'label-added': 'Label registered',
  'label-removed': 'Label removed',
  'label-modified': 'Label modified',
  'gate-added': 'Gate added',
  'gate-removed': 'Gate removed',
  'gate-modified': 'Gate modified',
  'stage-added': 'Stage added',
  'stage-removed': 'Stage removed',
  'stage-modified': 'Stage modified',
  'human-added': 'Human role added',
  'human-removed': 'Human role removed',
  'human-modified': 'Human role modified',
  'name-changed': 'Flow renamed to',
};

/** One human-readable line per change entry ({kind, id}). */
export function describeChange(change) {
  if (!change || typeof change !== 'object') return '';
  const label = CHANGE_TEXT[change.kind] || change.kind || 'Changed';
  return change.id ? `${label}: ${change.id}` : label;
}

/** Lint severity → the accent color token (mirrors LintsPanel's red/amber). */
export function lintColor(severity) {
  if (severity === 'error') return 'var(--eb-status-error)';
  if (severity === 'warning') return 'var(--eb-status-warning)';
  return 'var(--eb-text-muted)';
}

/**
 * Classify a failed POST /api/process/copilot for the chat's error row.
 * A 400 is a request-shape/provider problem — the panel always sends a valid
 * shape, so in practice it means no Model Provider is configured; retrying the
 * identical request cannot succeed, the fix is configuration (link to /models).
 * Everything else (502 transport, network) is retryable as-is.
 */
export function copilotErrorInfo(status, message) {
  const msg = typeof message === 'string' && message.trim() ? message.trim() : `Request failed (HTTP ${status || '?'})`;
  if (status === 400) return { kind: 'provider', retryable: false, message: msg };
  return { kind: 'transport', retryable: true, message: msg };
}

/**
 * A new proposal supersedes every still-actionable one: only the latest
 * assistant card may carry live Apply/Discard buttons — an older bundle would
 * silently drop everything proposed after it.
 */
export function supersedePending(entries) {
  return (Array.isArray(entries) ? entries : []).map(e =>
    (e && e.role === 'assistant' && e.status === 'proposed') ? { ...e, status: 'superseded' } : e);
}

/** The latest assistant entry still awaiting an Apply/Discard decision. */
export function latestProposal(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.role === 'assistant' && e.status === 'proposed') return e;
  }
  return null;
}
