// git-panel-ops.js — pure, injectable helpers for the deterministic Workspace
// Git panel (issue #648).
//
// The admin-console's agent-chat Workspace → Git view lets an operator switch
// the local branch, fast-forward-update the current branch, and discard local
// changes — all executed server-side by the orchestrator (no LLM). This module
// holds the pieces that decide *what* to do so they can be unit-tested without
// a live git remote; the orchestrator (orchestrator.js `performGitPanelAction`)
// runs the actual git commands.

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const { isValidBranchName, isSafePathSeg } = require("./agent-git-ops");

// The three actions the panel exposes. Deliberately narrow — commit / push /
// merge / rebase / branch-creation are out of scope (issue #648).
const GIT_PANEL_ACTIONS = new Set(["switch", "update", "discard"]);

// Validate + normalise a git-action request body. Returns
// { action, repoPath, branch } or throws a caller-facing Error (message safe
// to surface over the API).
function normalizeGitAction(body = {}) {
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!GIT_PANEL_ACTIONS.has(action)) {
    throw new Error(`unknown git action: ${action || "(none)"}`);
  }
  const repoPath =
    typeof body.repoPath === "string" && body.repoPath ? body.repoPath : ".";
  let branch = null;
  if (action === "switch") {
    branch = typeof body.branch === "string" ? body.branch.trim() : "";
    if (!branch) throw new Error("branch is required for a switch action");
    if (!isValidBranchName(branch)) throw new Error(`invalid branch name: ${branch}`);
  }
  return { action, repoPath, branch };
}

// Resolve a filesystem repoPath — as produced by the admin-console's
// getAgentGitRepos(): "." for the workspace root, else a single first-level
// directory segment — to an absolute directory inside the agent workspace.
// Verifies containment and that the directory holds a .git. Returns the
// absolute path or throws.
function resolveWorkspaceRepoDir({
  agentWorkspace,
  repoPath,
  fs = nodeFs,
  path = nodePath,
}) {
  const rel =
    typeof repoPath === "string" && repoPath && repoPath !== "." ? repoPath : "";
  if (rel && !isSafePathSeg(rel)) {
    throw new Error(`invalid repo path: ${repoPath}`);
  }
  const root = path.resolve(agentWorkspace);
  const abs = path.resolve(agentWorkspace, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`repo path escapes the workspace: ${repoPath}`);
  }
  if (!fs.existsSync(path.join(abs, ".git"))) {
    throw new Error("not a git repository");
  }
  return abs;
}

// Parse `git for-each-ref --format=%(refname:short) refs/heads` output into an
// array of local branch names.
function parseLocalBranches(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Decide the fast-forward outcome from ahead/behind counts relative to the
// upstream. `ahead` = commits local-only, `behind` = commits upstream-only
// (i.e. the left/right of `git rev-list --left-right --count HEAD...@{u}`).
//   behind === 0            → nothing to pull (up-to-date)
//   ahead === 0, behind > 0 → a clean fast-forward is possible
//   ahead > 0,  behind > 0  → diverged; a fast-forward is impossible
function classifyFastForward({ ahead, behind } = {}) {
  const a = Number(ahead) || 0;
  const b = Number(behind) || 0;
  if (b === 0) return { kind: "up-to-date" };
  if (a === 0) return { kind: "fast-forward", behind: b };
  return { kind: "diverged", ahead: a, behind: b };
}

// Find the env.repositories entry whose URL matches the repo's actual `origin`
// remote, so the orchestrator can recover its sshKeyId for credential
// injection. Matches on the normalised (.git-stripped, trailing-slash-stripped)
// URL first, then falls back to a case-insensitive basename match. Returns the
// entry or null.
function matchEnvRepoByRemote(remoteUrl, repositories) {
  const repos = Array.isArray(repositories) ? repositories.filter((r) => r && r.url) : [];
  if (!remoteUrl || repos.length === 0) return null;
  const norm = (u) => String(u || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const target = norm(remoteUrl);
  const exact = repos.find((r) => norm(r.url) === target);
  if (exact) return exact;
  const base = (u) => (norm(u).split(/[/:]/).pop() || "").toLowerCase();
  const tb = base(remoteUrl);
  return repos.find((r) => base(r.url) === tb) || null;
}

module.exports = {
  GIT_PANEL_ACTIONS,
  normalizeGitAction,
  resolveWorkspaceRepoDir,
  parseLocalBranches,
  classifyFastForward,
  matchEnvRepoByRemote,
};
