"use strict";

// Source-reading drift guard for the pool-instance DM-room pre-create (#2251).
//
// An autonomously spawned pool instance has nobody to open its chat, so its
// inherited github-event kickoff trigger fires seconds after boot. The
// container's `_execute_inner` HARD-SKIPS a triggered run when no DM room
// exists yet ("Trigger … skipped: no roomId and no DM room exists yet" —
// agent-entrypoint.py). The DM room is otherwise created only lazily by the
// admin console on chat-open, so the instance spawns and then does nothing:
// an empty session (the original #2251 field report).
//
// The fix pre-creates the room in `addTeamMember` for a pool instance. Two
// properties live ONLY in orchestrator.js's impure half and can regress
// silently (the happy path never proves either):
//
//   ORDERING — the pre-create must run BEFORE `startAgentProcess(memberConfig)`.
//   The container's start() does exactly one `_sync()` (which pulls
//   `dm-room.json`) before it starts the pending-drain loop, so the pointer
//   must be on disk before the container boots. Moved after the spawn, the
//   race returns and the first kickoff is skipped again.
//
//   GATING — it must key on `opts.poolInstance`; an ordinary member still gets
//   its room lazily on chat-open (unchanged behaviour).
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime, the webhook server and reaches for Matrix), so this reads its
// source — the `agent-pool-wiring.test.js` technique.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FULL_SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}
const SRC = stripComments(FULL_SRC);

// Free `function name(` slice (used for provisionAgentDmRoom).
function fn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

// Class-method slice for `async addTeamMember(...) {` up to the next 2-space
// method at the same indent.
function method(name) {
  const start = SRC.indexOf(`async ${name}(`);
  assert.ok(start > 0, `method ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextMethod = rest.search(/\n {2}(?:async )?[A-Za-z_]+\(/);
  const end = nextMethod === -1 ? SRC.length : start + 1 + nextMethod;
  return SRC.slice(start, end);
}

test("the guard is not vacuous: both slices come back with their bodies intact", () => {
  assert.ok(fn("provisionAgentDmRoom").length > 100, "provisionAgentDmRoom came back empty");
  assert.ok(method("addTeamMember").length > 100, "addTeamMember came back empty");
});

test("provisionAgentDmRoom creates the room as the agent, invites the admin, and persists dm-room.json", () => {
  const src = fn("provisionAgentDmRoom");
  // Created with the AGENT's own token (so the room's creator is the agent, and
  // the admin console reuses it verbatim on chat-open).
  assert.match(src, /createRoom/, "must call the createRoom endpoint");
  assert.match(src, /invite:\s*\[adminUserId\]/, "must invite the resolved admin user");
  assert.match(src, /is_direct:\s*true/, "the DM must be a 1:1 direct room");
  // Persists the same pointer file the agent reads and the admin console writes.
  assert.match(src, /agentDir\(agentId\), "dm-room\.json"/, "must write dm-room.json under the agent dir");
  assert.match(src, /fs\.renameSync\(tmp, dmPath\)/, "must persist the pointer atomically (tmp+rename)");
});

test("provisionAgentDmRoom is best-effort and idempotent", () => {
  const src = fn("provisionAgentDmRoom");
  // Never throws for a missing/unconfigured Matrix — returns a reason instead,
  // so a hiccup can't fail the spawn.
  assert.match(src, /matrix-not-configured/, "must no-op when Matrix env is absent");
  // Never clobbers an existing pointer (a reused instance keeps its room).
  assert.match(src, /if \(fs\.existsSync\(dmPath\)\) return \{ ok: true, reused: true \}/,
    "must short-circuit when dm-room.json already exists");
});

test("addTeamMember pre-creates the DM room for a pool instance, gated on opts.poolInstance", () => {
  const src = method("addTeamMember");
  assert.match(
    src,
    /if \(opts\.poolInstance && memberConfig\.enabled !== false\) \{[\s\S]*?provisionAgentDmRoom\(memberId, token, memberDisplayName\)/,
    "the pre-create must be gated on opts.poolInstance and pass the agent's own token",
  );
});

test("RACE GUARD: the DM-room pre-create runs BEFORE startAgentProcess in addTeamMember", () => {
  const src = method("addTeamMember");
  const preCreateAt = src.indexOf("provisionAgentDmRoom(memberId, token");
  const spawnAt = src.indexOf("startAgentProcess(memberConfig)");
  assert.ok(preCreateAt > 0, "provisionAgentDmRoom call not found in addTeamMember");
  assert.ok(spawnAt > 0, "startAgentProcess(memberConfig) call not found in addTeamMember");
  assert.ok(
    preCreateAt < spawnAt,
    "provisionAgentDmRoom must be awaited BEFORE startAgentProcess — otherwise the container can drain its kickoff trigger before dm-room.json exists and skip the run",
  );
});

test("mutation-proved: moving the pre-create after the spawn would fail the race guard", () => {
  // Simulate the regression: delete the pre-create block from before the spawn.
  const src = method("addTeamMember");
  const buggy = src.replace(
    /if \(opts\.poolInstance && memberConfig\.enabled !== false\) \{[\s\S]*?\n    \}\n\n(?=    if \(memberConfig\.enabled !== false\) startAgentProcess)/,
    "",
  );
  const preCreateAt = buggy.indexOf("provisionAgentDmRoom(memberId, token");
  assert.equal(preCreateAt, -1, "the pre-create block should have been stripped by the mutation");
});
