"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  repoDirName,
  cloneAdjustSafety,
  repoAdjustments,
  repoDivergence,
  syncAgentRepoPlan,
  summarizeRepoResults,
} = require("./repo-sync");

// A clone that is present, clean, fully pushed, on the declared branch and
// whose 'origin' still matches its own directory name — i.e. the one state
// cloneAdjustSafety() clears. Tests override single fields off this baseline so
// each one names exactly the fact under test.
function status(over = {}) {
  return {
    name: "widgets",
    url: "https://github.com/acme/widgets.git",
    exists: true,
    branchActual: "main",
    remoteUrl: "https://github.com/acme/widgets.git",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: { staged: 0, unstaged: 0, untracked: 0, files: [] },
    error: null,
    ...over,
  };
}

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
      statuses: [status()],
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
      statuses: [],
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
    { statuses: [], clone: () => ({ skipped: true }) },
  );
  assert.deepEqual(results, [
    {
      name: "widgets",
      url: "https://github.com/acme/widgets.git",
      status: "skipped",
      reason: "path-occupied",
      detail: "a folder that is not a git checkout already occupies that path",
      blocked: true,
    },
  ]);
});

test("a clone failure is captured per-repo and does not abort the others", () => {
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/bad.git" }, { url: "https://github.com/acme/good.git" }],
    {
      statuses: [],
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
    { statuses: [], clone: () => ({ skipped: false }) },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "widgets");
});

test("non-array repositories yield an empty plan", () => {
  assert.deepEqual(syncAgentRepoPlan(null, { statuses: [], clone: () => ({}) }), []);
  assert.deepEqual(syncAgentRepoPlan(undefined, { statuses: [], clone: () => ({}) }), []);
});

test("summarizeRepoResults counts each status", () => {
  const results = [
    { status: "cloned" },
    { status: "cloned" },
    { status: "skipped" },
    { status: "failed" },
  ];
  // `retained` is excluded from `total`: it is not a declared repository, so
  // counting it would inflate "3 of 4 done" with a row nothing acts on.
  assert.deepEqual(
    summarizeRepoResults([
      { status: "adjusted" },
      { status: "skipped", blocked: true },
      { status: "retained" },
    ]),
    { total: 2, cloned: 0, adjusted: 1, skipped: 1, blocked: 1, failed: 0, retained: 1 },
  );
  const zero = { total: 0, cloned: 0, adjusted: 0, skipped: 0, blocked: 0, failed: 0, retained: 0 };
  assert.deepEqual(summarizeRepoResults(results), {
    total: 4, cloned: 2, adjusted: 0, skipped: 1, blocked: 0, failed: 1, retained: 0,
  });
  assert.deepEqual(summarizeRepoResults([]), zero);
  assert.deepEqual(summarizeRepoResults(null), zero);
});

// ── D1: cloneAdjustSafety (#2066 AC28) ─────────────────────────────────────
//
// Every branch is a reason NOT to touch a clone. They are tested one field at a
// time off the safe baseline, because the value of this predicate is entirely
// in which single fact makes it say no.

test("a clean, pushed clone on a matching remote is safe to adjust", () => {
  assert.deepEqual(cloneAdjustSafety(status()), { safe: true });
});

test("an absent or unreadable clone is never adjusted", () => {
  assert.equal(cloneAdjustSafety(null).reason, "not-cloned");
  assert.equal(cloneAdjustSafety(status({ exists: false })).reason, "not-cloned");
  const broken = cloneAdjustSafety(status({ error: "git rev-parse failed" }));
  assert.equal(broken.reason, "status-unreadable");
  assert.match(broken.detail, /git rev-parse failed/);
});

test("uncommitted work blocks the adjustment and the reason names what kind", () => {
  const staged = cloneAdjustSafety(status({ dirty: { staged: 2, unstaged: 0, untracked: 0 } }));
  assert.equal(staged.safe, false);
  assert.equal(staged.reason, "uncommitted-changes");
  assert.match(staged.detail, /2 staged/);
  assert.match(staged.detail, /commit or discard/);

  const mixed = cloneAdjustSafety(status({ dirty: { staged: 1, unstaged: 3, untracked: 5 } }));
  assert.match(mixed.detail, /1 staged, 3 modified, 5 untracked files/);

  // Untracked files alone are enough — they are work that exists nowhere else.
  assert.equal(cloneAdjustSafety(status({ dirty: { untracked: 1 } })).reason, "uncommitted-changes");
});

