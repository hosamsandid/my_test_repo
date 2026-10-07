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

Two credential tiers (#2562):

- **Service account** — the team credential (`{site-url, email, api-token}`),
  pushed per-team into the broker sidecar's memory. Used **only** by the poller
  and by automated runs (schedules, loops, GitHub/plugin events, hand-offs).
- **Personal** — each member's own `{email, api-token}` (the site stays the
  team's). Used for **every** `aee-jira` call made during a chat turn that
  member started, so reads see their Jira permissions and writes are authored
  by them. The orchestrator hands it to the broker **per call** and the broker
  does not keep it.

Neither ever reaches your browser or an agent container. See
[Whose Jira account is used](#whose-jira-account-is-used).

---

## Setup (operator)

### 1. Build + install

```bash
make plugin-images     # builds localhost/aee-plugin-jira:latest
make seed-plugins      # lays plugins/jira/ into the pool
```

Then **Administration → Plugins → Jira → Install** (System Admin). Install starts
the broker sidecar and grants the plugin to nobody.

**Upgrading an installed Jira plugin** (e.g. to get the event kinds). Do
**not** uninstall and reinstall — uninstall reaps every team's Jira credential.
Instead: `make plugin-images` + `make seed-plugins` as above, then copy
`plugin.json`, `bin/` and `help/` from `plugins/jira/` over the installed
copy at `/workspace/plugins/jira/` and restart the stack (`make restart`). The
registry re-validates the manifest on read, granted agents get the new
`aee-jira` on the next plugin reconcile, and watch configs, cursors and the
inbox survive on the plugin's state volume. Existing watches stay *status
changes only* until a Team Admin ticks another kind.

### 2. Grant it to a team

On the same page, the Jira card's team-assign control — or a per-agent grant on
Agent Chat → **Settings** → plugins. The grant is what seeds `aee-jira` into the
agent workspace and makes the broker hold that team's credential.

### 3. Set the team's Jira service account (Team Admin)

Set it in **Agent Chat → Settings → Plugins** on the team agent (the
**Plugin service accounts** section) — a Team Admin of the team owns this,
no System-Admin access needed. The same fields also appear per granted team in
the **Credentials** section of the Jira card on the System-Admin **Plugins**
registry page (`/plugins`); both write the same per-team credential. The e-mail
and token are the **service account** — used for automated runs and watching
projects only, never for a chat turn (see
[Whose Jira account is used](#whose-jira-account-is-used)).

| Field | |
|---|---|
| `site-url` | a bare subdomain (`acme`) or a full origin (`https://acme.atlassian.net`) |
| `email` | the Atlassian account e-mail — the Basic-Auth username for the token |
| `api-token` | a Jira API token — **use a classic (unscoped) token**: id.atlassian.com/manage-profile/security/api-tokens → *Create API token*, **not** *Create API token with scopes*. A scoped token missing `read:jira-work` sees zero projects. |
| `readable-custom-fields` *(optional)* | comma-separated custom field names surfaced **by default** on `show`/`search`/`list` (e.g. `Team, Sprint`). Leave blank to surface none by default. This is a default set, **not** a read gate: an explicit `--fields "X"` read is never restricted by this list — any field the account can see is readable on request. Names are resolved to their per-site ids from `/rest/api/3/field`. |
| `writable-custom-fields` *(optional)* | comma-separated custom field names agents may **set** via `aee-jira set-field` / `create-epic` / `add-stories` / `create-issue` / `add-subtasks` (e.g. `Team`). **Leave blank to allow writing any custom field** the account can see; fill it in only to *restrict* agents to a specific set — then a field not on the list is refused (403). Names are resolved to their per-site ids from `/rest/api/3/field`. |

The account whose token this is must be able to see the projects you want to
watch — the plugin acts with exactly that person's Jira permissions. The entry
records who set it and when.

Values are stored `0600` server-side. The `api-token` is write-only — you see a
preview and the set-by/-at, nothing more, and blank-on-save keeps the existing
one. The non-secret fields (`site-url`, `email`, `readable-custom-fields`,
`writable-custom-fields`) show their real, editable value so you can adjust them
without retyping. Changing any of them takes effect on the next reconcile, no
restart.

Every Save is followed by a check of the stored credential, and **Test
connection** runs the same check on demand (Team Admins of that team only): the
broker reads the service account's own profile once (`GET /rest/api/3/myself`)
and the form shows e.g. *Connected as Jira Bot* or *Token rejected (401) — check
the service-account e-mail and API token*. With only the site set it checks that
the site is reachable. The token never reaches the browser. **Clear** removes
every stored value for the team and asks for confirmation first (#2640).

### 3a. Every member adds a personal credential

Chat turns use the sender's own Jira account. Each member opens **Connections →
Plugin Tokens** (`/plugin-tokens`) and saves their Atlassian e-mail and a
classic API token. It is self-service only: nobody else — System Admins
included — can read or set it; the page shows set/unset, a preview and when it
was saved. Deleting a user account deletes their personal credentials.

### 4. Configure which projects to watch

The Jira plugin's **Watch config** page (`/admin`, team-admin — reached from the
"Watch config" link on the plugin's main page): a list of
`{ projectKey, statusFilters?, events }` rows.

- `projectKey` — e.g. `KAN`.
- `events` — which **kinds** of event the row forwards (checkboxes):
  *Status changes* (`status_changed`), *New issues* (`issue_created`),
  *Comments* (`comment_added`), *Other field changes* (`field_changed`). Default
  — and the migration for a row saved before kinds existed — is status changes
  only, so an upgrade never makes a watch noisier.
- `statusFilters` — a **set** of target statuses (chips). An empty set fires on
  **any** status change; add one or more (exact match, case-sensitive — copy
  each from Jira) to fire only on transitions **into any of them**, e.g.
  `Ready for Dev` + `In Review`. A config written before multi-status support
  (a singular `statusFilter` string) is migrated to a one-element set on read.
  The set gates status changes only — never another kind.

### 5. Give the agents a `plugin-event` trigger

A watch tells the *broker* what to poll. Which *agents* a change wakes is a
per-agent trigger: Agent Chat → **Triggers** → add → type **Plugin event**:

| Field | |
|---|---|
| Plugin | `jira` (picked from the installed plugins) |
| Which event | `status_changed`, `issue_created`, `comment_added`, `field_changed`, or *Any event*. Offered as a select from the manifest's `events[]`. Once a watch forwards more than one kind, set it on **every** trigger — *Any event* with no *Only when…* wakes on every kind. A status name is **not** an event — the form flags one as *not an event this plugin declares*. |
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

The fields an `issue_created` payload carries (plus `id` = `<issueKey>:created`,
`created`, `summary`, `issueUrl` as above; `author` = the reporter):

| Key | |
|---|---|
| `origin` | `human`, or `agent` when this team's agents created the issue (`aee-jira create-epic` / `add-stories` / `create-issue` / `add-subtasks`) — the broker records every issue it creates. Filter `origin = human` on a triage trigger so an agent's own tickets do not wake it |
| `issueType` / `projectKey` / `issueKey` | as above |
| `status` / `priority` | what the issue was created with |
| `reporter` | who created it (display name) — the Team Admin's account for an agent-created issue, which is why `origin` exists |

The fields a `field_changed` payload carries — one event per changed field,
id `<issueKey>:<changelogId>.<fieldId>` (one history can change several
fields):

| Key | |
|---|---|
| `field` | the field's display name as Jira reports it (`assignee`, `priority`, `labels`, `Sprint`, `Fix Version`, `Attachment`, …) |
| `fieldId` | the stable id (`assignee`, `fixVersions`, `customfield_10020`) — route custom fields on this; their display names vary per site |
| `from` / `to` | Jira's display strings, cut at 500 characters; absent side = `""` (an unassign has no `to`), never `null`. A trigger cannot filter on an empty value (`payloadFilter` ignores empty values), so catch a cleared field with a `field` filter and read `to` in the wake |
| `fieldType` | `jira` or `custom` |
| `origin` | `agent` when the change matches a write this team's agents made through the broker (`set-field`, `attachment add`, `link` / `unlink` — a link write stamps the `Link` change on both issues; `set-epic` — stamps the parent change (`Parent` / `IssueParentAssociation` / `Epic Link`) on the moved issue and `Epic Child` on the old and new Epic; `edit` — stamps each changed standard field: `summary`, `assignee`, `priority`, `labels`, `components`, `fixVersions`, `duedate`) on the same issue + field within ±2 minutes — or any field on an issue an agent transitioned or created in that window (`resolution`, transition-screen fields) — else `human` |

Never a `field_changed`: `status` (its own kind), `description` (an agent's
`aee-jira update` would wake it — a separate kind, not yet built) and `Rank`
(every board drag writes one). Several labels changed at once arrive as one
item, space-separated, as Jira logs them.

The fields a `comment_added` payload carries — id `<issueKey>:c<commentId>`:

| Key | |
|---|---|
| `origin` | `agent` when this team's agents posted it (`aee-jira comment` — the broker records every comment id it creates, and as a restart-safe fallback recognises the *"Posted by an agent on team …"* line every agent comment opens with), else `human` |
| `author` | the commenter's display name — the Team Admin's account for an agent's comment, which is why `origin` exists |
| `commentId` | Jira's comment id |
| `body` | the comment as plain text (Atlassian Document Format flattened; the agent provenance line dropped), cut at 2000 characters |
| `bodyTruncated` | `"true"` when `body` was cut — `aee-jira show <issueKey> --comment <commentId>` returns the full text |

**Put `origin = human` on every `comment_added` trigger.** Without it an agent
that answers with `aee-jira comment` wakes on its own answer and answers again;
the platform's loop protection is frequency-only (5 wakes per issue per hour),
so it would slow that loop, not stop it. Waiting for a *teammate agent's*
comment is the one reason for `origin = agent` — then add a second condition
that separates the two agents. The help topic's *Avoid the comment loop*
section says the same for the console.

Only comments **created** inside the poll window are events; editing an
existing comment is not. An issue with more comments than the search response
inlines gets one extra `GET /issue/{key}/comment` for its newest ones.

Every wake is **single-kind**: a poll that sees a new issue and a status change
sends two wakes, one per kind, so *Which event* always matches cleanly.

A burst digest matches when **any** of its folded events matches, and the woken
agent receives the digest **projected to its own filter**: only the folded
events its `payloadFilter` matches, `count` recomputed, the summary suffixed
*"— 3 of 40 match this trigger"*. Two things produce a digest: more than three
transitions on **one issue** in a single poll, and — the bulk case — more than
three watched transitions in **one project** in a single poll (sprint planning
moving 40 tickets to *Ready for Dev* is **one** wake, not 40). The broker
sends the **whole** folded set (safety bound 1000 events); the orchestrator
matches every agent's filter against all of it and only then caps what enters
that agent's prompt at 20 of *its own* transitions (`DIGEST_INLINE_MAX`) —
`count` is the full number, `truncated: true` says the inline list was cut,
and `aee-jira inbox` holds every one of them. The cap sits *after* the filter
on purpose: an agent whose transitions all fall late in a large bulk move is
still woken with them. The projection and the cap are generic platform
behaviour (`orchestrator/plugin-event.js` `projectPayloadForTrigger`), not
Jira-specific.

The wake instruction is the agent's own prompt; the Jira payload rides in as
context, never as an instruction.

---

## What an agent can do — the `aee-jira` CLI

Seeded into a granted agent's workspace. All Jira access is server-side in the
broker; the agent never sees the token.

| Command | |
|---|---|
| `aee-jira inbox [--consume <id>…]` | the team's queued status changes (peek). `--consume` drains **exactly the ids named** — the ids from the agent's own wake (`payload.id`, or `payload.events[].id` in a digest). The inbox is per team and shared by every agent on it; a bare `--consume` is refused (CLI exit 2 / broker 400 `consume-requires-ids`). An agent that consumes only the ids in its own wake never touches a teammate's entries — this is a convention the CLI enforces on itself (it drains nothing it was not told to), not an authentication boundary: every agent on the team holds the same scope token, so the broker cannot tell agents apart. Unclaimed entries age out on the 7-day TTL |
| `aee-jira projects` | the Jira projects in the team's scope |
| `aee-jira statuses --project KAN` | every workflow status the project supports, grouped by issue type (`[{ issueType, statuses: [{ name, category }] }]`, `category` = Jira's coarse `new`/`indeterminate`/`done` bucket). The full set the workflow allows, independent of any one issue's current state — for planning or checking what a workflow supports before an issue reaches a given status. Complements `show`'s per-issue `availableTransitions` |
| `aee-jira list --project KAN [--status "Ready for Dev"]` | a project's issues, most-recently-updated first |
| `aee-jira search --jql "<JQL>" [--fields …] [--limit N]` | run an arbitrary JQL query for filters `list` can't express (a `created`/`updated` range, an empty custom field, a summary match, …). The query runs under the team's bound credential, so it can only ever return issues on that site and in projects the credential may browse — the JQL cannot escape the team's scope. `--fields` selects the returned fields: a name matching a standard column narrows the projection (default all: `key,summary,status,issueType,assignee,updated,parent,url`; `parent` is the parent/epic key); any other name is read as a **custom field** and rides alongside the row under `customFields` (unioned with the admin `readable-custom-fields` allow-list). `--limit` caps results (default 100, max 2000). Read-only, shaped exactly like `list` |
| `aee-jira show KAN-6 [--fields "Team,Sprint"] [--comment <id>]` | one issue (summary, status, assignee, created/updated, parent/epic key, URL, `links` — each `{ id, type, relationship, otherIssue: { key, summary, status }, statement }` as seen from this issue, e.g. `KAN-6 is blocked by KAN-5`; `[]` when it has none, and a link whose other issue is deleted or invisible to the account is left out) — and, when the issue has any, its attachments (filename, id, MIME type, size, author). `parent` is the native parent (team-managed) or the resolved Epic Link (company-managed), so an agent can `show` it to traverse Story→Epic. It also carries `availableTransitions` (`[{ transition, toStatus }, …]`) — the moves reachable from the issue's current status, so an agent can pick a `transition --to` without guessing-then-parsing a failed attempt. `--fields` additionally reads **custom fields** by their Jira name (unioned with the admin `readable-custom-fields` set) under `customFields`; an unset field comes back as `null`, so an empty value is distinguishable from a set one. `--comment <id>` adds one comment in full under `comment` (`id`, `author`, `created`, `body` as plain text) — how an agent reads a `comment_added` wake whose `body` was cut (`bodyTruncated`) |
| `aee-jira comments KAN-10 [--limit N] [--offset N]` | **an issue's comments, newest first** — Jira's `GET /rest/api/3/issue/{key}/comment?orderBy=-created`, one page per call: `--limit` comments (default 20, 1–100) after skipping the newest `--offset` (default 0). Per comment: `{ id, author, created, updated, body, bodyTruncated, origin }` — `author` is the display name; `updated` differs from `created` for an edited comment; `body` is the same plain text a `comment_added` wake carries (ADF→text, the agent provenance line dropped) cut at the same length (2000 characters) with `bodyTruncated: true` — `show <key> --comment <id>` returns it in full; `origin` is resolved like a wake's (`agent` when the scope's own-writes registry holds the comment id or it opens with the provenance line, else `human`). Result: `{ issue, comments, count, total, offset, limit, hasMore, nextOffset?, note? }` — `hasMore: true` with `nextOffset` and a `note` naming the command for the next older page; an issue without comments is `comments: []` (200, not an error). Comments with a visibility restriction the credential does not meet are not in Jira's answer and so are simply not listed. An issue the credential cannot see is the standard *outside this team's Jira scope* refusal (404). A read: no write policy, same credential rules as `show`; the audit line records the issue, count and offset (`KAN-10:20@0`), never comment text. A plain `show` is unchanged and lists no comments |
| `aee-jira attachment get KAN-6 10312 [--out PATH]` | fetch one attachment's content by id (the id comes from `show`). A text file (`.txt`/`.md`/`.json`/…) prints inline; a binary file (image, PDF) is decoded and saved under `.agent-studio/jira-attachments/` (or `--out`). An id not on the issue — or one deleted since `show` listed it — is a clean domain error. Files over the fetch cap (default 10 MB, `JIRA_ATTACHMENT_MAX_BYTES`) are refused with a message, not truncated |
| `aee-jira attachment add KAN-6 <path> [<path>…]` | upload one or more local files as new attachments. Each path becomes a **separate** attachment (Jira never overwrites — a same-named upload is a new, additional file). Every path is checked to exist, be readable and be within the upload cap (default 10 MB, `JIRA_ATTACHMENT_UPLOAD_MAX_BYTES`) *before* any upload starts; when several files are given and one upload fails, the others still go through and the result reports per-file success/failure with each created id (`--json` for machine-readable). The bytes travel to the broker, which does the multipart upload server-side — the token never reaches the agent. A missing/foreign issue key, disabled attachments or an over-instance-limit file surface as clean domain errors |
| `aee-jira comment KAN-6 --body "…"` | add a comment (attributed to *"an agent on team …"*) |
| `aee-jira transition KAN-6 --to "In Progress"` | move the issue to that **target status** — the broker resolves the Jira transition and, if none leads there from the issue's current status, reports the available options |
| `aee-jira update KAN-6 --description "…"` | **replace** the issue description (plain text; blank lines become paragraphs; an italic *rewritten by an agent…* line is appended). The previous text stays in Jira's issue history |
| `aee-jira set-field KAN-6 --field "Team" --value "<v>"` | **set one custom field** by its Jira name. Any custom field is writable by default; if the team set a non-empty `writable-custom-fields` allow-list, only those fields are writable and any other is refused (403). The name→id and the value shape are resolved server-side per the field's schema type (a Team/select/user field is not a plain string). `--value` takes the value to set — for an id-bearing field like Team, pass the id you read via `show --fields "Team"` (reads return the id alongside the label); `--value-json '<json>'` sends a raw JSON value verbatim for an exotic shape. **Idempotent**: setting a field to the value it already holds makes no change and reports `changed: false`. The change is recorded in Jira's issue history (its attribution — no free-text field to stamp, like `transition`) |
| `aee-jira users "<name or e-mail>" [--project KAN \| --issue KAN-10] [--limit N]` | **look up Jira users → accountId** — the value every assignee takes (`edit --assignee`, `create-issue --assignee`, `"assignee"` in a `create-epic` / `add-stories` payload), since Jira identifies people by an opaque accountId, never by name or e-mail. The query is a name or e-mail fragment (Jira matches display name and e-mail; a full e-mail address finds that one person if the credential may see them). Without a scope it is Jira's `GET /rest/api/3/user/search`: every match, deactivated accounts included and marked `active: false`. With `--project` (or `--issue`, mutually exclusive) it is `GET /rest/api/3/user/assignable/search`: only people who can be assigned issues in that project (or that issue), inactive accounts left out; the project / issue is looked up first, and one the credential cannot see is the standard *outside this team's Jira scope* refusal (404) — never an empty result. Per match: `{ accountId, displayName, email, active, accountType }` — `email` only when Jira returns it to the calling credential (privacy settings hide it → `null`; never derived), `accountType` is Jira's own (`atlassian` a person, `app` a bot / integration, `customer` a service-desk customer). Capped at 50 (`--limit` lowers it, 1–50); one extra row is requested so `truncated: true` says there were more. `note` explains the result: *No user found matching "…"* for no match (a 200 with `users: []`, not an error), the cap, several people with the same display name (*tell them apart by e-mail or accountId, do not guess*), apps and deactivated accounts. A read: no write policy, same credential rules as other reads (the member's own token in a chat turn, the service account in automated runs). Nothing is cached; the audit line records only where it searched and the match count (`KAN:3`, `site:0`), never the query or the people found. Result: `{ query, assignableOnly, project?, issue?, users, count, truncated, note }` |
| `aee-jira link-types` | the site's issue link types (`[{ id, name, outward, inward }]`, e.g. `Blocks (blocks / is blocked by)`). Types are admin-configurable per site, so they are always read from Jira, never hard-coded |
| `aee-jira link KAN-1 blocks KAN-2` | **link two existing issues**, read as a sentence: the first key is the subject of the phrase. The type can be its name (`Blocks` → its outward phrase) or either phrase (`aee-jira link KAN-2 is blocked by KAN-1` records the same link); quoting the phrase is optional. Jira's own `inwardIssue`/`outwardIssue` wire fields are resolved in the broker — the agent never deals with them. Refused before any write: a self-link, an unknown type (the error lists every type), a phrase two types share (*name the type instead*), linking disabled on the site. An identical existing link is reported (`created: false`) instead of duplicated; for a symmetric type (`relates to`) either direction counts. A missing **Link Issues** permission or an issue the account cannot see is named as such. Result: `{ created, id, type, statement, issues }` |
| `aee-jira unlink 10001` / `aee-jira unlink KAN-1 blocks KAN-2` | **remove a link** by its id (from `show`'s `links`) or by the same sentence; a link that does not exist is a 404 and nothing changes |
| `aee-jira create-epic --project KAN --file plan.json` | **create one Epic and its child Stories in one operation** — turn one ask (the Epic) into its breakdown (N Stories underneath it, each linked to the Epic), in one project. The Epic + Stories are described by a JSON payload read from `--file` (or stdin when omitted / `-`): `{"epic": {"summary": "…", "description": "…"}, "stories": [{"summary": "…", "assignee": "<accountId>", "status": "In Progress", "fields": {"Team": "<id>", "Story point estimate": 5}}]}`. Only a `summary` is required (epic + each story). Optional per issue: `description`, `assignee` (an Atlassian accountId), `status` (applied as a **follow-up transition** — Jira creates an issue in the workflow's initial status), and `fields` (custom fields by their Jira name). Custom fields named in `fields` are writable by default (**the same gate as `set-field`**); if the team set a non-empty `writable-custom-fields` allow-list, every named field must be on it or the whole operation is refused (403) before anything is created; the name→id and value shape are resolved server-side per the field's schema. Story→Epic linking uses the native `parent` (team-managed) or the Epic Link custom field (company-managed), mirroring `show`'s parent resolution. Jira has no create-transaction, so the guards (shape, allow-list, name resolution) all run up front; a per-Story failure **after** the Epic exists is reported per-Story (with the created Epic key + the other Stories' keys), not fatal. A non-default issue-type name is overridable with a top-level `"issueTypes": {"epic": "…", "story": "…"}`. Exit 1 if any Story failed (the Epic key is still reported) |
| `aee-jira add-stories --epic KAN-12 --file stories.json` | **add new Stories to an existing Epic** — fill an Epic the team already has, without creating a duplicate Epic (`create-epic` always creates a new one). The Epic is named by its key (case-insensitive, e.g. `kan-12`); the Stories are created in **the Epic's project**, each with the Epic as its parent (native `parent` on team-managed projects, the Epic Link field on company-managed ones — the same mechanism as `create-epic`). Payload from `--file` (or stdin): `{"stories": [{"summary": "…", "description": "…", "assignee": "<accountId>", "status": "In Progress", "fields": {"Team": "<id>"}}]}` — the per-Story contract is exactly `create-epic`'s (`summary` required; `status` as a follow-up transition; `fields` by Jira name, gated by a non-empty `writable-custom-fields` list). Refused **before anything is created** when: the payload has no stories or a story has no summary (400); a named custom field is off a non-empty allow-list (403); the key does not exist or the team's Jira account cannot see it — i.e. it is outside the team's scope (404); the issue is not an Epic (400, naming its actual type). Then each Story is created in turn; one failing Story is reported and does not stop the others (exit 1 if any failed). Uses the same `create` write policy as `create-epic`, is audited as `add-stories` (Epic key, created/total), and every created Story is recorded as the team's own write so it does not wake the team. To fill several Epics, make one call per Epic. **Any standard issue type under the Epic (#2896):** `--type Bug` sets the type for every issue in the call, and an entry's own `"type"` wins over it (so one call can create a Bug and a Task); `"issues"` is accepted instead of `"stories"`, and each entry may also carry `priority` (by name) and `labels` (single words), as in `create-issue`. As soon as a type is named, the Epic project's own issue types are read once and each issue's type is matched case-insensitively against them (localised names and team- / company-managed projects alike). These refusals fail **only that issue** — the others are still created: an unknown type (listing the project's standard types), an Epic type, a sub-task type, a field the project requires for that type but the entry does not set (named, from Jira's create metadata — if that is unreadable, Jira's own refusal is mapped to field names). Each typed outcome carries `issueType`. A call with no type at all is the Story create above, unchanged |
| `aee-jira create-issue --project KAN --type Bug --summary "…" [--description "…"] [--assignee <accountId>] [--priority High] [--label L]… [--status "In Progress"] [--field "Name=value"]… [--file issue.json]` | **create one standalone issue without a parent Epic** — the everyday Jira create (a bug report, a task, a single Story). `--type` is matched case-insensitively against **the project's own issue-type names** (so a localised `Fehler` works; team- and company-managed projects alike); the issue is created with no `parent`. `--file` (or `-` for stdin) is an optional JSON object with the same keys — `summary`, `description`, `assignee`, `priority`, `labels` (list), `status`, `fields` (custom fields by Jira name; an object value is sent verbatim) — and the flags win over it. The field contract is `create-epic`'s (`summary` required; `description` converted to ADF like `update`; `fields` gated by a non-empty `writable-custom-fields` list, 403) plus `priority` (by name) and `labels` (single words). `status` is a **follow-up transition**; if it is not possible the issue still exists and the result carries `statusError` next to the key (exit 1). Refused **before anything is created**: a project the team's Jira account cannot see — outside the team's scope (404); an unknown type (400, listing the project's standard types); an Epic type (400, pointing at `create-epic`); a sub-task type (400); a field the project requires for that type but the call does not set (400 naming it, from Jira's create metadata — if that is unreadable, Jira's own refusal is mapped to field names); a value Jira rejects, e.g. an unknown assignee accountId (400, nothing created). Same `create` write policy as `create-epic`, audited as `create-issue` (key and type), and the created issue is recorded as the team's own write so its `issue_created` event carries `origin: agent`. Result: `{ project, issueType, key, url, summary, status?, statusError? }` |
| `aee-jira add-subtasks --parent KAN-10 [--type "Sub-task"] --file subtasks.json` | **create Sub-tasks under an existing Story, Task or Bug** (#2900). The parent is named by its key (case-insensitive); the Sub-tasks are created in **the parent's project** with the native `parent` field (team- and company-managed projects alike). Payload from `--file` (or stdin): `{"subtasks": [{"summary": "…", "description": "…", "assignee": "<accountId>", "priority": "High", "labels": ["web"], "status": "In Progress", "fields": {"Team": "<id>"}, "type": "Sub-task"}]}` — per Sub-task the field contract of `create-issue` (`summary` required; `status` as a follow-up transition; `fields` gated by a non-empty `writable-custom-fields` list, 403). The sub-task type comes from **the project's own sub-task types** (`subtask: true` / hierarchy level −1 — so a localised *Unteraufgabe* works): with exactly one it is used without being named; with several, `--type` names it for the call and an entry's `"type"` wins. Refused **before anything is created**: no Sub-tasks or one without a summary (400); the parent does not exist or the team's Jira account cannot see it — outside the team's scope (404); the parent is an Epic or itself a Sub-task (400 — Jira allows neither); the project has no sub-task type, i.e. Sub-tasks are disabled (400); several sub-task types and none named (400, listing them). Then each Sub-task is created in turn; these fail **only that Sub-task**: an unknown or non-sub-task type (listing the sub-task types), a field the project requires but the entry does not set (named, from Jira's create metadata), a value Jira rejects (mapped to field names). Exit 1 if any failed. Same `create` write policy as `create-epic`, audited as `add-subtasks` (parent key, created/total); every created Sub-task is recorded as the team's own write so its `issue_created` event carries `origin: agent`. Result: `{ project, parent: { key, url, summary, issueType }, subtasks: [{ summary, issueType, key, url, ok, status?, statusError? } \| { summary, ok: false, error }], created, failed }`; `show <key>` then reports `parent` |
| `aee-jira set-epic KAN-30 KAN-31 --epic KAN-12` / `aee-jira set-epic KAN-30 --none` | **put existing issues under an Epic, move them to another Epic, or take them out of their Epic** — backlog grooming for tickets that already exist (`add-stories` only creates new ones). Every listed issue gets the named Epic as its parent (an issue under another Epic is moved); `--none` clears the parent. The target is checked first and refused before anything changes when it does not exist or is outside the team's scope (404, the same *outside this team's scope* wording as the other writes) or is not an Epic (400, naming its type). Then each issue is handled in turn and gets its own outcome: `added`, `moved` (with `from`), `removed`, `unchanged` (*already under KAN-12* / *has no parent Epic* — a success, no write) or `failed` with the reason — a key that does not exist or is outside the scope, an Epic or a sub-task (only Epic ↔ standard-issue parenting is in scope; neither is moved), or Jira's own refusal (a missing **Edit Issues** permission, a workflow that forbids the edit, an Epic in a project Jira does not allow). One failing key never stops the others; a key listed twice is handled once; there is no cap on the list. The write sets the native `parent` (Jira Cloud's parent for both team- and company-managed projects) and falls back to the Epic Link field when an older company-managed configuration rejects `parent`. Own write policy `set-epic`, audited (`<target>: N changed, N unchanged, N failed of N`), same credential rules as the other writes; each changed parent is stamped as the team's own write, so its `field_changed` echo carries `origin: agent`. Result: `{ epic, issues: [{ issue, ok, outcome, message, from, to, error }], changed, unchanged, failed }`; exit 1 if any issue failed. Verify with `show`, whose `parent` reports the new Epic (or `null`) |
| `aee-jira edit KAN-10 [--summary "…"] [--assignee <accountId> \| --unassign] [--priority <name>] [--add-label L]… [--remove-label L]… [--set-labels [L…]] [--add-component C]… [--remove-component C]… [--set-components [C…]] [--add-fix-version V]… [--remove-fix-version V]… [--set-fix-versions [V…]] [--due YYYY-MM-DD \| --clear-due]` | **change the standard fields of one existing issue** — the everyday upkeep `update` (description) and `set-field` (custom fields) do not cover. Several fields in one call. Guards, all before the single edit: shape (400, Jira not called) — an empty summary, a label with whitespace (Jira labels are single words), a due date that is not a real `YYYY-MM-DD`, a list given both `--set-…` and `--add-…`/`--remove-…`, nothing to change; the issue lookup — not found or outside the team's scope (404, the *outside this team's scope* wording); name resolution, case-insensitive — the priority against the site's priorities, components and fix versions against the issue's project; an unknown name is a 400 listing what exists (nothing is created — versions are managed in Jira). Then **one** `PUT /issue/<key>` with only the fields that actually change: scalars in `fields`, list `--add-…`/`--remove-…` as `update` add/remove ops (the issue's other values are not resent), `--set-…` as the whole list (empty = clear). Jira applies the edit as a whole or not at all; its refusal is mapped per field by name, and a field missing from the issue's edit screen is named as such (e.g. *Due date cannot be changed on KAN-10 — the field is not on the issue's edit screen*); an assignee Jira will not accept (not assignable in the project) is shown with Jira's reason. A field already at its target value is reported `unchanged` and not written; when nothing changes, Jira is not written at all. Own write policy `edit`, audited (`KAN-10: changed summary, labels, 1 unchanged`), same credential rules as the other writes; each changed field is stamped as the team's own write, so its `field_changed` echo carries `origin: agent`. Result: `{ issue, url, fields: [{ field, from, to, outcome: changed \| unchanged }], changed, unchanged }` — `assignee` by accountId, lists as names. Description (`update`), custom fields (`set-field`), reporter and issue type are out of scope |
| `aee-jira sprint list --board "<board name>"` | list a **Scrum board's** sprints (`id`, `name`, `state`, `startDate`, `endDate`, `goal`) over the Jira **Agile** API. The board is resolved by its human-readable name (an exact case-insensitive match wins; a single substring match is accepted; several matches are an error listing the candidates — `--project <key>` disambiguates). `--state future,active,closed` optionally filters. Read-only; needed to know where the board's last sprint ends so a bulk generation can continue from it |
| `aee-jira sprint create --board "<board name>" --name "<name>" --start <date> --end <date> [--goal "…"]` | create **one future sprint** on the board (a Scrum board has only one *active* sprint; a plain create yields a not-started/future one). `--start`/`--end` take `YYYY-MM-DD` (or a full ISO-8601 string). Role-gated write; the token stays server-side |
| `aee-jira sprint bulk-create --board "<board name>" --name-template "<tmpl>" --until <date> [--cadence-days 7] [--start <date>] [--goal "…"]` | **pre-create a run of future sprints** up to a target end date in one call. Each sprint is `--cadence-days` long (default 7, weekly Mon–Sun); the run **continues by default from the day after the board's latest existing sprint** (`--start` overrides, and is **required** when the board has no dated sprint yet). Each sprint's name is computed by `--name-template` off that sprint's **start day** (its Monday) — placeholders `{MMM}`/`{MMMM}` month, `{MM}`/`{M}` month number, `{YYYY}`/`{YY}` year, `{DD}`/`{D}` day, `{weekOfMonth}` the Nth-weekday-of-month index, `{n}` the 1-based batch index. The month is the sprint's Monday's month **even when the week crosses into the next month**: a sprint running Mon 26.10–Sun 01.11 with `"Acc2.0 {MMM}_{weekOfMonth}"` is `Acc2.0 Oct_4`, and the following Mon 02.11–Sun 08.11 is `Acc2.0 Nov_1`. The plan is computed up front (capped at 104 sprints per run); each sprint is then created, and a per-sprint failure is reported (not fatal — the dates are precomputed, not chained). Exit 1 if any sprint failed. Role-gated write |
| `aee-jira sprint close --board "<board name>" [--sprint-id <id>]` | **complete (close) the board's active sprint** — transition it `active` → `closed` over the Agile API. Defaults to whichever sprint is currently active (`--sprint-id` closes a specific one; refused if that sprint is not active). Reports `incompleteIssues`, the count of issues still open at close — the plain `state:"closed"` call leaves them assigned to the now-closed sprint (there is no move-to-backlog dialog for an agent). Role-gated write, never retried |
| `aee-jira sprint start --board "<board name>" [--sprint-id <id>]` | **start (activate) the board's next future sprint** — transition it `future` → `active`. Defaults to the earliest-starting future sprint (`--sprint-id` starts a specific one). Refuses to add a second active sprint (a board has only one — clear error naming the already-active sprint, rather than letting Jira's raw API error surface) and a sprint with no start/end date (Jira rejects a dateless activation). Role-gated write, never retried |
| `aee-jira sprint advance --board "<board name>" [--close-id <id>] [--start-id <id>]` | **roll the board over in one call**: close the active sprint, then start the next future one. Each phase is reported distinctly (`close` / `start`), so a partial outcome is visible rather than all-or-nothing — a missing active sprint is a *skip* (a first-ever activation is valid), any other phase error is a *failure*. `--close-id`/`--start-id` override each target. Exit 1 on a partial (a real phase failure) while still printing both outcomes. Role-gated write |

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
  - **Inbox** — the events queued for this team's agents.
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
  every fresh event the poller saw in a watched project and what it did
  with it — `woke agents` / `folded into digest` / `throttled` /
  `not watched` / `baseline`. Grouped by day, filterable by event kind (once
  more than one kind is present), issue type and *Watched* vs *All activity* (the latter also shows transitions the
  poller saw but did not act on). Kept **14 days**, independent of the agent
  inbox. This is the `JiraEventLog.jsx` #1539 deferred, at zero platform cost.
- **Platform GitHub Event Log** (`/github-events`) — every *wake* also writes one
  row there, tagged `source: internal-plugin`, event `plugin.event`. It has no
  repo, label or work item — those columns show `—` — but the row confirms the
  fan-out happened and to which agents.

---

## Whose Jira account is used

| Run | Account | Without it |
|---|---|---|
| a chat message from a team member | that member's **personal** credential — never the service account | every subcommand (incl. `whoami`, `inbox`) is refused with a pointer to Plugin Tokens; nothing is sent to Jira |
| a chat message from someone who is not trusted for the agent (not a member of its team) | none | refused (`untrusted-sender`) |
| schedules, loops, GitHub / plugin events, hand-offs from other agents | the team **service account** | refused (`no-service-account`) |

The identity is decided server-side and cannot be forged from inside the
container. The agent runner fetches a per-container run key from the
orchestrator once at startup and keeps it in non-dumpable memory — a second
request revokes it. It then declares every Claude run as `chat` (naming the
Matrix room and event) or `autonomous`. For a chat run the orchestrator reads
the event from the homeserver and takes the sender from there. Each `aee-jira`
call carries the agent's caller token (`AEE_AGENT_CALLER_TOKEN`, which names
the agent, not a person); the broker forwards it to
`POST /internal/plugin-credential-grant`, authenticated with a reserved
`_grant-<scope>` token only the broker mints. The team scope token an agent
holds in its workspace is refused there, so nothing inside the container can
ask for a person's credential itself. That route checks the one active
run, the sender's team trust (re-checked on every call) and the stored
personal credential. The old `AEE_ACTING_SENDER` env var plays no part.

**One refusal lists every missing setup item.** Because the orchestrator owns
both the personal store and the team credential store, an interactive refusal
aggregates ALL outstanding prerequisites into one message rather than surfacing
them one failed call at a time: a missing personal token (the sender fixes it,
Connections → Plugin Tokens) and a missing team site (a Team Admin fixes it,
Agent Chat → Settings → Plugins). Both missing → code `setup-required`; only one
→ the stable single-cause code (`personal-credential-required` / `no-site`). The
site check is driven by the manifest: a team credential marked
`requiredFor: ['interactive', …]` (Jira's `site-url`) is one an interactive turn
needs too. The service-account fields are `requiredFor: ['automated']` only, so
they never gate a chat turn and an interactive-only team is not asked to fill
them.

**Who "the sender" is.** The acting human is taken from the event's platform
author stamp (`io.aee.author`, written server-side from the authenticated
console session), falling back to the raw Matrix sender id. This matters in the
single-operator stack: there every human's message is sent under the ONE shared
Matrix identity (`@admin:local`), which maps to no user record — so without the
stamp a chat turn could never name the acting person and would always be refused
`untrusted-sender`. The stamp is as unforgeable from inside the container as the
sender is (the container holds only its own Matrix token, and a self-posted
event is rejected before the stamp is even read).

Every broker audit line records `identity` (the member's user id, or `service-account`)
and `interactive`. `aee-jira whoami` shows both.

Known limits: two Claude runs active at once in one agent make the identity
ambiguous, so calls are refused; an agent container started before this
version is refused until it is respawned; the console's Jira board still reads
with the service account.

---

## Limits

- **Throttle shared across kinds.** The per-issue 5-wakes-per-hour throttle
  counts every kind together — it is loop protection for one issue's
  conversation, and a comment loop is exactly what it must catch. A status
  change plus four comments on one issue in one hour drops the fifth wake
  (`throttled` on the Activity tab; the event is still in the log).
- **Poll only, no Jira webhooks.** Every kind is found by the same ~60 s JQL
  poll; nothing is instant.
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
| a call returns `setup-required` | a chat turn missing MORE than one interactive prerequisite (personal token AND team site) — the refusal message lists every item and who fixes each | the sender adds their token (Connections → Plugin Tokens); a Team Admin sets the site (Agent Chat → Settings → Plugins) |
| a call returns `personal-credential-required` | a chat turn, the team site is set, but the sender has no personal Jira credential | the sender adds it under Connections → Plugin Tokens |
| a call returns `personal-credential-rejected` | Jira refused the sender's personal token (401) — expired or revoked | the sender renews it on Plugin Tokens |
| a call returns `untrusted-sender` (message: *not a member of this agent's team*) | the sender resolves to a real account, but one that is not on this agent's team | share the team with that person, or ask a member |
| a call returns `untrusted-sender` (message: *could not identify who sent this chat message*) | the sender maps to no user record — e.g. an agent container from before author-stamp resolution, or a message with no author stamp | respawn the agent; ensure the message was sent through the console (which stamps the author) |
| a call returns `no-active-run` / `ambiguous-run` / `run-key-revoked` | the call is not inside exactly one run the runner declared (e.g. a second Claude run in the same agent overlapped a chat turn — the call is refused rather than guessed), or something in the container requested a second run key | respawn the agent; do not run `aee-jira` from background processes that outlive the turn |
| a chat turn returns `no-site` | the sender has a personal credential, but the team has no Jira site set | Team Admin sets the site in Agent Chat → Settings → Plugins (or a System Admin on the Plugins page) |
| an automated run returns `no-service-account` | the team has no service-account credential set | Team Admin sets it in Agent Chat → Settings → Plugins (or a System Admin on the Plugins page) |
| broker log: `Jira rejected the credential (401)` | the e-mail and token aren't the same Atlassian identity, or the token was revoked | regenerate a **classic** token while signed in as the intended account; **Test connection** in the credential form confirms the fix |
| `projects` returns nothing but the account sees projects in a browser | a **scoped** API token missing `read:jira-work` | use a classic (unscoped) token |
| a transition "no transition to X" | X isn't reachable from the issue's current status, or the name doesn't match | the error lists the available transitions; use one of those target names |
| the poll log shows `fetch failed` once then recovers | a stale keep-alive socket in the long-running broker | expected — the client retries transport failures once |
| a fresh transition doesn't wake the agent | no status in the watch's `statusFilters` set exactly matches the Jira status name, or the agent has no `plugin-event` trigger, or the poll already baselined the change, or the trigger's payload filter names a status that is not the one the issue moved into | check the Activity tab (a `not a watched status` row means the set is wrong); copy the status name verbatim from Jira; add the trigger |
| a watch card shows **Failing** | consecutive poll failures — expand it for the error log | usually a bad or expired API token: a Team Admin re-sets the service account (Agent Chat → Settings → Plugins), then hits **Retry now** |
| the agent says `aee-jira` is read-only / only knows `whoami` and `inbox` | its workspace holds a CLI copy from an older plugin version (the grant sync copies the file only when the grant changes) | since this version the copy is refreshed on every plugin reconcile — restart the orchestrator or `POST /internal/plugins/reconcile`; re-run `make seed-plugins` + reinstall first if `/workspace/plugins/jira/bin/aee-jira.py` is itself old |
| `aee-jira inbox --consume` fails with `broker HTTP 400: consume takes the event ids you were woken for…` (or, from a stale CLI copy, just `consume-requires-ids`) | the wake instruction still uses the pre-2026-09 team-wide drain | change it to `aee-jira inbox --consume <id>…` with the ids from the event payload (`id` / `events[].id`); the agent's own trigger filter already decided which events it received; a stale copy is refreshed on the next plugin reconcile (`planCliRefresh`) |
| the wrong agent wakes, or an agent wakes on its own transition | the agents' `plugin-event` triggers carry no payload filter, so every watched transition wakes all of them | set `toStatus=<status>` on each agent's trigger (§5) |
| a trigger whose *Which event* is a status name (`Ready for Dev`) never fires | `eventFilter` is compared with the event **name** (`status_changed`), not with the payload; the status belongs in *Only when…* (`toStatus`) | blank *Which event*, add the condition `toStatus = Ready for Dev` — the form now offers both from the manifest and flags the mistake |

For a hands-on debug session the broker ships `spike.js` (run inside the
sidecar): `podman exec aee-plugin-jira node spike.js probe --project KAN
--window 120 --status "Ready for Dev"` replays the exact search + changelog
extraction against Jira and prints what would fire. See
`plugins/jira/broker/README.md`.
