"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  retryWhile,
  isForbiddenError,
  isDeactivatedError,
  isRetryableLoginError,
  backoffDelay,
  DEFAULT_CEILING_MS,
  DEFAULT_MAX_DELAY_MS,
} = require("./matrix-login-retry");

// A deterministic fake clock: `now()` reads virtual time; `sleep(ms)` advances
// it (and records the gap) without any real timer, so retry timing is tested
// without a live homeserver or wall-clock waits.
function fakeClock(startMs = 0) {
  let t = startMs;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms) => {
      t += ms;
    },
  };
}

function forbidden() {
  return new Error('Login failed: {"errcode":"M_FORBIDDEN","error":"unknown"}');
}

function deactivated() {
  return new Error(
    'Login failed: {"errcode":"M_USER_DEACTIVATED","error":"M_USER_DEACTIVATED: The user has been deactivated"}'
  );
}

// ---- isForbiddenError --------------------------------------------------------

test("isForbiddenError matches the M_FORBIDDEN login failure (Error or string)", () => {
  assert.equal(isForbiddenError(forbidden()), true);
  assert.equal(isForbiddenError("Login failed: M_FORBIDDEN"), true);
  assert.equal(isForbiddenError(new Error("network down")), false);
  assert.equal(isForbiddenError(new Error("Login failed: M_USER_DEACTIVATED")), false);
  assert.equal(isForbiddenError(null), false);
  assert.equal(isForbiddenError(undefined), false);
});

// ---- isDeactivatedError ------------------------------------------------------

test("isDeactivatedError matches the M_USER_DEACTIVATED login failure (Error or string)", () => {
  assert.equal(isDeactivatedError(deactivated()), true);
  assert.equal(isDeactivatedError("Login failed: M_USER_DEACTIVATED"), true);
  assert.equal(isDeactivatedError(forbidden()), false);
  assert.equal(isDeactivatedError(new Error("network down")), false);
  assert.equal(isDeactivatedError(null), false);
  assert.equal(isDeactivatedError(undefined), false);
});

// ---- isRetryableLoginError (the default classifier) --------------------------

test("isRetryableLoginError covers BOTH provisioning-race flavours, nothing else", () => {
  assert.equal(isRetryableLoginError(forbidden()), true);
  assert.equal(isRetryableLoginError(deactivated()), true);
  assert.equal(isRetryableLoginError("Login failed: M_FORBIDDEN"), true);
  assert.equal(isRetryableLoginError("Login failed: M_USER_DEACTIVATED"), true);
  assert.equal(isRetryableLoginError(new Error("Login failed: M_UNKNOWN_TOKEN")), false);
  assert.equal(isRetryableLoginError(new Error("network down")), false);
  assert.equal(isRetryableLoginError(null), false);
});

// ---- backoffDelay ------------------------------------------------------------

test("backoffDelay grows exponentially and caps at maxDelayMs", () => {
  assert.equal(backoffDelay(0, { baseDelayMs: 500, maxDelayMs: 5000 }), 500);
  assert.equal(backoffDelay(1, { baseDelayMs: 500, maxDelayMs: 5000 }), 1000);
  assert.equal(backoffDelay(2, { baseDelayMs: 500, maxDelayMs: 5000 }), 2000);
  assert.equal(backoffDelay(3, { baseDelayMs: 500, maxDelayMs: 5000 }), 4000);
  // Capped from here on.
  assert.equal(backoffDelay(4, { baseDelayMs: 500, maxDelayMs: 5000 }), 5000);
  assert.equal(backoffDelay(10, { baseDelayMs: 500, maxDelayMs: 5000 }), 5000);
});

// ---- retryWhile: fast path ---------------------------------------------------

