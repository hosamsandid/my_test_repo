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
// #2066 widened this from "clone what is missing" to "reconcile the declared
// list against what is actually on disk": an already-cloned repository whose
// declared BRANCH or URL has since been edited is now adjusted in place — but
// only when that clone is clean and fully pushed (D1). Nothing here ever
// stashes, resets, force-checks-out or deletes: a checkout may hold unpushed
// work, so the no-data-loss rule outranks the reconciliation, and an unsafe
// clone is reported as a skip with an actionable reason instead.
//
// The plan is derived from the DECLARED list versus the ACTUAL clones, never
// from a remembered save-time diff — which is what keeps it correct after a
// declined offer, a partial run or a failure, and is why the save-time offer,
// the out-of-date indicator's catch-up and the per-agent panel can all drive
// this one core without being able to disagree (#2066 AC21).

// Derive the on-disk directory name a repo URL clones into. MUST match
// cloneRepository() / inspectAgentRepoStatuses() in orchestrator.js so the
// "is this repo already present?" probe looks at the right path.
function repoDirName(url) {
  return (String(url || "").split("/").pop() || "repo").replace(/\.git$/, "");
}

// ── D1: is this existing clone safe to adjust in place? ─────────────────────
//
// The no-data-loss rule is absolute, but "warn only" would leave the
// requirement (a changed branch/URL must produce an adjustment) unmet — so the
// adjustment happens exactly when it provably cannot lose work, and is reported
// as an actionable skip otherwise.
//
// Takes one entry of inspectAgentRepoStatuses() (orchestrator.js) and needs no
// history: every field it reads is a fact about the clone as it is now, which
// is what lets the save-time offer and the catch-up reach the same verdict.
//
// The foreign-remote test is the one that looks like it needs the previously
// declared URL and does not: the platform always clones into
// repoDirName(url), so a clone whose directory name still matches its own
// remote is one the platform placed there (possibly from an older declared URL,
// which is exactly the D1b same-directory case), while a clone whose directory
// and remote disagree can only have been repointed by hand. Repointing that one
// would silently overwrite a deliberate local decision.
//
// Returns { safe, reason?, detail? }; `reason` is a stable code, `detail` the
// human half naming what blocks it.
function cloneAdjustSafety(status) {
  if (!status || !status.exists) {
    return { safe: false, reason: "not-cloned", detail: "the repository is not cloned here yet" };
  }
  if (status.error) {
    return {
      safe: false,
      reason: "status-unreadable",
      detail: `the repository's git state could not be read: ${status.error}`,
    };
  }
  const d = status.dirty || {};
  const dirtyCount = (d.staged || 0) + (d.unstaged || 0) + (d.untracked || 0);
  if (dirtyCount > 0) {
    const parts = [];
    if (d.staged) parts.push(`${d.staged} staged`);
    if (d.unstaged) parts.push(`${d.unstaged} modified`);
    if (d.untracked) parts.push(`${d.untracked} untracked`);
    return {
      safe: false,
      reason: "uncommitted-changes",
      detail: `${parts.join(", ")} file${dirtyCount === 1 ? "" : "s"} — commit or discard them, then catch up`,
    };
  }
  if (status.branchActual === "HEAD") {
    return {
      safe: false,
      reason: "detached-head",
      detail: "no branch is checked out (detached HEAD) — check out a branch, then catch up",
    };
  }
  if (!status.upstream) {
    return {
      safe: false,
      reason: "no-upstream",
      detail: "the checked-out branch tracks no remote branch, so its commits exist only here — push it, then catch up",
    };
  }
  if (status.ahead === null || status.ahead === undefined) {
    return {
      safe: false,
      reason: "upstream-unknown",
      detail: "the branch could not be compared against its remote, so unpushed work cannot be ruled out",
    };
  }
  if (status.ahead > 0) {
    return {
      safe: false,
      reason: "unpushed-commits",
      detail: `${status.ahead} commit${status.ahead === 1 ? "" : "s"} not pushed — push them, then catch up`,
    };
  }
  if (!status.remoteUrl) {
    return {
      safe: false,
      reason: "no-remote",
      detail: "the clone has no 'origin' remote, so it cannot be verified against the declared URL",
    };
  }
  if (repoDirName(status.remoteUrl) !== status.name) {
    return {
      safe: false,
      reason: "foreign-remote",
      detail: `'origin' points at ${status.remoteUrl}, which this folder was not cloned from — repoint it by hand if that was intended`,
    };
  }
  return { safe: true };
}

// What, if anything, has to change about an existing clone for it to match its
// declared entry. Returns null when it already matches.
//
// A blank declared branch means "the repository's own default branch", which
// the clone already has — so it never forces a checkout.
function repoAdjustments(repo, status) {
  if (!repo || !status || !status.exists) return null;
  const setUrl = status.remoteUrl && status.remoteUrl !== repo.url ? repo.url : null;
  const declaredBranch = repo.branch ? String(repo.branch) : "";
  const checkoutBranch = declaredBranch && status.branchActual !== declaredBranch ? declaredBranch : null;
  if (!setUrl && !checkoutBranch) return null;
  return { setUrl, checkoutBranch };
}

