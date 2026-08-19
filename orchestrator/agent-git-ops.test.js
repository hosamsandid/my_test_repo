"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isHttpsGithubUrl,
  isSshUrl,
  isValidBranchName,
  resolveAgentRepo,
  buildRepoGitEnv,
  githubTokenStatus,
  sanitizeGitOutput,
  normalizePushRequest,
  PROTECTED_BRANCHES,
} = require("./agent-git-ops");

// ── URL classification ──────────────────────────────────────────────────────
test("isHttpsGithubUrl matches github https URLs only", () => {
  assert.equal(isHttpsGithubUrl("https://github.com/acme/repo.git"), true);
  assert.equal(isHttpsGithubUrl("https://www.github.com/acme/repo"), true);
  assert.equal(isHttpsGithubUrl("git@github.com:acme/repo.git"), false);
  assert.equal(isHttpsGithubUrl("https://gitlab.com/acme/repo"), false);
});

test("isSshUrl matches scp-like and ssh:// URLs", () => {
  assert.equal(isSshUrl("git@github.com:acme/repo.git"), true);
  assert.equal(isSshUrl("ssh://git@host/acme/repo.git"), true);
  assert.equal(isSshUrl("https://github.com/acme/repo"), false);
});

// ── Branch validation ─────────────────────────────────────────────────────
test("isValidBranchName accepts normal branches, rejects dangerous ones", () => {
  assert.equal(isValidBranchName("feat/433-accenture-logo"), true);
  assert.equal(isValidBranchName("agent/dev/abc123"), true);
  assert.equal(isValidBranchName("--force"), false); // option injection
  assert.equal(isValidBranchName("a b"), false); // whitespace
  assert.equal(isValidBranchName("foo..bar"), false);
  assert.equal(isValidBranchName("foo.lock"), false);
  assert.equal(isValidBranchName("foo~1"), false);
  assert.equal(isValidBranchName(""), false);
  assert.equal(isValidBranchName("/leading"), false);
});

// ── normalizePushRequest ────────────────────────────────────────────────────
test("normalizePushRequest rejects force pushes", () => {
  assert.throws(() => normalizePushRequest({ force: true }), /force-push/);
  assert.throws(() => normalizePushRequest({ forceWithLease: true }), /force-push/);
});

test("normalizePushRequest refuses protected branches", () => {
  for (const b of PROTECTED_BRANCHES) {
    assert.throws(() => normalizePushRequest({ branch: b }), /protected branch/);
  }
});

test("normalizePushRequest defaults remote=origin and setUpstream=true", () => {
  const r = normalizePushRequest({ branch: "feat/x" });
  assert.deepEqual(r, { branch: "feat/x", remote: "origin", setUpstream: true });
});

test("normalizePushRequest honours setUpstream:false and rejects bad remotes", () => {
  assert.equal(normalizePushRequest({ setUpstream: false }).setUpstream, false);
  assert.throws(() => normalizePushRequest({ remote: "bad remote" }), /invalid remote/);
});

// ── resolveAgentRepo ─────────────────────────────────────────────────────────
function fakeFs(existing) {
  return { existsSync: (p) => existing.has(p) };
}

test("resolveAgentRepo picks the single repo when none requested", () => {
  const r = resolveAgentRepo({
    repositories: [{ url: "git@github.com:acme/svc.git", sshKeyId: "k1" }],
    agentWorkspace: "/ws/agents/dev",
    fs: fakeFs(new Set(["/ws/agents/dev/svc/.git"])),
  });
  assert.equal(r.name, "svc");
  assert.equal(r.repoPath, "/ws/agents/dev/svc");
  assert.equal(r.sshKeyId, "k1");
});

test("resolveAgentRepo requires a name when multiple repos exist", () => {
  assert.throws(
    () =>
      resolveAgentRepo({
        repositories: [
          { url: "git@github.com:acme/a.git" },
          { url: "git@github.com:acme/b.git" },
        ],
        agentWorkspace: "/ws/agents/dev",
        fs: fakeFs(new Set()),
      }),
    /multiple repos/,
  );
});

test("resolveAgentRepo matches a requested repo by basename", () => {
  const r = resolveAgentRepo({
    repositories: [
      { url: "https://github.com/acme/a.git", githubTokenId: "t" },
      { url: "https://github.com/acme/b.git" },
    ],
    requestedRepo: "b",
    agentWorkspace: "/ws/agents/dev",
    fs: fakeFs(new Set(["/ws/agents/dev/b/.git"])),
  });
  assert.equal(r.name, "b");
});

test("resolveAgentRepo rejects unknown / unsafe repo names", () => {
  const args = {
    repositories: [{ url: "https://github.com/acme/a.git" }],
    agentWorkspace: "/ws/agents/dev",
    fs: fakeFs(new Set(["/ws/agents/dev/a/.git"])),
  };
  assert.throws(() => resolveAgentRepo({ ...args, requestedRepo: "nope" }), /is not in this environment/);
  assert.throws(() => resolveAgentRepo({ ...args, requestedRepo: "../etc" }), /invalid repo name/);
});

