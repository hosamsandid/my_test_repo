"use strict";

// #2135 — the create-user route, EXECUTED.
//
// `orchestrator.js` is a monolith with no exports that starts a service on
// require, so the house convention (#651) is to assert its wiring against the
// source text. `human-matrix-wiring.test.js` does exactly that — and it is
// precisely why `orchestrator.adminClient` shipped: a source-text guard cannot
// see a scoping error, and that one had pinned the buggy identifier, so it read
// the wrong name back and agreed with itself.
//
// So this file does the other thing. It slices `handleTeamsAdminApi` out of the
// source and evaluates it in a `vm` context whose global holds ONLY the
// module-level bindings that really exist beside it. A free identifier the
// function reads and the module does not define — `orchestrator`, or whatever
// the next copy-paste introduces — throws a ReferenceError here, at the line
// that reads it, which is the class of bug the regex guard slept through.
//
// The cost is that a NEW module-level dependency of this function must be added
// to STUB_NAMES below. That is the point, not an accident: the list is the
// function's declared surface, and the failure message names the identifier.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

// ---------------------------------------------------------------------------
// AC4 — the CLASS of bug is closed, not just its three instances.
// ---------------------------------------------------------------------------

// Every top-level `function`/`async function` in the file, sliced at the first
// closing brace in column 0 (these functions are all top-level, the same rule
// `human-matrix-wiring.js` slices by).
function topLevelFunctions() {
  const out = [];
  const re = /^(?:async )?function ([A-Za-z0-9_$]+)\(/gm;
  let m;
  while ((m = re.exec(SRC))) {
    const end = SRC.indexOf("\n}\n", m.index);
    out.push({ name: m[1], body: SRC.slice(m.index, end === -1 ? SRC.length : end) });
  }
  return out;
}

// `orchestrator` as a RECEIVER (`orchestrator.<something>`), not as part of a
// longer identifier — `orchestratorSingleton.` must not match.
const BARE_RECEIVER = /(?<![A-Za-z0-9_$])orchestrator\.[A-Za-z_$]/g;

// The ONLY scope where a local `const orchestrator = new Orchestrator()` exists.
const ORCHESTRATOR_LOCAL_SCOPES = new Set(["main"]);

test("no module-level free function reads the bare `orchestrator` receiver", () => {
  const fns = topLevelFunctions();
  const offenders = [];
  for (const fn of fns) {
    if (ORCHESTRATOR_LOCAL_SCOPES.has(fn.name)) continue;
    const hits = fn.body.match(BARE_RECEIVER);
    if (hits) offenders.push(`${fn.name}() reads ${hits.length}× \`orchestrator.\``);
  }
  assert.deepEqual(
    offenders,
    [],
    "`orchestrator` is local to main(); a free function must use the module-level "
    + `\`orchestratorSingleton\` (null-guarded): ${offenders.join("; ")}`,
  );
});

test("the scan is not vacuous — it finds function bodies and main()'s own uses", () => {
  const fns = topLevelFunctions();
  assert.ok(fns.length > 100, `expected the file's top-level functions, found ${fns.length}`);
  assert.ok(fns.some(f => f.name === "handleTeamsAdminApi"), "the route's own function must be scanned");

  // main() legitimately holds `const orchestrator`, so it must still match —
  // otherwise the rule above passes because the pattern matches nothing at all.
  const main = fns.find(f => f.name === "main");
  assert.ok(main, "expected main()");
  assert.ok(
    (main.body.match(BARE_RECEIVER) || []).length > 10,
    "main() must still read `orchestrator.` — otherwise the receiver pattern is broken",
  );

  // ...and `orchestratorSingleton.` must NOT be counted as a bare receiver.
  assert.equal(
    ("orchestratorSingleton.adminClient".match(BARE_RECEIVER) || []).length,
    0,
    "the receiver pattern must not match `orchestratorSingleton.`",
  );
});

// ---------------------------------------------------------------------------
// AC7 — the route is loaded and run, so a ReferenceError fails CI.
// ---------------------------------------------------------------------------

// The module-level bindings `handleTeamsAdminApi` may read. Anything it reads
// that is not here is, by construction, not defined beside it either.
// (`clean` is NOT here: the function declares its own
// `const clean = teamsStore.sanitizeUser` — a sandbox entry for it would be
// shadowed and silently unused, which is the kind of stub that reads as
// coverage while covering nothing.)
const STUB_NAMES = [
  "teamsStore",
  "readBody",
  "sendJson",
  "teamAdminSuccession",
  "teamHasOwnedResources",
  "provisionHumanMatrixIdentityInBackground",
  "deprovisionHumanMatrixIdentity",
  "orchestratorSingleton",
];

function handlerSource() {
  const start = SRC.indexOf("async function handleTeamsAdminApi(");
  assert.notEqual(start, -1, "expected handleTeamsAdminApi in orchestrator.js");
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "could not find the end of handleTeamsAdminApi");
  const body = SRC.slice(start, end + 2);
  assert.ok(body.includes("teamsStore.createUser(body)"), "the slice must contain the create-user branch");
  assert.ok(body.includes("teamsStore.deleteUser(resourceId)"), "the slice must contain the delete-user branch");
  return body;
}

