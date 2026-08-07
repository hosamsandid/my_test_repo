# Autonomous Triggers

Agents are driven by triggers defined in a per-agent `triggers.json` file. The scheduler syncs changes every 60 seconds. All trigger types can be created and managed via the Admin Console — either on the **Scheduled Jobs** page or inline in the **Agent Chat** right rail.

## Trigger Types

| Type | How it fires |
|---|---|
| **cron** | Recurring execution on a 5-field cron expression. Skips if the previous run is still in progress. |
| **once** | Fires once at a specific ISO timestamp, then removes itself automatically. |
| **http** | Fired by an external `POST /hooks/:agentId/:triggerId` with an `X-Hook-Secret` header. Every trigger carries its own auto-generated secret — there is no global open mode. |
| **github-event** | Fired by the built-in GitHub poller when the GitHub Events API reports a matching event (e.g. `pull_request.opened`, `push`). Requires a GitHub token on the Working Environment. The full event payload is appended to the agent prompt as JSON. |
| **jira-event** | Fired by the built-in Jira poller when an issue in a bound Jira project transitions status. Requires a Jira credential bound to a project key on the Working Environment (see **Jira Projects**). Optional `statusFilter` fires only on transitions into an exact status name. |

Cron format: `Minute Hour Day Month Weekday`

## Webhook Server

The orchestrator exposes a second HTTP server on `HOOK_PORT` (default `4003`). External systems — CI pipelines, GitHub Actions, monitoring tools — can trigger agent prompts via an outbound POST to your LAN. No public ingress is required.

**Endpoint:** `POST http://<host>:4003/hooks/<agentId>/<triggerId>`  
**Header:** `X-Hook-Secret: <secret>`

The webhook secret is generated automatically when the trigger is created. It is visible in the Admin Console trigger editor.

## GitHub Poller

The built-in GitHub poller queries the GitHub Events API every 30 seconds for all repositories referenced in Working Environments. It uses `If-None-Match` ETags so unchanged repositories cost no rate-limit budget — 304 responses are free. Per-repository state (ETag, last event ID) persists across restarts. The first poll records a baseline so there is no event flood on startup.

**Loop protection:** Agents that take GitHub actions via the `gh-as-agent` wrapper stamp commits with `<agentId>@agents.local` and PR/review bodies with `<!-- agent: <id> -->`. The poller reads these markers and drops events that originate from the same agent, preventing feedback loops.

## Jira Poller

The built-in Jira poller queries Jira Cloud's JQL search every 60 seconds (configurable) for every project bound to a credential on a Working Environment. Jira Cloud has no discrete events feed like GitHub's, so instead the poller diffs each matching issue's changelog for status-field transitions since the last poll. State (which changes have already been seen) persists across restarts, and the first poll for a project records a baseline so there is no event flood on startup.

Because a Jira project key (e.g. `ENG`) is not globally unique the way a GitHub `owner/repo` is, project resolution is scoped to each agent's own Working Environment — the same key bound to two different Jira sites on two different environments is never conflated.

See [docs/jira-integration-concept.md](./jira-integration-concept.md) for the full design rationale.
