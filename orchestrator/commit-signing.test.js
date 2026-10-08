"use strict";

// Unit tests for the SSH commit-signing decision core (#2938).
// Run: node --test orchestrator/commit-signing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  signingIdentityOf,
  signingKeyIndex,
  selectTeamSigningKeyId,
  resolveSigningKey,
  buildSigningGitConfig,
  withGitConfigEnv,
  isUnsignedCommitRejection,
  extractRejectedCommits,
  UNSIGNED_HINT_OPERATIONS,
  ghUnsignedOperation,
  buildUnsignedRejectionMessage,
} = require("./commit-signing");

const sig = (email, name = "Signer") => ({ name, email });

const INDEX = [
  { id: "auth-only", scope: "team", teamId: "t1" },
  { id: "alice-auth", scope: "personal", userId: "alice", identity: "human" },
  { id: "alice-sign", scope: "personal", userId: "alice", identity: "human", signing: sig("alice@example.com", "Alice") },
  { id: "team-sign", scope: "team", teamId: "t1", identity: "service", signing: sig("bot@example.com", "Team Bot") },
  { id: "global-sign", scope: "system", global: true, identity: "service", signing: sig("svc@example.com", "Service") },
];

test("signingIdentityOf: only a well-formed name + email is a signing identity", () => {
  assert.deepEqual(signingIdentityOf({ signing: sig(" a@b.co ", " A ") }), { name: "A", email: "a@b.co" });
  assert.equal(signingIdentityOf({}), null);
  assert.equal(signingIdentityOf({ signing: { name: "A" } }), null);
  assert.equal(signingIdentityOf({ signing: { name: "A", email: "not-an-email" } }), null);
  assert.equal(signingIdentityOf({ signing: { name: "A\nB", email: "a@b.co" } }), null);
  assert.equal(signingIdentityOf({ signing: { name: "A", email: "a b@c.co" } }), null);
});

test("signingKeyIndex keeps only signing-capable keys", () => {
  assert.deepEqual(signingKeyIndex(INDEX).map((k) => k.id), ["alice-sign", "team-sign", "global-sign"]);
  assert.deepEqual(signingKeyIndex(null), []);
});

test("selectTeamSigningKeyId: repo-bound key first, then team-scoped, then a system key assigned to the team", () => {
  const keys = signingKeyIndex([
    ...INDEX,
    { id: "repo-key", scope: "team", teamId: "t9", signing: sig("r@example.com") },
    { id: "assigned", scope: "system", assignedTeamIds: ["t2"], signing: sig("s@example.com") },
  ]);
  assert.equal(selectTeamSigningKeyId(keys, { teamId: "t1", repositories: [{ sshKeyId: "repo-key" }] }), "repo-key");
  assert.equal(selectTeamSigningKeyId(keys, { teamId: "t1", repositories: [{ sshKeyId: "auth-only" }] }), "team-sign");
  assert.equal(selectTeamSigningKeyId(keys, { teamId: "t2" }), "assigned");
  assert.equal(selectTeamSigningKeyId(keys, { teamId: "nobody" }), null);
  assert.equal(selectTeamSigningKeyId(keys, null), null);
  // A personal key bound to a repo is never the TEAM key.
  assert.equal(selectTeamSigningKeyId(keys, { teamId: "x", repositories: [{ sshKeyId: "alice-sign" }] }), null);
});

test("resolveSigningKey: personal → team → global, never refusing (AC3)", () => {
  const env = { teamId: "t1" };
  const personal = resolveSigningKey({ index: INDEX, ownerId: "alice", env });
  assert.equal(personal.source, "personal");
  assert.equal(personal.keyId, "alice-sign");
  assert.deepEqual(personal.identity, { name: "Alice", email: "alice@example.com" });

  // Bob has no personal signing key → the team key, never a refusal.
  const team = resolveSigningKey({ index: INDEX, ownerId: "bob", env });
  assert.equal(team.source, "team");
  assert.equal(team.keyId, "team-sign");

  // No team key → the global service signing key.
  const global = resolveSigningKey({ index: INDEX, ownerId: "bob", env: { teamId: "other" } });
  assert.equal(global.source, "global");
  assert.equal(global.keyId, "global-sign");

  // Nothing anywhere → none (commits stay unsigned, as before).
  const none = resolveSigningKey({ index: [INDEX[0], INDEX[1]], ownerId: "alice", env });
  assert.equal(none.source, "none");
  assert.equal(none.keyId, null);
  assert.equal(none.identity, null);
});

test("resolveSigningKey: an orphaned owner's personal key is skipped", () => {
  const liveUsers = { known: true, isLive: (u) => u !== "alice" };
  const r = resolveSigningKey({ index: INDEX, ownerId: "alice", env: { teamId: "t1" }, liveUsers });
  assert.equal(r.source, "team");
});

