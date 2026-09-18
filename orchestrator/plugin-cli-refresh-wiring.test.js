"use strict";

// Source-reading drift guard for two `orchestrator.js`-only properties of the
// plugin-event / plugin-CLI wiring. Both fail SILENTLY — the platform keeps
// working, only the property is gone:
//
//   AC1  `POST /internal/plugin-event` must hand the PAYLOAD to
//        `resolvePluginEventTargets`. Without it every `payloadFilter` reads as
//        "no payload" and a filtered trigger never fires — the exact symptom
//        this filter exists to remove ("everything runs, nothing wakes").
//
//   AC2/AC3 (Task 7): granted plugin CLIs are refreshed from the registry on
//        every reconcile, by comparing a digest of both files.
//
//   AC4  `refreshGrantedPluginClis` must resolve the agent state dir
//        (`resolveAgentStateDir`) BEFORE joining the plan's relative
//        `.agent-studio/...` paths onto the agent dir. Without it, an upgraded
//        agent still on the legacy `.aee/` sees its CLI as "missing", the
//        refresh creates a bare `.agent-studio/bin/`, and from then on every
//        reader resolves the NEW dir — orphaning `.aee/` (token config,
//        seeded-skills.json, seeded-plugins.json, artifacts) with no error.
//
//   AC5  The plugin-event fan-out scans every agent config. `loadAgentConfig`
//        throws on invalid JSON, so one malformed `config.json` anywhere must
//        be SKIPPED — unguarded, it 500s every plugin event for every team,
//        and the broker's cursor has already advanced, so the events are lost.
//
// AC4/AC5 are written as named predicates with mutation proofs (the
// internal-auth-wiring.test.js technique), so each is demonstrably load-bearing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function between(start, end) {
  const i = SRC.indexOf(start);
  assert.notEqual(i, -1, `marker not found: ${start}`);
  const j = SRC.indexOf(end, i);
  return SRC.slice(i, j === -1 ? undefined : j);
}

test("AC1: the plugin-event route resolves targets WITH the payload", () => {
  // The brief's own end marker, "Internal label fast-path", is the text of a
  // `//` comment header — the comment-stripping pass above removes it before
  // SRC is built, so it can never be found. Substituted with the next
  // non-comment `req.url ===` route literal after the plugin-event handler
  // (`/internal/github-label-applied`), which still bounds the search to the
  // plugin-event handler's own body.
  const route = between("req.url === '/internal/plugin-event'", "req.url === '/internal/github-label-applied'");
  assert.match(route, /resolvePluginEventTargets\(\{ pluginId, event, payload \}, agents\)/);
});

test("AC2: reconcilePluginsAndAttachments refreshes granted CLI copies after the credential pushes", () => {
  const fn = between("async function reconcilePluginsAndAttachments()", "return { sidecars, networks }");
  assert.match(fn, /await refreshGrantedPluginClis\(\)/);
  // Order: sidecars first, then credentials, then the CLI refresh — a fresh CLI
  // against a broker that is not yet up would only fail its first call anyway,
  // but the refresh must not run before the registry has been re-validated.
  assert.ok(fn.indexOf("pushDeclaredScopeCredentials()") < fn.indexOf("refreshGrantedPluginClis()"));
});

test("AC3: the refresh decides by digest on BOTH files and reseeds .agent-studio for isolated volumes", () => {
  const fn = between("async function refreshGrantedPluginClis()", "\n}\n");
  assert.match(fn, /planCliRefresh\(\{/);
  assert.match(fn, /workspaceDigest:/);
  assert.match(fn, /registryDigest:/);
  assert.match(fn, /createHash\("sha256"\)/);
  assert.match(fn, /fs\.chmodSync\(dest, item\.mode\)/);
  assert.match(fn, /reseedAgent\(id, \["\.agent-studio"\]\)/);
  assert.match(SRC, /planCliRefresh \} = require\("\.\/plugin-sync"\)/);
});

// ── AC4 / AC5 — predicates + mutation proofs ─────────────────────────────────

function runCheck(check, code) {
  try { check(code); return null; } catch (err) { return err.message; }
}

function sliceFrom(code, needle, length) {
  const at = code.indexOf(needle);
  assert.notEqual(at, -1, `anchor not found: ${needle}`);
  return code.slice(at, at + length);
}

const CHECKS = {
  "AC4: cli-refresh-resolves-state-dir": (code) => {
    const fn = sliceFrom(code, "async function refreshGrantedPluginClis() {", 3000);
    const dirAt = fn.indexOf("const dir = agentDir(id);");
    assert.notEqual(dirAt, -1, "the per-agent dir assignment moved — re-anchor this guard");
    const resolveAt = fn.indexOf("resolveAgentStateDir(dir);", dirAt);
    const planAt = fn.indexOf("planCliRefresh({", dirAt);
    assert.notEqual(resolveAt, -1,
      "refreshGrantedPluginClis must call resolveAgentStateDir(dir) — writing "
      + ".agent-studio/bin directly orphans an upgraded agent's legacy .aee/ state");
    assert.ok(resolveAt < planAt, "resolveAgentStateDir must run BEFORE the plan reads the workspace digest");
  },

  "AC5: plugin-event-skips-malformed-config": (code) => {
    const handler = sliceFrom(code, "req.url === '/internal/plugin-event'", 4000);
    const mapAt = handler.indexOf("const agents = listAgentIds().map(");
    assert.notEqual(mapAt, -1, "the plugin-event agent scan moved — re-anchor this guard");
    const scan = handler.slice(mapAt, mapAt + 700);
    assert.match(scan, /try \{ cfg = loadAgentConfig\(aid\); \} catch \{ cfg = null; \}/,
      "the plugin-event fan-out must guard loadAgentConfig — one malformed config.json "
      + "must not 500 every plugin event for every team");
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`wiring: ${name}`, () => {
    const failure = runCheck(check, SRC);
    assert.equal(failure, null, failure || "");
  });
}

const MUTATIONS = [
  {
    name: "dropping resolveAgentStateDir from the CLI refresh",
    check: "AC4: cli-refresh-resolves-state-dir",
    apply: (code) => {
      const at = code.indexOf("async function refreshGrantedPluginClis() {");
      const head = code.slice(0, at);
      const tail = code.slice(at, at + 3000).replace(/^\s*resolveAgentStateDir\(dir\);\n/m, "");
      return head + tail + code.slice(at + 3000);
    },
  },
  {
    name: "un-guarding loadAgentConfig in the plugin-event scan",
    check: "AC5: plugin-event-skips-malformed-config",
    apply: (code) => {
      const at = code.indexOf("req.url === '/internal/plugin-event'");
      const head = code.slice(0, at);
      const tail = code.slice(at, at + 4000).replace(
        "try { cfg = loadAgentConfig(aid); } catch { cfg = null; }", "cfg = loadAgentConfig(aid);");
      return head + tail + code.slice(at + 4000);
    },
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation proof: ${mutation.name} trips ${mutation.check}`, () => {
    const mutated = mutation.apply(SRC);
    assert.notEqual(mutated, SRC, "the sabotage matched nothing — this proof would be vacuous");
    const failure = runCheck(CHECKS[mutation.check], mutated);
    assert.ok(failure, `${mutation.check} did NOT fire on: ${mutation.name}`);
  });
}
