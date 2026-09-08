"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  ENVIRONMENT_SCOPE,
  AGENT_SCOPE,
  repoDirName,
  normalizeAgentRepository,
  normalizeAgentRepositories,
  envRepositories,
  resolveAgentRepositories,
  hasAnyRepository,
  repoTransport,
  credentialRefusal,
  planAgentRepoAttach,
  planAgentRepoDetach,
  removalFacts,
  attachAvailability,
} = require("./agent-repositories");

const { repoDirName: syncRepoDirName } = require("./repo-sync");

// ── the shared naming convention ────────────────────────────────────────────

test("repoDirName is literally repo-sync's — not a third copy", () => {
  assert.strictEqual(repoDirName, syncRepoDirName);
  assert.strictEqual(repoDirName("git@github.com:org/tools.git"), "tools");
  assert.strictEqual(repoDirName("https://github.com/org/tools"), "tools");
});

// ── shape ───────────────────────────────────────────────────────────────────

test("normalizeAgentRepository keeps exactly the environment card's four fields", () => {
  const entry = normalizeAgentRepository({
    url: "  git@github.com:org/docs.git  ",
    branch: " develop ",
    sshKeyId: " key-1 ",
    readOnly: true,
    // D5: no per-repository credential may enter the config through this door.
    token: "ghp_secret",
    password: "hunter2",
    scope: "environment",
  });
  assert.deepStrictEqual(entry, {
    url: "git@github.com:org/docs.git",
    branch: "develop",
    sshKeyId: "key-1",
    readOnly: true,
  });
});

test("normalizeAgentRepository omits readOnly when off, so a pre-#2067 config is byte-identical", () => {
  const entry = normalizeAgentRepository({ url: "git@github.com:org/a.git", readOnly: false });
  assert.deepStrictEqual(entry, { url: "git@github.com:org/a.git", branch: null, sshKeyId: null });
  assert.ok(!("readOnly" in entry));
});

test("normalizeAgentRepository rejects everything without a url", () => {
  for (const bad of [null, undefined, 42, "string", {}, { url: "" }, { url: "   " }]) {
    assert.strictEqual(normalizeAgentRepository(bad), null);
  }
});

test("normalizeAgentRepositories drops junk and collapses a duplicated url", () => {
  const list = normalizeAgentRepositories([
    { url: "git@github.com:org/a.git" },
    null,
    { branch: "main" },
    { url: "git@github.com:org/a.git", branch: "other" },
    { url: "git@github.com:org/b.git" },
  ]);
  assert.deepStrictEqual(list.map((r) => r.url), [
    "git@github.com:org/a.git",
    "git@github.com:org/b.git",
  ]);
});

test("normalizeAgentRepositories tolerates a non-array", () => {
  assert.deepStrictEqual(normalizeAgentRepositories(undefined), []);
  assert.deepStrictEqual(normalizeAgentRepositories("nope"), []);
});

test("envRepositories tolerates the repo-less and legacy-shaped env", () => {
  assert.deepStrictEqual(envRepositories(null), []);
  assert.deepStrictEqual(envRepositories({ repositories: [] }), []);
  assert.deepStrictEqual(envRepositories({ repository: { url: "x" } }), []);
  assert.deepStrictEqual(
    envRepositories({ repositories: [{ url: "u" }, { url: " " }, {}] }).map((r) => r.url),
    ["u"],
  );
});

// ── the merged view (AC7 / AC8) ──────────────────────────────────────────────

test("resolveAgentRepositories tags scope and removability, environment first", () => {
  const env = { repositories: [{ url: "git@github.com:org/app.git", branch: "main", readOnly: false }] };
  const resolved = resolveAgentRepositories(env, [
    { url: "git@github.com:org/docs.git", readOnly: true },
  ]);
  assert.strictEqual(resolved.length, 2);
  assert.strictEqual(resolved[0].scope, ENVIRONMENT_SCOPE);
  assert.strictEqual(resolved[0].removable, false, "AC8: an inherited repo is never removable here");
  assert.strictEqual(resolved[0].dirName, "app");
  assert.strictEqual(resolved[1].scope, AGENT_SCOPE);
  assert.strictEqual(resolved[1].removable, true);
  assert.strictEqual(resolved[1].readOnly, true);
  assert.strictEqual(resolved[1].dirName, "docs");
});

