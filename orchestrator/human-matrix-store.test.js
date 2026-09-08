"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHumanMatrixStore, FILE_MODE, DIR_MODE } = require("./human-matrix-store");
const { createTeamsStore } = require("./teams-store");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "human-matrix-store-"));
}

test("createHumanMatrixStore requires a root", () => {
  assert.throws(() => createHumanMatrixStore(), /root.*required/);
  assert.throws(() => createHumanMatrixStore({ root: "  " }), /root.*required/);
});

test("write → read round-trips the credential", () => {
  const store = createHumanMatrixStore({ root: tempRoot() });
  const written = store.writeIdentity(UUID_A, {
    matrixUserId: "@u-0123456789abcdef:local",
    accessToken: "syt_secret",
  });
  assert.equal(written.matrixUserId, "@u-0123456789abcdef:local");
  assert.equal(written.accessToken, "syt_secret");
  assert.ok(written.provisionedAt, "provisionedAt is stamped");

  const read = store.readIdentity(UUID_A);
  assert.deepEqual(read, written);
});

test("a user with no credential reads as null, not as a throw", () => {
  const store = createHumanMatrixStore({ root: tempRoot() });
  assert.equal(store.readIdentity(UUID_A), null);
});

test("a corrupt credential file reads as null so the caller re-provisions", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "t" });
  fs.writeFileSync(path.join(root, "users", "matrix", `${UUID_A}.json`), "{not json");
  assert.equal(store.readIdentity(UUID_A), null);
});

test("a JSON array is not a credential record", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "t" });
  fs.writeFileSync(path.join(root, "users", "matrix", `${UUID_A}.json`), "[]");
  assert.equal(store.readIdentity(UUID_A), null);
});

test("writeIdentity rejects an incomplete credential", () => {
  const store = createHumanMatrixStore({ root: tempRoot() });
  assert.throws(() => store.writeIdentity(UUID_A, { accessToken: "t" }), /matrixUserId is required/);
  assert.throws(
    () => store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local" }),
    /accessToken is required/,
  );
  assert.throws(
    () => store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "" }),
    /accessToken is required/,
  );
});

// ---- the secret never becomes world-readable --------------------------------

test("the credential file and its directory are owner-only", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "syt_secret" });

  const filePerm = fs.statSync(path.join(root, "users", "matrix", `${UUID_A}.json`)).mode & 0o777;
  assert.equal(filePerm, FILE_MODE, `file mode ${filePerm.toString(8)} should be 600`);

  const dirPerm = fs.statSync(path.join(root, "users", "matrix")).mode & 0o777;
  assert.equal(dirPerm, DIR_MODE, `dir mode ${dirPerm.toString(8)} should be 700`);
});

test("no temp file is left behind after a write", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "t" });
  const leftovers = fs.readdirSync(path.join(root, "users", "matrix")).filter(f => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

// ---- the split from users/index.json ----------------------------------------

test("the Matrix access token never lands in users/index.json", () => {
  // The whole reason this store exists: teams-store's sanitizeUser() is a
  // convention applied at the store boundary, and users/index.json is also read
  // directly by the admin-console — so a second secret on that record would
  // depend on every present and future path remembering to strip it. Keeping
  // the token in its own file makes the split structural instead.
  const root = tempRoot();
  const teams = createTeamsStore({ root });
  const store = createHumanMatrixStore({ root });

  const user = teams.createUser({ subject: "alice@corp.example", displayName: "Alice" });
  store.writeIdentity(user.id, {
    matrixUserId: "@u-0123456789abcdef:local",
    accessToken: "syt_super_secret",
  });

  const rawIndex = fs.readFileSync(path.join(root, "users", "index.json"), "utf8");
  assert.ok(
    !rawIndex.includes("syt_super_secret"),
    "the access token must not appear anywhere in the users index",
  );
  assert.ok(!rawIndex.includes("accessToken"));

  // …and the credential really was persisted, so the assertion above is not
  // vacuously true because nothing was written.
  assert.equal(store.readIdentity(user.id).accessToken, "syt_super_secret");
});

test("the credential file lives outside the users index file", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  assert.equal(store.MATRIX_DIR, path.join(root, "users", "matrix"));
  assert.notEqual(store.MATRIX_DIR, path.join(root, "users", "index.json"));
});

// ---- path-injection guard ---------------------------------------------------

test("a non-UUID user id is refused rather than joined into a path", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  for (const bad of ["../../etc/passwd", "a/b", "", "not-a-uuid", null, {}]) {
    assert.throws(
      () => store.writeIdentity(bad, { matrixUserId: "@u-1:local", accessToken: "t" }),
      /Invalid user id/,
      `writeIdentity must refuse ${String(bad)}`,
    );
    // Reads and deletes fail soft — they must not throw at their call sites.
    assert.equal(store.readIdentity(bad), null);
    assert.deepEqual(store.deleteIdentity(bad), { userId: bad, deleted: false });
  }
});

// ---- delete / list ----------------------------------------------------------

test("deleteIdentity removes the credential and is idempotent", () => {
  const store = createHumanMatrixStore({ root: tempRoot() });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "t" });

  assert.deepEqual(store.deleteIdentity(UUID_A), { userId: UUID_A, deleted: true });
  assert.equal(store.readIdentity(UUID_A), null);
  // Off-boarding may run twice; the second pass must not fail.
  assert.deepEqual(store.deleteIdentity(UUID_A), { userId: UUID_A, deleted: false });
});

test("deleting one user's credential leaves the others alone", () => {
  const store = createHumanMatrixStore({ root: tempRoot() });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "ta" });
  store.writeIdentity(UUID_B, { matrixUserId: "@u-2:local", accessToken: "tb" });
  store.deleteIdentity(UUID_A);
  assert.equal(store.readIdentity(UUID_B).accessToken, "tb");
});

test("listProvisionedUserIds returns ids only — never tokens — and ignores stray files", () => {
  const root = tempRoot();
  const store = createHumanMatrixStore({ root });
  store.writeIdentity(UUID_A, { matrixUserId: "@u-1:local", accessToken: "ta" });
  store.writeIdentity(UUID_B, { matrixUserId: "@u-2:local", accessToken: "tb" });
  fs.writeFileSync(path.join(root, "users", "matrix", "README.txt"), "not a credential");
  fs.writeFileSync(path.join(root, "users", "matrix", "not-a-uuid.json"), "{}");

  const ids = store.listProvisionedUserIds().sort();
  assert.deepEqual(ids, [UUID_A, UUID_B].sort());
});

test("listProvisionedUserIds is empty before anything is provisioned", () => {
  const store = createHumanMatrixStore({ root: tempRoot() });
  assert.deepEqual(store.listProvisionedUserIds(), []);
});