test("buildSigningGitConfig signs as the key's identity via committer.*, never user.*", () => {
  const pairs = buildSigningGitConfig({
    identity: { name: "Bot", email: "bot@example.com" },
    signingKey: "/keys/k",
    program: "/usr/local/bin/aee-ssh-sign",
    label: "team key 'k'",
  });
  const map = Object.fromEntries(pairs);
  assert.equal(map["gpg.format"], "ssh");
  assert.equal(map["commit.gpgsign"], "true");
  assert.equal(map["user.signingkey"], "/keys/k");
  assert.equal(map["committer.email"], "bot@example.com");
  assert.equal(map["committer.name"], "Bot");
  assert.equal(map["gpg.ssh.program"], "/usr/local/bin/aee-ssh-sign");
  assert.equal(map["aee.signingkeylabel"], "team key 'k'");
  assert.equal("user.email" in map, false);
  assert.deepEqual(buildSigningGitConfig({ identity: null, signingKey: "/k" }), []);
  assert.deepEqual(buildSigningGitConfig({ identity: { name: "a", email: "a@b.co" } }), []);
});

test("withGitConfigEnv appends after existing GIT_CONFIG entries without mutating the input", () => {
  const base = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.x", GIT_CONFIG_VALUE_0: "y", PATH: "/bin" };
  const out = withGitConfigEnv(base, [["gpg.format", "ssh"], ["commit.gpgsign", "true"]]);
  assert.equal(out.GIT_CONFIG_COUNT, "3");
  assert.equal(out.GIT_CONFIG_KEY_0, "http.x");
  assert.equal(out.GIT_CONFIG_KEY_1, "gpg.format");
  assert.equal(out.GIT_CONFIG_VALUE_2, "true");
  assert.equal(base.GIT_CONFIG_COUNT, "1");
  assert.deepEqual(withGitConfigEnv({ A: "1" }, []), { A: "1" });
  assert.equal(withGitConfigEnv({}, [["a.b", "c"]]).GIT_CONFIG_COUNT, "1");
});

const GH013 = [
  "remote: error: GH013: Repository rule violations found for refs/heads/feat/x.",
  "remote: Review all repository rules at https://github.com/o/r/rules?ref=refs%2Fheads%2Ffeat%2Fx",
  "remote: ",
  "remote: - Commits must have verified signatures.",
  "remote:   Found 2 violations:",
  "remote: ",
  "remote:   0123456789abcdef0123456789abcdef01234567",
  "remote:   89abcdef0123456789abcdef0123456789abcdef",
  " ! [remote rejected] feat/x -> feat/x (push declined due to repository rule violations)",
].join("\n");

test("isUnsignedCommitRejection recognises push, protection and merge phrasings only", () => {
  assert.equal(isUnsignedCommitRejection(GH013), true);
  assert.equal(isUnsignedCommitRejection("remote: error: GH006: Protected branch update failed\nremote: error: Commits must have verified signatures."), true);
  assert.equal(isUnsignedCommitRejection("GraphQL: Base branch requires signed commits (mergePullRequest)"), true);
  assert.equal(isUnsignedCommitRejection("! [rejected] x -> x (non-fast-forward)"), false);
  assert.equal(isUnsignedCommitRejection("Permission denied (publickey)."), false);
  assert.equal(isUnsignedCommitRejection(null), false);
});

test("ghUnsignedOperation: only gh pr merge / update-branch get the merge-side message (AC8)", () => {
  assert.equal(ghUnsignedOperation(["pr", "merge", "5", "--squash"]), "merge");
  assert.equal(ghUnsignedOperation(["pr", "update-branch", "5"]), "update-branch");
  assert.equal(ghUnsignedOperation(["pr", "create", "--title", "t"]), null);
  assert.equal(ghUnsignedOperation(["api", "repos/o/r/pulls/5/merge"]), null);
  assert.equal(ghUnsignedOperation(["pr"]), null);
  assert.equal(ghUnsignedOperation(null), null);
  assert.deepEqual(UNSIGNED_HINT_OPERATIONS, ["push", "PR", "merge", "update-branch"]);
});

test("buildUnsignedRejectionMessage names a merge rejection", () => {
  const msg = buildUnsignedRejectionMessage({ operation: "merge", signing: { source: "none" }, pushScope: "team" });
  assert.match(msg, /^GitHub rejected this merge: /);
  assert.match(msg, /team credential/);
});

test("extractRejectedCommits lists the full SHAs once", () => {
  assert.deepEqual(extractRejectedCommits(GH013 + "\n" + GH013), [
    "0123456789abcdef0123456789abcdef01234567",
    "89abcdef0123456789abcdef0123456789abcdef",
  ]);
  assert.deepEqual(extractRejectedCommits(""), []);
});

test("buildUnsignedRejectionMessage names cause, missing scope, commits and the fix (AC8)", () => {
  const msg = buildUnsignedRejectionMessage({
    operation: "push",
    signing: { source: "none" },
    pushScope: "personal",
    ownerLabel: "Alice",
    commits: extractRejectedCommits(GH013),
  });
  assert.match(msg, /requires signed commits/);
  assert.match(msg, /personal \(Alice\) credential/);
  assert.match(msg, /0123456789ab, 89abcdef0123/);
  assert.match(msg, /\/ssh-keys/);
  assert.match(msg, /"Signing Key"/);
  assert.match(msg, /VERIFIED email/);
  assert.match(msg, /git rebase --force-rebase/);

  const withKey = buildUnsignedRejectionMessage({
    operation: "PR",
    signing: { source: "team", keyId: "team-sign", identity: { email: "bot@example.com" } },
  });
  assert.match(withKey, /team signing key 'team-sign' as bot@example.com/);
  assert.doesNotMatch(withKey, /Affected commits/);
});