test("a clean but UNPUSHED clone is not safe — the commits exist only there", () => {
  const ahead = cloneAdjustSafety(status({ ahead: 3 }));
  assert.equal(ahead.reason, "unpushed-commits");
  assert.match(ahead.detail, /3 commits not pushed/);

  assert.equal(cloneAdjustSafety(status({ upstream: null, ahead: null })).reason, "no-upstream");
  assert.equal(cloneAdjustSafety(status({ ahead: null })).reason, "upstream-unknown");
});

test("a detached HEAD is not safe — there is no branch to move", () => {
  assert.equal(cloneAdjustSafety(status({ branchActual: "HEAD" })).reason, "detached-head");
});

test("a clone whose remote was repointed by hand is not safe (foreign-remote)", () => {
  // The platform always clones into repoDirName(url), so a folder called
  // 'widgets' whose origin ends in 'something-else' can only have been
  // repointed by a person — adjusting it would overwrite that decision.
  const foreign = cloneAdjustSafety(status({ remoteUrl: "git@github.com:acme/something-else.git" }));
  assert.equal(foreign.reason, "foreign-remote");
  assert.match(foreign.detail, /something-else/);
  assert.match(foreign.detail, /repoint it by hand/);

  // A DIFFERENT URL that still derives the same directory name is the D1b
  // same-directory case and stays safe — that is the whole point.
  assert.equal(cloneAdjustSafety(status({ remoteUrl: "git@newhost.com:newco/widgets.git" })).safe, true);

  assert.equal(cloneAdjustSafety(status({ remoteUrl: null })).reason, "no-remote");
});

// ── repoAdjustments: what actually has to change ────────────────────────────

test("a clone already matching its declared entry needs no adjustment", () => {
  const repo = { url: "https://github.com/acme/widgets.git", branch: "main" };
  assert.equal(repoAdjustments(repo, status()), null);
});

test("a blank declared branch never forces a checkout", () => {
  // Blank means "the repository's own default branch", which the clone already
  // has — treating it as a change would move every clone on every save.
  const repo = { url: "https://github.com/acme/widgets.git", branch: "" };
  assert.equal(repoAdjustments(repo, status({ branchActual: "trunk" })), null);
});

test("a changed branch and a changed URL are reported independently", () => {
  const url = "https://github.com/acme/widgets.git";
  assert.deepEqual(
    repoAdjustments({ url, branch: "develop" }, status()),
    { setUrl: null, checkoutBranch: "develop" },
  );
  assert.deepEqual(
    repoAdjustments({ url: "git@github.com:newco/widgets.git", branch: "main" }, status()),
    { setUrl: "git@github.com:newco/widgets.git", checkoutBranch: null },
  );
  assert.deepEqual(
    repoAdjustments({ url: "git@github.com:newco/widgets.git", branch: "develop" }, status()),
    { setUrl: "git@github.com:newco/widgets.git", checkoutBranch: "develop" },
  );
});

test("readOnly is not a workspace difference, so it never needs an adjustment", () => {
  const repo = { url: "https://github.com/acme/widgets.git", branch: "main", readOnly: true };
  assert.equal(repoAdjustments(repo, status()), null);
});

// ── D4: repoDivergence (#2066 AC19/AC20) ───────────────────────────────────

test("a declared repository with no clone is divergence", () => {
  assert.deepEqual(
    repoDivergence([{ url: "https://github.com/acme/widgets.git" }], []),
    [{ name: "widgets", url: "https://github.com/acme/widgets.git", kind: "missing" }],
  );
  assert.deepEqual(
    repoDivergence([{ url: "https://github.com/acme/widgets.git" }], [status({ exists: false })]),
    [{ name: "widgets", url: "https://github.com/acme/widgets.git", kind: "missing" }],
  );
});

test("a clone whose branch or remote differs is divergence, and says which", () => {
  const url = "https://github.com/acme/widgets.git";
  assert.deepEqual(
    repoDivergence([{ url, branch: "develop" }], [status()]),
    [{ name: "widgets", url, kind: "branch" }],
  );
  assert.deepEqual(
    repoDivergence([{ url: "git@github.com:newco/widgets.git", branch: "main" }], [status()]),
    [{ name: "widgets", url: "git@github.com:newco/widgets.git", kind: "url" }],
  );
  assert.deepEqual(
    repoDivergence([{ url: "git@github.com:newco/widgets.git", branch: "develop" }], [status()]),
    [{ name: "widgets", url: "git@github.com:newco/widgets.git", kind: "url-and-branch" }],
  );
});

