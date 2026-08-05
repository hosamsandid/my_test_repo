"use strict";

// repo-sync.js — pure decision logic for syncing a Working Environment's
// declared repositories into an *existing* agent's workspace (issue #1342).
//
// Repositories are otherwise only cloned when an agent is FIRST created
// (seedAgentWorkspace → cloneEnvironmentRepositories in orchestrator.js), so a
// repo added to an environment after its agents exist never reaches those
// agents' workspaces. This module decides, per repo, whether it is already
// present, needs cloning, or can't be synced — leaving the actual fs / clone
// I/O to the caller (orchestrator.js) via injected probes so the decision
// logic stays unit-testable.
//
// Idempotent by contract (issue scope: clone MISSING repos only): an
// already-cloned repo is never re-cloned, re-fetched, or branch-switched.

// Derive the on-disk directory name a repo URL clones into. MUST match
// cloneRepository() / inspectAgentRepoStatuses() in orchestrator.js so the
// "is this repo already present?" probe looks at the right path.
function repoDirName(url) {
  return (String(url || "").split("/").pop() || "repo").replace(/\.git$/, "");
}

// Plan + execute the sync for one agent. Pure with respect to injected probes:
//   deps.hasGit(name) → true when <workspace>/<name>/.git exists (already cloned)
//   deps.clone(repo)  → performs the clone; returns { skipped?, fromCache? } or throws
//
// Returns one entry per repo carrying a url, in declaration order:
//   { name, url, status, reason?, fromCache?, error? }
// where status is 'cloned' | 'skipped' | 'failed'.
function syncAgentRepoPlan(repositories, deps) {
  const repos = Array.isArray(repositories) ? repositories : [];
  const results = [];
  for (const repo of repos) {
    if (!repo || !repo.url) continue;
    const name = repoDirName(repo.url);
    const base = { name, url: repo.url };

    // Already cloned → skip untouched (no fetch, no branch switch).
    if (deps.hasGit(name)) {
      results.push({ ...base, status: "skipped", reason: "already-present" });
      continue;
    }

    try {
      const info = deps.clone(repo) || {};
      if (info.skipped) {
        // cloneRepository() reports skipped when the target directory already
        // exists but has no .git — a foreign / partially-cloned dir occupies
        // the path. Re-cloning it is out of scope, so surface it honestly
        // rather than reporting a clone that never happened.
        results.push({ ...base, status: "skipped", reason: "path-occupied" });
      } else {
        results.push({ ...base, status: "cloned", fromCache: Boolean(info.fromCache) });
      }
    } catch (err) {
      results.push({ ...base, status: "failed", error: (err && err.message) || "clone failed" });
    }
  }
  return results;
}

// Fold per-repo results into totals for a stream / summary payload.
function summarizeRepoResults(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    total: list.length,
    cloned: list.filter((r) => r.status === "cloned").length,
    skipped: list.filter((r) => r.status === "skipped").length,
    failed: list.filter((r) => r.status === "failed").length,
  };
}

module.exports = { repoDirName, syncAgentRepoPlan, summarizeRepoResults };
