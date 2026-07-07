"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isHttpsGithubUrl,
  isSshUrl,
  isValidBranchName,
  resolveAgentRepo,
  buildRepoGitEnv,
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

// ── sanitizeGitOutput ────────────────────────────────────────────────────────
test("sanitizeGitOutput redacts Authorization headers", () => {
  const out = sanitizeGitOutput("remote: error\nAuthorization: Basic c2VjcmV0\nfatal: nope");
  assert.match(out, /Authorization: \[redacted\]/);
  assert.doesNotMatch(out, /c2VjcmV0/);
});
