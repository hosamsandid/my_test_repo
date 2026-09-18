# Jira plugin — operator & project guide

> Replaces `docs/jira-integration-concept.md` (the reverted PR #1539). The
> design rationale and the phase history are in `docs/jira-plugin-plan.md`; this
> is the how-to.

The **Jira** plugin wakes an agent when a Jira Cloud issue changes status, and
lets that agent read and update the issue. It is an installable, uninstallable
platform plugin (`plugins/jira/`) — removing it leaves the platform
byte-identical.

- **Not** Jira Server / Data Center — Cloud only.
- **Not** a two-way sync — the plugin reacts to Jira and writes to Jira on
  request; it does not mirror state.
- **Podman only.** On Kubernetes the agent→broker network path is not
  established, so the `aee-jira` CLI would exit 3 even though wakes still fire —
  `platforms: ["podman"]` gates it off there deliberately.

---

## How it works

```
Jira Cloud                          the broker sidecar (aee-plugin-jira)
  │  a JQL search every ~60s:         │
  │  project = "KAN" AND updated       │  per watched project:
  │      >= -Nm ORDER BY updated ASC   │   • flatten each issue's changelog into
  │  expand=changelog                  │     <issueKey>:<historyId> status events
  │◀──────────────────────────────────│   • gate by the watch's status set
  │                                   │   • dedup against a per-site seen-id cursor
  │                                   │   • collapse a burst into one digest
  │                                   │
  │        POST /internal/plugin-event │──▶ orchestrator
  │        Bearer <jira scope token>   │      verifies the token → {pluginId, scopeId}
  │                                   │      resolves scopeId → the team
  │                                   │      enqueues into every GRANTED agent whose
  │                                   │      `plugin-event` trigger matches
  │                                   │              │
  │                                   │              ▼
  │                                   │        the agent runs its OWN wake
  │                                   │        instruction; the Jira payload
  │                                   │        arrives as untrusted context in
  │                                   │        an <external-event source="plugin:jira">
```

The credential (`{site-url, email, api-token}`) lives **only** in the broker
sidecar's memory, pushed there per-team by the orchestrator. It never reaches
your browser or an agent container.

---

## Setup (operator)

### 1. Build + install

```bash
make plugin-images     # builds localhost/aee-plugin-jira:latest
make seed-plugins      # lays plugins/jira/ into the pool
```

Then **Administration → Plugins → Jira → Install** (System Admin). Install starts
the broker sidecar and grants the plugin to nobody.

### 2. Grant it to a team

On the same page, the Jira card's team-assign control — or a per-agent grant on
Agent Chat → **Settings** → plugins. The grant is what seeds `aee-jira` into the
agent workspace and makes the broker hold that team's credential.

### 3. Set the team's Jira credential (Team Admin)

The **Credentials** section on the Jira card (`/plugins`): three fields per
granted team.

| Field | |
|---|---|
| `site-url` | a bare subdomain (`acme`) or a full origin (`https://acme.atlassian.net`) |
| `email` | the Atlassian account e-mail — the Basic-Auth username for the token |
| `api-token` | a Jira API token — **use a classic (unscoped) token**: id.atlassian.com/manage-profile/security/api-tokens → *Create API token*, **not** *Create API token with scopes*. A scoped token missing `read:jira-work` sees zero projects. |

The account whose token this is must be able to see the projects you want to
watch — the plugin acts with exactly that person's Jira permissions. The entry
records who set it and when.

Values are stored `0600` server-side and never read back — you see a preview and
the set-by/-at, nothing more. Changing them takes effect on the next reconcile,
no restart.

### 4. Configure which projects to watch

The Jira plugin's **Watch config** page (`/admin`, team-admin — reached from the
"Watch config" link on the plugin's main page): a list of
`{ projectKey, statusFilters? }` rows.

- `projectKey` — e.g. `KAN`.
- `statusFilters` — a **set** of target statuses (chips). An empty set fires on
  **any** status change; add one or more (exact match, case-sensitive — copy
  each from Jira) to fire only on transitions **into any of them**, e.g.
  `Ready for Dev` + `In Review`. A config written before multi-status support
  (a singular `statusFilter` string) is migrated to a one-element set on read.

### 5. Give the agents a `plugin-event` trigger

A watch tells the *broker* what to poll. Which *agents* a change wakes is a
per-agent trigger: Agent Chat → **Triggers** → add → type **Plugin event**:

| Field | |
|---|---|
| Plugin | `jira` (picked from the installed plugins) |
| Which event | *Any event* or `status_changed` (the only event the plugin sends). Offered as a select from the manifest's `events[]`. A status name is **not** an event — the form flags one as *not an event this plugin declares*. |
| Only when… | **which status wakes this agent** — condition rows `field = value`, e.g. `toStatus = Ready for Dev`; the field picker lists the payload keys below with an example. No conditions = every watched transition wakes this agent. Stored as `payloadFilter: { toStatus: "Ready for Dev" }`. |
| Wake instruction | what the agent should do — e.g. *"Take the event id(s) from the event payload, run `aee-jira inbox --consume <id>…`, read the issue with `aee-jira show`, refine the description and write it back with `aee-jira update`, then move it on with `aee-jira transition`."* |

The **Only when…** condition (the trigger's `payloadFilter`) is what routes a flow: give the Business Analyst
`toStatus=Ready for Refinement`, the Developer `toStatus=Ready for Dev`, the
Reviewer `toStatus=In Review`. Every key must equal the event's field **exactly**
(case-sensitive — copy the status name verbatim from Jira). Without a filter
*every* granted agent with a `plugin-event` trigger wakes on *every* watched
transition — including the one an agent just made itself.

The fields a `status_changed` payload carries, all plain strings:

| Key | |
|---|---|
| `toStatus` / `fromStatus` | the status names of the transition |
| `projectKey` | e.g. `KAN` |
| `issueKey` | e.g. `KAN-10` |
| `issueType` | Story / Bug / Task / … |
| `author` | who moved it (display name) |
| `id` | `<issueKey>:<changelogId>` — the dedup id; not useful for routing, but it is the handle `aee-jira inbox --consume <id>` takes |
| `created` | ISO timestamp of the transition; rarely useful for routing (an exact-match filter on a timestamp never matches twice) |
| `summary` | the issue title at the time of the transition; rarely useful for routing (exact-match on a title is brittle — it changes) |
| `issueUrl` | the Jira browse link; not useful for routing |

A burst digest matches when **any** of its folded events matches, and the woken
agent receives the digest **projected to its own filter**: only the folded
events its `payloadFilter` matches, `count` recomputed, the summary suffixed
*"— 3 of 40 match this trigger"*. Two things produce a digest: more than three
transitions on **one issue** in a single poll, and — the bulk case — more than
three watched transitions in **one project** in a single poll (sprint planning
moving 40 tickets to *Ready for Dev* is **one** wake, not 40). A digest inlines
the first 20 transitions plus `count`; when cut it carries `truncated: true`,
and `aee-jira inbox` holds every one of them. The projection is generic
platform behaviour (`orchestrator/plugin-event.js` `projectPayloadForTrigger`),
not Jira-specific.

The wake instruction is the agent's own prompt; the Jira payload rides in as
context, never as an instruction.

---

## What an agent can do — the `aee-jira` CLI

Seeded into a granted agent's workspace. All Jira access is server-side in the
broker; the agent never sees the token.

| Command | |
|---|---|
| `aee-jira inbox [--consume <id>…]` | the team's queued status changes (peek). `--consume` drains **exactly the ids named** — the ids from the agent's own wake (`payload.id`, or `payload.events[].id` in a digest). The inbox is per team and shared by every agent on it; a bare `--consume` is refused (CLI exit 2 / broker 400 `consume-requires-ids`), so no agent can drain a teammate's events. Unclaimed entries age out on the 7-day TTL |
| `aee-jira projects` | the Jira projects in the team's scope |
| `aee-jira list --project KAN [--status "Ready for Dev"]` | a project's issues, most-recently-updated first |
| `aee-jira show KAN-6` | one issue (summary, status, assignee, URL) |
| `aee-jira comment KAN-6 --body "…"` | add a comment (attributed to *"an agent on team …"*) |
| `aee-jira transition KAN-6 --to "In Progress"` | move the issue to that **target status** — the broker resolves the Jira transition and, if none leads there from the issue's current status, reports the available options |
| `aee-jira update KAN-6 --description "…"` | **replace** the issue description (plain text; blank lines become paragraphs; an italic *rewritten by an agent…* line is appended). The previous text stays in Jira's issue history |

`--json` on every subcommand; exit codes 0 ok / 1 domain error / 2 usage / 3
broker unreachable.

A transition an agent makes is an ordinary status change: the poller sees it on
its next tick and wakes whichever teammate's trigger names that target status —
that is how a BA → Developer → Reviewer chain runs with no other wiring. The
per-issue throttle (5 transitions per hour per issue) still applies to the whole
chain.

**Writes are role-gated, not confirmation-gated** (D3). The broker checks the
manifest's `policy` before touching the credential, and every write is audited —
but moving a ticket is routine and reversible, so nothing stops for a human. A
genuinely destructive Jira operation (bulk transition, delete) would be added
behind the `requiresApproval` pen, which is wired but unused today.

---

## The console UI

**Jira** in the sidebar (once installed) → the plugin's `/` route (any team
member of a granted team), two tabs:

- **Board**
  - **Issues** — pick a project, optionally filter by status.
  - **Watching** — one card per watched project with a health pill
    (**Watching** / **Degraded** / **Failing**) and a roll-up badge
    (`1 watch failing`). Click a card to expand it: a healthy card shows the
    last poll and the cursor — which agents a transition wakes is decided per
    agent by its own `plugin-event` trigger (see §5), not shown on the card;
    a failing one opens the failure detail — the consecutive-failure count,
    the next retry time, a short log of the actual errors with timestamps,
    a **Retry now** button (team-admin), and a pointer to
    *Plugins → Jira → Credentials*.
  - **Inbox** — the status changes queued for this team's agents.
- **Activity** — the retained event log (see below).

The **Watch config** link (team-admin only) opens `/admin` — the
project + status-set rows from step 4.

**Help.** The plugin ships its own console help topic (`plugins/jira/help/jira.md`,
installed to `/workspace/plugins/jira/help/`): on Agent Chat and on the Plugins
pages the "?" Helper Chat can answer "how does a Jira status change wake my
agent", "which fields can I filter on", "why did my agent not wake" from it —
folded only on those pages, never into the platform's own corpus
(`docs/plugin-system-concept.md` §4.1, *help/*). The trigger form's own "?"
deep-links the *Plugin event — Which event vs. Only when* chapter of the Agent
Chat help.

---

## The event log

Two records, for two audiences:

- **Activity tab** (the plugin's `/` route) — the plugin's own retained log:
  every fresh status change the poller saw in a watched project and what it did
  with it — `woke agents` / `folded into digest` / `throttled` /
  `not a watched status` / `baseline`. Grouped by day, filterable by issue type
  and by *Watched* vs *All activity* (the latter also shows transitions the
  poller saw but did not act on). Kept **14 days**, independent of the agent
  inbox. This is the `JiraEventLog.jsx` #1539 deferred, at zero platform cost.
- **Platform GitHub Event Log** (`/github-events`) — every *wake* also writes one
  row there, tagged `source: internal-plugin`, event `plugin.event`. It has no
  repo, label or work item — those columns show `—` — but the row confirms the
  fan-out happened and to which agents.

---

## Limits

- **No claim-label analogue.** Nothing in Jira marks an issue "picked up" the way
  a GitHub `ready` → `ready:wip` swap does.
- **Not on the Process Canvas.** A Jira wake is not a flow edge; it does not
  appear as a producer/consumer node, and `channels` / `dataFlow` / `humans[]`
  are untouched.
- **No flow-anomaly integration.** The four anomaly classes read GitHub
  label/timeline state and have no Jira signal to read.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `aee-jira` exits 3 `not-granted` | the plugin isn't granted to this agent | grant it (Plugins page or agent Settings) |
| `aee-jira` exits 3 `broker-unreachable` | the sidecar isn't running, or you're on Kubernetes | `podman ps \| grep aee-plugin-jira`; on k8s the CLI is expected to fail (see platforms note) |
| a write / read returns `no-credential` | the team has no Jira credential set | Team Admin sets it on the Plugins page |
| broker log: `Jira rejected the credential (401)` | the e-mail and token aren't the same Atlassian identity, or the token was revoked | regenerate a **classic** token while signed in as the intended account |
| `projects` returns nothing but the account sees projects in a browser | a **scoped** API token missing `read:jira-work` | use a classic (unscoped) token |
| a transition "no transition to X" | X isn't reachable from the issue's current status, or the name doesn't match | the error lists the available transitions; use one of those target names |
| the poll log shows `fetch failed` once then recovers | a stale keep-alive socket in the long-running broker | expected — the client retries transport failures once |
| a fresh transition doesn't wake the agent | no status in the watch's `statusFilters` set exactly matches the Jira status name, or the agent has no `plugin-event` trigger, or the poll already baselined the change, or the trigger's payload filter names a status that is not the one the issue moved into | check the Activity tab (a `not a watched status` row means the set is wrong); copy the status name verbatim from Jira; add the trigger |
| a watch card shows **Failing** | consecutive poll failures — expand it for the error log | usually a bad or expired API token: a Team Admin re-sets it on the Plugins page, then hits **Retry now** |
| the agent says `aee-jira` is read-only / only knows `whoami` and `inbox` | its workspace holds a CLI copy from an older plugin version (the grant sync copies the file only when the grant changes) | since this version the copy is refreshed on every plugin reconcile — restart the orchestrator or `POST /internal/plugins/reconcile`; re-run `make seed-plugins` + reinstall first if `/workspace/plugins/jira/bin/aee-jira.py` is itself old |
| `aee-jira inbox --consume` fails with *consume takes the event ids you were woken for* | the wake instruction still uses the pre-2026-09 team-wide drain | change it to `aee-jira inbox --consume <id>…` with the ids from the event payload (`id` / `events[].id`); the agent's own trigger filter already decided which events it received |
| the wrong agent wakes, or an agent wakes on its own transition | the agents' `plugin-event` triggers carry no payload filter, so every watched transition wakes all of them | set `toStatus=<status>` on each agent's trigger (§5) |
| a trigger whose *Which event* is a status name (`Ready for Dev`) never fires | `eventFilter` is compared with the event **name** (`status_changed`), not with the payload; the status belongs in *Only when…* (`toStatus`) | blank *Which event*, add the condition `toStatus = Ready for Dev` — the form now offers both from the manifest and flags the mistake |

For a hands-on debug session the broker ships `spike.js` (run inside the
sidecar): `podman exec aee-plugin-jira node spike.js probe --project KAN
--window 120 --status "Ready for Dev"` replays the exact search + changelog
extraction against Jira and prints what would fire. See
`plugins/jira/broker/README.md`.
