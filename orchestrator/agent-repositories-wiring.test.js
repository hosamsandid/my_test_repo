"use strict";

// Source-reading drift guard for the agent-scoped repository wiring (#2067).
//
// The pure core covers every decision; four properties are in orchestrator.js
// alone, and each of them fails SILENTLY — the feature keeps working in the
// happy path and breaks only on the path nobody exercises by hand:
//
//   AC5/D9 — reset-to-stub wipes everything but config.json, so config.json is
//            the only place the attachment can survive. Drop it from the
//            preserved key set and the next activation re-clones the
//            environment's repositories, silently loses the agent-scoped one,
//            and rebuilds a prompt that no longer names it.
//   AC10   — an agent-scoped clone must not touch the per-ENVIRONMENT clone
//            cache. Seeding it would let a sibling agent copy a working tree it
//            was never granted, which is exactly what "changes exactly one
//            agent" forbids — and nothing about the attaching agent would look
//            wrong.
//   AC13   — attach clones BEFORE it persists (a failed clone must write
//            nothing) and detach persists BEFORE it deletes (a failed delete
//            must not leave an entry pointing at deleted files). Swap either
//            order and the failure mode is a half-state, not an error.
//   AC17   — removal is refused while a run is in flight; attaching is not.
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime and reaches for Matrix), so this reads its source — the technique
// `bp-removal-guard.test.js` and the admin-console `*-wiring.test.js` files use.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

// Comments name the very properties under test, so strip them first.
//
// Anchored to the start of a line on BOTH forms, deliberately: an unanchored
// `/* … */` strip is unsafe on a 700k file full of regex literals — one
// `/…/*…/` pattern makes the strip run to the next `*/` thousands of lines
// away and silently delete a quarter of the source, which then makes every
// assertion below "pass" by finding nothing. The non-vacuity test right after
// this is what catches that class of mistake.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

const CODE = stripComments(SRC);

test("the comment strip did not eat the source it is reading", () => {
  // A runaway strip is the one failure mode that makes this whole file vacuous.
  assert.ok(CODE.length > SRC.length * 0.5, `stripped ${SRC.length} → ${CODE.length}`);
  for (const signature of [
    "function seedAgentWorkspace(",
    "function saveAgentPrompt(",
    "syncAgentRepositories(agentId) {",
    "attachAgentRepository(agentId, repo) {",
    "detachAgentRepository(agentId, url) {",
    "const stripped = {",
  ]) {
    assert.ok(CODE.includes(signature), `comment-stripping removed ${signature}`);
  }
});

/** Slice one function or method body out, so a match elsewhere can't fool us. */
function block(marker, endMarker) {
  const start = CODE.indexOf(marker);
  assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
  const end = CODE.indexOf(endMarker, start + marker.length);
  assert.ok(end > start, `end of ${marker} not found — this guard needs re-pointing`);
  return CODE.slice(start, end);
}

/** Index of `needle`, asserted to be a real hit — `-1 < x` is trivially true. */
function at(src, needle, label) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `${label || needle} not found — this guard needs re-pointing`);
  return i;
}

test("the pure core is required, not re-implemented here", () => {
  assert.match(CODE, /require\("\.\/agent-repositories"\)/);
  for (const fn of ["normalizeAgentRepositories", "resolveAgentRepositories", "planAgentRepoAttach", "planAgentRepoDetach", "removalFacts"]) {
    assert.match(CODE, new RegExp(`\\b${fn}\\b`), `${fn} is imported and used`);
  }
});

test("AC5/D9: reset-to-stub preserves agentRepositories on the stub config", () => {
  const stripped = block("const stripped = {", "saveAgentConfig(id, stripped)");
  assert.match(stripped, /agentRepositories/, "the attachment survives the wipe");
  // Written only when non-empty, so an agent that never had one stays
  // byte-identical to a pre-#2067 stub.
  assert.match(stripped, /normalizeAgentRepositories\(cfg\.agentRepositories\)\.length/);
});

test("AC5/D9: every seed re-clones the agent's own repositories", () => {
  const seed = block("function seedAgentWorkspace(", "\nfunction ");
  assert.match(seed, /cloneEnvironmentRepositories\(dest, env, warnings\)/);
  assert.match(seed, /cloneAgentScopedRepositories\(dest, env, [\s\S]{0,60}?agentRepositories, warnings\)/);
});

test("AC10: an agent-scoped clone bypasses the per-environment clone cache", () => {
  const clone = block("function cloneAgentScopedRepositories(", "\nfunction ");
  // cloneRepository(targetDir, repo, tokenId, envId) — the 4th argument drives
  // the cache, and it must be null here.
  assert.match(clone, /cloneRepository\(targetDir, repo, env\?\.githubTokenId \|\| null, null\)/);

  // The incremental sync path shares one cloneRepository call for both scopes,
  // so it has to make the same distinction per repo rather than per call.
  const sync = block("syncAgentRepositories(agentId) {", "\n  }\n");
  assert.match(sync, /ownUrls\.has\(String\(repo\.url \|\| ""\)\.trim\(\)\) \? null : \(env\?\.id \|\| null\)/);
});

