# jira broker sidecar

Server-side Jira Cloud for the `jira` plugin: polls issue **status changes** and
wakes agents, holds the per-team credential, serves the console UI. Built on the
[Broker SDK](../../../broker-sdk/).

- **Design + rollout:** `docs/jira-plugin-plan.md`
- **Operator & agent guide:** `docs/jira-plugin.md`

## What it does

A `setInterval` loop (inside this sidecar — nothing in the orchestrator) runs,
per watched project:

1. a narrow JQL search (`project = "KEY" AND updated >= -Nm ORDER BY updated ASC`)
   with `expand=changelog`;
2. backfills any changelog Atlassian truncated (`changelog.total > histories.length`);
3. flattens each `field: "status"` history item into one event keyed
   `<issueKey>:<historyId>`;
4. gates by the watch's `statusFilters` set (empty = any; fires on a transition
   into any listed status);
5. dedups against a per-`<siteUrl>::<projectKey>` seen-id cursor (first poll only
   baselines — no wake);
6. folds a bulk transition (more than `PROJECT_BURST_CAP` = 3 watched events in one
   poll of one project) into ONE lossless digest — otherwise collapses a per-issue
   burst into one digest and applies the hour-scoped throttle;
7. hands survivors to `deliver()` — the transport seam;
8. records every fresh event to the 14-day `activity-store.js` log with an
   outcome tag (`delivered` / `digested` / `throttled` / `filtered` / `stale` / `baseline`)
   and folds a poll failure into the cursor's `recentErrors` ring
   (`watch-health.js`).

The seen-id / burst / throttle / backoff primitives are a **copy** of the GitHub
poller's, in `broker-sdk/event-cursor.js` (`github-poller.js` is untouched).

## Modules

| File | Role |
|---|---|
| `event-extract.js` | pure: `resolveJiraApiBase`, `isChangelogTruncated`, `extractStatusChangeEvents` (summary + `issueType`, tolerating raw or shaped issues), `matchesStatusFilter` / `matchesStatusFilters`, `computeQueryWindowMinutes` (catch-up widening, capped 24h) |
| `jira-client.js` | Jira REST v3 surface (Basic auth); pure builders + thin `fetch` adapters; `JIRA_API_BASE` test seam; `searchProjectIssues` (poll — now requests `issuetype`), `listProjectIssues` / `getIssue` / `listProjects` (CLI + UI reads), `searchIssues` (agent arbitrary-JQL read, shaped like `listProjectIssues`, `--limit` clamped to `MAX_PAGES × PAGE_SIZE`); a per-site field catalog (`/rest/api/3/field`, cached) resolves custom-field names → ids for both the Epic Link parent link and agent-requested `customFields` reads (`show`/`search`/`list`, admin allow-list ∪ per-request `--fields`) |
| `watch-store.js` | per-scope watch config (`{ projectKey, statusFilters?: string[] }`, legacy `statusFilter` migrated on read) + poll cursor on `AEE_PLUGIN_STATE_DIR`, atomic writes |
| `watch-health.js` | pure: the cursor `recentErrors` ring (`recordPollError` / `clearPollFailure`) + the 3-state `deriveWatchHealth` (Watching / Degraded / Failing) + `summariseWatchHealth` roll-up, surfaced on `/watches` |
| `inbox-store.js` | per-scope queue of delivered-but-unconsumed events; TTL + `quota.maxObjects` ring — **this is what the manifest quota counts**; drained by event id only (`consumeIds`), never team-wide |
| `activity-store.js` | per-scope retained event log ("what did the poller see, and what did it do"); own 14-day retention + row cap, **not** the manifest quota |
| `poller.js` | the poll loop; transport-agnostic (`deliver()` callback); records activity rows + folds poll errors into the cursor |
| `viewer-headers.js` | §4.8 signed-viewer verify (byte-identical copy) + the `/admin` → team-admin role gate |
| `broker-policy.js` | write authorisation (D3): `authorizeWrite` → SDK `authorizeAction` against the manifest `policy`; `requiresApproval` wired-but-empty |
| `ui/` | the served `/` route (Board tab: issues / watch-health cards / inbox; Activity tab: the retained log) + `/admin` route (watch config with per-project status chips, team-admin). Dependency-free vanilla JS, `--eb-*` tokens, follows the console theme |
| `server.js` | wiring: `/healthz`, `/internal/{teardown-scope,scope-credentials}`, `/cli/*` (`whoami`/`inbox` (peek / `?consume=<id,…>`)/`projects`/`list`/`search` (arbitrary JQL)/`show`/`attachment` (content by id) + `comment`/`transition`/`update`/`attachment/add` (upload one file per call) POST), `/ui/*` (incl. `/ui/api/{watches,activity,admin/watch,admin/retry}`) |


