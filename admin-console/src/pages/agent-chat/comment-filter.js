// Comment-listener filters (#2822) — the trigger form's state / body helpers and
// the card's summary copy. Pure so `node --test` covers it. The console bundle
// cannot import the CommonJS server modules; this mirrors
// admin-console/api/comment-filter.js (write validation) and
// orchestrator/comment-filter.js (matching) — keep them in sync.
//
// The three fields only act on `issue_comment.*` events: `requireLabel` (the
// commented item must carry this label when the comment arrives),
// `skipAgentComments` (ignore comments carrying a gh-as-agent marker) and
// `target` ('issue' | 'pr'). Absent = no filter.

export const COMMENT_TARGET_OPTIONS = Object.freeze([
  { value: '', label: 'Issues and pull requests' },
  { value: 'issue', label: 'Issues only' },
  { value: 'pr', label: 'Pull requests only' },
]);

export const REQUIRE_LABEL_PLACEHOLDER = 'e.g. needs-clarification (leave empty for any item)';
export const REQUIRE_LABEL_HELP = 'Wake only for comments on an issue or PR that carries this label when the comment arrives. '
  + 'Empty = comments on any item.';
export const SKIP_AGENT_COMMENTS_HELP = 'Comments posted by agents (they carry a hidden agent marker) never wake this trigger — '
  + 'human answers still do.';

export function isCommentEvent(event) {
  return typeof event === 'string' && event.startsWith('issue_comment.');
}

// Whether the form shows the comment fields for the selected events.
export function showsCommentFilter(events) {
  return Array.isArray(events) && events.some(isCommentEvent);
}

// Stored trigger → form state.
export function commentFilterToForm(stored) {
  const t = stored && typeof stored === 'object' ? stored : {};
  return {
    requireLabel: typeof t.requireLabel === 'string' ? t.requireLabel : '',
    skipAgentComments: t.skipAgentComments === true,
    commentTarget: t.target === 'issue' || t.target === 'pr' ? t.target : '',
  };
}

// Form state → PUT/POST body fields. Every key is present: `null` clears a
// stored filter when the field is blanked or the event is no longer a comment.
export function commentFilterBody(form, { show = true } = {}) {
  const label = show && typeof form?.requireLabel === 'string' ? form.requireLabel.trim() : '';
  return {
    requireLabel: label || null,
    skipAgentComments: show && form?.skipAgentComments === true ? true : null,
    target: show && (form?.commentTarget === 'issue' || form?.commentTarget === 'pr') ? form.commentTarget : null,
  };
}

// Form-level error, or null. GitHub caps label names at 50 characters.
export function commentFilterFormError(form) {
  const label = typeof form?.requireLabel === 'string' ? form.requireLabel.trim() : '';
  if (label.length > 50) return 'Required label: at most 50 characters.';
  return null;
}

// Card summary parts for a comment trigger, e.g.
// ["PRs only", "item labelled “needs-clarification”", "ignores agent comments"];
// [] when the trigger sets no filter or does not listen to comments.
export function commentFilterSummary(trigger) {
  const events = Array.isArray(trigger?.events) ? trigger.events : [];
  if (!showsCommentFilter(events)) return [];
  const parts = [];
  if (trigger.target === 'issue') parts.push('issues only');
  else if (trigger.target === 'pr') parts.push('PRs only');
  if (typeof trigger.requireLabel === 'string' && trigger.requireLabel.trim()) {
    parts.push(`item labelled “${trigger.requireLabel.trim()}”`);
  }
  if (trigger.skipAgentComments === true) parts.push('ignores agent comments');
  return parts;
}
