// Pure adapters for the ticket-reconcile sweep (#2115, concept §4.1).
//
// `flow-anomaly-sweep.js` deliberately drops the expensive half of the PR truth:
// it never asks whether a PR merges, whether its checks are green, whether a
// reviewer approved it, or what it actually changes. That omission is exactly
// why the 2026-09-08 stall was invisible — four PRs sat `CONFLICTING` and the
// detector had no field in which to notice.
//
// This module is the translation layer for the truth the ledger DOES need:
// GitHub's JSON (REST) → the `ticket-reconciler.js` input contract. Same split
// as the anomaly pair: the orchestrator endpoint performs the I/O, the shaping
// lives here (pure, fs-free, unit-tested), the classification lives in the
// reconciler. Nothing here calls the network or the filesystem.

'use strict';

const { objectKind, labelAppliedAt, prsForIssue } = require('./flow-anomaly-sweep');
const { DEFAULT_TICKET_THRESHOLDS } = require('./ticket-reconciler');

// GitHub's `mergeable_state` vocabulary (REST) mapped onto the GraphQL-style
// `mergeStateStatus` the concept's table is written against, so the reconciler
// speaks ONE vocabulary regardless of which API fetched the data.
const MERGE_STATE_MAP = Object.freeze({
  dirty: 'DIRTY',
  blocked: 'BLOCKED',
  behind: 'BEHIND',
  clean: 'CLEAN',
  unstable: 'UNSTABLE',
  draft: 'DRAFT',
  has_hooks: 'CLEAN',
  unknown: 'UNKNOWN',
});

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Issue numbers a PR CLOSES, from the GitHub closing keywords in its title and
 * body. This is the STRICT direction of the linkage, and it is what ticket
 * attribution uses: a false positive here would merge two separate tickets into
 * one ledger row, so only the keyword forms GitHub itself honours count.
 * (`prsForIssue` is the loose direction and is used only as a fallback.)
 */
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)/gi;

function issuesClosedByPr(pr) {
  const hay = `${str(pr && pr.title)}\n${str(pr && pr.body)}`;
  const out = [];
  const seen = new Set();
  for (const m of hay.matchAll(CLOSES_RE)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Collapse a commit's check runs + commit statuses into one rollup.
 *
 * `failure` is asserted only on a CONCLUDED negative conclusion — a check that
 * is queued, in progress, skipped or neutral is not a failure, and calling a
 * still-running suite red would flood the ledger with `ci-red` on every fresh
 * push. `none` (nothing configured) is distinct from `success` on purpose: the
 * `approved-not-merged` rule must not read "no CI at all" as "CI is green".
 */
function checkRollup(checkRuns = [], statuses = []) {
  const failed = [];
  let anyPending = false;
  let anySuccess = false;
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    if (!run) continue;
    const status = str(run.status).toLowerCase();
    const conclusion = str(run.conclusion).toLowerCase();
    if (status !== 'completed') { anyPending = true; continue; }
    if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(conclusion)) {
      failed.push(str(run.name) || 'check');
    } else if (conclusion === 'success') {
      anySuccess = true;
    }
    // `neutral` / `skipped` / `stale` are neither — deliberately ignored.
  }
  for (const st of Array.isArray(statuses) ? statuses : []) {
    if (!st) continue;
    const state = str(st.state).toLowerCase();
    if (state === 'failure' || state === 'error') failed.push(str(st.context) || 'status');
    else if (state === 'pending') anyPending = true;
    else if (state === 'success') anySuccess = true;
  }
  let state = 'none';
  if (failed.length) state = 'failure';
  else if (anyPending) state = 'pending';
  else if (anySuccess) state = 'success';
  return { state, failed: [...new Set(failed)] };
}

/**
 * The effective review decision from the raw review list, GitHub's own rule:
 * only each reviewer's LATEST non-COMMENTED review counts, and a single
 * outstanding CHANGES_REQUESTED outranks any number of approvals. Returns
 * `{ decision, approvedAt }` — the timestamp is when the decision became
 * APPROVED, which is what `approved-not-merged` measures its age from.
 */
