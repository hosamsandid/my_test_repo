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
  // #2138 AC5 — the degraded-offboarding event-log writer. It is a named
  // module-level helper rather than an inline `githubEventLog.record(…)`
  // precisely so it can be stubbed here and asserted on.
  "recordOffboardingDegradation",
  // #2721 — the deduping provisioner behind the send-time and operator
  // matrix-identity routes, and the Users-page status decoration.
  "humanMatrixProvisioner",
  "withMatrixIdentityStatus",
  "OPERATOR_PROVISION_KEY_PREFIX",
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
  const calls = { provisioned: [], deprovisioned: [], offboarded: [], logs: [], degradations: [], ensured: [] };

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
    provisionHumanMatrixIdentityInBackground: (user) => {
      calls.provisioned.push({ user });
    },
    deprovisionHumanMatrixIdentity: async (adminClient, userId) => {
      calls.deprovisioned.push({ adminClient, userId });
    },
    orchestratorSingleton: {
      adminClient: "ADMIN",
      offboardOwner: async (id) => {
        calls.offboarded.push(id);
        // The real shape (#1571): the summary the route now reports verbatim.
        return { ownerId: id, paused: ["a-1"], skipped: [], deletedCredentials: [{ id: "k-1", kind: "ssh-key" }] };
      },
    },
    recordOffboardingDegradation: (userId, detail) => { calls.degradations.push({ userId, detail }); },
    humanMatrixProvisioner: {
      ensure: async (user) => {
        calls.ensured.push(user);
        return { matrixUserId: "@u-0123456789abcdef:local", accessToken: "SECRET-TOKEN" };
      },
      statusFor: () => ({ status: "ready" }),
    },
    withMatrixIdentityStatus: (u) => ({ ...u, matrixIdentity: { status: "ready" } }),
    OPERATOR_PROVISION_KEY_PREFIX: "operator:",
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
    calls.provisioned.map(c => c.user.id),
    ["u-1"],
    "provisioning must be started for the created record",
  );
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
  // Re-homed with a spread: since #2138 the route BUILDS this object (`{ok:true,
  // ...summary}`) inside the vm, so it carries the sandbox realm's
  // Object.prototype and strict deepEqual would reject it on identity alone.
  assert.deepEqual(
    { ...res.sent.payload.offboarding },
    { ok: true, ownerId: "u-1", paused: ["a-1"], skipped: [], deletedCredentials: [{ id: "k-1", kind: "ssh-key" }] },
    "the offboarding result must ride the response, tagged ok",
  );
  assert.deepEqual(calls.degradations, [], "a clean offboarding raises no degradation event");
});

// ---------------------------------------------------------------------------
// #2138 AC4/AC5 — offboarding runs, and a failure of it is never silent.
//
// AC5's own words: "log line only" is what hid this for four weeks. Q1 is
// answered "complete the deletion and report the degradation" — so each of
// these asserts BOTH halves: the user is still deleted, AND the failure is
// visible in the response and on the operator's timeline.
// ---------------------------------------------------------------------------

test("#2138 AC5: a throwing offboarding is reported in the response and the event log", async () => {
  const { fn, calls } = loadHandler({
    orchestratorSingleton: {
      adminClient: "ADMIN",
      offboardOwner: async () => { throw new Error("credential index unreadable"); },
    },
  });

  const { res } = await call(fn, "DELETE", "/internal/admin/users/u-1");

  assert.equal(res.sent.status, 200, "the deletion still completes — refusing would strand the user WITH their secrets");
  assert.equal(res.sent.payload.deleted, true);
  assert.equal(res.sent.payload.offboarding.ok, false, "`offboarding` must never be a bare null again");
  assert.equal(res.sent.payload.offboarding.error, "credential index unreadable");
  assert.equal(res.sent.payload.offboarding.ownerId, "u-1");
  assert.deepEqual(
    calls.degradations,
    [{ userId: "u-1", detail: "credential index unreadable" }],
    "the degradation must reach the operator-visible event log, not only the console",
  );
  assert.ok(
    calls.logs.some(l => l.includes("REVOKE")),
    "the log line must say what the operator has to do, not just that something failed",
  );
});

test("#2138 AC5: an uninitialised orchestrator is a reported degradation, not a clean delete", async () => {
  // The boot window. Before #2138 this branch logged a warning and left
  // `offboarding: null` — indistinguishable from a delete that offboarded.
  const { fn, calls } = loadHandler({ orchestratorSingleton: null });

  const { res } = await call(fn, "DELETE", "/internal/admin/users/u-1");

  assert.equal(res.sent.status, 200);
  assert.equal(res.sent.payload.offboarding.ok, false);
  assert.match(res.sent.payload.offboarding.error, /not initialised/);
  assert.equal(calls.degradations.length, 1, "the skipped offboarding must be recorded");
});

