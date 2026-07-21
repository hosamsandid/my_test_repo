// Pure builders for the Conduwuit/Continuwuity admin-room commands the
// orchestrator fires when it provisions (or re-provisions) a Matrix user.
//
// Kept in its own fs-free, side-effect-free module so the exact command
// bodies — in particular the deactivation-recovery flag — can be unit-tested
// without importing the orchestrator service (which starts on require) or
// talking to a live homeserver.

// Delays (ms) the orchestrator sleeps *after* sending each command, giving the
// admin bot time to process one command before the next arrives. create-user
// needs the longest settle; the follow-ups are quick.
const CREATE_USER_SETTLE_MS = 3000;
const FOLLOWUP_SETTLE_MS = 1000;

// Build the ordered sequence of admin-room commands that ensures a local Matrix
// user exists, has the given password, and can log in — including recovery from
// a previously *deactivated* account (issue #715).
//
// Why plain `reset-password` (no flag) recovers a deactivated account:
//   When a team/agent is deleted, `deactivateMatrixUser` fires
//   `!admin users deactivate @<user>:local`, which sets the account's
//   `deactivated` flag. On re-creation with the same name the account must be
//   reactivated before the agent can log in, or /login returns
//   M_USER_DEACTIVATED and creation fails.
//   In the Continuwuity version we run, `!admin users reset-password
//   <user> <pw>` both sets the password AND clears the `deactivated` flag in a
//   single command — verified empirically (deactivate → plain reset-password →
//   /login succeeds). It is no-op-safe for a freshly created (active) account.
//   NOTE: an earlier Continuwuity build refused a deactivated account here and
//   required a `--convert-to-local-account` flag; the current build *rejects*
//   that flag outright ("unexpected argument"), which silently defeated the
//   reset (password never set, flag never cleared) — so the flag was removed.
//   `enable-login` below only clears the separate login-disabled flag, never
//   the deactivated flag, so it cannot substitute for the reset.
//
// Returns: Array<{ body: string, delayMs: number }> in send order.
function buildEnsureUserCommands(username, password) {
  const userId = `@${username}:local`;
  return [
    {
      body: `!admin users create-user ${username} ${password}`,
      delayMs: CREATE_USER_SETTLE_MS,
    },
    // Plain reset-password reactivates a previously deactivated account (issue
    // #715) and sets the password in one command; no-op-safe for a just-created
    // active account.
    {
      body: `!admin users reset-password ${userId} ${password}`,
      delayMs: FOLLOWUP_SETTLE_MS,
    },
    // Clear the (separate) login-disabled flag as a belt-and-braces measure.
    {
      body: `!admin users enable-login ${userId}`,
      delayMs: FOLLOWUP_SETTLE_MS,
    },
  ];
}

module.exports = {
  buildEnsureUserCommands,
  CREATE_USER_SETTLE_MS,
  FOLLOWUP_SETTLE_MS,
};
