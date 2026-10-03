# Autonomous Triggers

Agents are driven by triggers defined in a per-agent `triggers.json` file. The scheduler syncs changes every 60 seconds. All trigger types are created and managed per agent via the Admin Console — inline in the **Agent Chat** right rail, under the **Triggers** tab.

## Trigger Types

| Type | How it fires |
|---|---|
| **cron** | Recurring execution on a 5-field cron expression. Skips if the previous run is still in progress. |
| **once** | Fires once at a specific ISO timestamp, then removes itself automatically. |
| **http** | Fired by an external `POST /hooks/:agentId/:triggerId` with an `X-Hook-Secret` header — or a GitHub webhook signed with the trigger's secret (`X-Hub-Signature-256`, see below). Every trigger carries its own auto-generated secret — there is no global open mode. |
| **github-event** | Fired by the built-in GitHub poller when the GitHub Events API reports a matching event (e.g. `pull_request.opened`, `push`). Requires a GitHub token on the environment. The full event payload is appended to the agent prompt as JSON. Supports an optional `claim` field (`{"remove": "<wakeLabel>", "add": "<wakeLabel>:wip"}`) — the runner swaps the labels before invoking the agent so "in progress" is visible on GitHub, and rolls the swap back automatically if the run fails both attempts (which re-fires the chain via the poller). The `add` value **must** follow the `<wakeLabel>:wip` convention (enforced by the bundle validator). For **channel-derived** label listeners (`expandGithubChannels`) the claim is stamped automatically; opt out per channel port with `autoClaim: false`. Push: optional `branchFilter` ([rules](push-branch-filter.md)); knowledge branches never wake. |
| **loop** | Runs the agent's prompt repeatedly — each try starts fresh — stopping once the goal is met or the maximum number of tries is reached. See [Loop triggers](#loop-triggers) below. |

Cron format: `Minute Hour Day Month Weekday`

## One run at a time (workspace serialization)

An agent has a **single workspace** — one clone of the repository — so it runs
**one thing at a time** in it. A loop iteration, any trigger run (`cron`, `once`,
`http`, `github-event`), and a chat/DM message all pass through one agent-wide
gate; their execution windows never overlap, so they can't interleave or corrupt
each other's git changes.

- **While a loop is running, everything else waits.** All other triggers *and*
  chat messages are held and only run once the **whole** loop has finished
  (natural completion or a user **Stop**) — never between iterations. Deferred
  `http`/`github-event` work stays durably queued (it is not dropped and not
  double-delivered) and drains in arrival order (FIFO) when the loop ends.
- **Stop always works.** Stopping a running loop is an out-of-band control, not a
  queued chat message, so you are never locked out while a loop holds the
  workspace.
- **Chat backlog is bounded.** A long loop can hold the workspace for a while; if
  many chat messages pile up, the newest are shed with a visible notice (resend
  them) rather than flooding the room when the loop ends. The cap is
  `AEE_MAX_QUEUED_CHAT` (default 8).
- The per-trigger "skip if the previous run of *this* trigger is still in
  progress" guard and the runaway backstop still apply on top of this. Maintenance
  Mode still pauses firing and draining.

## Webhook Server

The orchestrator exposes a second HTTP server on `HOOK_PORT` (default `4003`). External systems — CI pipelines, GitHub Actions, monitoring tools — can trigger agent prompts via an outbound POST to your LAN. No public ingress is required.

**Endpoint:** `POST http://<host>:4003/hooks/<agentId>/<triggerId>`  
**Auth:** `X-Hook-Secret: <secret>` header, e.g. `curl -X POST -H "X-Hook-Secret: <secret>" http://<host>:4003/hooks/<agentId>/<triggerId>` — or, for a GitHub webhook (which cannot send custom headers), the secret as the webhook's **Secret**: the `X-Hub-Signature-256` HMAC over the body is verified instead (#2680). A signed GitHub `ping` returns 200 without firing. Bodies over 25 MB → 413.

The webhook secret is generated automatically when the trigger is created. It is visible in the Admin Console trigger editor.

## GitHub Poller

Every 30 s the poller queries the GitHub Events API for each environment repository — or agent-scoped repository, using its agent's environment token — with a readable GitHub token that an enabled agent's enabled, non-internal `github-event` trigger names; the Event Log's **Repositories** area explains the rest. ETags make unchanged repositories free (304). Per-repository state (ETag, sliding set of seen event ids) survives restarts; the first poll only baselines. Reviews (Events API `pull_request_review.created`) are keyed `pull_request_review.submitted`; listing both wakes once.

