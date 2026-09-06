# Manual Test: Agent Deactivation Stops Active Triggers

Covers issue #207. Run against a local stack (`make up`).

---

## Prerequisites

- Stack is running (`make up`, admin console at `http://localhost:4000`).
- A team agent with at least one `cron` trigger has been created via the Agent Team Wizard.
- The team member is active (green dot, process running).

---

## TC-1 — Disable toggle stops cron trigger

1. In the Admin Console, open **Agent Chat** (`/chats`) — the Agents page these steps used to
   start from was removed in #1930 and its lifecycle actions moved into the left rail's row
   context menu.
2. Identify an active team-member agent that has a cron trigger configured in its `triggers.json`.
3. Open that row's context menu (kebab on hover, right-click, or `Menu`/`Shift+F10`) and choose
   **Disable**. Expected:
   - If the agent has active triggers or a running session → the **"Disable agent"** warning dialog appears, listing the active triggers / session.
4. Click **Hard stop**. Expected:
   - The agent flips to "paused" (grey indicator).
   - The process stops: `podman logs -f orchestrator` shows `[Orchestrator] stopAgentProcess <id>`.
5. Wait 2 minutes (past the next cron tick). Verify in the orchestrator logs that **no** `[Runner:<id>] Trigger fired` or `[Runner:<id>] Trigger skipped — agent is disabled` lines appear for that agent's triggers.
   - "Skipped" lines are acceptable (they confirm the guard works); "fired" lines are not.

**Pass:** No new trigger executions start after disabling.

---

## TC-2 — Drain mode lets current execution finish

1. Trigger an agent manually (send a DM) so it is in `state: busy` (check `status.json`).
2. While it is running, choose **Disable** from its row context menu. Expected:
   - Warning dialog appears with "a session is currently running".
3. Click **Let run**. Expected:
   - Agent is marked `enabled: false` in config.json immediately.
   - The **process keeps running** (check `podman logs -f orchestrator`; no `stopAgentProcess` log).
   - The current execution finishes and a response is posted.
4. After the execution finishes, verify no new trigger fires and the agent stays paused.

**Pass:** Drain disables without killing; current execution completes.

---

## TC-3 — Re-enabling resumes trigger behaviour

1. Re-enable the agent from TC-1 with **Enable** in its row context menu (turn on the rail's
   **show disabled agents** toggle first, so the paused agent is listed).
2. Wait for the next cron tick.
3. Verify in the orchestrator logs that the trigger **fires** normally (`[Runner:<id>] Trigger fired`).

**Pass:** Re-enabling resumes trigger execution.

---

## TC-4 — HTTP webhook rejected for disabled agent

1. Disable an agent that has an HTTP trigger (as in TC-1 Hard stop).
2. From the host, POST to the webhook endpoint:
   ```
   curl -X POST http://localhost:4003/hooks/<agentId>/<hookId> \
     -H 'X-Hook-Secret: <secret>' -w '\n%{http_code}\n'
   ```
3. Expected: HTTP **503** with `{ "error": "Agent '<id>' is disabled" }`.

**Pass:** Webhook is rejected while agent is disabled.

---

## TC-5 — BP-event router respects manual disable

1. Disable an agent that is a `bp-instance` (or team-member with bp-trigger-policy).
2. Send a BP event via `POST http://localhost:4002/internal/bp-events` targeting the agent's BP.
   - (Or simulate by calling the router directly in Node.)
3. Expected: the agent is **not** re-enabled. Check `config.json` remains `enabled: false`.

**Pass:** BP events do not auto-respawn manually-disabled agents.

---

## TC-6 — Full deactivate (stub reset) with active session

1. Ensure an agent is active and busy (as in TC-2 step 1).
2. Choose **Reset to stub…** from that agent's row context menu.
3. In the simple confirm dialog, click **Reset to stub** to confirm.
4. Expected: the orchestrator returns 409 and the **"Reset … to stub"** warning dialog appears.
5. Click **Hard stop + reset**. Expected:
   - Process killed, workspace wiped, agent resets to stub state.
6. Alternatively, click **Let run**. Expected:
   - Agent is disabled (enabled=false, triggers off) but **not** wiped.
   - User can reset cleanly once idle.

**Pass:** Deactivation with active state prompts user for drain-vs-hard-stop.