test("resolveAgentRepositories marks an agent entry the environment later shadowed", () => {
  // The environment added org-b/tools AFTER the agent attached org-a/tools.
  const env = { repositories: [{ url: "git@github.com:org-b/tools.git" }] };
  const resolved = resolveAgentRepositories(env, [{ url: "git@github.com:org-a/tools.git" }]);
  assert.strictEqual(resolved[0].shadowed, false);
  assert.strictEqual(resolved[1].shadowed, true);
  assert.strictEqual(resolved[1].dirName, "tools");
});

test("resolveAgentRepositories on a repo-less environment lists only the agent's own", () => {
  const resolved = resolveAgentRepositories(null, [{ url: "git@github.com:org/x.git" }]);
  assert.deepStrictEqual(resolved.map((r) => r.scope), [AGENT_SCOPE]);
});

test("hasAnyRepository is the AC14 gate: either scope counts", () => {
  assert.strictEqual(hasAnyRepository(null, []), false);
  assert.strictEqual(hasAnyRepository({ repositories: [] }, []), false);
  assert.strictEqual(hasAnyRepository({ repositories: [{ url: "u" }] }, []), true);
  // The whole point: a repo-less environment plus one attachment.
  assert.strictEqual(hasAnyRepository({ repositories: [] }, [{ url: "u" }]), true);
  assert.strictEqual(hasAnyRepository(null, [{ url: "u" }]), true);
});

// ── credentials (D5 / AC19) ─────────────────────────────────────────────────

test("repoTransport mirrors cloneRepository's URL-driven choice", () => {
  assert.strictEqual(repoTransport("git@github.com:org/a.git"), "ssh");
  assert.strictEqual(repoTransport("ssh://git@example.com/a.git"), "ssh");
  assert.strictEqual(repoTransport("https://github.com/org/a"), "https-github");
  assert.strictEqual(repoTransport("https://www.github.com/org/a"), "https-github");
  assert.strictEqual(repoTransport("https://gitlab.com/org/a"), "https");
  assert.strictEqual(repoTransport("/local/path"), "other");
});

test("an SSH URL with no key is refused and told a token will not help", () => {
  const refusal = credentialRefusal(
    { url: "git@github.com:org/a.git" },
    { sshKeyIds: ["key-1"], hasGithubToken: true },
  );
  assert.strictEqual(refusal.code, "ssh-key-required");
  assert.match(refusal.message, /SSH key/);
  assert.match(refusal.message, /GitHub token does not authenticate an SSH/);
});

test("an SSH URL naming a key that left the registry is refused by name", () => {
  const refusal = credentialRefusal(
    { url: "git@github.com:org/a.git", sshKeyId: "gone" },
    { sshKeyIds: ["key-1"] },
  );
  assert.strictEqual(refusal.code, "ssh-key-missing");
  assert.match(refusal.message, /`gone`/);
});

test("an SSH URL with a registered key passes", () => {
  assert.strictEqual(
    credentialRefusal({ url: "git@github.com:org/a.git", sshKeyId: "key-1" }, { sshKeyIds: ["key-1"] }),
    null,
  );
});

test("AC19: HTTPS GitHub with no environment token is refused, naming the credential tried", () => {
  const refusal = credentialRefusal(
    { url: "https://github.com/org/a" },
    { sshKeyIds: ["key-1"], hasGithubToken: false },
  );
  assert.strictEqual(refusal.code, "github-token-required");
  assert.match(refusal.message, /no GitHub token/);
  assert.match(refusal.message, /SSH keys do not authenticate HTTPS/);
});

test("HTTPS GitHub with a token passes, and non-GitHub HTTPS is never pre-refused", () => {
  assert.strictEqual(
    credentialRefusal({ url: "https://github.com/org/a" }, { hasGithubToken: true }),
    null,
  );
  // cloneRepository only pre-refuses HTTPS *github.com*; a public GitLab URL
  // clones anonymously, so refusing it here would diverge from the clone path.
  assert.strictEqual(credentialRefusal({ url: "https://gitlab.com/org/a" }, {}), null);
});

// ── attach (AC13 / AC19) ────────────────────────────────────────────────────

const ENV = { repositories: [{ url: "git@github.com:org/app.git" }], githubTokenId: "tok" };
const CREDS = { sshKeyIds: ["key-1"], hasGithubToken: true };