test("resolveAgentRepo errors when the repo was never cloned", () => {
  assert.throws(
    () =>
      resolveAgentRepo({
        repositories: [{ url: "https://github.com/acme/a.git" }],
        agentWorkspace: "/ws/agents/dev",
        fs: fakeFs(new Set()),
      }),
    /has not been cloned/,
  );
});

test("resolveAgentRepo errors when env has no repository", () => {
  assert.throws(
    () => resolveAgentRepo({ repositories: [], agentWorkspace: "/ws", fs: fakeFs(new Set()) }),
    /no repository configured/,
  );
});

// ── buildRepoGitEnv ─────────────────────────────────────────────────────────
test("buildRepoGitEnv sets GIT_SSH_COMMAND for ssh URLs with a key", () => {
  const fs = {
    existsSync: () => true,
    chmodSync: () => {},
    readFileSync: () => "",
  };
  const gitEnv = buildRepoGitEnv({
    env: {},
    repoUrl: "git@github.com:acme/svc.git",
    sshKeyId: "k1",
    baseEnv: {},
    sshKeysDir: "/keys",
    ghTokensDir: "/tokens",
    fs,
  });
  assert.match(gitEnv.GIT_SSH_COMMAND, /ssh -i \/keys\/k1/);
  assert.equal(gitEnv.GIT_TERMINAL_PROMPT, "0");
  assert.equal(gitEnv.GIT_CONFIG_COUNT, undefined);
});

