'use strict';

// ============================================================
// PR readiness evaluation (#2794)
// ------------------------------------------------------------
// The GitHub Events API never emits `check_suite`/`check_run`/`workflow_run`/
// `status` events and has no event for mergeability changes (#2287), so a
// `github-event` trigger on "CI finished" or "merge conflict" could never fire.
// The poller therefore READS the state of open pull requests itself and turns
// each verdict change into a synthetic event:
//
//   pull_request.checks_passed   CI verdict `passed`
//   pull_request.checks_failed   CI verdict `failed`
//   pull_request.merge_conflict  merge verdict `conflict`
//
// emitted once per (PR, head commit, verdict). This module is the pure core —
// verdict rules, the per-repo state machine, the GraphQL queries and their
// parsers. The poller (`github-poller.js` `_pollReadiness`) does the I/O and
// hands the synthetic events to its normal fan-out, so they pass the same
// gates and land in the GitHub Event Log like any polled event.
//
// API cost per poll cycle, per repository that has a subscriber to one of the
// keys above (repositories without one are never evaluated):
//   - 1 GraphQL call: the open PRs (head commit + `mergeable`), always;
//   - +1 GraphQL call: the checks of every head commit whose CI verdict is
//     still open (`pending`, or `failed` — a re-run can still turn it green),
//     only when there is at least one such commit.
// A head commit whose CI verdict is `passed` or `none` is no longer read.
// GitHub-only: GitLab repositories are never polled.
// ============================================================

const READINESS_EVENT_KEYS = Object.freeze([
  'pull_request.checks_passed',
  'pull_request.checks_failed',
  'pull_request.merge_conflict',
]);

// The event a verdict emits (verdicts not listed here emit nothing).
const CI_EVENT = { passed: 'pull_request.checks_passed', failed: 'pull_request.checks_failed' };
const MERGE_EVENT = { conflict: 'pull_request.merge_conflict' };

// How long a head commit may have no check at all before its CI verdict is
// `none` (the repo or PR has no CI). Measured from when the poller first saw
// the commit as the PR's head. Overridable via AEE_PR_READINESS_CI_GRACE_MS.
const DEFAULT_CI_GRACE_MS = 3 * 60_000;

function ciGraceMs(env = process.env) {
  const raw = env.AEE_PR_READINESS_CI_GRACE_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_CI_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CI_GRACE_MS;
}

// Upper bound on open PRs read per repository per cycle (one GraphQL page).
const MAX_OPEN_PRS = 100;
// Upper bound on labels read per open PR (#2795, the hand-off gate's cancel check).
const MAX_LABELS = 50;
// Upper bound on checks read per head commit (one GraphQL page).
const MAX_CHECKS = 100;

const CHECK_RUN_PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_RUN_FAIL = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const STATUS_PASS = new Set(['SUCCESS']);
const STATUS_FAIL = new Set(['FAILURE', 'ERROR']);