function reviewDecision(reviews = []) {
  const latest = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (!r) continue;
    const state = str(r.state).toUpperCase();
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    const who = str(r.user && r.user.login) || str(r.userLogin);
    if (!who) continue;
    const at = Date.parse(r.submitted_at || r.submittedAt || '');
    const prev = latest.get(who);
    if (!prev || !Number.isFinite(prev.at) || (Number.isFinite(at) && at >= prev.at)) {
      latest.set(who, { state, at });
    }
  }
  const effective = [...latest.values()].filter((v) => v.state !== 'DISMISSED');
  if (effective.some((v) => v.state === 'CHANGES_REQUESTED')) {
    return { decision: 'CHANGES_REQUESTED', approvedAt: null, reviewCount: latest.size };
  }
  const approvals = effective.filter((v) => v.state === 'APPROVED');
  if (approvals.length) {
    const at = approvals.map((a) => a.at).filter(Number.isFinite);
    return {
      decision: 'APPROVED',
      approvedAt: at.length ? new Date(Math.min(...at)).toISOString() : null,
      reviewCount: latest.size,
    };
  }
  return { decision: null, approvedAt: null, reviewCount: latest.size };
}

/**
 * Files a PR ADDS (`status: 'added'`). Only added files can prove the
 * `superseded` case: a modified file trivially "already exists in main", so
 * counting it would accuse every PR of being a duplicate.
 */
function addedFilesOf(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && str(f.status) === 'added' && str(f.filename))
    .map((f) => str(f.filename));
}

/**
 * The base branch's file path index from `GET /git/trees/:sha?recursive=1`.
 *
 * `complete` is the load-bearing field: GitHub truncates a large recursive tree
 * and then a path's absence means "not listed", not "not present". The
 * reconciler refuses to raise `superseded` on an incomplete index, so a
 * truncated response degrades to no finding rather than to a false accusation.
 */
function baseFileIndex(tree) {
  const t = tree && typeof tree === 'object' ? tree : {};
  const paths = new Set();
  for (const node of Array.isArray(t.tree) ? t.tree : []) {
    if (node && node.type === 'blob' && str(node.path)) paths.add(str(node.path));
  }
  return { paths, complete: !t.truncated };
}

/**
 * Shape one GitHub issue item (+ fetched extras) into a ledger issue.
 */
function issueToTicketObject(apiItem, extras = {}) {
  const it = apiItem || {};
  const timeline = extras.timeline || null;
  const labels = (Array.isArray(it.labels) ? it.labels : []).map((l) => {
    const name = typeof l === 'string' ? l : (l && l.name) || '';
    return { name, appliedAt: name && timeline ? labelAppliedAt(timeline, name) : null };
  });
  return {
    kind: objectKind(it),
    repo: str(extras.repo) || null,
    number: Number(it.number),
    url: it.html_url || null,
    title: it.title || null,
    body: it.body || '',
    state: it.state === 'closed' ? 'closed' : 'open',
    createdAt: it.created_at || null,
    updatedAt: it.updated_at || null,
    // GitHub's native sub-issue parent when the sweep could read it; the
    // reconciler falls back to parsing the body when this is null.
    parentIssueNumber: extras.parentIssueNumber != null ? Number(extras.parentIssueNumber) : null,
    labels,
    linkedPrNumbers: Array.isArray(extras.linkedPrNumbers) ? extras.linkedPrNumbers : [],
  };
}

/**
 * Shape one GitHub PR (the DETAIL form — `GET /pulls/:n`, which is the only one
 * carrying `mergeable`/`mergeable_state`) plus its fetched extras into a ledger
 * PR.
 *
 * `mergeable` is deliberately three-valued. GitHub computes mergeability
 * asynchronously and answers `null` until the background job finishes; mapping
 * that to "not conflicting" would silently clear a real conflict, and mapping it
 * to "conflicting" would invent one. `UNKNOWN` makes both rules decline.
 */