## Credentials

Each granted team's Jira credential (`site-url` / `email` / `api-token`) is set
by a **Team Admin** on the **Plugins** page (the Credentials section on the Jira
card). Values are written `0600` server-side
(`/workspace/plugins/_credentials/jira/<teamId>.json`), never read back (preview
+ set-by/-at only), and the orchestrator pushes the per-scope map here
(`PUT /internal/scope-credentials`, accepted from the orchestrator's `_internal`
token only — SDK `internalPushEndpoint`; a granted team's token is refused) on
boot, on grant change and on save — no restart, no secret in code or env. `resolveCredential(scopeId)` reads only that
pushed map; a granted-but-unconfigured team simply isn't polled. Use a **classic
(unscoped)** Jira API token — a scoped one missing `read:jira-work` sees zero
projects.

## Delivery — the `plugin-event` wake

On a fresh matching transition the broker mints a `jira.<scopeId>.<sig>` scope
token and POSTs `AEE_ORCHESTRATOR_URL/internal/plugin-event` (default
`http://orchestrator:4002`). The orchestrator verifies the token, resolves the
scope to its team, and wakes every granted agent carrying a matching
`plugin-event` trigger (`{ pluginId: "jira", eventFilter?, prompt }`). The
agent's own `prompt` is the wake instruction; the payload rides in as untrusted
context in an `<external-event source="plugin:jira">` envelope. A `digest` burst
(per issue, or the per-project bulk case) becomes one wake carrying the collapsed
set — every event (safety bound `DIGEST_MAX_EVENTS` = 1000) plus `count`; the
orchestrator projects it per target trigger before enqueuing and only then caps
the inline list at 20 of that agent's own events (`truncated: true` when cut),
so each agent sees only its own folded events and none are hidden from the
match; the inbox holds all of them.

## Writes — role-gated, not confirmation-gated (D3)

`aee-jira comment` / `transition` / `update` / `attachment add` POST through the
broker. `attachment add` sends ONE file per request as `{ issue, filename,
contentBase64 }`; the broker decodes it and does the multipart upload to Jira's
`/attachments` endpoint (with the required `X-Atlassian-Token: no-check` header)
server-side, so the Jira token never leaves the broker — the same containment as
every read. One request per file keeps the buffered body bounded
(`ATTACHMENT_BODY_MAX_BYTES` ≈ the base64-grown upload cap) and gives the CLI
clean per-file success/failure when several files are attached in one
invocation; the upload is a write and, like the others, is never retried on a
transport failure (a retry would create a duplicate attachment — Jira never
dedups a same-named upload). The upload cap is
`JIRA_ATTACHMENT_UPLOAD_MAX_BYTES` (default 10 MB); the instance's own limit may
be lower and surfaces as a mapped 413.

Before the credential
is touched, `broker-policy.authorizeWrite` runs the manifest's `policy` rule
through the SDK's `authorizeAction`. jira is `scopes: ["team"]`, so every caller
resolves to `kind: 'team'` and both rules pass — which is D3's intent (moving a
ticket is routine and reversible; an approval pen would stall unattended flows).
The value of the gate: the enforcement path exists, so a future tightening (or a
`requiresApproval` entry for a destructive op) is a manifest edit. `transition`
names the **target** status; the broker resolves the Jira transition id and 409s
with the available options if none leads there from the issue's current status.
Every write is audited, and each comment carries a *"Posted by an agent on
team …"* attribution paragraph.

## Debugging — `spike.js`

Runs inside the sidecar, edits the same state the poller reads:

```
podman exec aee-plugin-jira node spike.js status  --scope <teamId>
podman exec aee-plugin-jira node spike.js probe   --project KAN --window 120 --status "Ready for Dev"
podman exec aee-plugin-jira node spike.js raw     --path /rest/api/3/myself
podman exec aee-plugin-jira node spike.js poke    --scope <teamId> [--reset]
```

`probe` replays the exact JQL search + changelog extraction against Jira and
prints what would fire (or why nothing does); `poke` forces one real poll now.
These read the Jira credential from a gitignored `broker/.env.local`
(`KEY=VALUE`) — `server.js` itself no longer reads that file, only the pushed
per-scope map.

`spike.js watch --scope <teamId> --project KAN [--status …]` sets a scope's
watch list directly in the sidecar's state — the on-disk equivalent of the Team
Admin's `/admin` action. There is no HTTP route for it: the Phase-0
`PUT /internal/spike-config` seam (any scope token could reconfigure its own
team's watches, bypassing the Team-Admin gate) and its `doorbell` field are
gone; delivery is only ever the `plugin-event` wake above.
