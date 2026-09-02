---
id: maintenance-mode
routes: ["/maintenance-mode"]
title: Maintenance Mode
summary: A platform-wide flag you raise before restarting the stack — it quiets the schedulers and the chat composer so in-flight agent sessions can wind down, then hands everything back when you end it.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "GitHub Event Log", to: "/github-events" }
  - { label: "Agents", to: "/agents" }
askPrompts:
  - "What actually happens while maintenance mode is active?"
  - "Do my scheduled triggers run again after I end maintenance?"
  - "Are GitHub events lost while maintenance mode is on?"
  - "What does the grace period actually do?"
  - "Why can't I send a chat message right now?"
  - "Is it safe to restart while agents are still busy?"
---

## What maintenance mode is

It is a **signal, not an action**. Activating it writes one platform-wide flag
(`/workspace/maintenance/state.json`, read by the console, the orchestrator and
every agent container) that says: *a restart is coming, stop starting new work*.

It does **not** stop, restart, redeploy or shut down anything. The actual restart
stays a **manual, external step** you perform yourself once the platform has gone
quiet. Nothing auto-deactivates either — the mode stays on until you end it here.

What it *does* change while it is on: no new scheduled work is started anywhere,
and the console stops you from sending fresh chat messages. So it is not
completely passive — it is a **soft, cooperative pause** rather than a hard lock.

## The safety signal at the top

The counter above the switch reports how many agent sessions are **busy right
now, across every team and user** — the same platform-wide status poll the sidebar
badge uses, not a per-team view. Green (`0 active sessions`) means nothing is
mid-run and a restart loses no work in progress.

The counter is **advisory**. Nothing prevents you from activating maintenance
mode — or restarting the platform — while agents are still busy; a container
killed mid-run leaves the durable in-flight marker that produces the
*"⚠️ Trigger possibly lost"* warning on the next startup.

## The grace period

You give a grace period in minutes when you activate. It is a **wind-down window
for humans to read**: the page counts it down, and the chat banner shows the
remaining time so people know how long they have.

It is **not** an enforcement timer. No backend component reads it — only the
binary *active* flag is enforced. Concretely:

- Nothing is force-stopped when it starts, and nothing is force-stopped when it
  reaches zero.
- When it reaches **zero, maintenance mode stays active** — triggers stay
  suppressed and events keep queuing — until you press **End Maintenance Mode**.
- A longer grace period does not make the pause stronger; it only sets the number
  people see.

Any positive whole number of minutes is accepted, capped at **24 hours** so a
mistyped value cannot wedge the platform in maintenance for an absurd stretch.

## While active

**Scheduled work is paused, not cancelled.** Every agent's scheduler checks the
flag before it fires:

| Trigger kind | While active | Once you end it |
|---|---|---|
| `cron` | The fire time is skipped. | **Exactly one** catch-up run — never a backlog flood, no matter how many fire times were missed. |
| `once` | Left in place, overdue. | Fires on the next 60-second sync tick. |
| `loop` | Pauses between iterations (the current iteration finishes). | Resumes with one catch-up iteration. |
| `http` / `github-event` | Keep **queuing** durably; they are simply not drained. | Drain in arrival order — **nothing is dropped**. |

The queue only protects against *this flag*. An event that arrives while the
container or webhook server is genuinely **down** is not auto-retried, so prefer
`github-event` over `http` for anything that must survive a real outage.

**Console chat is read-only.** Every Agent Chat composer shows a warning banner
and refuses to send while the flag is up — platform-wide, not just the
conversation you have open. Starting a new session is blocked too. The lock
clears on its own within about five seconds of you ending the mode; no reload.

**Background platform passes are skipped.** The orchestrator's own timers — the
hourly flow-anomaly history sweep and the daily hill-climb metrics collector —
return early, and the on-demand **Anomalies** / **Improvements** panels answer
with an explicit *"maintenance mode is active"* notice instead of a stale or empty
result.

**Nothing already running is touched.** A session that was mid-run when you
flipped the switch keeps going to its natural end. That is exactly what the grace
period is for: you wait, watch the counter fall to zero, and *then* restart.

## Ending it

**End Maintenance Mode** clears the flag and everything above reverses within one
poll interval: the chat lock lifts, queued HTTP/GitHub events drain, overdue
`once` triggers fire, and each suppressed `cron` performs its single catch-up run.

## A typical restart

1. Activate with a grace period long enough for your slowest routine run.
2. Watch the active-session counter until it reads **0 active sessions**.
3. Perform the restart / redeploy outside the console.
4. Come back and **end** maintenance mode so the queues drain and the schedulers
   pick up again.
