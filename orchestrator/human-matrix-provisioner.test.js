"use strict";

// Run: node --test orchestrator/human-matrix-provisioner.test.js
//
// #2721 AC2 (backfill incl. the bootstrap admin, idempotent), AC3 (retry after
// a failed provisioning), AC8 (status) and the "two concurrent first sends"
// edge case, against fakes for the Matrix side.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createHumanMatrixProvisioner,
  STATUS_READY,
  STATUS_PENDING,
  STATUS_FAILED,
} = require("./human-matrix-provisioner");

// A fake homeserver: `accounts` counts account creations per subject, and
// `down` makes every provisioning attempt fail like an unreachable admin bot.
function fakeWorld(users) {
  const identities = new Map();
  const accounts = new Map();
  const world = {
    users,
    identities,
    accounts,
    down: false,
    calls: 0,
    provision: async (user) => {
      world.calls += 1;
      await new Promise((r) => setImmediate(r));
      if (world.down) throw new Error("homeserver unavailable");
      // Like ensureHumanMatrixIdentity: an existing credential short-circuits.
      if (identities.has(user.id)) return identities.get(user.id);
      accounts.set(user.subject, (accounts.get(user.subject) || 0) + 1);
      const record = { matrixUserId: `@u-${user.subject}:local`, accessToken: `t-${user.id}` };
      identities.set(user.id, record);
      return record;
    },
    hasIdentity: (user) => identities.has(user.id),
    listUsers: () => world.users,
  };
  return world;
}

function provisionerFor(world) {
  return createHumanMatrixProvisioner({
    provision: world.provision,
    hasIdentity: world.hasIdentity,
    listUsers: world.listUsers,
    now: () => Date.parse("2026-10-01T10:00:00Z"),
  });
}

const BOOTSTRAP_ADMIN = { id: "a", subject: "admin@example.com", systemAdmin: true };
const PRE_2173_USER = { id: "b", subject: "klaas@example.com" };
const PROVISIONED = { id: "c", subject: "ada@example.com" };

test("backfill provisions every user without an identity, the bootstrap System Admin included", async () => {
  const world = fakeWorld([BOOTSTRAP_ADMIN, PRE_2173_USER, PROVISIONED]);
  world.identities.set("c", { matrixUserId: "@u-ada:local", accessToken: "t" });
  const p = provisionerFor(world);

  const summary = await p.backfill();

  assert.deepEqual(summary, { attempted: 2, provisioned: 2, failed: 0 });
  assert.ok(world.identities.has("a"), "the bootstrap System Admin gets an identity");
  assert.ok(world.identities.has("b"), "a user created before #2173 gets an identity");
  assert.equal(world.accounts.get("ada@example.com"), undefined, "an already-provisioned user is not touched");
});

test("running the backfill again creates no duplicate accounts", async () => {
  const world = fakeWorld([BOOTSTRAP_ADMIN, PRE_2173_USER]);
  const p = provisionerFor(world);
  await p.backfill();
  const callsAfterFirst = world.calls;

  const again = await p.backfill();

  assert.deepEqual(again, { attempted: 0, provisioned: 0, failed: 0 });
  assert.equal(world.calls, callsAfterFirst, "a second pass makes no provisioning call");
  assert.equal(world.accounts.get("admin@example.com"), 1);
  assert.equal(world.accounts.get("klaas@example.com"), 1);
});

test("overlapping backfill passes share one run", async () => {
  const world = fakeWorld([BOOTSTRAP_ADMIN, PRE_2173_USER]);
  const p = provisionerFor(world);
  const [one, two] = await Promise.all([p.backfill(), p.backfill()]);
  assert.equal(one, two);
  assert.equal(world.calls, 2);
});

test("a failed provisioning is recorded and retried by the next pass", async () => {
  const world = fakeWorld([PRE_2173_USER]);
  const p = provisionerFor(world);

  world.down = true;
  const first = await p.backfill();
  assert.deepEqual(first, { attempted: 1, provisioned: 0, failed: 1 });
  const failed = p.statusFor(PRE_2173_USER);
  assert.equal(failed.status, STATUS_FAILED);
  assert.match(failed.error, /homeserver unavailable/);
  assert.equal(failed.lastAttemptAt, "2026-10-01T10:00:00.000Z");

  world.down = false;
  const second = await p.backfill();
  assert.deepEqual(second, { attempted: 1, provisioned: 1, failed: 0 });
  assert.deepEqual(p.statusFor(PRE_2173_USER), { status: STATUS_READY });
});

test("a send-time ensure after a failed attempt completes the provisioning", async () => {
  // AC3: "at the latest, it is completed before that user's next chat message".
  const world = fakeWorld([PRE_2173_USER]);
  const p = provisionerFor(world);
  world.down = true;
  await assert.rejects(p.ensure(PRE_2173_USER), /homeserver unavailable/);
  world.down = false;
  const record = await p.ensure(PRE_2173_USER);
  assert.equal(record.matrixUserId, "@u-klaas@example.com:local");
});

test("two concurrent first sends by the same user share one attempt and create one account", async () => {
  const world = fakeWorld([PRE_2173_USER]);
  const p = provisionerFor(world);
  const [a, b] = await Promise.all([p.ensure(PRE_2173_USER), p.ensure(PRE_2173_USER)]);
  assert.equal(a, b);
  assert.equal(world.calls, 1);
  assert.equal(world.accounts.get("klaas@example.com"), 1);
});

test("a user that left the list is not provisioned by the backfill", async () => {
  // Deleted users are gone from the index, so the backfill never re-creates them.
  const world = fakeWorld([PRE_2173_USER]);
  const p = provisionerFor(world);
  world.users = [];
  const summary = await p.backfill();
  assert.deepEqual(summary, { attempted: 0, provisioned: 0, failed: 0 });
  assert.equal(world.calls, 0);
});

test("status reads pending before the first attempt and while one is running", async () => {
  const world = fakeWorld([PRE_2173_USER]);
  const p = provisionerFor(world);
  assert.deepEqual(p.statusFor(PRE_2173_USER), { status: STATUS_PENDING });
  world.down = true;
  await p.ensure(PRE_2173_USER).catch(() => {});
  world.down = false;
  const running = p.ensure(PRE_2173_USER);
  assert.deepEqual(p.statusFor(PRE_2173_USER), { status: STATUS_PENDING }, "a retry in progress reads as pending");
  await running;
  assert.deepEqual(p.statusFor(PRE_2173_USER), { status: STATUS_READY });
});

test("records without an id or subject are skipped, and a throwing listUsers is survived", async () => {
  const world = fakeWorld([{ id: "x" }, { subject: "no-id@example.com" }, null]);
  const p = provisionerFor(world);
  assert.deepEqual(await p.backfill(), { attempted: 0, provisioned: 0, failed: 0 });
  world.listUsers = () => { throw new Error("index unreadable"); };
  const broken = createHumanMatrixProvisioner({
    provision: world.provision, hasIdentity: world.hasIdentity, listUsers: world.listUsers,
  });
  assert.deepEqual(await broken.backfill(), { attempted: 0, provisioned: 0, failed: 0 });
  await assert.rejects(p.ensure({}), /a user with an id is required/);
});