test("AC20 — a clone with NO declared entry is never divergence", () => {
  // Nothing is ever pruned, so it could never be brought "up to date" and
  // counting it would leave the indicator permanently lit.
  const orphan = status({ name: "retired", url: "git@github.com:acme/retired.git" });
  assert.deepEqual(repoDivergence([], [orphan]), []);
  assert.deepEqual(
    repoDivergence([{ url: "https://github.com/acme/widgets.git", branch: "main" }], [status(), orphan]),
    [],
    "the declared one matches and the undeclared one is ignored",
  );
});

test("an in-sync workspace diverges in nothing", () => {
  assert.deepEqual(
    repoDivergence([{ url: "https://github.com/acme/widgets.git", branch: "main" }], [status()]),
    [],
  );
  assert.deepEqual(repoDivergence(null, null), []);
});

// ── The adjust path through syncAgentRepoPlan ──────────────────────────────

test("a diverging clone that is safe is adjusted, never re-cloned", () => {
  const calls = [];
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/widgets.git", branch: "develop" }],
    {
      statuses: [status()],
      clone: () => { calls.push("clone"); return { skipped: false }; },
      adjust: (repo, st, plan) => {
        calls.push(["adjust", plan.setUrl, plan.checkoutBranch]);
        return { applied: ["fetched", "branch → develop"] };
      },
    },
  );
  assert.deepEqual(calls, [["adjust", null, "develop"]], "clone must never run for an existing checkout");
  assert.deepEqual(results, [{
    name: "widgets",
    url: "https://github.com/acme/widgets.git",
    status: "adjusted",
    applied: ["fetched", "branch → develop"],
  }]);
});

test("AC12/AC16 — an unsafe clone is left untouched and reported as a blocked skip", () => {
  let adjusted = false;
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/widgets.git", branch: "develop" }],
    {
      statuses: [status({ dirty: { staged: 0, unstaged: 2, untracked: 0 } })],
      clone: () => { throw new Error("clone must not run"); },
      adjust: () => { adjusted = true; return {}; },
    },
  );
  assert.equal(adjusted, false, "no git command may touch a dirty clone");
  assert.equal(results[0].status, "skipped");
  assert.equal(results[0].reason, "uncommitted-changes");
  assert.equal(results[0].blocked, true, "a D1 skip is distinguishable from an already-present one");
  assert.match(results[0].detail, /2 modified/);
});

test("a D1 skip is marked `blocked` and an already-present skip is not", () => {
  const url = "https://github.com/acme/widgets.git";
  const inSync = syncAgentRepoPlan([{ url, branch: "main" }], {
    statuses: [status()], clone: () => ({}), adjust: () => ({}),
  });
  assert.equal(inSync[0].reason, "already-present");
  assert.equal(inSync[0].blocked, undefined, "nothing to act on, so nothing to flag");
});

test("AC25 — an adjustment failure is per-repository and aborts nothing else", () => {
  const results = syncAgentRepoPlan(
    [
      { url: "https://github.com/acme/widgets.git", branch: "develop" },
      { url: "https://github.com/acme/docs.git" },
    ],
    {
      statuses: [status()],
      clone: () => ({ skipped: false }),
      adjust: () => { throw new Error("git merge failed: not a fast-forward"); },
    },
  );
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /not a fast-forward/);
  assert.equal(results[1].status, "cloned", "the next repository still runs");
});

test("AC15/AC18 — a clone with no declared entry is reported as retained, never removed", () => {
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/gadgets.git" }],
    {
      statuses: [],
      clone: () => ({ skipped: false }),
      adjust: () => ({}),
      listClones: () => ["widgets", "gadgets"],
    },
  );
  assert.deepEqual(results.map(r => [r.name, r.status]), [["gadgets", "cloned"], ["widgets", "retained"]]);
  assert.match(results[1].detail, /nothing is ever deleted/);
  assert.equal(results[1].url, null, "a retained clone has no declared entry to name a URL from");
});

test("listClones is optional — without it nothing is reported as retained", () => {
  const results = syncAgentRepoPlan(
    [{ url: "https://github.com/acme/widgets.git" }],
    { statuses: [], clone: () => ({ skipped: false }) },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "cloned");
});
