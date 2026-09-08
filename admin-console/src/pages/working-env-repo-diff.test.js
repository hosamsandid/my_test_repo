// Unit tests for the pure save-time repository-diff classification (#2066 AC27).
//
// Covers every class the offer distinguishes — added / changed / removed /
// unchanged — plus the two cases the ticket calls out by name: the D1b
// directory-name branch of a changed URL, and `readOnly` never counting as a
// change.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  repoDirName,
  changedRepoFields,
  classifyRepositoryChanges,
  hasRepositoryChanges,
  propagatableCount,
  repositoryChangeLines,
  repositoryChangeNotice,
  outOfDateIndicator,
} from './working-env-repo-diff.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const repo = (url, extra = {}) => ({ url, ...extra });

// ── repoDirName: the identity everything else keys on ───────────────────────

test("repoDirName strips .git and takes the trailing segment", () => {
  assert.equal(repoDirName("git@github.com:acme/widgets.git"), "widgets");
  assert.equal(repoDirName("https://github.com/acme/widgets"), "widgets");
  assert.equal(repoDirName(""), "repo");
  assert.equal(repoDirName(null), "repo");
});

// Two-sided guard: the browser bundle cannot require from orchestrator/, so the
// body is duplicated. If the canonical one changes, the diff would start keying
// on a different directory name than the propagation acts on — the one drift
// that would make the modal promise something the workspace never does.
test("repoDirName is byte-identical to the orchestrator's canonical copy", () => {
  const canonicalSrc = fs.readFileSync(
    path.join(here, "..", "..", "..", "orchestrator", "repo-sync.js"),
    "utf8",
  );
  const bodyOf = (src) => {
    const at = src.indexOf("function repoDirName(url) {");
    assert.ok(at > 0, "repoDirName must be declared in the expected form");
    const end = src.indexOf("\n}", at);
    assert.ok(end > at, "repoDirName body must terminate");
    return src.slice(at, end + 2).trim();
  };
  const mineSrc = fs.readFileSync(path.join(here, "working-env-repo-diff.js"), "utf8");
  // Quote style differs by container convention (src/ single, orchestrator/
  // double), so compare with the quotes normalised — everything else, including
  // the fallback name and the `.git` strip, must match character for character.
  const normalize = (src) => src.replace(/^export\s+/, "").replace(/'/g, '"');
  assert.equal(
    normalize(bodyOf(mineSrc)),
    normalize(bodyOf(canonicalSrc)),
    "the mirrored repoDirName drifted from orchestrator/repo-sync.js",
  );
});

// ── The four classes ────────────────────────────────────────────────────────

test("an unchanged list produces no classes and no offer", () => {
  const list = [repo("git@github.com:acme/widgets.git", { branch: "main" })];
  const diff = classifyRepositoryChanges(list, [{ url: list[0].url, branch: "main" }]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.unchanged.length, 1);
  assert.equal(diff.changeCount, 0);
  assert.equal(hasRepositoryChanges(diff), false);
  assert.equal(repositoryChangeNotice({ diff, agentCount: 3 }), null);
});

test("a new entry is added; a dropped entry is removed", () => {
  const diff = classifyRepositoryChanges(
    [repo("git@github.com:acme/widgets.git"), repo("git@github.com:acme/legacy.git")],
    [repo("git@github.com:acme/widgets.git"), repo("git@github.com:acme/docs.git")],
  );
  assert.deepEqual(diff.added.map((r) => r.name), ["docs"]);
  assert.deepEqual(diff.removed.map((r) => r.name), ["legacy"]);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.changeCount, 2);
});

test("a changed branch, and a changed SSH key, are each a change", () => {
  const url = "git@github.com:acme/widgets.git";
  const branchDiff = classifyRepositoryChanges(
    [repo(url, { branch: "main" })],
    [repo(url, { branch: "develop" })],
  );
  assert.deepEqual(branchDiff.changed.map((r) => r.fields), [["branch"]]);
  assert.equal(branchDiff.changed[0].previous.branch, "main");

  const keyDiff = classifyRepositoryChanges(
    [repo(url, { sshKeyId: "key-a" })],
    [repo(url, { sshKeyId: "key-b" })],
  );
  assert.deepEqual(keyDiff.changed.map((r) => r.fields), [["sshKeyId"]]);
});

