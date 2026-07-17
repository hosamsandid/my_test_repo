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
// Why `--convert-to-local-account` on reset-password:
//   When a team/agent is deleted, `deactivateMatrixUser` fires
//   `!admin users deactivate @<user>:local`, which sets the account's
//   `deactivated` flag. On re-creation with the same name the plain
//   `reset-password` command *refuses* a deactivated (or shadow) account —
//   Continuwuity replies "To convert it to a local account, pass the
//   --convert-to-local-account flag." — and `enable-login` only clears the
//   separate login-disabled flag, never the deactivated flag. The subsequent
//   /login then returns M_USER_DEACTIVATED and team creation fails for every
//   member.
//   `reset-password ... --convert-to-local-account` clears the deactivated
//   flag *and* sets the password in one command, so it both recovers a
//   deactivated account and works unchanged for a freshly created (active)
//   one — making re-creation of a same-named team transparent.
//
// Returns: Array<{ body: string, delayMs: number }> in send order.
function buildEnsureUserCommands(username, password) {
  const userId = `@${username}:local`;
  return [
    {
      body: `!admin users create-user ${username} ${password}`,
      delayMs: CREATE_USER_SETTLE_MS,
    },
    // reset-password with --convert-to-local-account reactivates a previously
    // deactivated account (issue #715) and sets the password; no-op-safe for a
    // just-created active account.
    {
      body: `!admin users reset-password ${userId} ${password} --convert-to-local-account`,
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
