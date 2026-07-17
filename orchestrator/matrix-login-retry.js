// Pure, fs-free, side-effect-free retry helper for the Matrix login step of
// user provisioning.
//
// Why this exists (issue #719): `ensureMatrixUser` fires the conduwuit admin-room
// commands (create-user / reset-password / enable-login) gated only on fixed
// setTimeout sleeps, then `loginMatrixUser` runs immediately. On a cold/slow
// stack (CI) the admin bot loses the race and the first login gets a hard
// `M_FORBIDDEN` — team creation fails on the first member. Rather than lengthen
// the blind sleeps (which slows every fast run), we retry the *login* with
// bounded exponential backoff until the admin bot catches up.
//
// The clock (`now`) and the sleeper (`sleep`) are injectable so the retry
// behaviour can be unit-tested deterministically without a real timer or a
// live homeserver.

// Total wall-clock ceiling across all attempts (including sleeps). Suggested by
// issue #719. The first attempt always runs, so a fast stack is never slowed.
const DEFAULT_CEILING_MS = 45000;
// Backoff schedule: 0.5s, 1s, 2s, 4s, then capped at 5s per gap.
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5000;

// Is this login error the transient provisioning race that a retry can plausibly
// clear? The homeserver returns `M_FORBIDDEN` both when the account does not
// exist yet (the race we recover from) and when the password is genuinely wrong.
// Since the login password is an internal generated credential, treating both
// the same is acceptable per #719: a truly wrong password just fails after the
// ceiling instead of instantly.
function isForbiddenError(err) {
  if (!err) return false;
  const msg = typeof err === "string" ? err : err.message || "";
  return /M_FORBIDDEN/.test(msg);
}

// Exponential backoff delay (ms) for retry number `attempt` (0-indexed), capped
// at maxDelayMs.
function backoffDelay(
  attempt,
  { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}
) {
  const raw = baseDelayMs * Math.pow(2, attempt);
  return Math.min(raw, maxDelayMs);
}

// Run `attemptFn` (async, returns the login result). On success, return it. On
// failure:
//   - if `shouldRetry(err)` is false → rethrow immediately (non-M_FORBIDDEN
//     errors are never masked by the retry loop);
//   - otherwise back off and retry, until the next sleep would cross `ceilingMs`
//     of total elapsed time, at which point the last error is rethrown.
//
// The first attempt runs with no delay, so behaviour on a fast system is
// unchanged (first-attempt success is returned immediately).
async function retryWhile(attemptFn, options = {}) {
  const {
    shouldRetry = isForbiddenError,
    ceilingMs = DEFAULT_CEILING_MS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  const start = now();
  let attempt = 0;
  for (;;) {
    try {
      return await attemptFn();
    } catch (err) {
      if (!shouldRetry(err)) throw err;
      const elapsed = now() - start;
      const delay = backoffDelay(attempt, { baseDelayMs, maxDelayMs });
      // Give up once the ceiling is reached, or when the next sleep would cross
      // it — never sleep past the ceiling.
      if (elapsed + delay >= ceilingMs) throw err;
      await sleep(delay);
      attempt += 1;
    }
  }
}

module.exports = {
  retryWhile,
  isForbiddenError,
  backoffDelay,
  DEFAULT_CEILING_MS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
};