test("changedRepoFields reports every differing workspace field at once", () => {
  const fields = changedRepoFields(
    { url: "a", branch: "main", sshKeyId: "k1" },
    { url: "b", branch: "dev", sshKeyId: "k2" },
  );
  assert.deepEqual(fields, ["url", "branch", "sshKeyId"]);
});

// ── D1b: the directory-name branch of a changed URL ─────────────────────────

test("D1b — a changed URL keeping the directory name is one changed entry", () => {
  const diff = classifyRepositoryChanges(
    [repo("git@github.com:acme/widgets.git")],
    [repo("git@github.com:newco/widgets.git")],
  );
  assert.deepEqual(diff.changed.map((r) => r.name), ["widgets"]);
  assert.deepEqual(diff.changed[0].fields, ["url"]);
  assert.deepEqual(diff.added, [], "no second clone is made for a same-directory move");
  assert.deepEqual(diff.removed, [], "and nothing is retained, because nothing moved on disk");
});

test("D1b — a changed URL changing the directory name is an addition plus a removal", () => {
  const diff = classifyRepositoryChanges(
    [repo("git@github.com:acme/widgets.git")],
    [repo("git@github.com:acme/gadgets.git")],
  );
  assert.deepEqual(diff.added.map((r) => r.name), ["gadgets"]);
  assert.deepEqual(diff.removed.map((r) => r.name), ["widgets"]);
  assert.deepEqual(diff.changed, [], "it is deliberately NOT reported as an in-place change");
});

// ── The edge cases the ticket names ─────────────────────────────────────────

test("readOnly is never a change — it is prompt awareness, not a clone difference", () => {
  const url = "git@github.com:acme/widgets.git";
  const diff = classifyRepositoryChanges(
    [repo(url, { branch: "main", readOnly: false })],
    [repo(url, { branch: "main", readOnly: true })],
  );
  assert.equal(diff.changeCount, 0);
  assert.equal(hasRepositoryChanges(diff), false);
});

test("a repository added and removed again before saving does not appear", () => {
  const list = [repo("git@github.com:acme/widgets.git")];
  const diff = classifyRepositoryChanges(list, list.map((r) => ({ ...r })));
  assert.equal(diff.changeCount, 0);
});

test("two entries deriving the same directory name: the loser is a collision, not a success", () => {
  const diff = classifyRepositoryChanges(
    [],
    [repo("git@github.com:acme/widgets.git"), repo("git@github.com:other/widgets.git")],
  );
  assert.deepEqual(diff.added.map((r) => r.url), ["git@github.com:acme/widgets.git"]);
  assert.deepEqual(diff.collisions.map((r) => r.url), ["git@github.com:other/widgets.git"]);
  assert.equal(diff.collisions[0].occupiedBy, "git@github.com:acme/widgets.git");
  assert.equal(hasRepositoryChanges(diff), true);
});

test("a collision alone raises the offer even when nothing else moved", () => {
  const both = [repo("git@github.com:acme/widgets.git"), repo("git@github.com:other/widgets.git")];
  const diff = classifyRepositoryChanges(both, both.map((r) => ({ ...r })));
  assert.equal(diff.changeCount, 0, "neither entry changed");
  assert.equal(hasRepositoryChanges(diff), true, "but one of them can never arrive");
  assert.match(
    repositoryChangeLines(diff, 2).find((l) => l.kind === "collision").text,
    /only the first repository with a given folder name is cloned/,
  );
});

test("repo-less: removing the last repository is a removal, not an empty state", () => {
  const diff = classifyRepositoryChanges([repo("git@github.com:acme/widgets.git")], []);
  assert.deepEqual(diff.removed.map((r) => r.name), ["widgets"]);
  assert.equal(propagatableCount(diff), 0, "a removal is never propagated");
  assert.equal(hasRepositoryChanges(diff), true, "but the warning is still owed");
});

test("an entry with no url is ignored on both sides", () => {
  const diff = classifyRepositoryChanges([null, { branch: "main" }], [{ url: "" }, undefined]);
  assert.equal(diff.changeCount, 0);
  assert.deepEqual(diff.unchanged, []);
});

test("a non-array list is tolerated", () => {
  const diff = classifyRepositoryChanges(undefined, null);
  assert.equal(diff.changeCount, 0);
  assert.equal(hasRepositoryChanges(diff), false);
});