// ── D4: which declared repositories are out of date in this workspace ───────
//
// Divergence is a property of the workspace, not of a save: a declared
// repository with no clone, or a clone whose branch or remote URL differs from
// the declared entry. A clone with NO matching declared entry is deliberately
// never divergence — nothing is ever pruned, so it can never be brought "up to
// date" and counting it would leave the indicator permanently lit (AC20).
function repoDivergence(repositories, statuses) {
  const byName = new Map(
    (Array.isArray(statuses) ? statuses : []).filter((s) => s && s.name).map((s) => [s.name, s]),
  );
  const out = [];
  for (const repo of Array.isArray(repositories) ? repositories : []) {
    if (!repo || !repo.url) continue;
    const name = repoDirName(repo.url);
    const status = byName.get(name);
    if (!status || !status.exists) {
      out.push({ name, url: repo.url, kind: "missing" });
      continue;
    }
    const adjust = repoAdjustments(repo, status);
    if (!adjust) continue;
    out.push({
      name,
      url: repo.url,
      kind: adjust.setUrl && adjust.checkoutBranch ? "url-and-branch" : (adjust.setUrl ? "url" : "branch"),
    });
  }
  return out;
}

// Plan + execute the propagation for one agent. Pure with respect to injected
// probes:
//   deps.statuses      → inspectAgentRepoStatuses(agentId, env) for this agent
//   deps.clone(repo)   → performs the clone; returns { skipped?, fromCache? } or throws
//   deps.adjust(repo, status, plan)
//                      → applies { setUrl, checkoutBranch } to an existing
//                        clone; returns { applied: [...] } or throws. Only ever
//                        called for a clone cloneAdjustSafety() cleared.
//   deps.listClones?() → directory names present in the workspace, used to
//                        report clones with no declared entry as RETAINED
//
// Returns one entry per repo carrying a url, in declaration order, followed by
// any retained entries:
//   { name, url, status, reason?, detail?, blocked?, applied?, fromCache?, error? }
// where status is 'cloned' | 'adjusted' | 'skipped' | 'failed' | 'retained'.
//
// `blocked: true` marks a D1 safety skip so a surface can tell it apart from an
// ordinary already-in-sync skip and from a failure — the three need different
// things from the reader (nothing / push or commit / fix credentials or the URL).
function syncAgentRepoPlan(repositories, deps) {
  const repos = Array.isArray(repositories) ? repositories : [];
  const statuses = Array.isArray(deps && deps.statuses) ? deps.statuses : [];
  const byName = new Map(statuses.filter((s) => s && s.name).map((s) => [s.name, s]));
  const results = [];
  const declared = new Set();

  for (const repo of repos) {
    if (!repo || !repo.url) continue;
    const name = repoDirName(repo.url);
    declared.add(name);
    const base = { name, url: repo.url };
    const status = byName.get(name);

    // Not cloned here yet → clone it. This is #1342's whole behaviour, kept.
    if (!status || !status.exists) {
      try {
        const info = deps.clone(repo) || {};
        if (info.skipped) {
          // cloneRepository() reports skipped when the target directory already
          // exists but has no .git — a foreign / partially-cloned dir occupies
          // the path. Re-cloning it is out of scope, so surface it honestly
          // rather than reporting a clone that never happened.
          results.push({
            ...base,
            status: "skipped",
            reason: "path-occupied",
            detail: "a folder that is not a git checkout already occupies that path",
            blocked: true,
          });
        } else {
          results.push({ ...base, status: "cloned", fromCache: Boolean(info.fromCache) });
        }
      } catch (err) {
        results.push({ ...base, status: "failed", error: (err && err.message) || "clone failed" });
      }
      continue;
    }

    // Cloned and already matching the declared entry → left untouched.
    const adjust = repoAdjustments(repo, status);
    if (!adjust) {
      results.push({ ...base, status: "skipped", reason: "already-present" });
      continue;
    }

    // Cloned but diverging → adjust in place, if and only if that provably
    // cannot lose work.
    const safety = cloneAdjustSafety(status);
    if (!safety.safe) {
      results.push({
        ...base,
        status: "skipped",
        reason: safety.reason,
        detail: safety.detail,
        blocked: true,
      });
      continue;
    }

    try {
      const info = deps.adjust(repo, status, adjust) || {};
      results.push({ ...base, status: "adjusted", applied: info.applied || [] });
    } catch (err) {
      results.push({ ...base, status: "failed", error: (err && err.message) || "adjustment failed" });
    }
  }

  // Clones with no declared entry. Never pruned, under any circumstance — a
  // checkout may hold unpushed work — so they are reported so the operator
  // knows they are still there (AC15/AC17/AC18).
  if (typeof (deps && deps.listClones) === "function") {
    for (const name of deps.listClones() || []) {
      if (!name || declared.has(name)) continue;
      results.push({
        name,
        url: null,
        status: "retained",
        reason: "no-longer-declared",
        detail: "still in the workspace — nothing is ever deleted from an agent",
      });
    }
  }

  return results;
}

// Fold per-repo results into totals for a stream / summary payload.
//
// `blocked` counts the D1 safety skips inside `skipped`, so a surface can say
// "2 already present, 1 left alone (uncommitted changes)" rather than lumping
// an actionable skip in with a no-op one.
function summarizeRepoResults(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    total: list.filter((r) => r.status !== "retained").length,
    cloned: list.filter((r) => r.status === "cloned").length,
    adjusted: list.filter((r) => r.status === "adjusted").length,
    skipped: list.filter((r) => r.status === "skipped").length,
    blocked: list.filter((r) => r.status === "skipped" && r.blocked).length,
    failed: list.filter((r) => r.status === "failed").length,
    retained: list.filter((r) => r.status === "retained").length,
  };
}

module.exports = {
  repoDirName,
  cloneAdjustSafety,
  repoAdjustments,
  repoDivergence,
  syncAgentRepoPlan,
  summarizeRepoResults,
};
