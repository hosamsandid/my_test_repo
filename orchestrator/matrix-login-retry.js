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
// The same race also surfaces as `M_USER_DEACTIVATED` (issue #711): when a
// same-named team is re-created (the E2E journeys tear a team down and
// re-materialise it), `deactivateMatrixUser` has flagged each account
// `deactivated`. `ensureMatrixUser` re-sends a plain `reset-password` (which
// both sets the password and clears that flag on the Continuwuity build we run
// — see matrix-admin-commands.js) *before* the login, but on a loaded stack the
// admin bot may not have processed the reset by the time the fixed sleeps
// elapse, so the login sees a still-deactivated account and returns
// `M_USER_DEACTIVATED`. Because every login is preceded by that reactivating
// reset, a lingering `M_USER_DEACTIVATED` is always this transient race — not
// a genuinely-permanent state — so it is retryable on exactly the same footing
// as `M_FORBIDDEN`: the retried login succeeds once the reset lands, and a
// truly unrecoverable account just fails after the ceiling instead of instantly.
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

// Canonical, human-facing message for a login that stays M_USER_DEACTIVATED
// after all recovery attempts (issue #1386, AC3). Surfaced by the create-agent
// API instead of a raw `Login failed: {...}` stack so the operator gets an
// actionable next step rather than an errcode.
const DEACTIVATED_USER_MESSAGE =
  "Matrix user is deactivated — wait a moment and try again, or use a different agent ID";

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

// Does this login error indicate the account is still flagged `deactivated`?
// Every login is preceded by `ensureMatrixUser`'s plain `reset-password`
// reactivation command, so at login time a lingering `M_USER_DEACTIVATED` means
// the admin bot has not processed that reset yet — the same cold-stack
// provisioning race as `M_FORBIDDEN` (issue #711).
function isDeactivatedError(err) {
  if (!err) return false;
  const msg = typeof err === "string" ? err : err.message || "";
  return /M_USER_DEACTIVATED/.test(msg);
}

// The default retry classifier: retry a login while it fails with either flavour
// of the provisioning race — the account not yet visible (`M_FORBIDDEN`) or not
// yet reactivated (`M_USER_DEACTIVATED`). Any other error propagates at once.
function isRetryableLoginError(err) {
  return isForbiddenError(err) || isDeactivatedError(err);
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
//   - if `shouldRetry(err)` is false → rethrow immediately (errors outside the
//     provisioning race are never masked by the retry loop);
//   - otherwise back off and retry, until the next sleep would cross `ceilingMs`
//     of total elapsed time, at which point the last error is rethrown.
//
// `onBeforeRetry(err, attempt)` (optional, async) runs once we have decided to
// retry — after `shouldRetry` and the ceiling check, before the backoff sleep.
// The orchestrator uses it to re-issue the account-reactivation admin command
// on a lingering M_USER_DEACTIVATED (issue #1386): the command is re-sent, then
// the backoff sleep gives the admin bot time to process it before the next
// login attempt. It runs *inside* the ceiling gate, so a retry is never armed
// past the ceiling — but its own duration is not counted, so keep it cheap.
//
// The first attempt runs with no delay, so behaviour on a fast system is
// unchanged (first-attempt success is returned immediately).
async function retryWhile(attemptFn, options = {}) {
  const {
    shouldRetry = isRetryableLoginError,
    ceilingMs = DEFAULT_CEILING_MS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onBeforeRetry = null,
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
      if (onBeforeRetry) await onBeforeRetry(err, attempt);
      await sleep(delay);
      attempt += 1;
    }
  }
}

module.exports = {
  retryWhile,
  isForbiddenError,
  isDeactivatedError,
  isRetryableLoginError,
  backoffDelay,
  DEFAULT_CEILING_MS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEACTIVATED_USER_MESSAGE,
};
