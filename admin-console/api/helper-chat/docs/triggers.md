# Autonomous Triggers

Agents are driven by triggers defined in a per-agent `triggers.json` file. The scheduler syncs changes every 60 seconds. All trigger types are created and managed per agent in Agent Studio — inline in the **Agent Chat** right rail, under the **Triggers** tab.

## Trigger Types

| Type | How it fires |
|---|---|
| **cron** | Recurring execution on a 5-field cron expression. Skips if the previous run is still in progress. |
| **once** | Fires once at a specific ISO timestamp, then removes itself automatically. |
| **http** | Fired by an external `POST /hooks/:agentId/:triggerId` with an `X-Hook-Secret` header — or a GitHub webhook signed with the trigger's secret (`X-Hub-Signature-256`, see below). Every trigger carries its own auto-generated secret — there is no global open mode. |
| **github-event** | Fired by the built-in GitHub poller when the GitHub Events API reports a matching event (e.g. `pull_request.opened`, `push`). Requires a GitHub token on the environment. The full event payload is appended to the agent prompt as JSON. Supports an optional `claim` field (`{"remove": "<wakeLabel>", "add": "<wakeLabel>:wip"}`) — the runner swaps the labels before invoking the agent so "in progress" is visible on GitHub, and rolls the swap back automatically if the run fails both attempts (which re-fires the chain via the poller). The `add` value **must** follow the `<wakeLabel>:wip` convention (enforced by the bundle validator). For **channel-derived** label listeners (`expandGithubChannels`) the claim is stamped automatically; opt out per channel port with `autoClaim: false`. Push: optional `branchFilter` ([rules](push-branch-filter.md)); knowledge branches never wake. PR hand-off: optional `readinessGate` ([below](#hand-off-readiness-gate-wait-for-ci-block-on-merge-conflict)). Comments: optional `requireLabel`, `skipAgentComments`, `target` ([below](#comment-listeners-requirelabel-skipagentcomments-target)). |
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

The webhook secret is generated automatically when the trigger is created. It is visible in the Agent Studio trigger editor.

## GitHub Poller

Every 30 s the poller queries the GitHub Events API for each environment repository — or agent-scoped repository, using its agent's environment token — with a readable GitHub token that an enabled agent's enabled, non-internal `github-event` trigger names; the Event Log's **Repositories** area explains the rest. ETags make unchanged repositories free (304). Per-repository state (ETag, sliding set of seen event ids) survives restarts; the first poll only baselines. Reviews (Events API `pull_request_review.created`) are keyed `pull_request_review.submitted`; listing both wakes once.

**Loop protection is frequency-based, not origin-based.** No source filtering unless a push trigger sets `pushedBy: [agentId…]`: only pushes those same-team agents (or their pool instances) made via `gh-as-agent` fire it. Otherwise any matching event fires, whoever caused it. The backstops are the per-conversation throttle (default 5 events/hour per agent per PR / issue / branch) and the burst digest (more than 3 events on one conversation in a single poll fold into one lossless summary wake). `gh-as-agent` stamps are attribution for humans — the poller ignores them. The **GitHub Event Log** page (and help topic) shows what happened to each event.

**The chat notice names the issue a pull request closes.** When a `github-event` trigger fires, the agent's room gets a notice such as ``⚡ Trigger fired — PR labeled · `revisions-required` · `repo` · #2798 → closes #2794 (https://github.com/…/pull/2798): <title> — <trigger description> — starting work…``. For `pull_request.*` and `pull_request_review.*` events whose PR is linked to issues (`Closes/Fixes/Resolves #N` in the PR body, or an `issue-N` branch — the same link the GitHub Event Log shows), `→ closes #N` (several: `#12, #15`, ascending) follows the PR number, so searching for the issue number finds the run. A PR without a link shows only `#<PR>`, as before. The same wording appears in the burst digest DM (`` on `pr:2798` → closes #2794 ``), in the agent's **Events** tab and in the pending-queue reassign messages.

**The first push to a new branch arrives as the pull request it opens.** The Events API reports no `PushEvent` (and often no `CreateEvent`) for the push that creates a branch — only later pushes to the existing branch surface as `push`. So the poller turns every `pull_request.opened` / `pull_request.reopened` whose head branch lives in the same repository (not a fork) into an extra `push` event for that head branch and commit, logged as its own `push` row (event id `prpush:<id>`, payload `ref`/`head` plus `synthesizedFrom` and the PR number). Push wakes are de-duplicated per repository on branch + head commit: whichever of the PR-derived push and a real `PushEvent` for the same commit arrives first wakes `push` triggers, and the other is logged as dropped (`push-duplicate`). A trigger that also listens to the originating `pull_request.*` event is not woken a second time by the derived push. History horizon, throttle and burst digest apply as for any event. A branch pushed without opening a PR is still not detected — GitHub reports nothing for it.

### PR readiness: `pull_request.checks_passed` / `checks_failed` / `merge_conflict`

The Events API has no event for "CI finished" or "this PR now conflicts" (no `check_suite`, `check_run`, `workflow_run`, `status`, and nothing for mergeability). So for a repository where at least one `github-event` trigger listens to one of these three keys, the poller **reads** the state of the open pull requests itself on every cycle (GitHub GraphQL API) and wakes the trigger once a verdict is reached (`orchestrator/pr-readiness.js`, #2794). **GitHub only** — GitLab repositories are not polled.

| Key | Fires when |
|---|---|
| `pull_request.checks_passed` | The PR's head commit has at least one check and **all** of them passed (`success`, `neutral` or `skipped`). |
| `pull_request.checks_failed` | **Any** check of the head commit failed (`failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure`, `stale`, or a commit status `failure`/`error`) — even while others are still running. |
| `pull_request.merge_conflict` | GitHub reports the PR as conflicting with its base branch. |

- **Every check counts**, required or not — CodeQL, external commit statuses, and checks branch protection does not require. A queued or running check keeps CI *pending*.
- **No CI**: a head commit with no check at all after a grace period (default 3 minutes from when the poller first saw it, `AEE_PR_READINESS_CI_GRACE_MS` on the orchestrator) gets the verdict *none*, which fires nothing. *None* is final: checks that only start after the grace period (e.g. a long runner queue) are not read any more for that commit, so raise the grace period if your CI routinely starts late. Mergeability `UNKNOWN` (GitHub still computing) stays *pending* and is re-read on the next cycle; `MERGEABLE` is *clean* and fires nothing.
- **Once per (PR, head commit, verdict).** A new push resets both verdicts for the new head; a verdict of the old head is never delivered after the new head was seen. A re-run on the same commit can still turn `checks_failed` into a later `checks_passed`; a base branch that moves under an already-clean head still produces `merge_conflict` (once per head). A PR closed or merged while pending fires nothing. Fork PRs are evaluated like any other.
- **Payload**: a `pull_request` event (`payload.action` = `checks_passed` / `checks_failed` / `merge_conflict`) with `number`, `pull_request.{number, title, html_url, head.{ref,sha}, base.ref}` and `payload.readiness = {headSha, verdict, ci, merge, failingChecks, fromFork}` — `failingChecks` names the failed checks for `checks_failed`. The wake is routed to the PR's conversation and logged in the **GitHub Event Log** like any polled event; history horizon, throttle and burst digest apply.
- **No replay**: the first evaluation of a repository (or the first after its last readiness subscriber was removed) only records the verdicts already reached and wakes nobody. After that the state is kept (in the poller's `state.json`), so an outage, an orchestrator restart or a backoff does **not** re-baseline: a PR whose verdict was reached meanwhile is woken on the next successful cycle, like the events poll backfills.
- **API cost** per poll cycle, per repository with a subscriber: **one** GraphQL call for the open PRs (head commit + mergeability, up to 100 PRs), plus **one** GraphQL call for the checks of all head commits whose CI verdict is still open (pending or failed), only when there is one. A head whose verdict is `passed` or *none* is no longer read. Repositories without a subscriber cost nothing extra. While the events poll of a repository backs off (rate limit, GitHub unreachable, bad token), readiness is not evaluated either; a failed read leaves every verdict as it was.

### Hand-off readiness gate: wait for CI, block on merge conflict

A PR hand-off — a `github-event` trigger on `pull_request.labeled`, `pull_request.opened` or `pull_request.reopened`, including the listener a PR channel derives — can carry a **readiness gate** (#2795). Instead of waking the next agent the moment the label is set, the poller **holds** the wake until the PR's current head commit is ready, using the same GitHub reads as PR readiness above.

```json
"readinessGate": { "ci": true, "conflict": true, "failureLabel": "revisions-required", "timeoutMinutes": 60 }
```

| Field | Meaning |
|---|---|
| `ci` | **Wait for CI** — hold until the head's checks pass. *None* (no check at all after the grace period) also releases. |
| `conflict` | **Block on merge conflict** — hold until GitHub reports the PR as mergeable. |
| `failureLabel` | Set when a gate fails. Default `revisions-required`. Must differ from the wake label — also when left at the default, so a new hand-off on `revisions-required` starts ungated. |
| `timeoutMinutes` | How long a hold may last, 1–10080. Default 60. |

On a channel port the same object is the channel's `readiness` field; the derived listener carries it as `readinessGate`. Both toggles off (or the field absent) means no gate. Defaults are not written.

- **Release**: every enabled gate is satisfied for the current head → the agent is woken with the original event, logged `delivered · gate cleared`.
- **Failure**: a check failed or the PR conflicts → nobody is woken; the poller removes the wake label, sets the failure label and comments on the PR, listing the failing checks or naming the conflict. Wire an agent on the failure label (e.g. a developer that fixes the PR and re-applies the hand-off label) — the Flows editor warns when nobody listens on it.
- **Timeout**: still pending after `timeoutMinutes` → the wake label is removed, `needs-human` set and a comment names what was still pending.
- **Push during a hold**: the new head is evaluated afresh (the old head's failure is void); the timeout counts from the original hold.
- **Cancel**: PR closed or merged, wake label removed, or trigger deleted → the hold is dropped, nobody is woken.
- **Labels applied from the console** (GitHub Issues plugin, Flow Supervisor) are held the same way.
- **Restarts**: holds live in the poller's `state.json` and survive a restart; a failed GitHub write is retried next cycle.
- **Fan-in**: when several PR channels share one listener, their gates are combined — each toggle is on if any channel enables it; the first channel's explicit failure label / timeout wins.
- **Defaults**: the core, extended and dispatched SDLC templates gate their PR hand-offs, and a new PR hand-off drawn in the Flow editor starts with both gates on. Existing hand-offs stay ungated until switched on in the hand-off dialog or **Agent Chat → Triggers** (new triggers start ungated; a derived listener's gate is saved to its channels).

Visible in the **GitHub Event Log** (`held — waiting for CI / conflict-free`, then `delivered · gate cleared` or `not woken (gate failed / timed out / cancelled)`), on the agent's **Events** tab, and as **waiting for CI** on the PR's row in **Flow Control**. Only PR hand-offs can be gated; issue hand-offs are not.

Re-fire a dropped wake from Agent Chat → **Events** (#2525).

### Comment listeners: `requireLabel`, `skipAgentComments`, `target`

A role that resumes when a human answers on an issue listens to `issue_comment.created`. Without a filter it wakes on **every** comment in the repository — on any issue or PR, including the comments agents post themselves. Three optional trigger fields narrow it (#2822). They act **only on `issue_comment.*` events**; on any other event they are ignored. Absent = no filter, unchanged behaviour.

```json
{ "type": "github-event", "repo": "org/repo", "events": ["issue_comment.created"],
  "requireLabel": "needs-clarification", "skipAgentComments": true, "target": "issue",
  "prompt": "A human answered your question — continue." }
```

- **`requireLabel`** — wake only when the commented issue / PR **currently** carries this label. The comment event's own label list is the set when GitHub recorded the event, so the poller reads the item's live labels (one GitHub request per item per poll cycle, shared by all listeners) and falls back to the event's labels only when that read fails. Dropped as **`comment-label`**. Stamped by a team's `labelSuffix` like `labelFilter`.
- **`skipAgentComments: true`** — drop a comment whose body carries a `gh-as-agent` marker (`<!-- agent: <id> -->`); human comments still wake. All agents share one GitHub token, so the marker is what tells an agent comment apart. Dropped as **`agent-comment`**.
- **`target: "issue" | "pr"`** — wake only for comments on that kind of item. Dropped as **`comment-target`**.

The filters apply on every delivery path: the poller fan-out, a pending-queue reassign (which uses the queued event's labels) and **Fire again**, which refuses when the required label is no longer on the item. Every drop is shown with its reason in the **GitHub Event Log** and on the agent's **Events** tab. Edit them in the trigger form (Agent Chat → Triggers, and the Flow editor) when the event is *Issue comment*.

### In-turn wait: `aee-wait-ci`

The two mechanisms above wake an agent in a **later** run. An agent that needs the verdict **within its current turn** (e.g. in chat: "is my PR green?") runs the container CLI `aee-wait-ci <pr> [--repo <clone-dir>|owner/name] [--timeout <minutes>] [--head <sha>] [--no-conflict-check]` in the foreground (#2796). It applies the **same rules** as PR readiness — one shared definition, `orchestrator/pr-readiness-rules.json`, vendored into the agent image — re-reads the PR every ~20 s and prints one JSON object (`status`, `headSha`, `ci`, `merge`, `failingChecks`, `pendingChecks`, `supersededHeads`, …) plus an exit code: `0` passed / no CI, `4` failed, `5` conflict, `6` timeout, `1` error (no token, PR not found, closed or merged, or the expected head never shown — `staleHead: true`), `3` GitHub unreachable, `2` usage.

- **Bounded**: default 20 minutes, never more than 50, and always capped to end two minutes before the run's own timeout (`AEE_RUN_DEADLINE`, set per turn by the runtime). The runtime raises only Claude Code's **maximum** Bash tool timeout for each turn (`BASH_MAX_TIMEOUT_MS` 55 min, a larger operator value kept); the default stays at 2 minutes so an accidentally blocking command (e.g. one reading stdin) is not held for long (#2815). The agent therefore passes the Bash tool `timeout` explicitly — the wait plus 5 minutes, `1500000` ms for the default 20.
- **Push during the wait**: the new head is evaluated from scratch; `headSha` names the commit the verdict belongs to.
- **Push right before the wait** (#2818): GitHub can still show the previous commit as the PR's head for a few seconds. The expected head is `--head <sha>` or, by default, the local clone's HEAD when the clone is on the PR's branch; while the PR's head is not it, the old head's red CI or conflict is not reported and the PR is re-read every ~5 s. With the local default this applies only while GitHub's head is an older commit of the branch — a head the clone does not have (a teammate's push) is evaluated as before. Not shown after 3 minutes → error with `staleHead: true` (was the push made?). `expectedHead` in the result names the expected commit.
- **Rate limiting** is backed off and retried, never reported as a failure.
- **Status note in chat** (#2841): once a wait actually starts (the PR is not settled at the first look), `aee-wait-ci` appends one line to the per-turn file named by `AEE_STATUS_FILE`; the runtime watches that file and posts **one** short `m.notice` to the run's room — *Pull request #2838 is open — waiting for CI to finish (up to 20 min).*, the PR number linking to the repository the wait resolved. A second wait on the same PR in the same run names the attempt (*attempt 2*). The note is in German when the chat message was, else English; it carries `io.aee.status-note` (`kind`, `repo`, `pr`, `attempt`, `timeoutMinutes`, `correlationId`). It is posted by the runtime, not the agent, so it never depends on the agent remembering to; it never replaces the final reply. No note for a usage error, a PR already settled at the first look, or a run without a room.
- **Not for unattended flows**: on timeout it says so — continue via a gated hand-off or a `pull_request.checks_*` trigger, never via a background task (which is killed when the turn ends).

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

### In Agent Studio

The **Start a loop** dialog opens from the **loop icon** (`<Repeat/>`) in the chat composer (bottom-left of the message input area in Agent Chat). The icon carries a tooltip and screen-reader label — "Run a loop — repeats until the goal is met" — shown on hover **and** keyboard focus, so it is discoverable without prior context. Core settings (number of tries, who checks the work) are always visible; the stop condition, token budget, and gap options live under **Advanced settings**. The loop icon is **launch-only** (#1427): while any chat turn or loop is running for the selected agent, the primary-action button (the **Send** position) switches to a unified **Stop** (⏹) control; pressing it aborts whatever is running via the session-stop path and returns to **Send**. A turn stop also inserts a distinct "Stopped by user" marker in the transcript.
