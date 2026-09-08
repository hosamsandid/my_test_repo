"use strict";

// Source-reading drift guard for the :4002 internal-auth wiring (#1456).
//
// `internal-auth.js` is fully unit-tested, but four properties live in
// `orchestrator.js` alone and every one of them fails SILENTLY — the platform
// keeps working and only the security property is gone:
//
//   AC1  The gate must be the FIRST statement of the internal-API handler. Put
//        it one branch lower and `/internal/admin/*` — the users, teams and
//        memberships CRUD — is served unauthenticated, which is worse than not
//        having a gate, because the boot log claims there is one.
//
//   AC2  `startAgentProcess` spreads `...process.env` into every agent
//        container, so the orchestrator's own INTERNAL_API_TOKEN — the
//        control-plane credential granting the FULL surface — travels into the
//        very containers this ticket fences out. The `delete` is what stops it,
//        and it has to happen AFTER the spread. Nothing about a leaked token
//        looks wrong at runtime: every call simply succeeds.
//
//   AC3  The per-agent token must be minted inside `startAgentProcess`, which is
//        what makes rotation free — all three respawn paths funnel through it.
//        Minted anywhere else and a respawn hands the agent a stale token.
//
//   AC4  `enforce` with no token configured must be refused at BOOT. Deferred to
//        the first request, the symptom is a platform that 401s everything and a
//        cause three env vars away.
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime and reaches for Matrix), so this reads its source — the technique
// `bp-removal-guard.test.js` and `agent-repositories-wiring.test.js` use.
//
// Every check below is a named predicate over a source STRING, so the same
// predicates run over the real file AND over deliberately sabotaged copies. A
// guard nobody has watched fail is worth nothing; the mutation block at the
// bottom is what makes each assertion demonstrably load-bearing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

// Comments name the very properties under test, so strip them first. Line
// comments BEFORE block comments, deliberately: a `//` comment mentioning a glob
// (`/api/*`) contains a `/*` that would pair with the next real `*/` thousands of
// lines below and silently delete a quarter of the file — after which every
// assertion here "passes" by finding nothing. Both forms are line-anchored for
// the same reason, and the non-vacuity test right below is the backstop.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "")
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "");
}

const CODE = stripComments(SRC);

test("the comment strip did not eat the source it is reading", () => {
  assert.ok(CODE.length > SRC.length * 0.5, `stripped ${SRC.length} → ${CODE.length}`);
  for (const signature of [
    "function startAgentProcess(config) {",
    "const internalApi = http.createServer((req, res) => {",
    "async function main() {",
  ]) {
    assert.ok(CODE.includes(signature), `signature survived the strip: ${signature}`);
  }
});

// ── The checks, as predicates over a source string ──────────────────────────
//
// Each throws with a message naming what broke. `runCheck` returns the failure
// message (or null), so the mutation block can assert WHICH guard fired rather
// than just "something did".

function sliceFrom(code, needle, length = 6000) {
  const at = code.indexOf(needle);
  assert.notEqual(at, -1, `anchor not found: ${needle}`);
  return code.slice(at, at + length);
}

