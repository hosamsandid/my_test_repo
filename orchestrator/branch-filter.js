'use strict';

// Push-trigger branch filter (#2570) — which branches a `push` subscriber
// reacts to. Pure and fs-free so the poller, the pending-queue reassign and the
// unit tests share one rule.
//
// Stored on a github-event trigger as `branchFilter`: a normalized array of
// branch patterns (`["main", "feature/*"]`). A comma-separated string is
// accepted too — an agent hand-editing its own triggers.json may write
// `"main, feature/*"` — and is split the same way the console form splits it.
// Absent / empty / only commas and whitespace = no filter = every branch
// (today's behaviour, no migration).
//
// Patterns follow the GitHub-Actions branch-filter convention: `*` matches any
// characters except `/`, `**` matches any characters including `/`. Every
// other character — including `?`, `[`, `!` — is literal. Matching is exact
// and case-sensitive.
//
// Mirrors (the console and the agent runtime cannot require this module; keep
// them in sync): admin-console/api/branch-filter.js (write validation),
// admin-console/src/pages/agent-chat/branch-filter.js (form + card) and
// `_branch_filter_error` in agent-image/scripts/agent-entrypoint.py.

// Split, trim, drop empties, de-duplicate (first occurrence wins). Tolerant:
// junk input yields [] (no filter) rather than throwing.
function parseBranchFilter(raw) {
  const parts = [];
  if (typeof raw === 'string') parts.push(...raw.split(','));
  else if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string') parts.push(...v.split(','));
  }
  const out = [];
  for (const p of parts) {
    const s = p.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// `refs/heads/<branch>` → `<branch>`; a tag push (`refs/tags/…`) or anything
// else → null, which no non-empty filter matches.
function pushBranch(ghEvent) {
  const ref = ghEvent && ghEvent.payload && ghEvent.payload.ref;
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) return null;
  const branch = ref.slice('refs/heads/'.length);
  return branch || null;
}

function patternToRegExp(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { src += '.*'; i++; } else src += '[^/]*';
    } else {
      src += c.replace(/[\\^$.|?+()[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${src}$`);
}

function branchMatchesPattern(branch, pattern) {
  if (typeof branch !== 'string' || !branch) return false;
  if (!pattern.includes('*')) return branch === pattern;
  return patternToRegExp(pattern).test(branch);
}

// Does `branch` satisfy the (already parsed) filter? Empty filter → true.
function branchFilterMatches(branch, filter) {
  if (!Array.isArray(filter) || filter.length === 0) return true;
  return filter.some((p) => branchMatchesPattern(branch, p));
}

module.exports = {
  parseBranchFilter,
  pushBranch,
  branchMatchesPattern,
  branchFilterMatches,
};
