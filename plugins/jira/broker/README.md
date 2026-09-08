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

## Phase 0 — the spike

Proves the JQL/changelog/dedup core against a **real Jira Cloud sandbox** with
zero platform change, via Option A (the content-free doorbell):

- **Credential**: one install-wide credential from the sidecar env —
  `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. The spike delivers them via a
  gitignored `broker/.env.local` (`KEY=VALUE` lines): `server.js` loads it at
  startup, and because the image's build context is the repo root the file is
  baked into `aee-plugin-jira:latest` when you `make plugin-images`. That is the
  **spike credential path** and it is fine for a sandbox — the file is gitignored
  and the image is `localhost/` only. Phase 1 replaces it with the generic
  per-scope credential store (no secret in the image, set per team in the
  console). Delete `.env.local` and rebuild when you are done spiking.
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
