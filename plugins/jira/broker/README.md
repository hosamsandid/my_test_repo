# jira broker sidecar

Server-side Jira Cloud polling for issue **status changes**. Built on the
[Broker SDK](../../../broker-sdk/). Full design: `docs/jira-plugin-plan.md`.

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
| `jira-client.js` | Jira REST v3 surface (Basic auth); pure builders + thin `fetch` adapters; `JIRA_API_BASE` test seam |
| `watch-store.js` | per-scope watch config + poll cursor on `AEE_PLUGIN_STATE_DIR`, atomic writes |
| `inbox-store.js` | per-scope queue of delivered-but-unconsumed events; TTL + `quota.maxObjects` ring — **this is what the manifest quota counts** |
| `poller.js` | the poll loop; transport-agnostic (`deliver()` callback) |
| `server.js` | wiring: `/healthz`, `/internal/teardown-scope`, `/cli/*`, the Phase-0 `/internal/spike-config` seam |

## Credentials (Phase 1 — the per-scope store)

Each granted team's Jira credential (`site-url` / `email` / `api-token`) is set
by a **Team Admin** in the console — the **Credentials** section on the Jira card
on the **Plugins** page. Values are written `0600` server-side
(`/workspace/plugins/_credentials/jira/<teamId>.json`), never read back (preview
+ set-by/-at only), and the orchestrator pushes the per-scope map to this broker
(`PUT /internal/scope-credentials`) on boot, on grant change and on save — no
restart, no secret in code or env. `resolveCredential(scopeId)` reads only that
pushed map; a granted-but-unconfigured team simply isn't polled.

`broker/.env.local` (`KEY=VALUE`, gitignored) is now **spike diagnostics only** —
`spike.js probe` / `raw` / `whoami-jira` load it so you can hit Jira by hand.
`server.js` no longer reads it.

## Delivery (Phase 2 — the `plugin-event` wake)

On a fresh matching transition the broker mints a `jira.<scopeId>.<sig>` scope
token and `POST`s `AEE_ORCHESTRATOR_URL/internal/plugin-event` (default
`http://orchestrator:4002`). The orchestrator verifies the token, resolves the
scope to its team, and wakes every granted agent that carries a matching
`plugin-event` trigger (`{ pluginId: "jira", eventFilter?, prompt }`). The
agent's own `prompt` is the wake instruction; the status-change payload rides in
as untrusted context in an `<external-event source="plugin:jira">` envelope.

No doorbell, no hand-wired `http` trigger. The Phase-0 `doorbell` field +
`spike-config` endpoint remain only so `spike.js` can still exercise things.

## Phase 0 — the spike (superseded)

Proved the JQL/changelog/dedup core against a real Jira Cloud sandbox with zero
platform change, via Option A (the content-free doorbell).
- **Watch + doorbell**: hand-wired. Create an `http` trigger on the target agent
  (any prompt that says "run `aee-jira inbox --consume` and act on the events"),
  then register the watch. Easiest is `spike.js`, which runs INSIDE the sidecar
  and needs no scope token:

  ```
  podman exec aee-plugin-jira node spike.js watch \
    --scope <teamId> --project ENG --status "Ready for Dev" \
    --doorbell http://orchestrator:4003/hooks/<agentId>/<hookId> --secret <trigger secret>
  podman exec aee-plugin-jira node spike.js status --scope <teamId>
  podman exec aee-plugin-jira node spike.js inbox  --scope <teamId> [--consume]
  ```

  The `<teamId>` scope is the `scopeId` in a granted agent's
  `.agent-studio/plugins/jira.json`. The equivalent bearer-authed HTTP surface is
  `PUT /internal/spike-config` / `GET /internal/status` (a `jira.<scopeId>.<sig>`
  token — reuse the one in that same seeded file).

  On a fresh matching transition the broker appends the event to the scope's
  inbox and POSTs the doorbell; the webhook server enqueues the agent's `http`
  trigger; the agent runs and drains the inbox with `aee-jira inbox --consume`.

## Later phases

- **1** — generic per-scope credential store (`PUT /internal/scope-credentials`).
- **2** — `deliver()` swapped for `POST /internal/plugin-event` (drops the doorbell).
- **3–4** — `aee-jira projects|list|show`, then `comment|transition` behind
  `policy`; the `/` and `/admin` UI routes.
