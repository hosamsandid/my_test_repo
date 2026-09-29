'use strict';

// Internal-channel emit — the pure core of POST /internal/flow-emit (#1173,
// epic #1172; docs/internal-channels-concept.md §4.2).
//
// An agent→agent label hand-off whose listener carries `transport: 'internal'`
// is delivered by the orchestrator queue instead of the GitHub Events API
// round trip; the GitHub label is stamped afterwards as decoration only, so
// the repo stays the human-visible process state. Internal-transport triggers
// are excluded from the poller's subscriber plan (`pollerSubscribes` in
// github-poller.js) — that exclusion, not anything here, is the single dedup
// mechanism that makes the mirror stamp safe.
//
// This module is fs-free so the delivery contract is unit-testable
// (`node --test`): request validation, listener matching, and the synthesized
// event/queue-entry shapes. All I/O (queue write, REST stamp, event log)
// stays in orchestrator.js.

const { listensTo } = require('./event-key-aliases');

const TARGET_KINDS = ['issue', 'pr'];

// The poller event key a target kind maps to. An emit is always a "labeled"
// action — that is the whole vocabulary of a label hand-off.
function eventKeyForKind(kind) {
  return kind === 'pr' ? 'pull_request.labeled' : 'issues.labeled';
}

// Validate the request body into `{ok: true, value}` or `{ok: false, error}`.
// Shape: { agentId, repo: "owner/name", label, target: {kind: issue|pr, number} }.
function validateEmitRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const agentId = body.agentId;
  if (typeof agentId !== 'string' || !agentId.trim()) {
    return { ok: false, error: 'agentId must be a non-empty string' };
  }
  const repo = body.repo;
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { ok: false, error: 'repo must be "owner/name"' };
  }
  const label = body.label;
  if (typeof label !== 'string' || !label.trim()) {
    return { ok: false, error: 'label must be a non-empty string' };
  }
  const target = body.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return { ok: false, error: 'target must be an object' };
  }
  if (!TARGET_KINDS.includes(target.kind)) {
    return { ok: false, error: `target.kind must be one of ${TARGET_KINDS.join('|')}` };
  }
  const number = target.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    return { ok: false, error: 'target.number must be a positive integer' };
  }
  return {
    ok: true,
    value: {
      agentId: agentId.trim(),
      repo,
      label: label.trim(),
      target: { kind: target.kind, number },
    },
  };
}

// Resolve which triggers an emit wakes. `agents` is
// [{agentId, enabled, triggers}]; the gates mirror the poller's exactly
// (disabled agent, disabled trigger, repo, event key, labelFilter — where an
// absent labelFilter matches any label, the poller's legacy semantics) PLUS
// the one gate the poller inverts: only `transport: 'internal'` listeners are
// ours. Returns [{agentId, triggerId}] in agent order.
function matchInternalListeners({ repo, label, kind }, agents) {
  const key = eventKeyForKind(kind);
  const out = [];
  for (const a of agents) {
    if (!a || a.enabled === false || !Array.isArray(a.triggers)) continue;
    for (const t of a.triggers) {
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      if (t.transport !== 'internal') continue;
      if (t.repo !== repo) continue;
      if (!Array.isArray(t.events) || !listensTo(t.events, key)) continue;
      const filter = typeof t.labelFilter === 'string' && t.labelFilter.trim();
      if (filter && filter !== label) continue;
      out.push({ agentId: a.agentId, triggerId: t.id });
    }
  }
  return out;
}

// Synthesize a ghEvent in the Events-API shape the fan-out already writes, so
// the consumer's prompt context and the claim-swap runner (`_claim_plan` in
// agent-entrypoint.py — reads `github.repo` + `payload.issue.number` /
// `payload.pull_request.number`) work byte-compatibly. `actor` carries the
// producing agent, attributed — an internal emit is an explicit act, never
// anonymous.
function buildSyntheticEvent({ repo, label, kind, number, title, closesIssues, producerId, eventId, now }) {
  const subject = {
    number,
    html_url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    // #1897: carry the resolved title (best-effort, fetched by the caller) so
    // the consumer's trigger notice shows `[#N](url): <title>`, not just `#N`.
    // Absent when the fetch failed/timed out — the notice degrades to `#N`.
    ...(typeof title === 'string' && title ? { title } : {}),
    // #2114: for a PR, carry the issue(s) it closes (strict parseCloses, from the
    // caller's single PR-detail fetch) so admission control's `entryTicketRef`
    // keys this hand-off to the issue's ticket rather than treating the PR as a
    // brand-new one — which, over `transport: internal`, is what would otherwise
    // deadlock a `wipLimit: 1` flow forever.
    ...(kind === 'pr' && Array.isArray(closesIssues) && closesIssues.length ? { closesIssues } : {}),
  };
  return {
    id: eventId,
    actor: { login: `agent:${producerId}` },
    repo: { name: repo },
    created_at: now,
    payload: {
      action: 'labeled',
      label: { name: label },
      ...(kind === 'pr' ? { pull_request: subject } : { issue: subject }),
    },
  };
}

// The pending-queue entry for one listener — the same `{triggerId, github}`
// shape the poller's `_enqueue` writes (the drain doesn't branch on origin),
// plus `source: 'internal'` so log readers and operators can tell the
// delivery path apart. #2151: also stamps `wakeLabel` from the synthesized
// event's own label — an internal hand-off's matched listener filter and its
// synthetic `payload.label.name` always agree (matchInternalListeners /
// matchPollerListeners only forward a listener whose filter is absent or
// equals the applied label), so reading it off the event needs no extra
// parameter and stays byte-identical to what callers already log as
// `wakeLabel` for the event-log outcome.
function buildPendingEntry(triggerId, key, ghEvent) {
  return {
    triggerId,
    source: 'internal',
    wakeLabel: ghEvent.payload?.label?.name ?? null,
    github: {
      event: key,
      eventId: ghEvent.id,
      repo: ghEvent.repo?.name,
      actor: ghEvent.actor?.login,
      createdAt: ghEvent.created_at,
      payload: ghEvent.payload,
    },
  };
}

module.exports = {
  TARGET_KINDS,
  eventKeyForKind,
  validateEmitRequest,
  matchInternalListeners,
  buildSyntheticEvent,
  buildPendingEntry,
};
