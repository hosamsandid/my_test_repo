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
// The delivery side synthesizes a poller-shaped event and enqueues it; the
// MATCHING side selects the ordinary **poller-subscribed** listeners — no
// trigger config change (AC5). (The agent→agent internal transport that used
// to share this vocabulary was removed in #2578: every labelled hand-off is
// now an ordinary poller-delivered github-event trigger.)
//
// fs-free so the delivery contract is unit-testable (`node --test`): request
// validation, listener matching, and the synthesized event shape. All I/O
// (queue write, marker store, event log) stays in orchestrator.js.

const { listensTo } = require('./event-key-aliases');
const handoffGate = require('./handoff-gate');
const { isDirectWakeListener } = require('./pool-wake-target');

const TARGET_KINDS = ['issue', 'pr'];

// The poller event key a target kind maps to. A label-apply is always a
// "labeled" action — that is the whole vocabulary of a label hand-off.
function eventKeyForKind(kind) {
  return kind === 'pr' ? 'pull_request.labeled' : 'issues.labeled';
}

// Validate the request body into `{ok: true, value}` or `{ok: false, error}`.
// Shape: { repo: "owner/name", number, kind?: issue|pr (default issue), label,
// actor? }. `kind` defaults to `issue`; the console proxy passes `pr` when the
// GitHub Issues plugin's broker reports it labelled a pull request (#2746).
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
// EXACTLY (`pollerSubscribes`: type/enabled/repo/events) plus the label-name
// filter (absent/blank labelFilter = any label, the poller's legacy
// semantics). This is the same predicate `_fanOutBatch` uses. A legacy
// `transport` field on a trigger is ignored (#2578). Returns
// [{agentId, triggerId}] in agent order; a PR listener whose trigger carries a
// readiness gate (#2795) also gets its normalized `readinessGate`, so the
// caller holds that wake instead of delivering it. A pool instance (its
// `config.poolInstance`) is never a listener (#2875) — the same rule the
// poller's plan applies, so both paths wake the same set.
function matchPollerListeners({ repo, label, kind }, agents) {
  const key = eventKeyForKind(kind);
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.enabled === false || !Array.isArray(a.triggers)) continue;
    if (!isDirectWakeListener(a.config)) continue;
    for (const t of a.triggers) {
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      if (t.repo !== repo) continue;
      if (!Array.isArray(t.events) || !listensTo(t.events, key)) continue;
      const filter = typeof t.labelFilter === 'string' && t.labelFilter.trim();
      if (filter && filter !== label) continue;
      const normalized = handoffGate.normalizeGate(t.readinessGate);
      const gate = handoffGate.gateApplies(normalized, key) ? normalized : null;
      out.push({ agentId: a.agentId, triggerId: t.id, ...(gate ? { readinessGate: gate } : {}) });
    }
  }
  return out;
}

// Synthesize a ghEvent in the Events-API shape the poller fan-out already
// writes, so the consumer's prompt context and the claim-swap runner
// (`_claim_plan` in agent-entrypoint.py — reads `github.repo` +
// `payload.issue.number` / `payload.pull_request.number`) work byte-compatibly.
// `actor` carries the human who applied the label (via the plugin) — plainly,
// never an `agent:`-prefixed producer id.
function buildSyntheticEvent({ repo, label, kind, number, title, closesIssues, actor, eventId, now }) {
  const subject = {
    number,
    html_url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    // #1897: carry the resolved title (best-effort, fetched by the caller) so
    // the consumer's trigger notice shows `[#N](url): <title>`, not just `#N`.
    // Absent when the fetch failed/timed out — the notice degrades to `#N`.
    ...(typeof title === 'string' && title ? { title } : {}),
    // #2114: for a PR, carry the issue(s) it closes (strict parseCloses, from the
    // caller's single PR-detail fetch) so admission control's `entryTicketRef`
    // keys a human-applied wake label to the issue's ticket rather than the PR
    // as a new one — which would otherwise deadlock a `wipLimit: 1` flow.
    ...(kind === 'pr' && Array.isArray(closesIssues) && closesIssues.length ? { closesIssues } : {}),
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

// The pending-queue entry for one listener — the same `{triggerId, github}`
// shape the poller's `_enqueue` writes (the drain doesn't branch on origin),
// plus `source: 'internal'` so log readers and operators can tell the
// delivery path apart (callers may override `source`, e.g. the Flow
// Supervisor). #2151: also stamps `wakeLabel` from the synthesized event's
// own label — the matched listener filter and the synthetic
// `payload.label.name` always agree (`matchPollerListeners` only forwards a
// listener whose filter is absent or equals the applied label), so reading it
// off the event needs no extra parameter and stays byte-identical to what
// callers already log as `wakeLabel` for the event-log outcome.
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
  validateLabelAppliedRequest,
  matchPollerListeners,
  buildSyntheticEvent,
  buildPendingEntry,
};