test("AC11: the sync reads the AGENT's own list, so the env fan-out cannot propagate it", () => {
  const sync = block("syncAgentRepositories(agentId) {", "\n  }\n");
  assert.match(sync, /normalizeAgentRepositories\(cfg\.agentRepositories\)/);
  // Both scopes are cloned, and the env's own list is untouched.
  assert.match(sync, /\[\.\.\.envRepos, \.\.\.ownRepos\]/);
});

test("AC13: attach clones before it persists; detach persists before it deletes", () => {
  const attach = block("attachAgentRepository(agentId, repo) {", "\n  detachAgentRepository");
  const cloneAt = at(attach, "cloneAgentScopedRepositories(", "the clone");
  const saveAt = at(attach, "saveAgentConfig(agentId, cfg)", "the config write");
  assert.ok(cloneAt < saveAt, "a failed clone must write no config entry");
  // …and it cleans up whatever a partial clone left behind before surfacing
  // the real git error, so no half-cloned directory is orphaned.
  assert.match(attach, /fs\.rmSync\(target, \{ recursive: true, force: true \}\)/);
  assert.match(attach, /code = "clone-failed"|e\.code = "clone-failed"/);
  // cloneRepository REPORTS a pre-existing directory rather than throwing, so
  // the "clone did not fail but also did not happen" case has to be refused
  // explicitly — otherwise the entry binds to a directory it did not produce.
  assert.match(attach, /clones\.some\(\(c\) => c && c\.skipped\)/);

  const detach = block("detachAgentRepository(agentId, url) {", "\n  }\n\n");
  const dSaveAt = at(detach, "saveAgentConfig(agentId, cfg)", "the config write");
  const dDelAt = at(detach, "fs.rmSync(target", "the delete");
  assert.ok(dSaveAt < dDelAt, "a failed delete must not leave an entry pointing at deleted files");
});

test("AC17: detach refuses a busy agent; attach has no such gate", () => {
  const detach = block("detachAgentRepository(agentId, url) {", "\n  }\n\n");
  assert.match(detach, /agentBusyState\(agentId\)/);
  assert.match(detach, /e\.code = "busy"/);

  const attach = block("attachAgentRepository(agentId, repo) {", "\n  detachAgentRepository");
  assert.doesNotMatch(attach, /e\.code = "busy"/, "attaching is additive and needs no gate");
});

test("both mutations rebuild the prompt and neither respawns the container", () => {
  for (const marker of ["attachAgentRepository(agentId, repo) {", "detachAgentRepository(agentId, url) {"]) {
    const body = block(marker, marker.startsWith("attach") ? "\n  detachAgentRepository" : "\n  }\n\n");
    assert.match(body, /rebuildAgentPrompt\(agentId, "agent-repositor/, `${marker} rebuilds the prompt`);
    assert.doesNotMatch(body, /respawnAgent/, `${marker} must not respawn — the volume is shared`);
  }
});

test("the prompt and the hand-off pre-flight both see the agent's own repositories", () => {
  // saveAgentPrompt resolves the list from the config itself, so no caller can
  // rebuild a prompt that omits a repository the workspace has.
  const save = block("function saveAgentPrompt(", "\n}\n");
  assert.match(save, /normalizeAgentRepositories\(cfg && cfg\.agentRepositories\)/);
  assert.match(save, /agentRepositories,/, "threaded into buildAgentClaudeMd");

  // A hand-off that reads "ready" over losable work in an agent-scoped clone is
  // the failure this closes.
  assert.match(CODE, /inspectAgentRepoStatuses\(id, env, normalizeAgentRepositories\(cfg\.agentRepositories\)\)/);
});

test("AC18: the Git panel's update can resolve an agent-scoped repo's SSH key", () => {
  // The key is recorded on the AGENT, so matchEnvRepoByRemote must be offered
  // both lists or an agent-scoped SSH repo fetches with no key at all.
  assert.match(
    CODE,
    /matchEnvRepoByRemote\(remoteUrl, \[\s*\.\.\.\(Array\.isArray\(env\?\.repositories\)[\s\S]{0,200}?normalizeAgentRepositories/,
  );
});

test("the three internal routes exist and map refusal codes onto statuses", () => {
  const route = block("const agentReposMatch = req.url.match(", "const disableMatch");
  assert.match(route, /\['GET', 'POST', 'DELETE'\]\.includes\(req\.method\)/);
  assert.match(route, /orchestrator\.agentRepositoriesView\(id\)/);
  assert.match(route, /orchestrator\.attachAgentRepository\(id, parsed\)/);
  assert.match(route, /orchestrator\.detachAgentRepository\(id, parsed\.url\)/);
  // A refusal is a status the console can relay, never a bare 500.
  assert.match(route, /code === 'not-found' \|\| code === 'not-attached'\) return 404/);
  assert.match(route, /code === 'url-required'\) return 400/);
  assert.match(route, /code === 'error' \? 500 : statusFor\(code\)/);
});