**Loop protection is frequency-based, not origin-based.** No source filtering unless a push trigger sets `pushedBy: [agentId…]`: only pushes those same-team agents (or their pool instances) made via `gh-as-agent` fire it. Otherwise any matching event fires, whoever caused it. The backstops are the per-conversation throttle (default 5 events/hour per agent per PR / issue / branch) and the burst digest (more than 3 events on one conversation in a single poll fold into one lossless summary wake). `gh-as-agent` stamps are attribution for humans — the poller ignores them. The **GitHub Event Log** page (and help topic) shows what happened to each event.

**The first push to a new branch arrives as the pull request it opens.** The Events API reports no `PushEvent` (and often no `CreateEvent`) for the push that creates a branch — only later pushes to the existing branch surface as `push`. So the poller turns every `pull_request.opened` / `pull_request.reopened` whose head branch lives in the same repository (not a fork) into an extra `push` event for that head branch and commit, logged as its own `push` row (event id `prpush:<id>`, payload `ref`/`head` plus `synthesizedFrom` and the PR number). Push wakes are de-duplicated per repository on branch + head commit: whichever of the PR-derived push and a real `PushEvent` for the same commit arrives first wakes `push` triggers, and the other is logged as dropped (`push-duplicate`). A trigger that also listens to the originating `pull_request.*` event is not woken a second time by the derived push. History horizon, throttle and burst digest apply as for any event. A branch pushed without opening a PR is still not detected — GitHub reports nothing for it.

### PR readiness: `pull_request.checks_passed` / `checks_failed` / `merge_conflict`

