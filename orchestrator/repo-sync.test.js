"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { repoDirName, syncAgentRepoPlan, summarizeRepoResults } = require("./repo-sync");

test("repoDirName strips .git and takes the trailing path segment", () => {
  assert.equal(repoDirName("git@github.com:acme/widgets.git"), "widgets");
  assert.equal(repoDirName("https://github.com/acme/widgets.git"), "widgets");
  assert.equal(repoDirName("https://github.com/acme/widgets"), "widgets");
  assert.equal(repoDirName(""), "repo");
  assert.equal(repoDirName(null), "repo");
});

test("already-present repos are skipped and never cloned", () => {
  const cloned = [];
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/widgets.git" }],
    {
      hasGit: () => true,
      clone: (repo) => { cloned.push(repo); return { skipped: false }; },
    },
  );
  assert.equal(cloned.length, 0, "clone must not be called for an already-present repo");
  assert.deepEqual(results, [
    { name: "widgets", url: "https://github.com/acme/widgets.git", status: "skipped", reason: "already-present" },
  ]);
});

test("missing repos are cloned; fromCache is surfaced", () => {
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/widgets.git" }, { url: "git@github.com:acme/docs.git" }],
    {
      hasGit: () => false,
      clone: (repo) => (repo.url.includes("docs")
        ? { skipped: false, fromCache: true }
        : { skipped: false, fromCache: false }),
    },
  );
  assert.deepEqual(results, [
    { name: "widgets", url: "https://github.com/acme/widgets.git", status: "cloned", fromCache: false },
    { name: "docs", url: "git@github.com:acme/docs.git", status: "cloned", fromCache: true },
  ]);
});

test("a dir occupying the path without .git is skipped, not reported as cloned", () => {
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/widgets.git" }],
    { hasGit: () => false, clone: () => ({ skipped: true }) },
  );
  assert.deepEqual(results, [
    { name: "widgets", url: "https://github.com/acme/widgets.git", status: "skipped", reason: "path-occupied" },
  ]);
});

test("a clone failure is captured per-repo and does not abort the others", () => {
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/bad.git" }, { url: "https://github.com/acme/good.git" }],
    {
      hasGit: () => false,
      clone: (repo) => {
        if (repo.url.includes("bad")) throw new Error("git clone failed: auth");
        return { skipped: false };
      },
    },
  );
  assert.deepEqual(results, [
    { name: "bad", url: "https://github.com/acme/bad.git", status: "failed", error: "git clone failed: auth" },
    { name: "good", url: "https://github.com/acme/good.git", status: "cloned", fromCache: false },
  ]);
});

test("repos without a url are ignored entirely", () => {
  const results = syncAgentRepoPlan(
    [{ branch: "main" }, { url: "" }, { url: "https://github.com/acme/widgets.git" }],
    { hasGit: () => false, clone: () => ({ skipped: false }) },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "widgets");
});

test("non-array repositories yield an empty plan", () => {
  assert.deepEqual(syncAgentRepoPlan(null, { hasGit: () => false, clone: () => ({}) }), []);
  assert.deepEqual(syncAgentRepoPlan(undefined, { hasGit: () => false, clone: () => ({}) }), []);
});

test("summarizeRepoResults counts each status", () => {
  const results = [
    { status: "cloned" },
    { status: "cloned" },
    { status: "skipped" },
    { status: "failed" },
  ];
  assert.deepEqual(summarizeRepoResults(results), { total: 4, cloned: 2, skipped: 1, failed: 1 });
  assert.deepEqual(summarizeRepoResults([]), { total: 0, cloned: 0, skipped: 0, failed: 0 });
  assert.deepEqual(summarizeRepoResults(null), { total: 0, cloned: 0, skipped: 0, failed: 0 });
});