test("a clean attach returns the normalized entry and the appended list", () => {
  const plan = planAgentRepoAttach({
    env: ENV,
    agentRepositories: [],
    repo: { url: "git@github.com:org/docs.git", sshKeyId: "key-1", branch: "" },
    credentials: CREDS,
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.dirName, "docs");
  assert.deepStrictEqual(plan.repo, { url: "git@github.com:org/docs.git", branch: null, sshKeyId: "key-1" });
  assert.deepStrictEqual(plan.agentRepositories.map((r) => r.url), ["git@github.com:org/docs.git"]);
});

test("attach requires a url", () => {
  const plan = planAgentRepoAttach({ env: ENV, agentRepositories: [], repo: { url: "  " } });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.code, "url-required");
});

test("attaching the same url twice is refused", () => {
  const plan = planAgentRepoAttach({
    env: ENV,
    agentRepositories: [{ url: "git@github.com:org/docs.git" }],
    repo: { url: "git@github.com:org/docs.git", sshKeyId: "key-1" },
    credentials: CREDS,
  });
  assert.strictEqual(plan.code, "already-attached");
});

test("attaching what the environment already declares is refused, not duplicated", () => {
  const plan = planAgentRepoAttach({
    env: ENV,
    agentRepositories: [],
    repo: { url: "git@github.com:org/app.git", sshKeyId: "key-1" },
    credentials: CREDS,
  });
  assert.strictEqual(plan.code, "environment-declares-repo");
});

test("AC13: the three directory-name collisions are told apart", () => {
  const envClash = planAgentRepoAttach({
    env: { repositories: [{ url: "git@github.com:org-b/tools.git" }] },
    agentRepositories: [],
    repo: { url: "git@github.com:org-a/tools.git", sshKeyId: "key-1" },
    credentials: CREDS,
  });
  assert.strictEqual(envClash.code, "dir-name-taken-by-environment");
  assert.match(envClash.message, /org-b\/tools/);

  const agentClash = planAgentRepoAttach({
    env: null,
    agentRepositories: [{ url: "git@github.com:org-b/tools.git" }],
    repo: { url: "git@github.com:org-a/tools.git", sshKeyId: "key-1" },
    credentials: CREDS,
  });
  assert.strictEqual(agentClash.code, "dir-name-taken-by-agent-repo");

  const folderClash = planAgentRepoAttach({
    env: null,
    agentRepositories: [],
    repo: { url: "git@github.com:org-a/tools.git", sshKeyId: "key-1" },
    occupiedNames: ["memory", "tools", "skills"],
    credentials: CREDS,
  });
  assert.strictEqual(folderClash.code, "dir-name-occupied");
  assert.match(folderClash.message, /Nothing was cloned/);
});

test("AC19: the credential refusal happens before any clone is planned", () => {
  const plan = planAgentRepoAttach({
    env: { repositories: [] },
    agentRepositories: [],
    repo: { url: "https://github.com/org/private" },
    credentials: { sshKeyIds: ["key-1"], hasGithubToken: false },
  });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.code, "github-token-required");
  assert.strictEqual(plan.agentRepositories, undefined, "nothing to write on a refusal");
});

test("a collision is reported before a credential problem, so the actionable fix comes first", () => {
  const plan = planAgentRepoAttach({
    env: { repositories: [{ url: "git@github.com:org-b/tools.git" }] },
    agentRepositories: [],
    repo: { url: "https://github.com/org-a/tools" },
    credentials: { hasGithubToken: false },
  });
  assert.strictEqual(plan.code, "dir-name-taken-by-environment");
});

// ── detach (AC8 / AC9 + the environment-caught-up edge case) ────────────────

test("detaching an agent-scoped repository deletes the working copy", () => {
  const plan = planAgentRepoDetach({
    env: ENV,
    agentRepositories: [{ url: "git@github.com:org/docs.git" }],
    url: "git@github.com:org/docs.git",
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.dirName, "docs");
  assert.strictEqual(plan.deleteWorkingCopy, true);
  assert.strictEqual(plan.keptReason, null);
  assert.deepStrictEqual(plan.agentRepositories, []);
});

test("AC8: an inherited repository is refused with the environment named as the place to change it", () => {
  const plan = planAgentRepoDetach({
    env: ENV,
    agentRepositories: [],
    url: "git@github.com:org/app.git",
  });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.code, "environment-repository");
  assert.match(plan.message, /Working Environment/);
});

