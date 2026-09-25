# jira broker sidecar

Server-side Jira Cloud for the `jira` plugin: polls watched projects for
**status changes, new issues, comments and other field changes** and wakes
agents, holds the per-team credential, serves the console UI. Built on the
[Broker SDK](../../../broker-sdk/).

- **Design + rollout:** `docs/jira-plugin-plan.md`
- **Operator & agent guide:** `docs/jira-plugin.md`
- **Event kinds:** `docs/jira-plugin-events-plan.md` (what/why),
  `docs/jira-plugin-events-implementation.md` (contracts)

## What it does

A `setInterval` loop (inside this sidecar — nothing in the orchestrator) runs,
per watched project:

1. a narrow JQL search (`project = "KEY" AND updated >= -Nm ORDER BY updated ASC`)
   with `expand=changelog`, fields `summary, status, issuetype, created,
   reporter, priority, comment`;
2. backfills any changelog Atlassian truncated (`changelog.total > histories.length`)
   and any comment list it cut short (`fetchRecentComments`, newest first, stops
   at the window);
3. extracts typed events, each with an explicit `event` kind and an id that
   `inbox --consume` accepts (`EVENT_ID_RE`, exactly one colon):

   | kind | from | id |
   |---|---|---|
   | `status_changed` | changelog `status` item | `<key>:<historyId>` |
   | `issue_created` | `fields.created` inside the window | `<key>:created` |
   | `field_changed` | any other changelog item except `description` / `Rank` | `<key>:<historyId>.<fieldId>` |
   | `comment_added` | `fields.comment` created inside the window | `<key>:c<commentId>` |

   The last three carry `origin: agent | human` from `own-writes-store.js`;
4. dedups against a per-`<siteUrl>::<projectKey>` seen-id cursor (first poll only
   baselines — no wake) and drops anything created before the previous poll
   (`stale`);
5. gates by the watch's opt-in `events` set (default `["status_changed"]`) and,
   for a status change only, its `statusFilters` set (empty = any);
