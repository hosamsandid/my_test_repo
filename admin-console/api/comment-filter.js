'use strict';

// Comment-listener filters (#2822) — the console's write-side half: validate
// and normalize a github-event trigger's `requireLabel`, `skipAgentComments`
// and `target` before it is persisted or carried through a bundle. They only
// act on `issue_comment.*` events; the matching lives in
// orchestrator/comment-filter.js (the poller) and the form/card copy in
// src/pages/agent-chat/comment-filter.js. The console cannot require the
// orchestrator module — keep the three in sync.
//
// Stored form: `requireLabel` a trimmed label name, `skipAgentComments: true`,
// `target` 'issue' | 'pr' — each key absent when unset (no filter).

const COMMENT_TARGETS = Object.freeze(['issue', 'pr']);

// GitHub caps label names at 50 characters.
const MAX_LABEL_LENGTH = 50;

// Human-readable error for the trigger's comment filter fields, or null when
// valid. Absent / null / blank / false are valid (no filter).
function commentFilterError(t) {
  if (!t || typeof t !== 'object') return null;
  const { requireLabel, skipAgentComments, target } = t;
  if (requireLabel !== undefined && requireLabel !== null) {
    if (typeof requireLabel !== 'string') return 'requireLabel must be a label name';
    if (requireLabel.trim().length > MAX_LABEL_LENGTH) return `requireLabel must be at most ${MAX_LABEL_LENGTH} characters`;
  }
  if (skipAgentComments !== undefined && skipAgentComments !== null && typeof skipAgentComments !== 'boolean') {
    return 'skipAgentComments must be true or false';
  }
  if (target !== undefined && target !== null && target !== '' && !COMMENT_TARGETS.includes(target)) {
    return 'target must be "issue" or "pr"';
  }
  return null;
}

// The set fields in stored form — `{}` when none is set. Used by the bundle /
// materialise paths so a filtered listener never silently widens.
function commentFilterFields(t) {
  const out = {};
  if (!t || typeof t !== 'object') return out;
  if (typeof t.requireLabel === 'string' && t.requireLabel.trim()) out.requireLabel = t.requireLabel.trim();
  if (t.skipAgentComments === true) out.skipAgentComments = true;
  if (COMMENT_TARGETS.includes(t.target)) out.target = t.target;
  return out;
}

// Normalize the fields in place to the stored form: unset ones are removed (so
// a PUT body's `null` clears a stored filter). Call after validation.
function normalizeCommentFilter(t) {
  if (!t || typeof t !== 'object') return t;
  const fields = commentFilterFields(t);
  for (const k of ['requireLabel', 'skipAgentComments', 'target']) {
    if (k in fields) t[k] = fields[k];
    else delete t[k];
  }
  return t;
}

module.exports = { COMMENT_TARGETS, commentFilterError, commentFilterFields, normalizeCommentFilter };