test("an unknown url is a refusal, not a silent success", () => {
  const plan = planAgentRepoDetach({ env: ENV, agentRepositories: [], url: "git@github.com:org/nope.git" });
  assert.strictEqual(plan.code, "not-attached");
});

test("detach requires a url", () => {
  assert.strictEqual(planAgentRepoDetach({ env: ENV, agentRepositories: [] }).code, "url-required");
});

test("edge case: when the environment now declares the same directory, the working copy is KEPT", () => {
  const plan = planAgentRepoDetach({
    // Same directory name (`tools`) reached from a different URL — the
    // environment caught up after the attachment.
    env: { repositories: [{ url: "git@github.com:org-b/tools.git" }] },
    agentRepositories: [{ url: "git@github.com:org-a/tools.git" }],
    url: "git@github.com:org-a/tools.git",
  });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.deleteWorkingCopy, false, "must not delete a repo the environment declares");
  assert.match(plan.keptReason, /kept/);
  assert.deepStrictEqual(plan.agentRepositories, []);
});

// ── removal confirmation (AC9) ──────────────────────────────────────────────

test("removalFacts names uncommitted changes and unpushed commits concretely", () => {
  const facts = removalFacts({
    exists: true,
    ahead: 3,
    dirty: { staged: 1, unstaged: 2, untracked: 1, files: [{}, {}, {}, {}] },
  });
  assert.strictEqual(facts.state, "dirty");
  assert.strictEqual(facts.clean, false);
  assert.strictEqual(facts.uncommittedFiles, 4);
  assert.strictEqual(facts.unpushedCommits, 3);
  assert.match(facts.lines[0], /4 uncommitted changes/);
  assert.match(facts.lines[0], /1 staged, 2 unstaged, 1 untracked/);
  assert.match(facts.lines[1], /3 commits have not been pushed/);
});

test("removalFacts singularises one change and one commit", () => {
  const facts = removalFacts({ exists: true, ahead: 1, dirty: { staged: 1, files: [{}] } });
  assert.match(facts.lines[0], /1 uncommitted change\b/);
  assert.match(facts.lines[1], /1 commit has not been pushed/);
});

test("AC9: a clean working copy says so rather than leaving it to inference", () => {
  const facts = removalFacts({ exists: true, ahead: 0, dirty: { staged: 0, unstaged: 0, untracked: 0, files: [] } });
  assert.strictEqual(facts.state, "clean");
  assert.strictEqual(facts.clean, true);
  assert.match(facts.lines[0], /clean and fully pushed/);
});

test("removalFacts is honest about an absent or unreadable working copy", () => {
  const absent = removalFacts(null);
  assert.strictEqual(absent.state, "absent");
  assert.deepStrictEqual(absent.lines, []);

  const unknown = removalFacts({ exists: true, error: "not a git repository" });
  assert.strictEqual(unknown.state, "unknown");
  assert.strictEqual(unknown.clean, false);
  assert.match(unknown.lines[0], /could not be read/);
});

// ── where the action is offered (AC16 / AC17) ───────────────────────────────

test("AC16: a team record and a stub are disabled WITH a reason, never silently absent", () => {
  const team = attachAvailability({ role: "team" });
  assert.strictEqual(team.canAttach, false);
  assert.match(team.reason, /no container and no workspace/);

  const stub = attachAvailability({ role: "team-member", materialized: false });
  assert.strictEqual(stub.canAttach, false);
  assert.match(stub.reason, /Materialize it first/);
});

test("AC12: a chat-only user gets no action on either surface", () => {
  const readOnly = attachAvailability({ role: "agent", canManage: false });
  assert.strictEqual(readOnly.canAttach, false);
  assert.strictEqual(readOnly.canRemove, false);
  assert.match(readOnly.reason, /permission/);
});

test("AC17: a running session is safe to attach into but not to remove from, and says why", () => {
  const busy = attachAvailability({ role: "agent", busy: true });
  assert.strictEqual(busy.canAttach, true, "additive clone, the #1342 precedent");
  assert.strictEqual(busy.canRemove, false, "removal deletes files under a live run");
  assert.match(busy.reason, /running a session/);
});

test("an ordinary idle agent may do both", () => {
  assert.deepStrictEqual(attachAvailability({ role: "agent" }), {
    canAttach: true,
    canRemove: true,
    reason: null,
  });
  assert.deepStrictEqual(attachAvailability(), { canAttach: true, canRemove: true, reason: null });
});