test("first-attempt success returns immediately with no sleep (fast path unchanged)", async () => {
  const clock = fakeClock();
  let calls = 0;
  const token = await retryWhile(
    async () => {
      calls += 1;
      return "tok-fast";
    },
    { now: clock.now, sleep: clock.sleep }
  );
  assert.equal(token, "tok-fast");
  assert.equal(calls, 1);
  assert.deepEqual(clock.sleeps, []); // never slept
});

// ---- retryWhile: succeeds on the Nth attempt ---------------------------------

test("retries M_FORBIDDEN and succeeds on the Nth attempt", async () => {
  const clock = fakeClock();
  let calls = 0;
  const token = await retryWhile(
    async () => {
      calls += 1;
      if (calls < 4) throw forbidden();
      return "tok-eventually";
    },
    { now: clock.now, sleep: clock.sleep, baseDelayMs: 500, maxDelayMs: 5000 }
  );
  assert.equal(token, "tok-eventually");
  assert.equal(calls, 4);
  // Three backoffs before the 4th (successful) attempt.
  assert.deepEqual(clock.sleeps, [500, 1000, 2000]);
});

// ---- retryWhile: M_USER_DEACTIVATED is retried too (issue #711) ---------------

test("retries M_USER_DEACTIVATED (re-created same-named team race) and succeeds", async () => {
  const clock = fakeClock();
  let calls = 0;
  const token = await retryWhile(
    async () => {
      calls += 1;
      if (calls < 3) throw deactivated();
      return "tok-reactivated";
    },
    { now: clock.now, sleep: clock.sleep, baseDelayMs: 500, maxDelayMs: 5000 }
  );
  assert.equal(token, "tok-reactivated");
  assert.equal(calls, 3);
  // Two backoffs before the 3rd (successful, post-reactivation) attempt.
  assert.deepEqual(clock.sleeps, [500, 1000]);
});

// ---- retryWhile: respects the ceiling ----------------------------------------

test("stops retrying once the ceiling is reached and rethrows the last error", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryWhile(
      async () => {
        calls += 1;
        throw forbidden();
      },
      { now: clock.now, sleep: clock.sleep, ceilingMs: 3000, baseDelayMs: 500, maxDelayMs: 5000 }
    ),
    /M_FORBIDDEN/
  );
  // Elapsed budget 3000ms: sleeps 500 (elapsed 500) + 1000 (1500) are allowed;
  // the next delay would be 2000 → elapsed 1500 + 2000 = 3500 >= 3000 → give up.
  assert.deepEqual(clock.sleeps, [500, 1000]);
  assert.equal(calls, 3); // three attempts, all failed
});

test("never sleeps past the ceiling (total virtual time stays under it)", async () => {
  const clock = fakeClock();
  await assert.rejects(
    retryWhile(async () => { throw forbidden(); }, {
      now: clock.now,
      sleep: clock.sleep,
      ceilingMs: DEFAULT_CEILING_MS,
      baseDelayMs: 500,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
    }),
    /M_FORBIDDEN/
  );
  const total = clock.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(total < DEFAULT_CEILING_MS, `total slept ${total} should be < ${DEFAULT_CEILING_MS}`);
});

// ---- retryWhile: non-retryable errors propagate immediately ------------------

test("propagates an error outside the provisioning race immediately without retrying", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryWhile(
      async () => {
        calls += 1;
        throw new Error("Login failed: M_UNKNOWN_TOKEN");
      },
      { now: clock.now, sleep: clock.sleep }
    ),
    /M_UNKNOWN_TOKEN/
  );
  assert.equal(calls, 1); // no retry
  assert.deepEqual(clock.sleeps, []);
});

test("a custom shouldRetry predicate is honoured", async () => {
  const clock = fakeClock();
  let calls = 0;
  const token = await retryWhile(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error("try-again");
      return "ok";
    },
    {
      now: clock.now,
      sleep: clock.sleep,
      shouldRetry: (e) => /try-again/.test(e.message),
    }
  );
  assert.equal(token, "ok");
  assert.equal(calls, 2);
});
