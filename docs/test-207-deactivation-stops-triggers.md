# Manual Test: Agent Deactivation Stops Active Triggers (issue #207)

## Prerequisites

- Stack running (`make up`)
- At least one agent with a cron trigger configured in its `triggers.json`

## Test 1 — Disable with no active state (fast path)

1. Ensure the agent is idle (not busy) and note that the `triggers.json` has at least one enabled trigger.
2. In the Admin Console, toggle the agent's enable switch to **off**.
3. **Expected:** The agent disables immediately without any dialog. The process stops.
4. Check `config.json` for the agent: `enabled` must be `false`.
5. Wait 60–90 seconds (one trigger scheduler tick).
6. **Expected:** No trigger fires. The trigger scheduler inside agent-runner.js read `enabled: false` and skipped all executions.

## Test 2 — Warning dialog when agent is busy

1. Start a long-running trigger or send the agent a message that keeps it busy (the `status.json` `state` should be `busy`).
2. While busy, toggle the agent **off** in the Admin Console.
3. **Expected:** A warning dialog appears listing "a session is currently running".
4. Click **Cancel** — dialog closes, agent stays enabled.
5. Repeat and click **Let run (drain)**:
   - `config.json` should immediately show `enabled: false`.
   - The process continues running until the current invocation finishes.
   - No new trigger executions start after the drain.
   - Once idle, the agent process may keep running (process not killed), but triggers are blocked.
6. Re-enable the agent — verify it responds normally again.

## Test 3 — Hard stop

1. While an agent is busy or has scheduled triggers, toggle **off** in the Admin Console.
2. When the warning dialog appears, click **Hard stop**.
3. **Expected:** The agent process is killed immediately. `config.json` shows `enabled: false`.
4. Check no further trigger fires.

## Test 4 — GitHub poller respects disabled state

1. Disable an agent that subscribes to GitHub events (has a `github-event` trigger).
2. Trigger a matching GitHub event on the repo (e.g., open a PR or add a label).
3. Wait up to 30 seconds (one GitHub poller tick).
4. **Expected:** No entry is added to the agent's `pending-triggers.json`. The poller skips disabled agents in `_buildPlan()`.

## Test 5 — Re-enable resumes normal behavior

1. Disable an agent (drain or abort).
2. Re-enable it via the Admin Console toggle.
3. Trigger a GitHub event or wait for a cron tick.
4. **Expected:** The agent picks up the trigger and responds normally.