const OPEN_PRS_QUERY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){'
  + `pullRequests(states:OPEN,first:${MAX_OPEN_PRS},orderBy:{field:UPDATED_AT,direction:DESC}){`
  + 'pageInfo{hasNextPage} nodes{number title url headRefName headRefOid baseRefName mergeable isCrossRepository '
  // #2795: the current labels, so a held hand-off sees its wake label removed.
  + `labels(first:${MAX_LABELS}){nodes{name}}}}}}`;

const SHA_RE = /^[0-9a-f]{40}$/i;

// One check run or commit status → 'pass' | 'fail' | 'pending'. Every check
// counts, required or not (CodeQL included). Anything not yet completed, or
// completed without a conclusion we recognise, is `pending` — never guessed.
function classifyCheck(node) {
  if (!node || typeof node !== 'object') return 'pending';
  if (node.__typename === 'StatusContext' || ('state' in node && !('status' in node))) {
    const state = String(node.state || '').toUpperCase();
    if (STATUS_PASS.has(state)) return 'pass';
    if (STATUS_FAIL.has(state)) return 'fail';
    return 'pending';
  }
  if (String(node.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  const conclusion = String(node.conclusion || '').toUpperCase();
  if (CHECK_RUN_PASS.has(conclusion)) return 'pass';
  if (CHECK_RUN_FAIL.has(conclusion)) return 'fail';
  return 'pending';
}

function checkName(node) {
  return String((node && (node.name || node.context)) || 'unnamed check');
}

// The CI verdict of one head commit.
//   checks     — the commit's check runs + commit statuses (GraphQL nodes)
//   truncated  — more checks exist than were read
//   headSeenAt — ms epoch the commit was first seen as the PR's head
// Returns { verdict: 'pending'|'passed'|'failed'|'none', failingChecks }.
function ciVerdict({ checks, truncated = false, headSeenAt, now = Date.now(), graceMs = DEFAULT_CI_GRACE_MS } = {}) {
  const list = Array.isArray(checks) ? checks.filter(Boolean) : [];
  const failingChecks = [];
  let pending = false;
  for (const node of list) {
    const c = classifyCheck(node);
    if (c === 'fail') failingChecks.push(checkName(node));
    else if (c === 'pending') pending = true;
  }
  // A failing check settles the verdict even while others still run.
  if (failingChecks.length) return { verdict: 'failed', failingChecks: [...new Set(failingChecks)].sort() };
  if (list.length === 0 && !truncated) {
    const seen = Number(headSeenAt);
    const elapsed = Number.isFinite(seen) ? now - seen : 0;
    return { verdict: elapsed >= graceMs ? 'none' : 'pending', failingChecks: [] };
  }
  if (pending || truncated) return { verdict: 'pending', failingChecks: [] };
  return { verdict: 'passed', failingChecks: [] };
}

// GitHub's `mergeable` → the merge verdict. UNKNOWN (still computing) and
// anything unexpected stay `pending` and are re-read next cycle.
function mergeVerdict(mergeable) {
  const m = String(mergeable || '').toUpperCase();
  if (m === 'MERGEABLE') return 'clean';
  if (m === 'CONFLICTING') return 'conflict';
  return 'pending';
}

// CI verdicts that end the reading of a head commit's checks. `failed` is not
// one of them: a re-run on the same commit can still turn it `passed`.
function ciSettled(verdict) {
  return verdict === 'passed' || verdict === 'none';
}

// GraphQL `data` of OPEN_PRS_QUERY → { prs, truncated }. Nodes without a
// number or a well-formed head SHA are skipped.
function parseOpenPrs(data) {
  const conn = data && data.repository && data.repository.pullRequests;
  const nodes = conn && Array.isArray(conn.nodes) ? conn.nodes : [];
  const prs = [];
  for (const n of nodes) {
    if (!n || !Number.isInteger(n.number) || typeof n.headRefOid !== 'string' || !SHA_RE.test(n.headRefOid)) continue;
    prs.push({
      number: n.number,
      sha: n.headRefOid.toLowerCase(),
      title: typeof n.title === 'string' ? n.title : null,
      url: typeof n.url === 'string' ? n.url : null,
      headRef: typeof n.headRefName === 'string' ? n.headRefName : null,
      baseRef: typeof n.baseRefName === 'string' ? n.baseRefName : null,
      mergeable: typeof n.mergeable === 'string' ? n.mergeable : null,
      fromFork: n.isCrossRepository === true,
      // #2795: label names, only when the query returned them (absent ≠ none).
      ...(n.labels && Array.isArray(n.labels.nodes)
        ? { labels: n.labels.nodes.map((l) => l && l.name).filter((x) => typeof x === 'string') }
        : {}),
    });
  }
  return { prs, truncated: !!(conn && conn.pageInfo && conn.pageInfo.hasNextPage) };
}

// The GraphQL query reading the checks of the given head commits, one alias
// per commit (`c0`, `c1`, …), plus its variables. Commits are addressed by SHA,
// so a result can never describe a different commit than the one asked for.
function buildChecksQuery(owner, name, shas) {
  const list = (Array.isArray(shas) ? shas : []).filter((s) => typeof s === 'string' && SHA_RE.test(s));
  const variables = { owner, name };
  const decls = ['$owner:String!', '$name:String!'];
  const fields = [];
  list.forEach((sha, i) => {
    decls.push(`$o${i}:GitObjectID!`);
    variables[`o${i}`] = sha;
    fields.push(`c${i}:object(oid:$o${i}){...ReadinessChecks}`);
  });
  const query = `query(${decls.join(',')}){repository(owner:$owner,name:$name){${fields.join(' ')}}}`
    + ' fragment ReadinessChecks on Commit{oid statusCheckRollup{'
    + `contexts(first:${MAX_CHECKS}){pageInfo{hasNextPage} nodes{__typename `
    + '... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}';
  return { query, variables, shas: list };
}

// GraphQL `data` of buildChecksQuery → Map<sha, { checks, truncated }>. A
// commit GitHub returned nothing for is absent from the map (its verdict is
// left as it was — never guessed).
function parseChecks(data, shas) {
  const out = new Map();
  const repo = data && data.repository;
  if (!repo) return out;
  (Array.isArray(shas) ? shas : []).forEach((sha, i) => {
    const obj = repo[`c${i}`];
    if (!obj || typeof obj !== 'object') return;
    const contexts = obj.statusCheckRollup && obj.statusCheckRollup.contexts;
    out.set(sha.toLowerCase(), {
      checks: contexts && Array.isArray(contexts.nodes) ? contexts.nodes : [],
      truncated: !!(contexts && contexts.pageInfo && contexts.pageInfo.hasNextPage),
    });
  });
  return out;
}

// A repository with no stored readiness state (first evaluation, or the last
// subscriber left and the state was dropped) is baselined: verdicts already
// final on that pass are recorded as delivered without waking anyone, so
// subscribing to the keys does not replay the state of every open PR as if it
// had just happened. A stored state is never re-baselined because of a time
// gap: after an outage or a backoff, a tracked head whose verdict became final
// meanwhile emits normally (the events poller backfills the same way); the
// history horizon, throttle and burst digest guard against a flood.
function needsBaseline(state) {
  return !state || typeof state !== 'object' || !state.prs || typeof state.prs !== 'object';
}

// The head commits whose checks must be read this cycle: a head not tracked
// yet (new PR or new push) or one whose CI verdict is still open.
function shasToRead(state, prs) {
  const tracked = (state && state.prs) || {};
  const out = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const entry = tracked[pr.number];
    if (!entry || entry.sha !== pr.sha || !ciSettled(entry.ci)) out.push(pr.sha);
  }
  return [...new Set(out)];
}

// One evaluation step for a repository.
//   state     — the stored `{ lastEvaluatedAt, prs }` (null/undefined = none)
//   prs       — parseOpenPrs(...).prs
//   truncated — the open-PR list was cut off (PRs missing from it are kept,
//               not treated as closed)
//   checks    — parseChecks(...) result, or null when the checks could not be
//               read this cycle (CI verdicts then stay as they were)
// Returns { state, emits }. `emits` lists one entry per (PR, head, verdict)
// reached for the first time — never for a head that is no longer the PR's
// head, and nothing for a closed/merged PR (it is simply dropped). On a
// baseline pass (needsBaseline) verdicts are recorded but nothing is emitted.
function evaluateReadiness({ state, prs, truncated = false, checks = null, now = Date.now(), graceMs = DEFAULT_CI_GRACE_MS } = {}) {
  const baseline = needsBaseline(state);
  const prev = (state && state.prs) || {};
  const nextPrs = {};
  const emits = [];

  for (const pr of Array.isArray(prs) ? prs : []) {
    const old = prev[pr.number];
    // A new push (head changed) resets both verdicts for the new commit.
    const entry = old && old.sha === pr.sha
      ? { ...old, emitted: Array.isArray(old.emitted) ? old.emitted.slice() : [] }
      : { sha: pr.sha, headSeenAt: now, ci: 'pending', merge: 'pending', failingChecks: [], emitted: [] };

    const read = checks instanceof Map ? checks.get(pr.sha) : undefined;
    if (read && !ciSettled(entry.ci)) {
      const v = ciVerdict({ checks: read.checks, truncated: read.truncated, headSeenAt: entry.headSeenAt, now, graceMs });
      entry.ci = v.verdict;
      entry.failingChecks = v.failingChecks;
    }
    entry.merge = mergeVerdict(pr.mergeable);

    for (const key of [CI_EVENT[entry.ci], MERGE_EVENT[entry.merge]]) {
      if (!key || entry.emitted.includes(key)) continue;
      entry.emitted.push(key);
      if (baseline) continue;
      emits.push({
        key,
        pr,
        sha: pr.sha,
        verdict: key === MERGE_EVENT.conflict ? entry.merge : entry.ci,
        ci: entry.ci,
        merge: entry.merge,
        failingChecks: key === CI_EVENT.failed ? entry.failingChecks.slice() : [],
      });
    }
    nextPrs[pr.number] = entry;
  }

  // A PR missing from a complete list is closed or merged: forget it.
  if (truncated) {
    for (const [num, entry] of Object.entries(prev)) {
      if (!(num in nextPrs)) nextPrs[num] = entry;
    }
  }

  return { state: { lastEvaluatedAt: new Date(now).toISOString(), prs: nextPrs }, emits, baseline };
}

// A synthetic Events-API-shaped PullRequestEvent for one emit, so the poller's
// fan-out keys it (`pull_request.<action>`), routes it to the PR's conversation
// and logs it like a polled event. The id is unique per (PR, head, verdict).
function readinessEvent(repoFullName, emit, now = Date.now()) {
  const action = emit.key.slice('pull_request.'.length);
  const { pr } = emit;
  return {
    id: `readiness:${pr.number}:${emit.sha}:${action}`,
    type: 'PullRequestEvent',
    repo: { name: repoFullName },
    created_at: new Date(now).toISOString(),
    payload: {
      action,
      number: pr.number,
      pull_request: {
        number: pr.number,
        ...(pr.title ? { title: pr.title } : {}),
        ...(pr.url ? { html_url: pr.url } : {}),
        head: { ref: pr.headRef, sha: emit.sha },
        base: { ref: pr.baseRef },
      },
      readiness: {
        headSha: emit.sha,
        verdict: emit.verdict,
        ci: emit.ci,
        merge: emit.merge,
        failingChecks: emit.failingChecks,
        fromFork: !!pr.fromFork,
      },
    },
  };
}

module.exports = {
  READINESS_EVENT_KEYS,
  DEFAULT_CI_GRACE_MS,
  MAX_OPEN_PRS,
  MAX_CHECKS,
  OPEN_PRS_QUERY,
  ciGraceMs,
  classifyCheck,
  ciVerdict,
  mergeVerdict,
  ciSettled,
  parseOpenPrs,
  buildChecksQuery,
  parseChecks,
  needsBaseline,
  shasToRead,
  evaluateReadiness,
  readinessEvent,
};