6. **per kind** (a wake carries one `event`, all a trigger's `eventFilter` sees):
   folds a bulk change (more than `PROJECT_BURST_CAP` = 3 gated events of that
   kind in one poll of one project) into ONE lossless digest — otherwise
   collapses a per-issue burst into one digest and applies the hour-scoped
   throttle (shared across kinds);
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
| `event-extract.js` | pure: `EVENT_KINDS` / `KNOWN_EVENTS` (the one kind registry — manifest `events[]`, watch store, admin checkboxes and activity rows agree with it), `EVENT_ID_RE`, `describeEvent`; the extractors `extractStatusChangeEvents` / `extractIssueCreatedEvents` / `extractFieldChangeEvents` (`FIELD_CHANGED_DENY`) / `extractCommentEvents` (`adfToText`, `COMMENT_BODY_MAX`); the `origin` resolvers (`resolveIssueOrigin` / `resolveFieldOrigin` / `resolveCommentOrigin` + `AGENT_COMMENT_MARKER`); `resolveJiraApiBase`, `isChangelogTruncated` / `isCommentListTruncated`, `matchesStatusFilter(s)`, `computeQueryWindowMinutes` (catch-up widening, capped 24h) |
| `jira-client.js` | Jira REST v3 surface (Basic auth); pure builders + thin `fetch` adapters; `JIRA_API_BASE` test seam; `searchProjectIssues` (poll — `issuetype`, `created`, `reporter`, `priority`, `comment`), `fetchRecentComments` (comment backfill), `listProjectIssues` / `getIssue` / `listProjects` (CLI + UI reads), `searchIssues` (agent arbitrary-JQL read, shaped like `listProjectIssues`, `--limit` clamped to `MAX_PAGES × PAGE_SIZE`), `listProjectStatuses` (CLI project-wide workflow statuses, grouped by issue type); a per-site field catalog (`/rest/api/3/field`, cached) resolves custom-field names → ids for both the Epic Link parent link and agent-requested `customFields` reads (`show`/`search`/`list`, admin allow-list ∪ per-request `--fields`); `setCustomField` (allow-listed custom-field write, #2417 — returns the resolved `fieldId`), `createEpicWithStories` (create one Epic + N child Stories in one project, #2424 — allow-list-gated custom fields, Story→Epic via native `parent` or Epic Link; `onCreated(key)` fires per created issue) |
| `watch-store.js` | per-scope watch config (`{ projectKey, statusFilters?: string[], events: string[] }`, legacy `statusFilter` migrated on read, absent `events` → `["status_changed"]`) + poll cursor on `AEE_PLUGIN_STATE_DIR`, atomic writes |
| `watch-health.js` | pure: the cursor `recentErrors` ring (`recordPollError` / `clearPollFailure`) + the 3-state `deriveWatchHealth` (Watching / Degraded / Failing) + `summariseWatchHealth` roll-up, surfaced on `/watches` |
| `inbox-store.js` | per-scope queue of delivered-but-unconsumed events; TTL + `quota.maxObjects` ring — **this is what the manifest quota counts**; drained by event id only (`consumeIds`), never team-wide |
| `activity-store.js` | per-scope retained event log ("what did the poller see, and what did it do"); own 14-day retention + row cap, **not** the manifest quota; a row keeps the kind and that kind's fields (a comment body cut to 300 chars) |
| `own-writes-store.js` | per-scope registry of the broker's OWN Jira writes (created issue keys, comment ids, field writes by issue+field with a stamp list, description writes); 7-day TTL, reaped on the poll sweep, removed on teardown — the source of `origin` |
| `poller.js` | the poll loop; transport-agnostic (`deliver()` callback); records activity rows + folds poll errors into the cursor |
| `viewer-headers.js` | §4.8 signed-viewer verify (byte-identical copy) + the `/admin` → team-admin role gate |
| `broker-policy.js` | write authorisation (D3): `authorizeWrite` → SDK `authorizeAction` against the manifest `policy`; `requiresApproval` wired-but-empty |
| `ui/` | the served `/` route (Board tab: issues / watch-health cards / inbox; Activity tab: the retained log, kind + issue-type filters) + `/admin` route (watch config with per-project status chips and per-project event-kind checkboxes from `eventKinds`, team-admin). Dependency-free vanilla JS, `--eb-*` tokens, follows the console theme |
| `server.js` | wiring: `/healthz`, `/internal/{teardown-scope,scope-credentials}`, `/cli/*` (`whoami`/`inbox` (peek / `?consume=<id,…>`)/`projects`/`statuses` (project-wide workflow statuses)/`list`/`search` (arbitrary JQL)/`show` (incl. `availableTransitions`)/`attachment` (content by id) + `comment`/`transition`/`update`/`set-field` (allow-listed custom-field write)/`attachment/add` (upload one file per call) POST), `/ui/*` (incl. `/ui/api/{watches,activity,admin/watch,admin/retry}`) |


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
projects. Two optional credential values are admin allow-lists of custom fields
by their human name: `readable-custom-fields` (surfaced by default on
`show`/`search`/`list`) and `writable-custom-fields` (settable via `set-field` —
empty means every custom field is writable; a non-empty list restricts writes to
only the named fields, refusing any other).

## Delivery — the `plugin-event` wake

On a fresh matching event the broker mints a `jira.<scopeId>.<sig>` scope
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

`aee-jira comment` / `transition` / `update` / `set-field` / `attachment add` /
`create-epic` / `sprint create` / `sprint bulk-create` POST through the broker. `set-field` sets one custom field (#2417): the broker
gates it three ways — (1) if the team's `writable-custom-fields` allow-list is
non-empty, the field's name must be on it, else 403 (empty = every field
writable); (2) the
name is resolved to its per-site id from the cached `/rest/api/3/field` catalog
(the same one the #2415/#2416 reads use), a miss is a 400; (3) the value is shaped
per the field's schema type (`shapeFieldWriteValue` — a Team/select/user field is
not a plain string), or sent verbatim from `--value-json`. It reads the current
value first and skips the `PUT` when it already matches (idempotent, `changed:
false`), and — being a write — is never retried on a transport failure.
`attachment add` sends ONE file per request as `{ issue, filename,
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

`create-epic` (#2424) is the plugin's first CREATE: `{ project, epic, stories[],
issueTypes? }` creates one Epic and N child Stories (each linked to it) in one
project. Jira has no create-transaction, so the guards run up front — shape
validation, the `writable-custom-fields` allow-list over EVERY custom field named
(the same #2417/#2449 gate that `set-field` uses — empty list = all writable, a
non-empty list restricts; the Epic-link field the broker sets is structural and
exempt), then name→id + schema resolution from the cached catalog.
The Epic is created first (its key links the Stories), then each Story; a per-Story
failure after the Epic exists is reported per-Story, not fatal, so the caller gets
the Epic key + a success/failure map. A Story's `status` is applied as a follow-up
`transition` (Jira creates in the workflow's initial status). Story→Epic linking
uses the native `parent` (team-managed) or the Epic Link custom field
(company-managed), mirroring the #2415 read side. Every create is a write, never
retried on a transport failure (a retry would duplicate the issue).

`sprint create` / `sprint bulk-create` (#2450) are the plugin's first touch of
Jira's **Agile** API (`/rest/agile/1.0`, not `/rest/api/3`): board & sprint
management. A board is resolved by its human name (`resolveBoardByName` — an exact
case-insensitive match wins, a single substring match is accepted, several are an
actionable error — mirroring the field name→id resolution). `sprint create` POSTs
one future sprint (name + start/end + `originBoardId`). `sprint bulk-create` reads
the board's sprints (`sprint list` also exposes this as a plain read — no policy,
just the credential), computes a whole run up front from a cadence + a naming
template + a target end date (the PURE `planSprints` — the month/`weekOfMonth`
naming keys off each sprint's start Monday, so the "Monday decides the label even
when the week crosses months" rule falls out, and the run is capped at 104
sprints), continuing by default from the day after the board's latest existing
sprint (an explicit `--start` overrides, and is required for a board with no dated
sprint). Every sprint is created as a Jira *future* sprint (a plain create yields
one; a Scrum board has only one active sprint), each create is a write never
retried on a transport failure, and a per-sprint failure is reported (not fatal —
the dates are precomputed, not chained on Jira's responses), like `create-epic`.

Before the credential
is touched, `broker-policy.authorizeWrite` runs the manifest's `policy` rule
through the SDK's `authorizeAction`. jira is `scopes: ["team"]`, so every caller
resolves to `kind: 'team'` and every rule passes — which is D3's intent (moving a
ticket is routine and reversible; an approval pen would stall unattended flows).
The value of the gate: the enforcement path exists, so a future tightening (or a
`requiresApproval` entry for a destructive op) is a manifest edit. `transition`
names the **target** status; the broker resolves the Jira transition id and 409s
with the available options if none leads there from the issue's current status.
Every write is audited, and each comment carries a *"Posted by an agent on
team …"* attribution paragraph (`AGENT_COMMENT_MARKER`). Before answering the
CLI, `comment` / `create-epic` / `set-field` (when changed) / `attachment add`
/ `update` record the write in `own-writes-store.js`, so the poller stamps the
echo `origin: agent` — a trigger filtered `origin = human` never wakes an agent
on its own write. `transition` is not recorded (a status change has no
`origin`).

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
