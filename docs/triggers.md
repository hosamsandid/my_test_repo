# Autonomous Triggers

Agents are driven by triggers defined in a per-agent `triggers.json` file. The scheduler syncs changes every 60 seconds. All trigger types can be created and managed via the Admin Console — either on the **Scheduled Jobs** page or inline in the **Agent Chat** right rail.

## Trigger Types

| Type | How it fires |
|---|---|
| **cron** | Recurring execution on a 5-field cron expression. Skips if the previous run is still in progress. |
| **once** | Fires once at a specific ISO timestamp, then removes itself automatically. |
| **http** | Fired by an external `POST /hooks/:agentId/:triggerId` with an `X-Hook-Secret` header. Every trigger carries its own auto-generated secret — there is no global open mode. |
| **github-event** | Fired by the built-in GitHub poller when the GitHub Events API reports a matching event (e.g. `pull_request.opened`, `push`). Requires a GitHub token on the Working Environment. The full event payload is appended to the agent prompt as JSON. Supports an optional `claim` field (`{"remove": "<wakeLabel>", "add": "<wakeLabel>:wip"}`) — the runner swaps the labels before invoking the agent so "in progress" is visible on GitHub, and rolls the swap back automatically if the run fails both attempts (which re-fires the chain via the poller). The `add` value **must** follow the `<wakeLabel>:wip` convention (enforced by the bundle validator). For **channel-derived** label listeners (`expandGithubChannels`) the claim is stamped automatically — zero authoring cost; opt out per channel port with `autoClaim: false`. |
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
**Header:** `X-Hook-Secret: <secret>`

The webhook secret is generated automatically when the trigger is created. It is visible in the Admin Console trigger editor.

## GitHub Poller

The built-in GitHub poller queries the GitHub Events API every 30 seconds for all repositories referenced in Working Environments. It uses `If-None-Match` ETags so unchanged repositories cost no rate-limit budget — 304 responses are free. Per-repository state (ETag, last event ID) persists across restarts. The first poll records a baseline so there is no event flood on startup.

**Loop protection:** Agents that take GitHub actions via the `gh-as-agent` wrapper stamp commits with `<agentId>@agents.local` and PR/review bodies with `<!-- agent: <id> -->`. The poller reads these markers and drops events that originate from the same agent, preventing feedback loops.

## Loop Triggers

A **loop** trigger runs the agent's prompt repeatedly. Each try starts with a fresh context window; anything the next try needs must be written to disk (e.g. `memory/` files or a worklist) and re-read at the start of every run.

### Required fields

| Field | Type | Description |
|---|---|---|
| `maxIterations` | integer | Maximum number of tries. **Required.** The loop always stops here. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `until` | `{ command: string }` | Shell command run after each try. The loop finishes as soon as it exits `0`. Omit to run the full iteration cap. |
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

### Admin Console

The **Start a loop** dialog in Agent Chat (right-rail trigger editor) exposes all fields. Core settings (number of tries, who checks the work) are always visible; the stop condition, token budget, and gap options live under **Advanced settings**.
