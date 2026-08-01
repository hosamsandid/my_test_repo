"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const {
  GIT_PANEL_ACTIONS,
  normalizeGitAction,
  resolveWorkspaceRepoDir,
  parseLocalBranches,
  classifyFastForward,
  matchEnvRepoByRemote,
} = require("./git-panel-ops");

test("GIT_PANEL_ACTIONS is exactly switch/update/discard", () => {
  assert.deepEqual([...GIT_PANEL_ACTIONS].sort(), ["discard", "switch", "update"]);
});

test("normalizeGitAction rejects unknown / missing actions", () => {
  assert.throws(() => normalizeGitAction({}), /unknown git action/);
  assert.throws(() => normalizeGitAction({ action: "merge" }), /unknown git action: merge/);
  assert.throws(() => normalizeGitAction({ action: "push" }), /unknown git action: push/);
});

test("normalizeGitAction: update/discard default repoPath to '.'", () => {
  assert.deepEqual(normalizeGitAction({ action: "update" }), { action: "update", repoPath: ".", branch: null });
  assert.deepEqual(normalizeGitAction({ action: "discard" }), { action: "discard", repoPath: ".", branch: null });
  assert.equal(normalizeGitAction({ action: "update", repoPath: "sub" }).repoPath, "sub");
});

test("normalizeGitAction: switch requires a valid branch", () => {
  assert.throws(() => normalizeGitAction({ action: "switch" }), /branch is required/);
  assert.throws(() => normalizeGitAction({ action: "switch", branch: "" }), /branch is required/);
  assert.throws(() => normalizeGitAction({ action: "switch", branch: "bad branch" }), /invalid branch name/);
  assert.throws(() => normalizeGitAction({ action: "switch", branch: "-leading" }), /invalid branch name/);
  const ok = normalizeGitAction({ action: "switch", branch: "  feature/x  " });
  assert.deepEqual(ok, { action: "switch", repoPath: ".", branch: "feature/x" });
});

test("resolveWorkspaceRepoDir resolves '.' to the workspace root when it holds .git", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gpo-root-"));
  fs.mkdirSync(path.join(ws, ".git"));
  const abs = resolveWorkspaceRepoDir({ agentWorkspace: ws, repoPath: "." });
  assert.equal(abs, path.resolve(ws));
  fs.rmSync(ws, { recursive: true, force: true });
});

test("resolveWorkspaceRepoDir resolves a first-level subdir repo", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gpo-sub-"));
  fs.mkdirSync(path.join(ws, "repo", ".git"), { recursive: true });
  const abs = resolveWorkspaceRepoDir({ agentWorkspace: ws, repoPath: "repo" });
  assert.equal(abs, path.resolve(ws, "repo"));
  fs.rmSync(ws, { recursive: true, force: true });
});

test("resolveWorkspaceRepoDir rejects traversal, unsafe segments, and non-repos", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gpo-guard-"));
  fs.mkdirSync(path.join(ws, "plain"), { recursive: true }); // no .git
  assert.throws(() => resolveWorkspaceRepoDir({ agentWorkspace: ws, repoPath: "../escape" }), /invalid repo path|escapes/);
  assert.throws(() => resolveWorkspaceRepoDir({ agentWorkspace: ws, repoPath: "a/b" }), /invalid repo path/);
  assert.throws(() => resolveWorkspaceRepoDir({ agentWorkspace: ws, repoPath: "plain" }), /not a git repository/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("parseLocalBranches trims + drops blanks", () => {
  assert.deepEqual(parseLocalBranches("main\n feature/x \n\ndev\n"), ["main", "feature/x", "dev"]);
  assert.deepEqual(parseLocalBranches(""), []);
  assert.deepEqual(parseLocalBranches(null), []);
});

test("classifyFastForward maps ahead/behind to the right outcome", () => {
  assert.deepEqual(classifyFastForward({ ahead: 0, behind: 0 }), { kind: "up-to-date" });
  assert.deepEqual(classifyFastForward({ ahead: 3, behind: 0 }), { kind: "up-to-date" }); // behind 0 wins
  assert.deepEqual(classifyFastForward({ ahead: 0, behind: 4 }), { kind: "fast-forward", behind: 4 });
  assert.deepEqual(classifyFastForward({ ahead: 2, behind: 5 }), { kind: "diverged", ahead: 2, behind: 5 });
  assert.deepEqual(classifyFastForward({}), { kind: "up-to-date" });
});

test("matchEnvRepoByRemote matches on normalised URL then basename", () => {
  const repos = [
    { url: "git@github.com:acme/foo.git", sshKeyId: "k1" },
    { url: "https://github.com/acme/bar", sshKeyId: "k2" },
  ];
  // Exact (normalised) match ignores a trailing .git and trailing slashes.
  assert.equal(matchEnvRepoByRemote("git@github.com:acme/foo", repos).sshKeyId, "k1");
  assert.equal(matchEnvRepoByRemote("https://github.com/acme/bar.git", repos).sshKeyId, "k2");
  assert.equal(matchEnvRepoByRemote("https://github.com/acme/bar/", repos).sshKeyId, "k2");
  // Basename fallback (different host / protocol, same repo name).
  assert.equal(matchEnvRepoByRemote("https://example.com/mirror/foo.git", repos).sshKeyId, "k1");
  // No match / empty input.
  assert.equal(matchEnvRepoByRemote("git@github.com:acme/other", repos), null);
  assert.equal(matchEnvRepoByRemote("", repos), null);
  assert.equal(matchEnvRepoByRemote("git@github.com:acme/foo", []), null);
});
