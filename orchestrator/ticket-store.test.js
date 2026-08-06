"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseIssueRef,
  resolveRepoFullName,
  ticketFromIssue,
  isValidTicket,
  addChild,
} = require("./ticket-store");

test("parseIssueRef accepts a bare integer", () => {
  assert.deepEqual(parseIssueRef("123"), { kind: "number", number: 123 });
});

test("parseIssueRef accepts a #-prefixed integer", () => {
  assert.deepEqual(parseIssueRef("#42"), { kind: "number", number: 42 });
});

test("parseIssueRef trims surrounding whitespace", () => {
  assert.deepEqual(parseIssueRef("  7 "), { kind: "number", number: 7 });
});

test("parseIssueRef parses a github issue URL into owner/repo/number", () => {
  assert.deepEqual(parseIssueRef("https://github.com/acme/widgets/issues/1383"), {
    kind: "url",
    owner: "acme",
    repo: "widgets",
    number: 1383,
  });
});

test("parseIssueRef ignores a query/fragment suffix on a URL", () => {
  assert.deepEqual(parseIssueRef("https://github.com/a/b/issues/9?foo=1#note"), {
    kind: "url",
    owner: "a",
    repo: "b",
    number: 9,
  });
});

test("parseIssueRef honours a self-hosted host (only owner/repo/number matter)", () => {
  assert.deepEqual(parseIssueRef("https://ghe.corp.example/team/proj/issues/5"), {
    kind: "url",
    owner: "team",
    repo: "proj",
    number: 5,
  });
});

test("parseIssueRef rejects zero, negatives, non-numbers and junk", () => {
  for (const bad of ["0", "-3", "#0", "abc", "", "   ", null, undefined, 12, "12.5", "https://github.com/a/b/pull/3"]) {
    assert.equal(parseIssueRef(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("resolveRepoFullName: a URL ref always wins over explicit/env", () => {
  const parsed = { kind: "url", owner: "acme", repo: "widgets", number: 1 };
  assert.equal(
    resolveRepoFullName(parsed, { explicitRepo: "other/repo", envRepoFullNames: ["env/one"] }),
    "acme/widgets",
  );
});

test("resolveRepoFullName: explicit repo used for a number ref", () => {
  const parsed = { kind: "number", number: 1 };
  assert.equal(
    resolveRepoFullName(parsed, { explicitRepo: "me/here", envRepoFullNames: ["env/one"] }),
    "me/here",
  );
});

test("resolveRepoFullName: falls back to the env's first repo", () => {
  const parsed = { kind: "number", number: 1 };
  assert.equal(
    resolveRepoFullName(parsed, { envRepoFullNames: ["env/one", "env/two"] }),
    "env/one",
  );
});

test("resolveRepoFullName: null when nothing resolves", () => {
  assert.equal(resolveRepoFullName({ kind: "number", number: 1 }, {}), null);
  assert.equal(resolveRepoFullName(null, { explicitRepo: "no-slash" }), null);
});

test("resolveRepoFullName: create action (parsed=null) uses explicit then env", () => {
  assert.equal(resolveRepoFullName(null, { explicitRepo: "x/y" }), "x/y");
  assert.equal(resolveRepoFullName(null, { envRepoFullNames: ["a/b"] }), "a/b");
});

test("ticketFromIssue normalises a GitHub payload", () => {
  const issue = { number: 1383, html_url: "https://github.com/a/b/issues/1383", title: "Bug", state: "open" };
  assert.deepEqual(ticketFromIssue(issue, "a/b"), {
    repo: "a/b",
    number: 1383,
    url: "https://github.com/a/b/issues/1383",
    title: "Bug",
    state: "open",
  });
});

test("ticketFromIssue omits state when absent and tolerates missing url/title", () => {
  const t = ticketFromIssue({ number: 5 }, "a/b");
  assert.deepEqual(t, { repo: "a/b", number: 5, url: "", title: "" });
  assert.equal("state" in t, false);
});

test("ticketFromIssue rejects a payload with no valid number", () => {
  assert.equal(ticketFromIssue({ title: "x" }, "a/b"), null);
  assert.equal(ticketFromIssue(null, "a/b"), null);
});

test("isValidTicket enforces repo full-name + positive number", () => {
  assert.equal(isValidTicket({ repo: "a/b", number: 1 }), true);
  assert.equal(isValidTicket({ repo: "no-slash", number: 1 }), false);
  assert.equal(isValidTicket({ repo: "a/b", number: 0 }), false);
  assert.equal(isValidTicket({ repo: "a/b" }), false);
  assert.equal(isValidTicket(null), false);
});

test("addChild appends, de-duplicates and sorts", () => {
  const base = { repo: "a/b", number: 1, url: "", title: "" };
  const one = addChild(base, 5);
  assert.deepEqual(one.children, [5]);
  const two = addChild(one, 3);
  assert.deepEqual(two.children, [3, 5]);
  const dup = addChild(two, 5);
  assert.deepEqual(dup.children, [3, 5]);
});

test("addChild does not mutate the input ticket", () => {
  const base = { repo: "a/b", number: 1, url: "", title: "", children: [2] };
  const next = addChild(base, 4);
  assert.deepEqual(base.children, [2]);
  assert.deepEqual(next.children, [2, 4]);
});

test("addChild rejects an invalid parent or child number", () => {
  assert.equal(addChild({ repo: "bad" }, 3), null);
  assert.equal(addChild({ repo: "a/b", number: 1 }, 0), null);
  assert.equal(addChild({ repo: "a/b", number: 1 }, "x"), null);
});
