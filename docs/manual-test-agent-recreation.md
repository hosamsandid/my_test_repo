# Manual Test: Re-creating a Deleted Agent with the Same ID

Covers issue #1386 (`M_USER_DEACTIVATED` on same-id re-creation). Run against a
local stack (`make up`). The unit tests
(`orchestrator/matrix-admin-commands.test.js`,
`orchestrator/matrix-login-retry.test.js`) cover the command sequences and the
retry/re-issue logic; these steps verify the end-to-end behaviour against a live
Continuwuity homeserver, which the unit tests cannot.

> **Homeserver note.** Continuwuity manages users exclusively through the admin
> room (`!admin users ...`) — it exposes **no** Synapse `/_synapse/admin/` REST
> API. So the fix reactivates via a **reliable retry loop that re-issues the
> reactivation admin command** on a lingering `M_USER_DEACTIVATED`, not via REST
> (answering the issue's open question).

---

## Prerequisites

- Stack is running (`make up`, admin console at `http://localhost:4000`).
- You can create and delete an `agent`-role agent bound to any Working
  Environment.

---

## TC-1 — Delete then immediately re-create the same id (the race)

1. Create an agent, e.g. id `recreate-probe`, and confirm it comes up (green dot).
2. Delete it with **Delete…** in its Agent Chat row context menu.
3. **Immediately** (within ~5 seconds) create a new agent with the **same id**
   `recreate-probe`.
4. Expected:
   - Creation **succeeds** and the agent starts normally.
   - The re-issue is silent on success — no `reactivation re-issue for ...`
     warning log appears in `podman logs -f orchestrator` when recovery works.
     (That warn line only fires if the admin command itself could not be sent.)

**Pass:** Same-id re-creation within the settle window completes without error.

---

## TC-2 — Reactivation is reliable across the retry window

1. Repeat TC-1 several times in quick succession (delete → recreate same id).
2. Expected: every attempt eventually completes; no attempt is left as a
   half-created agent (no workspace without a working chat identity).

**Pass:** Re-creation is robust to the deactivate/reactivate ordering race — the
login-retry loop re-issues the reactivation command until the account is active
or the bounded ceiling is reached.

---

## TC-3 — Clear operator error when reactivation cannot complete

To observe the AC3 error surface without a broken homeserver, shorten the retry
ceiling so the loop gives up quickly, then force the race:

1. Restart the orchestrator with `AEE_MATRIX_LOGIN_RETRY_CEILING_MS=1` (so the
   login retry gives up after the first attempt).
2. Delete `recreate-probe` and immediately re-create it with the same id.
3. If the login hits `M_USER_DEACTIVATED` before the account settles, expected:
   - The direct create form (**+ Create** → **Advanced options** → *Configure an agent
     manually*, or **New
     Agent** in Agent Chat's header — the same component; the Agents page that used to host
     it was removed in #1930) shows:
     **"Matrix user is deactivated — wait a moment and try again, or use a
     different agent ID"** (not a raw `Login failed: {...}` stack).
   - The API response is `409` with `code: "matrix_user_deactivated"`.
4. Restore the default ceiling (unset the env var) and confirm re-creation
   succeeds again.

**Pass:** A still-deactivated account yields the actionable message, not a stack
trace; a normal retry then succeeds.
