'use strict';

// Internal fast-path for human-applied GitHub labels (#1858).
//
// The GitHub Events API — the only source the poller reads (no public ingress
// → polling, not webhooks) — is best-effort and drops/coalesces events under
// rapid label add/remove/add churn, so a human-applied flow label (`ready`,
// `req:refine`, …) frequently never wakes the target agent. When the label is
// applied through the GitHub Issues plugin (the dominant path — the #1730
// workflow-trigger buttons and manual labeling both go through the broker's
// `writeLabel(name, 'add')`), the Admin Console immediately tells the
// orchestrator, which wakes the poller-subscribed listener directly instead of
// waiting on the Events API. The label is still set externally on GitHub
// unchanged; the poller keeps its subscription as the fallback for labels set
// elsewhere (GitHub web UI, CI) and DEDUPS against a marker so it doesn't wake
// the same agent twice.
//
// This is the sibling of flow-emit.js (agent→agent internal hand-offs). The
// delivery side is largely the same (synthesize a poller-shaped event →
// enqueue); only the MATCHING side differs: flow-emit matches
// `transport: 'internal'` listeners, this matches the ordinary
// **poller-subscribed** `transport: 'github'` listeners — no trigger config
// change (AC5). Reuses flow-emit's `eventKeyForKind` so the two paths speak the
// same event vocabulary.
//
// fs-free so the delivery contract is unit-testable (`node --test`): request
// validation, listener matching, and the synthesized event shape. All I/O
// (queue write, marker store, event log) stays in orchestrator.js.

const { eventKeyForKind, TARGET_KINDS } = require('./flow-emit');

// Validate the request body into `{ok: true, value}` or `{ok: false, error}`.
// Shape: { repo: "owner/name", number, kind?: issue|pr (default issue), label,
// actor? }. `kind` defaults to `issue` because the GitHub Issues plugin — the
// only caller today — lists issues; a caller may still pass `pr` explicitly.
function validateLabelAppliedRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const repo = body.repo;
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { ok: false, error: 'repo must be "owner/name"' };
  }
  const kind = body.kind == null ? 'issue' : body.kind;
  if (!TARGET_KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of ${TARGET_KINDS.join('|')}` };
  }
  const number = body.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    return { ok: false, error: 'number must be a positive integer' };
  }
  const label = body.label;
  if (typeof label !== 'string' || !label.trim()) {
    return { ok: false, error: 'label must be a non-empty string' };
  }
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : null;
  return { ok: true, value: { repo, number, kind, label: label.trim(), actor } };
}

// Resolve which poller-subscribed triggers a label-apply wakes. `agents` is
// [{agentId, enabled, triggers}]. The gates mirror the poller's plan builder
// EXACTLY (`pollerSubscribes`: type/enabled/transport≠internal/repo/events) plus
// the label-name filter (absent/blank labelFilter = any label, the poller's
// legacy semantics). This is the same predicate `_fanOutBatch` uses — never
// `matchInternalListeners`, which is `transport: 'internal'` only. The target
// trigger stays `transport: 'github'`. Returns [{agentId, triggerId}] in agent
// order.
function matchPollerListeners({ repo, label, kind }, agents) {
  const key = eventKeyForKind(kind);
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.enabled === false || !Array.isArray(a.triggers)) continue;
    for (const t of a.triggers) {
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      if (t.transport === 'internal') continue; // poller-subscribed listeners only
      if (t.repo !== repo) continue;
      if (!Array.isArray(t.events) || !t.events.includes(key)) continue;
      const filter = typeof t.labelFilter === 'string' && t.labelFilter.trim();
      if (filter && filter !== label) continue;
      out.push({ agentId: a.agentId, triggerId: t.id });
    }
  }
  return out;
}

// Synthesize a ghEvent in the Events-API shape the poller fan-out already
// writes, so the consumer's prompt context and the claim-swap runner
// (`_claim_plan` in agent-entrypoint.py — reads `github.repo` +
// `payload.issue.number` / `payload.pull_request.number`) work byte-compatibly.
// `actor` carries the human who applied the label (via the plugin) — plainly,
// not the `agent:` prefix flow-emit uses for an agent producer.
function buildSyntheticEvent({ repo, label, kind, number, title, actor, eventId, now }) {
  const subject = {
    number,
    html_url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    // #1897: carry the resolved title (best-effort, fetched by the caller) so
    // the consumer's trigger notice shows `[#N](url): <title>`, not just `#N`.
    // Absent when the fetch failed/timed out — the notice degrades to `#N`.
    ...(typeof title === 'string' && title ? { title } : {}),
  };
  return {
    id: eventId,
    actor: { login: actor || 'console' },
    repo: { name: repo },
    created_at: now,
    payload: {
      action: 'labeled',
      label: { name: label },
      ...(kind === 'pr' ? { pull_request: subject } : { issue: subject }),
    },
  };
}

module.exports = {
  TARGET_KINDS,
  eventKeyForKind,
  validateLabelAppliedRequest,
  matchPollerListeners,
  buildSyntheticEvent,
};
