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
4. gates by the watch's optional exact-match `statusFilter`;
5. dedups against a per-`<siteUrl>::<projectKey>` seen-id cursor (first poll only
   baselines — no wake);
6. collapses a per-issue burst into one digest, applies the hour-scoped throttle;
7. hands survivors to `deliver()` — the transport seam.

The seen-id / burst / throttle / backoff primitives are a **copy** of the GitHub
poller's, in `broker-sdk/event-cursor.js` (`github-poller.js` is untouched).

## Modules

| File | Role |
|---|---|
| `event-extract.js` | pure: `resolveJiraApiBase`, `isChangelogTruncated`, `extractStatusChangeEvents`, `matchesStatusFilter`, `computeQueryWindowMinutes` (catch-up widening, capped 24h) |
| `jira-client.js` | Jira REST v3 surface (Basic auth); pure builders + thin `fetch` adapters; `JIRA_API_BASE` test seam; `searchProjectIssues` (poll), `listProjectIssues` / `getIssue` / `listProjects` (CLI + UI reads) |
| `watch-store.js` | per-scope watch config + poll cursor on `AEE_PLUGIN_STATE_DIR`, atomic writes |
| `inbox-store.js` | per-scope queue of delivered-but-unconsumed events; TTL + `quota.maxObjects` ring — **this is what the manifest quota counts** |
| `poller.js` | the poll loop; transport-agnostic (`deliver()` callback) |
| `viewer-headers.js` | §4.8 signed-viewer verify (byte-identical copy) + the `/admin` → team-admin role gate |
| `broker-policy.js` | write authorisation (D3): `authorizeWrite` → SDK `authorizeAction` against the manifest `policy`; `requiresApproval` wired-but-empty |
| `ui/` | the served `/` route (issues / inbox / watch view) + `/admin` route (watch config, team-admin). Dependency-free vanilla JS, `--eb-*` tokens, follows the console theme |
| `server.js` | wiring: `/healthz`, `/internal/{teardown-scope,scope-credentials}`, `/cli/*` (`whoami`/`inbox`/`projects`/`list`/`show` + `comment`/`transition` POST), `/ui/*` (incl. `/ui/api/admin/watch`), the Phase-0 `/internal/spike-config` seam |


## Credentials

Each granted team's Jira credential (`site-url` / `email` / `api-token`) is set
by a **Team Admin** on the **Plugins** page (the Credentials section on the Jira
card). Values are written `0600` server-side
(`/workspace/plugins/_credentials/jira/<teamId>.json`), never read back (preview
+ set-by/-at only), and the orchestrator pushes the per-scope map here
(`PUT /internal/scope-credentials`) on boot, on grant change and on save — no
restart, no secret in code or env. `resolveCredential(scopeId)` reads only that
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
becomes one wake carrying the collapsed set.

## Writes — role-gated, not confirmation-gated (D3)

`aee-jira comment` / `transition` POST through the broker. Before the credential
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

The Phase-0 `doorbell` field and `PUT /internal/spike-config` remain wired so
`spike.js watch` can still stand up an end-to-end path without a real grant, but
the real delivery path is the `plugin-event` wake above.
