# Jira status-change integration (poller-based)

## Context

The goal: let agents in this stack react to Jira issue status changes — e.g. wake an agent when an issue moves to "Ready for Dev". This stack (`e-vgh-claw`) currently only integrates with an external issue tracker via GitHub, through `orchestrator/github-poller.js` polling the GitHub Events API and fanning out into per-agent `pending-triggers.json` queues consumed by `github-event` triggers.

Two paths were considered:
- **Native Jira webhooks** (Jira Cloud Automation → "send web request" → the existing generic `http` trigger type). Rejected for now: this podman stack has no public ingress, and Jira Cloud can't reach `localhost` — the same reason GitHub uses a poller here instead of webhooks.
- **A new `jira-poller.js` mirroring `github-poller.js`.** Chosen — works today with zero infra changes, and reuses this project's existing trigger/credential/pending-queue plumbing end to end.

A related project (`insurance-agent-garage`) has a Jira REST client (`python/agents/jira_client.py`, Basic Auth via email + API token, hits `/rest/api/3/search`) but does inbound webhooks, not polling — useful only as an auth/endpoint reference, not for the dedup/cursor design.

This plan was validated against the actual current source (not just docs) — file/function names below were spot-checked directly (`grep`/`Read`), not taken on faith from documentation.

## Key design decision: no Jira "Events API," so what gets polled?

Unlike GitHub, Jira Cloud has no discrete immutable events feed. The mechanism:

