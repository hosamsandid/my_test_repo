"use strict";

// #2066 AC16/AC18, the no-data-loss guard.
//
// A source-reading drift guard (#651 convention) over the propagation path,
// because the requirement is the ABSENCE of a category of operation and no
// behavioural test can prove an absence: an `adjustRepoClone` that grew a
// `git checkout -f` would still pass every test in repo-sync.test.js, since
// that module injects `adjust` as a stub.
//
// The rule is the hard constraint of the whole ticket. A checkout in an agent's
// workspace may hold the only copy of someone's work, so the reconciliation is
// allowed to fail — reported as a skip or a per-repository failure — but is
// never allowed to discard.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ORCHESTRATOR = path.join(__dirname, "orchestrator.js");

// The propagation's own git surface: adjustRepoClone plus the two read-only
// probes it is driven by. Scoped to that region rather than the whole file,
// because orchestrator.js legitimately contains a destructive `reset --hard`
// elsewhere (the operator-invoked reset-repos route, which is a different
// feature with its own confirmation).
// Comments are stripped first: a guard that reads raw source is satisfied by a
// comment merely NAMING the thing it looks for, which is how a mutation that
// leaves an explanatory note behind slips past it.
function code(file) {
  return fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function propagationRegion() {
  const src = code(ORCHESTRATOR);
  const start = src.indexOf("function adjustRepoClone(");
  assert.ok(start > 0, "adjustRepoClone must exist — the propagation executor was renamed or removed");
  const end = src.indexOf("\nfunction ", start + 10);
  assert.ok(end > start, "adjustRepoClone must be followed by another top-level function");
  return src.slice(start, end);
}

test("the adjust path runs no operation that can discard work", () => {
  const region = propagationRegion();
  const forbidden = [
    [/\bstash\b/, "git stash moves work out of the tree — a run the user did not watch could hide it"],
    [/\breset\b/, "git reset can drop commits or staged work"],
    // Matched as its own argv token, because the call is
    // run(["checkout", "-f", branch]) — a `checkout\s*-f` pattern never fires.
    [/"(-f|--force|--hard|--force-with-lease)"/, "a forced operation overwrites or rewrites work in the tree"],
    [/\bclean\b/, "git clean deletes untracked files, which exist nowhere else"],
    [/\brestore\b/, "git restore discards working-tree changes"],
    [/rmSync|unlinkSync|rmdirSync/, "nothing in the propagation may delete from a workspace"],
  ];
  for (const [pattern, why] of forbidden) {
    assert.ok(!pattern.test(region), `adjustRepoClone must not use ${pattern}: ${why}`);
  }
});

test("the adjust path moves a branch only with --ff-only", () => {
  const region = propagationRegion();
  // A fast-forward cannot rewrite history or drop a commit, so a local branch
  // that has diverged makes the merge REFUSE — which surfaces as a per-
  // repository failure rather than a silently rewritten checkout.
  assert.ok(
    /"merge",\s*"--ff-only"/.test(region),
    "the branch move must be `merge --ff-only`; a plain merge or a rebase could rewrite the checkout",
  );
  assert.ok(
    !/"pull"/.test(region),
    "git pull hides which merge strategy runs — spell out fetch + merge --ff-only",
  );
});

test("deps.adjust has exactly one call site, behind the D1 safety predicate", () => {
  const src = code(path.join(__dirname, "repo-sync.js"));
  const planAt = src.indexOf("function syncAgentRepoPlan(");
  assert.ok(planAt > 0, "syncAgentRepoPlan must exist");
  const plan = src.slice(planAt);
  assert.ok(
    plan.includes("cloneAdjustSafety(status)"),
    "the plan must consult cloneAdjustSafety",
  );
  // Exactly one call site is the assertion that carries the weight: a second
  // one is how a bypass would actually arrive, and no behavioural test can see
  // a path it is not driven down. The ORDER — checked before adjusted, not
  // after — is deliberately NOT asserted textually: a source-order assertion
  // is satisfied by any earlier textual occurrence (a wrapper, a comment) and
  // could not be made to fail on mutation. It is covered behaviourally instead,
  // by the "AC12/AC16 — an unsafe clone is left untouched" test in
  // repo-sync.test.js, whose injected `adjust` throws if it is ever reached.
  assert.equal(
    (plan.match(/deps\.adjust\(/g) || []).length, 1,
    "exactly one call site, so no second path can bypass the safety check",
  );
});

test("nothing in the propagation core removes a clone", () => {
  const src = code(path.join(__dirname, "repo-sync.js"));
  for (const pattern of [/deps\.remove/, /rmSync/, /unlinkSync/, /\bprune\b(?!.*fetch)/]) {
    assert.ok(!pattern.test(src), `repo-sync.js must not reference ${pattern} — pruning is out of scope forever`);
  }
  // A clone with no declared entry has exactly one outcome, and it is a report.
  assert.ok(
    /status: "retained"/.test(src),
    "an undeclared clone must be reported as retained — the only thing left to do about it",
  );
});