const CHECKS = {
  // AC1 — the gate is the first statement of the handler.
  "gate-is-first": (code) => {
    const handler = sliceFrom(code, "const internalApi = http.createServer((req, res) => {", 4000);
    const gateAt = handler.indexOf("internalAuth.decideInternalAuth({");
    const adminAt = handler.indexOf("req.url.startsWith('/internal/admin/')");
    assert.notEqual(gateAt, -1, "the auth gate is missing from the internal-API handler");
    assert.notEqual(adminAt, -1, "the /internal/admin delegation moved — re-anchor this guard");
    assert.ok(gateAt < adminAt,
      "the auth gate must run BEFORE the /internal/admin/* delegation, or the "
      + "users/teams/memberships CRUD is served unauthenticated");
  },

  // AC1b — the gate actually rejects, rather than only logging.
  "gate-denies": (code) => {
    const handler = sliceFrom(code, "const internalApi = http.createServer((req, res) => {", 4000);
    const gateAt = handler.indexOf("internalAuth.decideInternalAuth({");
    const denyAt = handler.indexOf("if (authDecision.denied) {", gateAt);
    assert.ok(denyAt > gateAt, "the gate computes a decision but never acts on it");
    const denyBlock = handler.slice(denyAt, denyAt + 400);
    assert.match(denyBlock, /sendJson\(res, authDecision\.status/,
      "a denied request must be answered with the decision's own status");
    assert.match(denyBlock, /return;/, "a denied request must not fall through to a route");
  },

  // AC2 — the control-plane credential is stripped from the agent container env,
  // and the strip happens after the spread that put it there.
  "control-plane-token-stripped": (code) => {
    const fn = sliceFrom(code, "function startAgentProcess(config) {", 6000);
    const spreadAt = fn.indexOf("...process.env");
    assert.notEqual(spreadAt, -1, "the env spread moved — re-anchor this guard");
    for (const secret of ["INTERNAL_API_TOKEN", "INTERNAL_AGENT_TOKEN_SECRET"]) {
      const at = fn.indexOf(`delete childEnv.${secret};`);
      assert.notEqual(at, -1,
        `childEnv.${secret} is not deleted — the orchestrator's own control-plane `
        + "credential would be inherited by EVERY agent container, granting each one "
        + "the full /internal/* surface the per-agent token exists to narrow");
      assert.ok(at > spreadAt, `the ${secret} delete must come after the ...process.env spread`);
    }
  },

  // AC3 — the per-agent token is minted here, so every respawn re-mints it.
  "agent-token-minted-at-spawn": (code) => {
    const fn = sliceFrom(code, "function startAgentProcess(config) {", 6000);
    assert.match(fn, /internalAuth\.mintAgentToken\(id, internalAuthConfig\.agentTokenSecret\)/,
      "startAgentProcess must mint the per-agent token — minting it anywhere else "
      + "breaks rotation, since all three respawn paths funnel through here");
    assert.match(fn, /childEnv\.AEE_INTERNAL_TOKEN = /,
      "the minted token must reach the container env");
    // …and an unarmed stack must not ship an inherited stale value under that name.
    assert.match(fn, /delete childEnv\.AEE_INTERNAL_TOKEN;/,
      "with no token minted the variable must be removed, not left inherited");
  },

  // AC4 — a lockout config is refused at boot.
  "boot-refusal": (code) => {
    const fn = sliceFrom(code, "async function main() {", 3000);
    const refusalAt = fn.indexOf("internalAuth.bootRefusal(internalAuthConfig)");
    assert.notEqual(refusalAt, -1, "main() must check bootRefusal before serving");
    assert.match(fn.slice(refusalAt, refusalAt + 400), /process\.exit\(1\)/,
      "a lockout config must stop the boot, not merely log");
  },

  // The config is a deployment property, read once — not per request, where a
  // half-applied env change could flip the gate mid-flight.
  "config-resolved-once": (code) => {
    assert.match(code, /^const internalAuthConfig = internalAuth\.resolveInternalAuthConfig\(process\.env\);$/m,
      "the internal-auth config must be resolved once at module level");
    const occurrences = code.split("resolveInternalAuthConfig(").length - 1;
    assert.equal(occurrences, 1, "exactly one resolution site");
  },
};

function runCheck(name, code) {
  try {
    CHECKS[name](code);
    return null;
  } catch (err) {
    return err.message;
  }
}

for (const name of Object.keys(CHECKS)) {
  test(`wiring: ${name}`, () => {
    const failure = runCheck(name, CODE);
    assert.equal(failure, null, failure || "");
  });
}

// ── Mutation proof ──────────────────────────────────────────────────────────
//
// One mutation at a time, each applied to a PRISTINE copy of the source, each
// asserted to have actually changed the text before the check is run (a
// substitution that silently matched nothing would make the proof vacuous), and
// each asserted to trip the SPECIFIC guard it targets — not merely "a" guard.

const MUTATIONS = [
  {
    name: "moving the gate below the /internal/admin delegation",
    check: "gate-is-first",
    apply: (code) => {
      // Delete the gate's decide call so it can no longer precede anything.
      const at = code.indexOf("const authDecision = internalAuth.decideInternalAuth({");
      return code.slice(0, at) + code.slice(at).replace(
        "internalAuth.decideInternalAuth({", "internalAuth.NOT_THE_GATE({");
    },
  },
  {
    name: "logging the denial but serving the request anyway",
    check: "gate-denies",
    apply: (code) => code.replace("if (authDecision.denied) {\n        sendJson(res, authDecision.status",
      "if (false) {\n        sendJson(res, authDecision.status"),
  },
  {
    name: "forgetting to strip the control-plane token from the agent env",
    check: "control-plane-token-stripped",
    apply: (code) => code.replace("  delete childEnv.INTERNAL_API_TOKEN;\n", ""),
  },
  {
    name: "forgetting to strip the agent-token signing secret",
    check: "control-plane-token-stripped",
    apply: (code) => code.replace("  delete childEnv.INTERNAL_AGENT_TOKEN_SECRET;\n", ""),
  },
  {
    name: "stripping the token BEFORE the spread that re-adds it",
    check: "control-plane-token-stripped",
    apply: (code) => code
      .replace("  delete childEnv.INTERNAL_API_TOKEN;\n", "")
      .replace("function startAgentProcess(config) {",
        "function startAgentProcess(config) {\n  delete childEnv.INTERNAL_API_TOKEN;"),
  },
  {
    name: "not minting the per-agent token at spawn",
    check: "agent-token-minted-at-spawn",
    apply: (code) => code.replace(
      "internalAuth.mintAgentToken(id, internalAuthConfig.agentTokenSecret)", "null"),
  },
  {
    name: "downgrading the boot refusal to a warning",
    check: "boot-refusal",
    apply: (code) => {
      const at = code.indexOf("internalAuth.bootRefusal(internalAuthConfig)");
      const head = code.slice(0, at);
      const tail = code.slice(at, at + 400).replace("process.exit(1);", "void 0;");
      return head + tail + code.slice(at + 400);
    },
  },
  {
    name: "re-resolving the config per request",
    check: "config-resolved-once",
    apply: (code) => code.replace(
      "      method: req.method, url: req.url, headers: req.headers, config: internalAuthConfig,",
      "      method: req.method, url: req.url, headers: req.headers,\n"
      + "      config: internalAuth.resolveInternalAuthConfig(process.env),"),
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation proof: ${mutation.name} trips ${mutation.check}`, () => {
    const mutated = mutation.apply(CODE);
    assert.notEqual(mutated, CODE,
      "the sabotage matched nothing — this proof would be vacuous");
    const failure = runCheck(mutation.check, mutated);
    assert.ok(failure, `${mutation.check} did NOT fire on: ${mutation.name}`);
  });
}

test("every check is covered by at least one mutation", () => {
  const covered = new Set(MUTATIONS.map((m) => m.check));
  for (const name of Object.keys(CHECKS)) {
    assert.ok(covered.has(name), `check "${name}" has no mutation proving it fires`);
  }
});