The Events API has no event for "CI finished" or "this PR now conflicts" (no `check_suite`, `check_run`, `workflow_run`, `status`, and nothing for mergeability). So for a repository where at least one `github-event` trigger listens to one of these three keys, the poller **reads** the state of the open pull requests itself on every cycle (GitHub GraphQL API) and wakes the trigger once a verdict is reached (`orchestrator/pr-readiness.js`, #2794). **GitHub only** — GitLab repositories are not polled.

| Key | Fires when |
|---|---|
| `pull_request.checks_passed` | The PR's head commit has at least one check and **all** of them passed (`success`, `neutral` or `skipped`). |
| `pull_request.checks_failed` | **Any** check of the head commit failed (`failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure`, `stale`, or a commit status `failure`/`error`) — even while others are still running. |
| `pull_request.merge_conflict` | GitHub reports the PR as conflicting with its base branch. |

- **Every check counts**, required or not — CodeQL, external commit statuses, and checks branch protection does not require. A queued or running check keeps CI *pending*.
- **No CI**: a head commit with no check at all after a grace period (default 3 minutes from when the poller first saw it, `AEE_PR_READINESS_CI_GRACE_MS` on the orchestrator) gets the verdict *none*, which fires nothing. Mergeability `UNKNOWN` (GitHub still computing) stays *pending* and is re-read on the next cycle; `MERGEABLE` is *clean* and fires nothing.
- **Once per (PR, head commit, verdict).** A new push resets both verdicts for the new head; a verdict of the old head is never delivered after the new head was seen. A re-run on the same commit can still turn `checks_failed` into a later `checks_passed`; a base branch that moves under an already-clean head still produces `merge_conflict` (once per head). A PR closed or merged while pending fires nothing. Fork PRs are evaluated like any other.
- **Payload**: a `pull_request` event (`payload.action` = `checks_passed` / `checks_failed` / `merge_conflict`) with `number`, `pull_request.{number, title, html_url, head.{ref,sha}, base.ref}` and `payload.readiness = {headSha, verdict, ci, merge, failingChecks, fromFork}` — `failingChecks` names the failed checks for `checks_failed`. The wake is routed to the PR's conversation and logged in the **GitHub Event Log** like any polled event; history horizon, throttle and burst digest apply.
- **No replay**: the first evaluation of a repository (or one after more than 15 minutes without an evaluation, e.g. an orchestrator restart) only records the verdicts already reached and wakes nobody.
- **API cost** per poll cycle, per repository with a subscriber: **one** GraphQL call for the open PRs (head commit + mergeability, up to 100 PRs), plus **one** GraphQL call for the checks of all head commits whose CI verdict is still open (pending or failed), only when there is one. A head whose verdict is `passed` or *none* is no longer read. Repositories without a subscriber cost nothing extra. While the events poll of a repository backs off (rate limit, GitHub unreachable, bad token), readiness is not evaluated either; a failed read leaves every verdict as it was.

Re-fire a dropped wake from Agent Chat → **Events** (#2525).

## Operational note: host clock skew (Podman machine)

On macOS/Windows the stack runs inside a Podman VM, and containers inherit **that
VM's clock**, not the host's. If the host sleeps, the VM clock stops with it. It
is supposed to be corrected by `chronyd` inside the VM on resume — but chronyd
needs a reachable NTP server, and UDP/123 is blocked on many corporate networks.
When that happens chronyd reports itself as perfectly in sync (its own estimate,
based on its last successful poll) while every source shows `Reach 0`, and the
skew simply persists. Observed in practice: **68 minutes behind the host**, with
containers matching the VM exactly.

Check it:

```bash
date -u                                    # host
podman machine ssh date -u                 # the VM — the clock containers see
podman exec <orchestrator-ctr> date -u     # should equal the VM
podman machine ssh chronyc sources         # 'Reach 0' everywhere ⇒ no NTP
```

Fix it (one-shot step from the host clock):

```bash
podman machine ssh "sudo date -u -s '$(date -u '+%Y-%m-%d %H:%M:%S')'"
```

Why it matters for triggers:

- **`cron` / `once`** fire on the container clock, so they run late by the skew.
  Before stepping the clock, check which triggers fall inside the jump — a
  forward step fires any `once` whose `at` it passes, and a `cron` whose time it
  crosses.
- **Flow anomaly detection** compares GitHub timestamps (real time) against the
  container clock, so a behind clock **under-reports** every age by the skew and
  `claim-stalled` / `gate-idle` trip late.
- The **GitHub poller** itself is unaffected in its delivery decision: freshness
  is per-event-id set membership, not a clock comparison. The per-subscriber
  history horizon is a clock comparison, but a behind clock only makes it more
  permissive (it can admit pre-activation backlog, never drop live events).

`podman machine stop && podman machine start` also resyncs, but it recreates
every container — prefer the one-shot step on a running stack.

## Loop Triggers

A **loop** trigger runs the agent's prompt repeatedly. Each try starts with a fresh context window; anything the next try needs must be written to disk (e.g. `memory/` files or a worklist) and re-read at the start of every run.

### Required fields

| Field | Type | Description |
|---|---|---|
| `maxIterations` | integer | Maximum number of tries. **Required.** The loop always stops here. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `until` | `{ command: string }` | Shell command (`sh -c`, in the agent workspace) run after each try. The loop finishes as soon as it exits `0`. Omit to run the full iteration cap. |
| `verify` | `{ command: string }` or `{ agentId: string }` or `{ flow: true }` or `{ selfGraded: true }` | A separate gate that must pass for a try to count. A shell command (exit `0` = pass), a different agent that reviews the work, `{ flow: true }` to delegate to the flow's wired downstream QS chain (no inline gate — use when the loop starts a review pipeline), or `{ selfGraded: true }` (standalone agents only). Team agents that omit `verify` have a sibling reviewer enforced server-side. |
| `maxTokens` | integer | Stop once this many tokens have been consumed across all tries. Common values: `500000` (small), `2000000` (medium), `8000000` (large). Omit for no token cap. |
| `minGapSeconds` | integer | Minimum wait between tries. `0` (default) chains immediately. |

### How the loop ends

The loop posts a summary and stops when it reaches any terminal state:

| State | Cause |
|---|---|
| **done** | `until.command` exits `0` — goal confirmed met. |
| **exhausted** | `maxIterations` cap or `maxTokens` budget reached. |
| **paused** | Platform runaway safeguard tripped. |
| **stopped** | User pressed **Stop** mid-loop. |

### Admin Console

The **Start a loop** dialog opens from the **loop icon** (`<Repeat/>`) in the chat composer (bottom-left of the message input area in Agent Chat). The icon carries a tooltip and screen-reader label — "Run a loop — repeats until the goal is met" — shown on hover **and** keyboard focus, so it is discoverable without prior context. Core settings (number of tries, who checks the work) are always visible; the stop condition, token budget, and gap options live under **Advanced settings**. The loop icon is **launch-only** (#1427): while any chat turn or loop is running for the selected agent, the primary-action button (the **Send** position) switches to a unified **Stop** (⏹) control; pressing it aborts whatever is running via the session-stop path and returns to **Send**. A turn stop also inserts a distinct "Stopped by user" marker in the transcript.