// ── The offer's own copy ────────────────────────────────────────────────────

test("AC4 — zero agents produces no notice, whatever the diff", () => {
  const diff = classifyRepositoryChanges([], [repo("git@github.com:acme/widgets.git")]);
  assert.equal(hasRepositoryChanges(diff), true);
  assert.equal(repositoryChangeNotice({ diff, agentCount: 0 }), null);
});

test("the notice asks to bring existing agents up to date when there is work", () => {
  const diff = classifyRepositoryChanges([], [repo("git@github.com:acme/widgets.git")]);
  const text = repositoryChangeNotice({ diff, agentCount: 1 });
  assert.match(text, /1 existing agent/);
  assert.match(text, /up to date\?$/);
});

test("a removal-only diff says there is nothing to bring up to date", () => {
  const diff = classifyRepositoryChanges([repo("git@github.com:acme/widgets.git")], []);
  const text = repositoryChangeNotice({ diff, agentCount: 2 });
  assert.match(text, /Nothing needs to be brought up to date/);
  assert.match(text, /ever deleted from an agent/);
});

test("the per-class lines name the repositories and mark the removal as a warning", () => {
  const diff = classifyRepositoryChanges(
    [repo("git@github.com:acme/legacy.git"), repo("git@github.com:acme/widgets.git", { branch: "main" })],
    [repo("git@github.com:acme/widgets.git", { branch: "dev" }), repo("git@github.com:acme/docs.git")],
  );
  const lines = repositoryChangeLines(diff, 3);
  const byKind = Object.fromEntries(lines.map((l) => [l.kind, l]));
  assert.match(byKind.added.text, /docs/);
  assert.match(byKind.changed.text, /widgets/);
  assert.match(byKind.changed.text, /clean and fully pushed/);
  assert.equal(byKind.removed.tone, "warning");
  assert.match(byKind.removed.text, /legacy/);
  assert.match(byKind.removed.text, /nothing is deleted from any agent/);
  assert.match(byKind.removed.text, /manual step/);
});

test("no lines are produced for a clean diff", () => {
  const list = [repo("git@github.com:acme/widgets.git")];
  assert.deepEqual(repositoryChangeLines(classifyRepositoryChanges(list, list), 3), []);
});

// ── D4: outOfDateIndicator (#2066 AC19) ────────────────────────────────────

test("no indicator when nothing diverges, when the probe failed, or with no agents", () => {
  assert.equal(outOfDateIndicator(null), null);
  assert.equal(outOfDateIndicator({ agents: [] }), null);
  assert.equal(outOfDateIndicator({ agents: [{ agentId: "a1", diverged: [] }] }), null);
});

test("the indicator counts AGENTS, not repositories, and names each in its title", () => {
  const ind = outOfDateIndicator({
    canManage: true,
    agents: [
      { agentId: "a1", displayName: "Dev", diverged: [
        { name: "widgets", kind: "missing" },
        { name: "docs", kind: "branch" },
      ] },
      { agentId: "a2", displayName: "Reviewer", diverged: [] },
      { agentId: "a3", displayName: "QA", diverged: [{ name: "widgets", kind: "url-and-branch" }] },
    ],
  });
  assert.equal(ind.count, 2, "two agents are behind, across three divergences");
  assert.equal(ind.label, "2 agents not up to date");
  assert.match(ind.title, /Dev: widgets \(not cloned\), docs \(on a different branch\)/);
  assert.match(ind.title, /QA: widgets \(on a different branch and address\)/);
  assert.doesNotMatch(ind.title, /Reviewer/, "an up-to-date agent is not listed");
  assert.equal(ind.canManage, true);
});

test("the indicator is singular for one agent and reports a read-only caller", () => {
  const ind = outOfDateIndicator({
    canManage: false,
    agents: [{ agentId: "a1", diverged: [{ name: "widgets", kind: "url" }] }],
  });
  assert.equal(ind.label, "1 agent not up to date");
  assert.equal(ind.canManage, false, "the catch-up would be refused server-side");
  assert.match(ind.title, /a1: widgets \(pointing at a different address\)/);
});

test("a stub agent is not counted — it has nothing to be out of date with", () => {
  assert.equal(
    outOfDateIndicator({ agents: [{ agentId: "stub", diverged: [], noWorkspace: true }] }),
    null,
  );
});