// Build a fresh sandbox per test so calls are never shared between them.
function loadHandler(overrides = {}) {
  const calls = { provisioned: [], deprovisioned: [], offboarded: [], logs: [] };

  const sandbox = {
    URL,
    decodeURIComponent,
    console: {
      log: (...a) => calls.logs.push(String(a[0])),
      warn: (...a) => calls.logs.push(String(a[0])),
      error: (...a) => calls.logs.push(String(a[0])),
    },
    teamsStore: {
      createUser: (body) => ({ id: "u-1", ...body, passwordHash: "SECRET" }),
      deleteUser: (id) => ({ id, deleted: true }),
      listMemberships: () => [],
      // The route aliases this as its local `clean`.
      sanitizeUser: (u) => { const { passwordHash, ...rest } = u; return rest; },
    },
    readBody: async () => ({ subject: "jane@corp.com", displayName: "Jane Doe" }),
    sendJson: (res, status, payload) => { res.sent = { status, payload }; },
    teamAdminSuccession: { planUserDeletion: () => ({ ok: true }) },
    teamHasOwnedResources: () => false,
    provisionHumanMatrixIdentityInBackground: (adminClient, user) => {
      calls.provisioned.push({ adminClient, user });
    },
    deprovisionHumanMatrixIdentity: async (adminClient, userId) => {
      calls.deprovisioned.push({ adminClient, userId });
    },
    orchestratorSingleton: { adminClient: "ADMIN", offboardOwner: async (id) => { calls.offboarded.push(id); return { paused: 2 }; } },
    ...overrides,
  };

  // Anything the function reads that is NOT in the sandbox throws a
  // ReferenceError from inside the vm — which is exactly the failure #2135 was.
  for (const name of STUB_NAMES) {
    assert.ok(name in sandbox, `STUB_NAMES lists ${name} but the sandbox does not define it`);
  }

  vm.createContext(sandbox);
  const fn = vm.runInContext(`(${handlerSource()})`, sandbox, { filename: "handleTeamsAdminApi.js" });
  return { fn, calls, sandbox };
}

async function call(fn, method, url) {
  const res = {};
  const handled = await fn({ method, url }, res);
  return { handled, res };
}

test("POST /internal/admin/users returns 201 with the created record", async () => {
  const { fn, calls } = loadHandler();

  const { handled, res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(handled, true, "the route must report itself handled");
  assert.ok(res.sent, "the route must send a response — a ReferenceError here sends none");
  assert.equal(res.sent.status, 201, "a persisted user must be reported as created, never as a 500");
  assert.equal(res.sent.payload.id, "u-1");
  assert.equal(res.sent.payload.passwordHash, undefined, "the response must still be sanitized");
  assert.deepEqual(
    calls.provisioned.map(c => c.adminClient),
    ["ADMIN"],
    "provisioning must be handed the singleton's adminClient",
  );
});

test("a missing orchestrator singleton degrades the create — it does not throw", async () => {
  // The boot window: `internalApi` is listening before main() assigns the
  // singleton. `ensureHumanMatrixIdentity` tolerates a null adminClient, so the
  // create must still succeed with the identity left for the next call to repair.
  const { fn, calls } = loadHandler({ orchestratorSingleton: null });

  const { res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(res.sent.status, 201);
  assert.deepEqual(calls.provisioned.map(c => c.adminClient), [null]);
});

test("post-persist work cannot fail a write that already landed", async () => {
  // AC5. The record is on disk before this line; a throw after it must not be
  // reported to the operator as a failure.
  const { fn, calls } = loadHandler({
    provisionHumanMatrixIdentityInBackground: () => { throw new Error("homeserver down"); },
  });

  const { res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(res.sent.status, 201, "the create must still be reported as created");
  assert.equal(res.sent.payload.id, "u-1");
  assert.ok(
    calls.logs.some(l => l.includes("homeserver down")),
    "the degradation must be logged rather than swallowed",
  );
});

test("DELETE /internal/admin/users/:id actually offboards and de-provisions", async () => {
  // AC3. Both of these have been dead since 2026-08-11 — inside a try/catch, so
  // they logged a ReferenceError and the delete looked clean.
  const { fn, calls } = loadHandler();

  const { res } = await call(fn, "DELETE", "/internal/admin/users/u-1");

  assert.equal(res.sent.status, 200);
  assert.deepEqual(calls.offboarded, ["u-1"], "owner offboarding must run on delete");
  assert.deepEqual(
    calls.deprovisioned,
    [{ adminClient: "ADMIN", userId: "u-1" }],
    "the departing human's Matrix identity must be de-provisioned",
  );
  assert.equal(
    calls.logs.some(l => l.includes("is not defined")),
    false,
    "no step may degrade into a logged ReferenceError",
  );
  assert.deepEqual(res.sent.payload.offboarding, { paused: 2 }, "the offboarding result must ride the response");
});

test("the sandbox really would catch a ReferenceError (anti-vacuity)", () => {
  // Prove the mechanism rather than trusting it: the same evaluation of a
  // function reading an undefined free identifier must throw.
  const sandbox = {};
  vm.createContext(sandbox);
  const probe = vm.runInContext("(function () { return orchestrator.adminClient; })", sandbox);
  // `instanceof` is cross-realm here — the vm context has its own ReferenceError
  // constructor — so match on the name, which is what a reader of the bug report
  // saw in the dialog anyway.
  assert.throws(() => probe(), (err) => err.name === "ReferenceError"
    && /orchestrator is not defined/.test(err.message));
});