test("buildRepoGitEnv injects PAT extraheader + GH_TOKEN for https github URLs", () => {
  const fs = {
    existsSync: () => true,
    chmodSync: () => {},
    readFileSync: () => "ghp_secrettoken\n",
  };
  const gitEnv = buildRepoGitEnv({
    env: { githubTokenId: "t1" },
    repoUrl: "https://github.com/acme/svc.git",
    baseEnv: {},
    sshKeysDir: "/keys",
    ghTokensDir: "/tokens",
    fs,
  });
  assert.equal(gitEnv.GIT_CONFIG_COUNT, "1");
  assert.equal(gitEnv.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.match(gitEnv.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  assert.equal(gitEnv.GH_TOKEN, "ghp_secrettoken");
  assert.equal(gitEnv.GITHUB_TOKEN, "ghp_secrettoken");
  assert.equal(gitEnv.GIT_SSH_COMMAND, undefined);
});

// Regression: an SSH remote still needs the PAT for `gh`. Gating GH_TOKEN on the
// URL scheme broke PR creation on the recommended setup (SSH URL + deploy key) —
// `git push` succeeded over SSH, then `gh pr create` died with "run gh auth
// login", because `gh` talks to the REST API and never to the git remote.
test("buildRepoGitEnv injects GH_TOKEN for an SSH remote too (gh needs the PAT regardless of scheme)", () => {
  const fs = {
    existsSync: () => true,
    chmodSync: () => {},
    readFileSync: () => "ghp_secrettoken\n",
  };
  const gitEnv = buildRepoGitEnv({
    env: { githubTokenId: "t1" },
    repoUrl: "git@github.com:acme/svc.git",
    sshKeyId: "k1",
    baseEnv: {},
    sshKeysDir: "/keys",
    ghTokensDir: "/tokens",
    fs,
  });
  assert.equal(gitEnv.GH_TOKEN, "ghp_secrettoken", "gh pr create must be authenticated");
  assert.equal(gitEnv.GITHUB_TOKEN, "ghp_secrettoken");
  // The SSH identity still carries git I/O …
  assert.match(gitEnv.GIT_SSH_COMMAND, /ssh -i \/keys\/k1/);
  // … and the https-only extraheader must NOT appear for an SSH remote.
  assert.equal(gitEnv.GIT_CONFIG_COUNT, undefined);
});

test("buildRepoGitEnv sets no gh credential when no token is configured", () => {
  const fs = { existsSync: () => true, chmodSync: () => {}, readFileSync: () => "ghp_x" };
  const gitEnv = buildRepoGitEnv({
    env: {},
    repoUrl: "git@github.com:acme/svc.git",
    sshKeyId: "k1",
    baseEnv: {},
    sshKeysDir: "/keys",
    ghTokensDir: "/tokens",
    fs,
  });
  assert.equal(gitEnv.GH_TOKEN, undefined);
  assert.equal(gitEnv.GITHUB_TOKEN, undefined);
});

test("buildRepoGitEnv never leaks the token when the key file is outside the dir", () => {
  const fs = { existsSync: () => true, chmodSync: () => {}, readFileSync: () => "x" };
  const gitEnv = buildRepoGitEnv({
    env: {},
    repoUrl: "git@github.com:acme/svc.git",
    sshKeyId: "../escape",
    baseEnv: {},
    sshKeysDir: "/keys",
    ghTokensDir: "/tokens",
    fs,
  });
  assert.equal(gitEnv.GIT_SSH_COMMAND, undefined);
});

// ── githubTokenStatus ────────────────────────────────────────────────────────
test("githubTokenStatus reports no-token-configured when nothing names a token", () => {
  const s = githubTokenStatus({ env: {}, ghTokensDir: "/tokens", fs: fakeFs(new Set()) });
  assert.deepEqual(s, { resolvable: false, tokenId: null, reason: "no-token-configured" });
});

test("githubTokenStatus reports token-file-missing when the id resolves to no file", () => {
  const s = githubTokenStatus({
    env: { githubTokenId: "t1" },
    ghTokensDir: "/tokens",
    fs: fakeFs(new Set()),
  });
  assert.equal(s.resolvable, false);
  assert.equal(s.tokenId, "t1");
  assert.equal(s.reason, "token-file-missing");
});

test("githubTokenStatus reports token-file-empty for a blank token file", () => {
  const fs = { existsSync: () => true, readFileSync: () => "   \n" };
  const s = githubTokenStatus({ githubTokenId: "t1", ghTokensDir: "/tokens", fs });
  assert.equal(s.resolvable, false);
  assert.equal(s.reason, "token-file-empty");
});

test("githubTokenStatus rejects a token id that escapes the store dir", () => {
  const fs = { existsSync: () => true, readFileSync: () => "ghp_x" };
  const s = githubTokenStatus({ githubTokenId: "../escape", ghTokensDir: "/tokens", fs });
  assert.equal(s.resolvable, false);
  assert.equal(s.reason, "token-path-invalid");
});

test("githubTokenStatus resolves when the token file has content", () => {
  const fs = { existsSync: () => true, readFileSync: () => "ghp_secret\n" };
  const s = githubTokenStatus({ githubTokenId: "t1", ghTokensDir: "/tokens", fs });
  assert.deepEqual(s, { resolvable: true, tokenId: "t1", reason: null });
});

test("githubTokenStatus prefers the explicit tokenId over the env's", () => {
  const fs = { existsSync: () => true, readFileSync: () => "ghp_secret" };
  const s = githubTokenStatus({
    env: { githubTokenId: "env-token" },
    githubTokenId: "req-token",
    ghTokensDir: "/tokens",
    fs,
  });
  assert.equal(s.tokenId, "req-token");
});

// ── sanitizeGitOutput ────────────────────────────────────────────────────────
test("sanitizeGitOutput redacts Authorization headers", () => {
  const out = sanitizeGitOutput("remote: error\nAuthorization: Basic c2VjcmV0\nfatal: nope");
  assert.match(out, /Authorization: \[redacted\]/);
  assert.doesNotMatch(out, /c2VjcmV0/);
});

// ── makeKeyedQueue ───────────────────────────────────────────────────────────
const { makeKeyedQueue } = require("./agent-git-ops");

test("makeKeyedQueue serializes work on the same key", async () => {
  const enqueue = makeKeyedQueue();
  const order = [];
  let releaseFirst;
  const firstRunning = new Promise((r) => { releaseFirst = r; });
  const a = enqueue("repo", async () => {
    order.push("a:start");
    await firstRunning;
    order.push("a:end");
    return "a";
  });
  const b = enqueue("repo", async () => {
    order.push("b:start");
    return "b";
  });
  // b must not start while a is still in flight.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["a:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
});

test("makeKeyedQueue runs different keys concurrently", async () => {
  const enqueue = makeKeyedQueue();
  const order = [];
  let releaseA;
  const gate = new Promise((r) => { releaseA = r; });
  const a = enqueue("repo-1", async () => { order.push("a:start"); await gate; return "a"; });
  const b = enqueue("repo-2", async () => { order.push("b:start"); return "b"; });
  await b;
  // repo-2 finished while repo-1 is still blocked — no cross-key serialization.
  assert.deepEqual(order, ["a:start", "b:start"]);
  releaseA();
  assert.equal(await a, "a");
});

test("makeKeyedQueue propagates a rejection to its caller only", async () => {
  const enqueue = makeKeyedQueue();
  const failing = enqueue("repo", async () => { throw new Error("push failed"); });
  const following = enqueue("repo", async () => "ok");
  await assert.rejects(failing, /push failed/);
  assert.equal(await following, "ok");
});

test("makeKeyedQueue drops the chain entry once the tail settles", async () => {
  const enqueue = makeKeyedQueue();
  await enqueue("repo", async () => "done");
  await new Promise((r) => setImmediate(r));
  // A fresh call after the chain drained must run immediately (no stale tail).
  const order = [];
  await enqueue("repo", async () => { order.push("ran"); });
  assert.deepEqual(order, ["ran"]);
});