1. Per tracked project, run a JQL search `project = "<KEY>" AND updated >= -Nm ORDER BY updated ASC` against `GET {siteBase}/rest/api/3/search/jql` with `expand=changelog`.
2. Each returned issue's `changelog.histories[]` has a stable `id`, a `created` timestamp, and `items[]` (`{field, fromString, toString}`). Filter `items` where `field === 'status'`.
3. Each match becomes a candidate event `{ id: "<issueKey>:<historyId>", issueKey, created, author, fromStatus, toStatus, summary, issueUrl }`. The composite id plays exactly the role GitHub's `event.id` plays.
4. Feed straight into the **existing, unmodified** `selectFreshEvents(events, seenArr, seenMax)` from `github-poller.js` for seen-id dedup — no adapter needed, the shapes line up by design.
5. **Changelog truncation guard**: Atlassian truncates `changelog.histories` on issues with heavy history. If `changelog.total > changelog.histories.length`, fall back to the paginated `GET /rest/api/3/issue/{key}/changelog` for just that issue. Rare, bounded to the issues that actually need it.
6. The window is *not* the dedup mechanism (same philosophy as the GH poller's seen-id set vs. a timestamp watermark) — it's just a generous overlapping fetch range; freshness is decided purely by seen-id membership.

## Project-key scoping (differs from GitHub's design)

A Jira project key (e.g. `ENG`) is not globally unique the way `owner/repo` is — the same key could exist on two different Jira sites bound into one deployment. So poll-plan building must **not** build one global `projectKey → credential` map (GitHub's `repoToToken` approach). Instead, resolve each subscribing agent's `t.projectKey` against **its own environment's** `env.jiraProjects[]` binding, keyed internally as `${siteUrl}::${projectKey}`. This makes same-named projects on different sites unambiguous.

## Implementation

### 1. Jira credential store (mirrors the GitHub-token pattern in `admin-console/api/api.js`)

- Storage: `JIRA_TOKENS_DIR = ENVIRONMENTS_DIR/_jira-tokens`, `JIRA_TOKENS_INDEX`, same `/^[a-z0-9-]+$/` id regex as `GH_TOKEN_ID_RE` (api.js ~L98-146). Raw API token as its own file, mode `0600`.
- Metadata: `{ id, name, teamId, assignedTeamIds, siteUrl, email, preview, fingerprint, createdAt }`. `siteUrl`/`email` live on the credential (not env/trigger) because credentials are global and a deployment can span multiple Jira sites — same philosophy as this project's existing SSH-key/PAT and MCP-credential split.
- CRUD: `GET/POST/PATCH/DELETE /api/jira-tokens`, reusing `normalizeCredential`, `visibleCredential`, `applyCredentialPatch`, `canCreateCredential` verbatim (all already credential-shape-agnostic, per `admin-console/api/scope.js`). `DELETE` blocked via a `jiraTokenInUse()` mirroring `githubTokenInUse()` (api.js ~L833).
- Optional nice-to-have: `POST /api/jira/probe` doing one `GET /rest/api/3/myself` to validate credentials before save (mirrors the existing GitHub probe endpoint).
- UI: new `admin-console/src/pages/JiraTokens.jsx`, a straight adaptation of `GithubTokens.jsx` with `siteUrl`/`email` fields added to the create form. Route + nav entry alongside the existing GitHub Tokens page.

### 2. Environment schema: `env.jiraProjects`

Add `env.jiraProjects: [{ projectKey, credentialId }]` — deliberately the same `{id, credentialId}` shape as `env.mcpServers`, not the URL-derived `repositories[]` shape, since a project key is an opaque identifier that only makes sense paired explicitly with a credential (it can't be parsed out of a clonable URL the way a repo can).

- Validation on env create/update (parallel to the existing `githubTokenId` checks, api.js ~L8369-8375 / ~L8413-8418): every entry needs a non-empty `projectKey` and a `credentialId` that resolves against `listJiraTokens()`.
- UI: `WorkingEnvironments.jsx` gets a repeatable `{projectKey, credential <select>}` row list below the existing GitHub-token picker (~L440-470), structurally simpler than `RepositoryCard`.

### 3. `orchestrator/jira-poller.js` (new)

- Extract reusable pure primitives from `github-poller.js` — confirmed present and already exported (`selectFreshEvents`, `planBurstHandoffs`, `passesHorizon`, `effectiveHorizon`, `SEEN_MAX`, `BURST_CAP`, throttle constants; see `module.exports` at github-poller.js:1097). Minimal-diff option: `require('./github-poller')` directly. Cleaner option: pull these into a new `orchestrator/event-poller-shared.js` used by both pollers — pure refactor, no behavior change. **Recommended: the cleaner option**, since we're about to have two consumers.
- `effectiveHorizon(trigger, triggersMtime)` is already type-agnostic (just reads `activatedAt || createdAt || mtime`) — reused with zero changes. `backfillHorizonStamps` is GH-specific legacy-backfill and needs no Jira counterpart (every `jira-event` trigger is new, always stamped at creation).
- Poll plan: walk agents (not a global repo map, see scoping decision above) → for each `enabled` agent with a `jira-event` trigger whose `projectKey` resolves in that agent's own `env.jiraProjects[]`, bucket by `${siteUrl}::${projectKey}`, first-write-wins on credential per bucket (same posture as `repoToToken`).
- State file `/workspace/jira-poller/state.json`, keyed by `${siteUrl}::${projectKey}`, shape `{ seen: [...], lastPolledAt, consecutiveFailures?, skipUntil? }` (no `etag` — Jira search has no conditional-GET).
- Throttle: reuse `_checkAndIncThrottle`'s logic (same 5/hour/window shape), own state file `/workspace/jira-poller/throttle-state.json` (kept separate from GitHub's to avoid cross-poller coupling). `conversationKey = issue:<issueKey>`.
- Burst-cap digest: **build it** (`kind: 'jira-digest'`, reusing `planBurstHandoffs` unmodified) — bulk sprint transitions are a very plausible burst source, arguably more so than GitHub's mass-relabeling case.
- `statusFilter` field: exact-match gate on `event.toStatus` (mirrors `labelFilter`'s exact-match semantics), applied before enqueue.
- Auth: HTTP Basic (`email:apiToken`), matching the `insurance-agent-garage` reference client's convention.
- Site-base resolution: if `siteUrl` starts with `http(s)://`, use as-is (supports custom domains and test fixtures with no extra env-var plumbing needed); otherwise treat as a bare subdomain and build `https://<siteUrl>.atlassian.net`.
- Custom `jql` override on a trigger: add the field to the schema now (unused in v1) but defer actual support — a free-form JQL trigger can't safely share a per-project poll bucket. Flag as a v1.1 follow-up.
- Startup wiring in `orchestrator.js`, parallel to the existing `GitHubPoller` instantiation (~L10521-10540): `new JiraPoller({ loadEnvironment, listEnvironmentIds, loadJiraCredential, enqueuePending, triggersPath }).start()`.
- Poll interval default: `AEE_JIRA_POLL_INTERVAL_MS` = 60s (slower than GitHub's 30s — Jira Cloud search has its own indexing lag, no benefit to polling faster). `AEE_JIRA_POLL_WINDOW_MINUTES` overrides the JQL window (default derived from interval, min 5).

### 4. New `jira-event` trigger type

Fields: `projectKey` (required, must match the agent's env `jiraProjects[]`), `events` (defaults to `['status_changed']` — v1 only implements this one key, field kept for forward-compat), `statusFilter` (optional exact-match), `jql` (optional, reserved/unused in v1).

- `TriggersPanel.jsx`: add `'jira-event'` to `knownTypes` (~L509); a project `<select>` reusing the exact fetch pattern already used for the repo picker (agent → `environmentId` → env → now also `env.jiraProjects`, no new endpoint needed); submit-validation branch parallel to the `github-event` one (~L610-646).
- Admin-console trigger CRUD stamping (api.js ~L2933-2953, ~L2955-2989): broaden the `type === 'github-event'` guards to include `'jira-event'` so `createdAt`/`activatedAt` get stamped/refreshed identically.
- Orchestrator's `PUT /internal/agents/:id/triggers` needs no change — validation there is already type-agnostic.
- Other UI surfaces with a `'github-event'` literal needing a parallel one-line `'jira-event'` case: type-icon map (`process/RoutingSection.jsx`), summary builders (`trigger-summary.js`, `process/input-rows.js`), edge derivation (`process/EdgeDialogs.jsx`, `process/edit-adapters.js`), session correlation-id parsing (`github-event-session.js`/`SessionsPanel.jsx` needs a `jira:` prefix variant alongside `gh:`). Each is a small, mechanical addition once the pattern lands in `TriggersPanel.jsx` — no bespoke design needed per file. A dedicated `JiraEventLog.jsx` transparency page (mirroring `GithubEventLog.jsx`) is optional and deferred — it's an independent observability add-on, not required to ship the poller.

### 5. Python runtime (`agent-image/scripts/agent-entrypoint.py`)

- Pending-entry shape: `{triggerId, jira: {event, eventId, project, issueKey, issueUrl, summary, fromStatus, toStatus, actor, createdAt}}` — field-parallel to the existing `{triggerId, github: {...}}`.
- `_process_pending` (~L3443-3545): add a `kind == "jira-digest"` branch calling a new `_execute_jira_digest` (mirrors `_execute_github_digest` at ~L3644-3705, same "plain DM, no Claude call, capped list + N more" shape). Broaden the ordinary-fire type filter to include `"jira-event"`.
- `_execute_inner` correlation id (~L3897-3931): add a `jira_event_id` branch parallel to `gh_event_id`, producing `trigger:<tid>:jira:<eventId>`; append `<external-event source="jira">{...}</external-event>` to the prompt, mirroring the `source="github"` case.
- `_post_trigger_notice` (~L3740-3786): add a `jira-event` branch rendering a one-liner (`Issue <key>: <summary> — <fromStatus> → <toStatus>`), mirroring the GitHub branch; small `_jira_event_detail()` helper parallel to `_github_event_detail()`.

### 6. Config & docs

- Env vars: `AEE_JIRA_POLL_INTERVAL_MS` (default 60000), `AEE_JIRA_POLL_WINDOW_MINUTES` (default derived, min 5). No API-base override needed — `siteUrl` already travels per-credential, which is actually simpler than GitHub's `GITHUB_API_BASE` global override.
- `CLAUDE.md`: add a **"Jira poller (`jira-event` triggers)"** subsection right after the existing GitHub poller section, same structure (why polling, cursor/dedup model — explicitly note reuse of `selectFreshEvents` — fetch mechanism + truncation fallback, throttle/digest reuse). Add a `jira-event` row to the trigger-type table and a `jira-poller.js` row to Key Files.
- Testing: unit-test the pure pieces first (changelog→event flattening, `statusFilter` gating, per-agent project/credential resolution) exactly like `github-poller.js`'s existing unit tests. An e2e fake-Jira fixture (mirroring an existing `fake-github`-style fixture, if present) implementing `/rest/api/3/search/jql` + `/rest/api/3/issue/:key/changelog` is a reasonable fast-follow for full end-to-end coverage, not a blocker for the initial poller landing.

## v1 scope boundary

`jira-event` ships as a **wake source only** — it fires an agent's trigger prompt with the Jira event payload, exactly like a raw `github-event` trigger with no `labelFilter`. It is deliberately **not** a full flow participant in this v1, unlike `github-event`'s deep integration into the Process Canvas:

- **No `claim` label swap.** GitHub's `ready` → `ready:wip` → `ready:completed` mechanical claim rotation (§ Autonomous Agent Triggers in `CLAUDE.md`) has no Jira analogue — there is nothing that marks a Jira issue "picked up" the way a claim label does on GitHub.
- **No channel/graph/human-touchpoint wiring.** `jira-event` triggers don't participate in the Process Canvas's declarative ports (`channels`, `dataFlow`, `humans[]`); a Jira-driven agent shows up on the flow graph the same way a raw, `labelFilter`-less `github-event` listener does (`external: true`, no derived edge) — never as a first-class producer/consumer node.
- **No flow-anomaly-detector integration.** The four anomaly classes (`wake-not-claimed`, `claim-stalled`, `output-missing`, `gate-idle`) read GitHub label/timeline state; they have no Jira-side signal to read and never fire for a Jira-only hand-off.
- **No event-transparency log.** The GitHub Event Log (`orchestrator/github-event-log.js`, `/github-events`) answers "what did the poller see and what happened to it" for GitHub; there is no Jira equivalent yet. A dedicated `JiraEventLog.jsx` (mirroring `GithubEventLog.jsx`) is noted above as an independent, deferred add-on — not required to ship the poller, and not part of this v1.
- **`events` field kept for forward-compat, not extensibility yet.** The trigger schema carries `events` (defaults to `['status_changed']`) and `jql` (reserved, unused) so a v1.1 can grow additional Jira event shapes or free-form JQL without a schema migration — but v1 implements exactly the one status-change path described above.

This is a deliberate v1 boundary, not an oversight: the goal was parity with GitHub's *wake* mechanism (poll → dedup → throttle → burst-digest → fan-out), not parity with its *flow-orchestration* surface. Extending `jira-event` into a full flow participant (claim-equivalent, graph wiring, anomaly detection, transparency log) is future work, scoped separately if/when a concrete need for it shows up.

## Verification

1. Unit tests for `orchestrator/jira-poller.js`'s pure functions (event flattening from changelog histories, `statusFilter` gate, per-agent poll-plan resolution) — run via the existing test runner (`npm test` in `orchestrator/`, matching how `github-poller.js`'s tests run).
2. Manual smoke test: create a Jira credential + env `jiraProjects` binding + a `jira-event` trigger against a real (or sandbox) Jira Cloud project; transition an issue's status; confirm the poller's next tick (or a forced tick) enqueues a `pending-triggers.json` entry and the agent posts a DM referencing the transition.
3. Verify dedup: transition the same issue twice within one poll window before the tick runs; confirm only distinct `changelog.history.id`s produce events (no duplicate DM).
4. Verify burst digest: bulk-transition several issues in the same project within one poll tick (above `BURST_CAP`); confirm a single `jira-digest` DM lands instead of one per issue.
5. Verify scoping: bind the same `projectKey` on two environments pointing at two different Jira sites/credentials; confirm each agent only ever polls its own environment's site (no cross-site leakage).
