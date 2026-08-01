'use strict';

// PR-link record store (#655, §4.2 + §6 phase 2 of docs/cost-per-pr-concept.md).
//
// The one gap phase 1 left open: outbound PR identity. `agentCreatePr` /
// `agentGitPush` know agent id, repo, branch, base and the created PR URL at the
// moment of creation but persisted nothing — so "which run created this PR" was a
// heuristic. This module is the single writer that appends one JSONL line per
// outbound git action to a day-bucketed file on the shared `/workspace` volume;
// admin-console/api/pr-events-log.js is the read-side counterpart.
//
// Same day-bucketed pattern as orchestrator/usage-log.js (#654) — one file per
// calendar day, best-effort append, single-writer on the orchestrator side, many
// readers on the admin-console side. Like usage records these are billing-adjacent
// and retained indefinitely; pruning is an explicit operator action (§4.3).
//
// Two record kinds share the file:
//   - `pr-created`   — a PR was opened (agentCreatePr): carries prNumber/url/base/closes.
//   - `branch-pushed`— a branch was pushed without opening a PR (agentGitPush):
//                      the correlationId↔branch binding, useful to corroborate the
//                      branch-tier (C) join when a PR is later opened another way.

const fs = require('fs');
const path = require('path');

// Same shared volume as the usage records (§4.2 writes both under /workspace/usage).
const PR_EVENTS_LOG_DIR = process.env.PR_EVENTS_LOG_DIR || process.env.USAGE_LOG_DIR || '/workspace/usage';

// GitHub closing keywords (closes/fixes/resolves, all tenses) — the exact set
// GitHub itself honours for auto-closing an issue from a PR body.
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)/gi;
// Issue number embedded in a head branch name (`agent/x/issue-99`, `feature/issue_42`,
// `bugfix/issue/7`). Conservative on purpose: only the `issue` convention counts, so a
// stray number in an agent id or hash can't invent a false artifact edge.
const BRANCH_ISSUE_RE = /issue[-_/]?(\d+)/gi;

// Normalize a repo to GitHub `owner/name` form — the same identity the poller
// stamps onto usage records' `github.repo`, so pr-created records and inbound
// event records key the artifact graph on the SAME node. `resolveAgentRepo`
// only knows the short clone-dir name; the owner comes from the git remote URL
// or the created PR URL. Handles SSH (`git@github.com:owner/name.git`), HTTPS
// (`https://github.com/owner/name(.git)`) and PR URLs (`…/owner/name/pull/N`).
// Returns `owner/name` or null.
function repoFullName(url) {
  if (typeof url !== 'string' || !url) return null;
  let m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?(?:\/pull\/\d+.*)?$/);
  if (!m) return null;
  const owner = m[1];
  const name = m[2].replace(/\.git$/, '');
  if (!owner || !name || owner.includes('.')) return null; // guard against host being captured as owner
  return `${owner}/${name}`;
}

// Parse the PR number from the URL the create handler already regex-extracts
// (…/pull/731). Returns a positive integer or null.
function parsePrNumber(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The issue numbers this PR links to, for the artifact graph (§3.1): closing
// keywords in the body plus `issue-N` tokens in the head branch name. Sorted,
// deduped, positive integers only.
function parseCloses(body, branch) {
  const out = new Set();
  const scan = (text, re) => {
    if (typeof text !== 'string') return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  };
  scan(body, CLOSES_RE);
  scan(branch, BRANCH_ISSUE_RE);
  return [...out].sort((a, b) => a - b);
}

// Bucket by the record's own `ts` (UTC ISO string), NOT wall-clock-now — mirrors
// usage-log.dayOf so a spooled/late record lands in the day it happened.
function dayOf(entry) {
  const ts = entry && typeof entry.ts === 'string' ? entry.ts : '';
  if (/^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// Append one PR-link record as a JSONL line to its day file. Never throws — an
// outbound git action must not fail because the disk write hiccuped.
function record(entry) {
  try {
    fs.mkdirSync(PR_EVENTS_LOG_DIR, { recursive: true });
    const day = dayOf(entry);
    fs.appendFileSync(path.join(PR_EVENTS_LOG_DIR, `pr-events-${day}.jsonl`), JSON.stringify(entry) + '\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = { PR_EVENTS_LOG_DIR, repoFullName, parsePrNumber, parseCloses, dayOf, record };