function prToTicketObject(apiPr, extras = {}) {
  const pr = apiPr || {};
  const timeline = extras.timeline || null;
  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((l) => {
    const name = typeof l === 'string' ? l : (l && l.name) || '';
    return { name, appliedAt: name && timeline ? labelAppliedAt(timeline, name) : null };
  });
  const rollup = extras.checks || checkRollup(extras.checkRuns, extras.statuses);
  const review = extras.review || reviewDecision(extras.reviews);
  const added = Array.isArray(extras.addedFiles) ? extras.addedFiles : addedFilesOf(extras.files);
  const index = extras.baseFileIndex || null;
  const merged = !!(pr.merged || pr.merged_at);

  let mergeable = 'UNKNOWN';
  if (pr.mergeable === true) mergeable = 'MERGEABLE';
  else if (pr.mergeable === false) mergeable = 'CONFLICTING';
  const mergeStateStatus = MERGE_STATE_MAP[str(pr.mergeable_state).toLowerCase()] || 'UNKNOWN';

  return {
    kind: 'pr',
    repo: str(extras.repo) || null,
    number: Number(pr.number),
    url: pr.html_url || null,
    title: pr.title || null,
    body: pr.body || '',
    state: pr.state === 'closed' ? 'closed' : 'open',
    merged,
    draft: !!pr.draft,
    createdAt: pr.created_at || null,
    updatedAt: pr.updated_at || null,
    headSha: (pr.head && pr.head.sha) || null,
    baseRef: (pr.base && pr.base.ref) || null,
    baseSha: (pr.base && pr.base.sha) || null,
    mergeable,
    mergeStateStatus,
    checks: rollup.state,
    failedChecks: rollup.failed,
    reviewDecision: review.decision,
    approvedAt: review.approvedAt,
    reviewCount: review.reviewCount || 0,
    // How far the base branch has moved since this PR branched — the second
    // half of the `stale-base` discrimination. null means "not measured".
    baseAheadBy: typeof extras.baseAheadBy === 'number' ? extras.baseAheadBy : null,
    addedFiles: added,
    addedFilesInBase: index ? added.filter((f) => index.paths.has(f)) : [],
    baseFileIndexComplete: index ? !!index.complete : false,
    labels,
    closesIssues: Array.isArray(extras.closesIssues) ? extras.closesIssues : issuesClosedByPr(pr),
    linkedPrNumbers: [],
  };
}

/**
 * Attach the loose issue→PR linkage to every issue in one pass, mirroring what
 * `computeTeamFlowAnomalies` does inline. Kept here so the endpoint stays a
 * sequence of fetches and the linkage stays unit-tested.
 *
 * `rawPrs` must be the RAW GitHub PR list items, not shaped ledger PRs:
 * `prsForIssue` also matches on the head branch name (`feat/2115-…`), and the
 * ledger shape does not carry `head.ref`. Passing shaped objects still works but
 * silently loses the branch-name half of the loose link.
 */
function linkIssuesToPrs(issues, rawPrs) {
  return (Array.isArray(issues) ? issues : []).map((it) => ({
    ...it,
    linkedPrNumbers: prsForIssue(rawPrs, it.number),
  }));
}

// Merge a per-team ledger-threshold override over the defaults (ms; a
// non-positive or non-finite override is ignored — fail-safe to the default).
function resolveTicketThresholds(override) {
  const out = { ...DEFAULT_TICKET_THRESHOLDS };
  if (override && typeof override === 'object') {
    for (const k of Object.keys(DEFAULT_TICKET_THRESHOLDS)) {
      const v = override[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  return out;
}

module.exports = {
  MERGE_STATE_MAP,
  issuesClosedByPr,
  checkRollup,
  reviewDecision,
  addedFilesOf,
  baseFileIndex,
  issueToTicketObject,
  prToTicketObject,
  linkIssuesToPrs,
  resolveTicketThresholds,
};