test("#2138 AC5: a PARTIAL offboarding is degraded too — an unpausable agent is not a clean run", async () => {
  // `offboardOwner` is best-effort per item and returns what it could not do.
  // Reporting only thrown errors would call this a success while an agent of
  // the departed human is still running under their credentials.
  const { fn, calls } = loadHandler({
    orchestratorSingleton: {
      adminClient: "ADMIN",
      offboardOwner: async (id) => ({ ownerId: id, paused: ["a-1"], skipped: ["a-2"], deletedCredentials: [] }),
    },
  });

  const { res } = await call(fn, "DELETE", "/internal/admin/users/u-1");

  assert.equal(res.sent.status, 200);
  assert.equal(res.sent.payload.offboarding.ok, true, "nothing threw, so `ok` stays true");
  assert.deepEqual(res.sent.payload.offboarding.skipped, ["a-2"], "what could not be paused rides the response");
  assert.deepEqual(
    calls.degradations,
    [{ userId: "u-1", detail: "could not pause a-2" }],
    "a partial run must still raise the degradation event, naming the agent",
  );
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

// ---------------------------------------------------------------------------
// AC9 (D2) — the admin catch-all genericises UNTAGGED built-in errors and logs
// them server-side, while every statusHint-tagged domain message stays verbatim.
//
// These run the real catch-all (the tail of the sliced handleTeamsAdminApi), so
// a regression in the branch order or the guard condition fails here rather than
// leaking a raw ReferenceError to the client as #2135 did.
//
// Cross-realm note: the handler runs in the vm sandbox, so its `instanceof
// ReferenceError` checks the SANDBOX's constructor. A ReferenceError minted in
// this (Node) realm would not match — the same cross-realm fact the anti-vacuity
// test above relies on — so the built-in-error fixtures are minted INSIDE the
// sandbox via `vm.runInContext`.
// ---------------------------------------------------------------------------

test("AC9: an untagged built-in error is genericised and logged, never relayed", async () => {
  const { fn, calls, sandbox } = loadHandler();
  const makeRefError = vm.runInContext("(m) => new ReferenceError(m)", sandbox);
  // Exactly the #2135 shape: a ReferenceError with no statusHint reaching the
  // catch-all while handling POST /internal/admin/users.
  sandbox.teamsStore.createUser = () => { throw makeRefError("orchestrator is not defined"); };

  const { res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(res.sent.status, 500);
  assert.equal(
    res.sent.payload.error,
    "Internal server error",
    "a raw engine message must never reach the client",
  );
  assert.doesNotMatch(
    JSON.stringify(res.sent.payload),
    /orchestrator is not defined/,
    "the internal message must not leak anywhere in the response body",
  );
  assert.ok(
    calls.logs.some(l => l.includes("orchestrator is not defined")),
    "the real error must be logged server-side, not silently swallowed",
  );
});

test("AC9: a TypeError is genericised the same way (the rule is by type, not by one message)", async () => {
  const { fn, sandbox } = loadHandler();
  const makeTypeError = vm.runInContext("(m) => new TypeError(m)", sandbox);
  sandbox.teamsStore.createUser = () => { throw makeTypeError("Cannot read properties of undefined (reading 'x')"); };

  const { res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(res.sent.status, 500);
  assert.equal(res.sent.payload.error, "Internal server error");
});

test("AC9: a statusHint-tagged domain error is still forwarded verbatim (byte-identity contract)", async () => {
  const { fn, sandbox } = loadHandler();
  // The store's `tagged()` shape: a real message + statusHint (+ code). The UI
  // byte-identity contract (users-view.test.js / agent-repos-wiring.test.js)
  // depends on this reaching the reader unchanged.
  sandbox.teamsStore.createUser = () => {
    const e = new Error("Subject 'jane@corp.com' already exists");
    e.statusHint = 409;
    e.code = "duplicate-subject";
    throw e;
  };

  const { res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(res.sent.status, 409, "the tagged domain status must be preserved");
  assert.equal(
    res.sent.payload.error,
    "Subject 'jane@corp.com' already exists",
    "a tagged domain message must be forwarded byte-identical",
  );
  assert.equal(res.sent.payload.code, "duplicate-subject", "the machine-readable code must ride along");
});

test("AC9: an untagged NON-built-in error is still forwarded verbatim (the rule stays narrow)", async () => {
  const { fn, sandbox } = loadHandler();
  // A plain domain Error with no statusHint is not a ReferenceError/TypeError/
  // RangeError, so the new rule must NOT sweep it up — it keeps its pre-#2135
  // 500-verbatim behaviour.
  sandbox.teamsStore.createUser = () => { throw new Error("a plain domain failure"); };

  const { res } = await call(fn, "POST", "/internal/admin/users");

  assert.equal(res.sent.status, 500);
  assert.equal(
    res.sent.payload.error,
    "a plain domain failure",
    "a plain (non-built-in) error is not genericised",
  );
});

test("AC9 companion: readBody tags a malformed body 400, so the catch-all answers 400 not 500", async () => {
  const start = SRC.indexOf("function readBody(");
  assert.notEqual(start, -1, "expected readBody in orchestrator.js");
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "could not find the end of readBody");
  const src = SRC.slice(start, end + 2);
  assert.ok(src.includes("statusHint = 400"), "the readBody slice must carry the 400 tag");

  const readBodyFn = vm.runInContext(`(${src})`, vm.createContext({ Promise, JSON }));

  const handlers = {};
  const req = { on: (ev, cb) => { handlers[ev] = cb; return req; } };
  const p = readBodyFn(req);
  handlers.data("{ not valid json");
  handlers.end();

  await assert.rejects(p, (err) => {
    assert.equal(err.message, "invalid JSON body");
    assert.equal(err.statusHint, 400, "a malformed body must be tagged 400, not left to answer 500");
    return true;
  });
});

// ---------------------------------------------------------------------------
// #2721 — the send-time and single-operator identity routes, EXECUTED.
// ---------------------------------------------------------------------------

const failingProvisioner = (calls) => ({
  ensure: async (user) => { calls.push(user); throw new Error("homeserver unavailable"); },
  statusFor: () => ({ status: "failed" }),
});

test("POST /internal/admin/users/:id/matrix-identity provisions now and never returns the token", async () => {
  const { fn, calls } = loadHandler({
    teamsStore: { getUser: (id) => (id === "u-7" ? { id: "u-7", subject: "jane@corp.com" } : null), sanitizeUser: (u) => u },
  });
  const { handled, res } = await call(fn, "POST", "/internal/admin/users/u-7/matrix-identity");
  assert.equal(handled, true);
  assert.equal(res.sent.status, 200);
  // JSON round-trip: the payload is built inside the vm realm.
  assert.deepEqual(JSON.parse(JSON.stringify(res.sent.payload)), { matrixUserId: "@u-0123456789abcdef:local", status: "ready" });
  assert.ok(!JSON.stringify(res.sent.payload).includes("SECRET-TOKEN"), "the token must never leave the orchestrator");
  assert.deepEqual(calls.ensured.map((u) => u.id), ["u-7"]);
});

test("a failed send-time provisioning is a 503 with the chat-identity-not-ready code", async () => {
  const attempts = [];
  const { fn } = loadHandler({
    teamsStore: { getUser: () => ({ id: "u-7", subject: "jane@corp.com" }), sanitizeUser: (u) => u },
    humanMatrixProvisioner: failingProvisioner(attempts),
  });
  const { res } = await call(fn, "POST", "/internal/admin/users/u-7/matrix-identity");
  assert.equal(res.sent.status, 503);
  assert.equal(res.sent.payload.code, "chat-identity-not-ready");
  assert.equal(attempts.length, 1);
});

test("an unknown (or deleted) user is a 404 and is never provisioned", async () => {
  const { fn, calls } = loadHandler({
    teamsStore: { getUser: () => null, sanitizeUser: (u) => u },
  });
  const { res } = await call(fn, "POST", "/internal/admin/users/gone/matrix-identity");
  assert.equal(res.sent.status, 404);
  assert.deepEqual(calls.ensured, []);
});

test("POST /internal/admin/operator/matrix-identity provisions the single operator under its own key", async () => {
  const { fn, calls } = loadHandler({ readBody: async () => ({ subject: " Admin " }) });
  const { handled, res } = await call(fn, "POST", "/internal/admin/operator/matrix-identity");
  assert.equal(handled, true);
  assert.equal(res.sent.status, 200);
  assert.equal(res.sent.payload.matrixUserId, "@u-0123456789abcdef:local");
  assert.ok(!JSON.stringify(res.sent.payload).includes("SECRET-TOKEN"));
  assert.equal(calls.ensured.length, 1);
  assert.equal(calls.ensured[0].id, "operator:admin", "keyed apart from every user id, so no record collides");
  assert.equal(calls.ensured[0].operator, true);
  assert.equal(calls.ensured[0].subject, "Admin");
});

test("the operator route refuses a missing subject and fails closed on a provisioning error", async () => {
  const missing = loadHandler({ readBody: async () => ({}) });
  const r1 = await call(missing.fn, "POST", "/internal/admin/operator/matrix-identity");
  assert.equal(r1.res.sent.status, 400);
  assert.deepEqual(missing.calls.ensured, []);

  const attempts = [];
  const down = loadHandler({ readBody: async () => ({ subject: "admin" }), humanMatrixProvisioner: failingProvisioner(attempts) });
  const r2 = await call(down.fn, "POST", "/internal/admin/operator/matrix-identity");
  assert.equal(r2.res.sent.status, 503);
  assert.equal(r2.res.sent.payload.code, "chat-identity-not-ready");
});

test("GET /internal/admin/users decorates every record with its identity status (AC8)", async () => {
  const { fn } = loadHandler({
    teamsStore: { listUsers: () => [{ id: "u-1", passwordHash: "x" }], sanitizeUser: (u) => { const { passwordHash, ...r } = u; return r; } },
  });
  const { res } = await call(fn, "GET", "/internal/admin/users");
  assert.equal(res.sent.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.sent.payload)), [{ id: "u-1", matrixIdentity: { status: "ready" } }]);
});
