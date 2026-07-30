// Pure adapters for the flow-anomaly sweep (#959).
//
// The orchestrator endpoint does the actual I/O (resolve repo+token, GET open
// issues/PRs, GET the issue timeline for label-application times, read each
// member's session state). The bug-prone part is turning GitHub's JSON and the
// session JSONL into the detector's input contract — so that translation lives
// here, pure and fs-free, and is unit-tested. `flow-anomaly-detector.js` then
// classifies. Keeping the two apart mirrors the repo's "pure core + injected
// I/O" convention (e.g. `matrix-login-retry.js`, `prompt-assembly.js`).

'use strict';

const { DEFAULT_THRESHOLDS } = require('./flow-anomaly-detector');

// A GitHub issues-list item is a PR iff it carries a `pull_request` sub-object.
// Works for both the issues API item and a raw webhook/event payload.
function objectKind(apiItem) {
  return apiItem && apiItem.pull_request ? 'pr' : 'issue';
}

// Extract `{ kind, number }` from a raw github EVENT payload (the `payload`
// block the poller delivers on a `trigger.fired` row): a PR event carries
// `payload.pull_request`, an issue event `payload.issue`; an issue_comment on a
// PR carries `payload.issue.pull_request`.
function eventObjectRef(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const pr = p.pull_request && typeof p.pull_request === 'object' ? p.pull_request : null;
  const issue = p.issue && typeof p.issue === 'object' ? p.issue : null;
  if (pr && pr.number != null) return { kind: 'pr', number: Number(pr.number) };
  if (issue && issue.pull_request && issue.number != null) return { kind: 'pr', number: Number(issue.number) };
  if (issue && issue.number != null) return { kind: 'issue', number: Number(issue.number) };
  return null;
}

// The application time of a label currently present on an object, from its
// timeline (`GET /repos/:o/:r/issues/:n/timeline`). The timeline lists `labeled`
// / `unlabeled` events oldest→newest; the authoritative "since" is the most
// recent `labeled` event for that name that was not later removed. Returns an
// ISO string, or null when the timeline doesn't cover it (caller falls back to
// the object's updated/created time).
function labelAppliedAt(timeline, labelName) {
  let appliedAt = null;
  for (const ev of Array.isArray(timeline) ? timeline : []) {
    if (!ev || !ev.label || ev.label.name !== labelName) continue;
    if (ev.event === 'labeled') appliedAt = ev.created_at || appliedAt;
    else if (ev.event === 'unlabeled') appliedAt = null; // removed since — reset
  }
  return appliedAt;
}

// Turn a GitHub issues-API item + its fetched extras into a detector object.
// `timeline` gives per-label application times (optional); `linkedPrNumbers`
// are PRs that reference this issue (used to suppress false positives — a wake
// with an existing PR was consumed, a claim with a PR shows activity).
function issueToDetectorObject(apiItem, extras = {}) {
  const it = apiItem || {};
  const timeline = extras.timeline || null;
  const labels = (Array.isArray(it.labels) ? it.labels : []).map((l) => {
    const name = typeof l === 'string' ? l : (l && l.name) || '';
    return { name, appliedAt: name && timeline ? labelAppliedAt(timeline, name) : null };
  });
  const merged = it.pull_request && it.pull_request.merged_at ? true : !!it.merged;
  return {
    kind: objectKind(it),
    number: Number(it.number),
    url: it.html_url || null,
    title: it.title || null,
    state: it.state === 'closed' ? 'closed' : 'open',
    merged,
    createdAt: it.created_at || null,
    updatedAt: it.updated_at || null,
    labels,
    linkedPrNumbers: Array.isArray(extras.linkedPrNumbers) ? extras.linkedPrNumbers : [],
    // Real branch/commit activity beyond a linked PR isn't fetched in this
    // observe-only version; null means "unknown" and the detector relies on
    // linkedPrNumbers. Documented so a later phase can populate it.
    lastActivityAt: extras.lastActivityAt || null,
  };
}

// Which open PRs reference a given issue number — by a `#<n>` mention in the
// title/body, or an issue-number token in the head branch (`issue-42`,
// `feat/42-...`). Pure and deliberately loose: a false link only SUPPRESSES an
// anomaly (fail-safe toward fewer nudges).
function prsForIssue(openPrs, issueNumber) {
  const n = Number(issueNumber);
  const out = [];
  const numRe = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`);
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    if (!pr) continue;
    const hay = `${pr.title || ''}\n${pr.body || ''}`;
    const branch = (pr.head && pr.head.ref) || '';
    const hashRe = new RegExp(`#${n}([^0-9]|$)`);
    if (hashRe.test(hay) || numRe.test(branch)) out.push(Number(pr.number));
  }
  return out;
}

// Group a member's session-log rows into runs tied to a GitHub object. A run is
// keyed by `correlationId`; its object comes from the `trigger.fired` row's
// `github.payload`. `activeCorrelationIds` (from the live running-sessions
// registry) marks a run still in flight. A run with no resolvable object is
// dropped (DM/cron runs aren't flow objects).
function runsFromSessionEvents(events, activeCorrelationIds = new Set()) {
  const byCorr = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const corr = ev.correlationId;
    if (!corr) continue;
    if (ev.type === 'trigger.fired' && ev.github && ev.github.payload) {
      const ref = eventObjectRef(ev.github.payload);
      if (ref) {
        const prev = byCorr.get(corr) || {};
        byCorr.set(corr, { ...prev, correlationId: corr, kind: ref.kind, number: ref.number, ranAt: prev.ranAt || ev.ts || null });
      }
    } else if (ev.type === 'claude.invoke') {
      const prev = byCorr.get(corr) || { correlationId: corr };
      if (!prev.ranAt) prev.ranAt = ev.ts || null;
      byCorr.set(corr, prev);
    } else if (ev.type === 'message.posted' || ev.type === 'error') {
      const prev = byCorr.get(corr) || { correlationId: corr };
      prev.finishedAt = ev.ts || prev.finishedAt || null;
      byCorr.set(corr, prev);
    }
  }
  const runs = [];
  for (const r of byCorr.values()) {
    if (r.kind == null || r.number == null) continue; // no flow object — skip
    runs.push({
      kind: r.kind,
      number: r.number,
      ranAt: r.ranAt || null,
      finishedAt: r.finishedAt || null,
      active: activeCorrelationIds.has(r.correlationId),
    });
  }
  return runs;
}

// Merge a per-team threshold override document over the defaults. Values are ms;
// a non-positive / non-finite override is ignored (fail-safe to the default).
function resolveThresholds(override) {
  const out = { ...DEFAULT_THRESHOLDS };
  if (override && typeof override === 'object') {
    for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
      const v = override[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  return out;
}

module.exports = {
  objectKind,
  eventObjectRef,
  labelAppliedAt,
  issueToDetectorObject,
  prsForIssue,
  runsFromSessionEvents,
  resolveThresholds,
};
