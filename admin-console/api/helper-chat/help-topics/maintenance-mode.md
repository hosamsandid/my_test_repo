---
id: maintenance-mode
routes: ["/maintenance-mode"]
title: Maintenance Mode
summary: A platform-wide flag you raise before restarting the stack — it quiets the schedulers and the chat composer so in-flight agent sessions can wind down, then hands everything back when you end it.
seeAlso:
  - { label: "Agent Chat", to: "/chats" }
  - { label: "GitHub Event Log", to: "/github-events" }
askPrompts:
  - "What actually happens while maintenance mode is active?"
  - "Do my scheduled triggers run again after I end maintenance?"
  - "Are GitHub events lost while maintenance mode is on?"
  - "What does the grace period actually do?"
  - "Why can't I send a chat message right now?"
  - "Is it safe to restart while agents are still busy?"
  - "How accurate is the active-session counter?"
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

"Cooperative" is the exact word. Nothing is enforced centrally: each component
*reads* the flag and decides to hold off. A component that is not looking — or
that cannot reach the flag — carries on, and every reader that fails to read it
treats the platform as **not** in maintenance. That is the safe default for a
signal whose whole job is to be advisory, but it does mean maintenance mode is
never a security or safety boundary. Use it to make a restart *tidy*, not to make
one *safe*.

## The safety signal at the top

The counter above the switch reports how many agent sessions are **busy right
now, across every team and user** — the same platform-wide status poll the sidebar
badge uses, not a per-team view. Green (`0 active sessions`) means nothing is
mid-run and a restart loses no work in progress.

The counter is **advisory**, and it is worth knowing exactly how:

- **It counts agents, not requests.** One agent working through a long run is
  `1`, however many tool calls that involves.
- **It is a recent reading, not a live probe.** Each agent writes its own status
  file; the console re-polls every five seconds and the server caches the answer
  for a couple more. So the number can lag reality by several seconds in either
  direction, and an agent that crashed mid-run can stay `busy` until something
  rewrites its status.
- **Disabled and offline agents never count**, even if work was in flight when
  they went away. A `0` therefore means "nothing *reachable* is busy", not
  "nothing was interrupted".
- **You see what you are allowed to see.** The reading is scoped like every other
  list in the console. For the System Admins this page is meant for that is the
  whole platform; it is not a globally privileged number.

Nothing prevents you from activating maintenance mode — or restarting the
platform — while agents are still busy; a container killed mid-run leaves the
durable in-flight marker that produces the *"⚠️ Trigger possibly lost"* warning on
the next startup.

## Activating it and the grace period

You give a grace period **in minutes** when you activate — any positive whole
number, capped at **24 hours** so a mistyped value cannot wedge the platform in
maintenance for an absurd stretch. The flag goes up the moment you submit; there
is no confirmation step and no scheduled start.

The grace period is a **wind-down window for humans to read**: the page counts it
down, and the chat banner shows the remaining time so people know how long they
have.

It is **not** an enforcement timer. No backend component reads it — only the
binary *active* flag is enforced, and the countdown is
never sent to the agent containers at all. Concretely:

- Nothing is force-stopped when it starts, and nothing is force-stopped when it
  reaches zero.
- When it reaches **zero, maintenance mode stays active** — triggers stay
  suppressed and events keep queuing — until you press **End Maintenance Mode**.
- A longer grace period does not make the pause stronger; it only sets the number
  people see.

So choose it as a **promise to your users**, not as a setting: long enough for
your slowest routine run to finish, and honest about when you actually intend to
restart.

## While active

**Scheduled work is paused, not cancelled.** Every agent's scheduler checks the
flag before it fires:

| Trigger kind | While active | Once you end it |
|---|---|---|
| `cron` | The fire time is skipped. | **Exactly one** catch-up run — never a backlog flood, no matter how many fire times were missed. |
| `once` | Left in place, overdue. | Fires on the next 60-second sync tick. |
| `loop` | Pauses between iterations (the current iteration finishes). | Resumes with one catch-up iteration. |
| `http` / `github-event` | Keep **queuing** durably; they are simply not drained. | Drain in arrival order — **nothing is dropped**. |

The single cron catch-up is a real property of how the next fire time is
computed, not a best effort: after the pause the schedule is recalculated from
*now*, so however long you were in maintenance, each cron trigger runs once and
then returns to its normal rhythm.

For the queued kinds it is only the **consumer** that pauses. The GitHub poller
and the webhook endpoint keep accepting and keep writing to the durable queue
throughout — which is why nothing is lost, and also why a very long maintenance
window on a busy repository leaves a correspondingly long queue to drain. The
drain is deliberately one entry at a time, oldest first, so a crash part-way
through loses at most the single entry in flight.

The queue only protects against *this flag*. An event that arrives while the
container or webhook server is genuinely **down** is not auto-retried, so prefer
`github-event` over `http` for anything that must survive a real outage.

**Console chat is read-only.** Every Agent Chat composer shows a warning banner
and refuses to send while the flag is up — platform-wide, not just the
conversation you have open. The quick-reply buttons an agent offers when it asks
you a question go inert for the same reason. The lock clears on its own within
about five seconds of you ending the mode; no reload.

Two honest limits on that lock. It is a **console courtesy, not a gate**: it is
applied in the browser, so the flag stops people from sending, not the API. And
because the console starts each page load assuming no maintenance, opening the
console fresh during a window leaves a one-round-trip moment before the banner
appears. Session controls are *not* locked either — **Reset Session** and
**Clear History** stay available throughout, since they only affect your own
conversation pointer and start no agent work.

**Background platform passes are skipped.** The orchestrator's own timers — the
hourly flow-anomaly history sweep and the daily hill-climb metrics collector —
return early, and the on-demand **Anomalies** / **Improvements** panels answer
with an explicit *"maintenance mode is active"* notice instead of a stale or empty
result. That notice is the intended answer, not an error: those panels are asking
the platform to do fresh analysis work, which is exactly what maintenance mode is
holding back.

**Nothing already running is touched.** A session that was mid-run when you
flipped the switch keeps going to its natural end. That is exactly what the grace
period is for: you wait, watch the counter fall to zero, and *then* restart.

## Ending it

**End Maintenance Mode** clears the flag and everything above reverses within one
poll interval: the chat lock lifts, queued HTTP/GitHub events drain, overdue
`once` triggers fire, and each suppressed `cron` performs its single catch-up run.

There is no confirmation on the way out, because ending maintenance mode destroys
nothing — the worst case is that you raise it again.

## A typical restart

1. Activate with a grace period long enough for your slowest routine run.
2. Watch the active-session counter until it reads **0 active sessions**.
3. Perform the restart / redeploy outside the console.
4. Come back and **end** maintenance mode so the queues drain and the schedulers
   pick up again.

Step 4 is the one people forget. Nothing reminds you, nothing expires, and the
platform will sit quietly suppressed — schedulers idle, events piling up — until
somebody comes back to this page.
