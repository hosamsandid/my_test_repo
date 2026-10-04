'use strict';

// Comment-listener filters for `issue_comment.*` triggers (#2822).
//
// A role that resumes when a human answers on an issue listens to
// `issue_comment.created`. Without a filter it wakes on EVERY comment in the
// repository — on any PR, any issue, and the agent's own question comments — so
// a github-event trigger may narrow it with three optional fields:
//
//   requireLabel      — fire only when the commented issue / PR CURRENTLY carries
//                       this label. The comment payload's `issue.labels` is the
//                       label set when the event was recorded, so the poller reads
//                       the live set (see `_fanOutBatch`) and falls back to the
//                       payload's set only when that read fails.
//   skipAgentComments — drop a comment whose body carries a `gh-as-agent` marker
//                       (`<!-- agent: <id> -->`). All agents share one PAT, so the
//                       marker is the only thing telling an agent comment apart.
//   target            — 'issue' or 'pr': fire only for comments on that kind of
//                       item (`issue.pull_request` set = a PR).
//
// Content routing like `labelFilter` / `branchFilter`: scoped to `issue_comment.*`
// events only — a trigger that carries the fields but listens to another event is
// unaffected. Absent fields = no filter (legacy behaviour). Pure so `node --test`
// covers it; shared by the poller fan-out, the pending-queue reassign and the
// manual re-fire.

const COMMENT_TARGETS = Object.freeze(['issue', 'pr']);

// Same shape `flow-board.js` reads, anchored to one marker anywhere in the body.
const AGENT_MARKER_RE = /<!--\s*agent:\s*[^\s>]+\s*-->/;

function isCommentEvent(key) {
  return typeof key === 'string' && key.startsWith('issue_comment.');
}

// The trigger's comment filter in canonical form, or null when it sets none.
function parseCommentFilter(t) {
  if (!t || typeof t !== 'object') return null;
  const requireLabel = typeof t.requireLabel === 'string' && t.requireLabel.trim() ? t.requireLabel.trim() : null;
  const skipAgentComments = t.skipAgentComments === true;
  const target = COMMENT_TARGETS.includes(t.target) ? t.target : null;
  if (!requireLabel && !skipAgentComments && !target) return null;
  return { requireLabel, skipAgentComments, target };
}

function hasAgentMarker(body) {
  return typeof body === 'string' && AGENT_MARKER_RE.test(body);
}

// 'pr' for a comment on a pull request, 'issue' otherwise.
function commentTargetKind(ghEvent) {
  return ghEvent?.payload?.issue?.pull_request ? 'pr' : 'issue';
}

// Label names of an issue / PR object (`labels` as objects or strings).
function labelNames(item) {
  const list = Array.isArray(item?.labels) ? item.labels : [];
  return list.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

// The checks that need nothing beyond the event itself: target, then agent
// marker. `{ok: true}` or `{ok: false, reason, detail}`.
function commentPrecheck(filter, ghEvent) {
  if (!filter) return { ok: true };
  if (filter.target) {
    const kind = commentTargetKind(ghEvent);
    if (kind !== filter.target) {
      return { ok: false, reason: 'comment-target', detail: `comment on ${kind === 'pr' ? 'a PR' : 'an issue'}, want ${filter.target}` };
    }
  }
  if (filter.skipAgentComments && hasAgentMarker(ghEvent?.payload?.comment?.body)) {
    return { ok: false, reason: 'agent-comment', detail: 'comment carries an agent marker' };
  }
  return { ok: true };
}

// The label condition against the item's current label names.
function requireLabelVerdict(filter, labels) {
  if (!filter || !filter.requireLabel) return { ok: true };
  const list = Array.isArray(labels) ? labels : [];
  if (list.includes(filter.requireLabel)) return { ok: true };
  return { ok: false, reason: 'comment-label', detail: `item lacks label '${filter.requireLabel}'` };
}

module.exports = {
  COMMENT_TARGETS,
  isCommentEvent,
  parseCommentFilter,
  hasAgentMarker,
  commentTargetKind,
  labelNames,
  commentPrecheck,
  requireLabelVerdict,
};
