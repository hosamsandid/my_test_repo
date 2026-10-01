'use strict';

// Per-human Matrix identity provisioning — backfill, retry, status (#2721).
//
// #1458/#2173 provisioned a human's Matrix account in exactly one place: once,
// in the background, right after `POST /internal/admin/users`. Nothing retried
// it and nothing backfilled it, so a user created before #2173, the bootstrap
// System Admin (seeded through `teams-store` directly) and anyone whose one
// attempt hit a homeserver hiccup stayed without an identity for good — and the
// console then posted their chat messages under the shared admin account.
//
// This module owns the *policy* around the existing idempotent
// `ensureHumanMatrixIdentity` (orchestrator.js), so it can be unit-tested with
// fakes per #651:
//
//   ensure(user)  — the one entry point every caller goes through (user
//                   create, startup backfill, the periodic retry, and the
//                   console's send-time "provision now"). Concurrent calls for
//                   the same key share ONE in-flight attempt, so two first
//                   sends by the same not-yet-provisioned human cannot race
//                   into two Matrix accounts.
//   backfill()    — every listed user without a usable identity, one at a
//                   time. Driven at startup and on a timer, which is what makes
//                   a failed provisioning self-heal without an operator.
//   statusFor(u)  — 'ready' | 'pending' | 'failed' for the Users page.
//
// It holds no Matrix client and touches no disk itself: `provision`,
// `hasIdentity` and `listUsers` are injected.

const STATUS_READY = 'ready';
const STATUS_PENDING = 'pending';
const STATUS_FAILED = 'failed';

function createHumanMatrixProvisioner({
  provision,
  hasIdentity,
  listUsers,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (typeof provision !== 'function') throw new Error('createHumanMatrixProvisioner: provision is required');
  if (typeof hasIdentity !== 'function') throw new Error('createHumanMatrixProvisioner: hasIdentity is required');
  if (typeof listUsers !== 'function') throw new Error('createHumanMatrixProvisioner: listUsers is required');

  const inFlight = new Map();  // key → Promise
  const failures = new Map();  // key → { error, at }
  let backfillRun = null;

  function keyOf(user) {
    return user && user.id ? String(user.id) : null;
  }

  // Provision `user` now, or join the attempt already running for it. Resolves
  // with whatever `provision` resolves with; rejects with its error (after
  // recording it, so the Users page can show the failure).
  function ensure(user) {
    const key = keyOf(user);
    if (!key) return Promise.reject(new Error('ensure: a user with an id is required'));
    const running = inFlight.get(key);
    if (running) return running;
    const attempt = Promise.resolve()
      .then(() => provision(user))
      .then((result) => {
        failures.delete(key);
        return result;
      }, (err) => {
        failures.set(key, { error: String((err && err.message) || err), at: new Date(now()).toISOString() });
        throw err;
      })
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, attempt);
    return attempt;
  }

  // Every listed user without a usable identity, sequentially (each attempt
  // costs several seconds of admin-room settle delays; a burst would only make
  // the admin bot's queue the bottleneck). Idempotent by construction: a user
  // who already has an identity is skipped before any call is made, and the
  // underlying provisioning is itself idempotent. A pass already running is
  // joined rather than duplicated.
  function backfill() {
    if (backfillRun) return backfillRun;
    backfillRun = (async () => {
      const summary = { attempted: 0, provisioned: 0, failed: 0 };
      let users;
      try {
        users = listUsers();
      } catch (err) {
        log(`human Matrix identity backfill could not list users: ${err.message}`);
        return summary;
      }
      for (const user of Array.isArray(users) ? users : []) {
        if (!keyOf(user) || !user.subject) continue;
        if (hasIdentity(user)) continue;
        summary.attempted += 1;
        try {
          await ensure(user);
          summary.provisioned += 1;
        } catch (err) {
          summary.failed += 1;
          log(`Matrix identity for user ${user.id} not provisioned yet (will retry): ${err.message}`);
        }
      }
      return summary;
    })().finally(() => { backfillRun = null; });
    return backfillRun;
  }

  // What the Users page shows per user. `failed` wins over `pending` only when
  // no attempt is currently running — a retry in progress reads as pending.
  function statusFor(user) {
    const key = keyOf(user);
    if (!key) return { status: STATUS_PENDING };
    if (hasIdentity(user)) return { status: STATUS_READY };
    if (inFlight.has(key)) return { status: STATUS_PENDING };
    const failure = failures.get(key);
    if (failure) return { status: STATUS_FAILED, error: failure.error, lastAttemptAt: failure.at };
    return { status: STATUS_PENDING };
  }

  return { ensure, backfill, statusFor };
}

module.exports = {
  createHumanMatrixProvisioner,
  STATUS_READY,
  STATUS_PENDING,
  STATUS_FAILED,
};
