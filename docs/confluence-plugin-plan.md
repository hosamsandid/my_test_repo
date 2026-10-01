# Confluence plugin — concept and plan

> Status: **plan, not started** (written 2026-09-21). This is the document
> `docs/jira-plugin-plan.md` §5/§11 forward-references (its "§4 credential
> question" is §4 here). It follows the Jira plugin's shape deliberately — the
> same five layers (credential, per-scope broker, CLI facade, UI routes, event
> source), the same SDK primitives, the same decisions where they transfer —
> because that shape shipped and held. Read `docs/jira-plugin-plan.md` and
> `docs/plugin-system-concept.md` §4 first; this document only spells out what
> is *different* about a wiki.

## 1. Why Confluence, and what it is for in this stack

Jira is where the *work* is tracked; Confluence is where the *deliverable* of
a mainframe-migration analysis lives: program analysis reports, business-rule
extractions, data dictionaries (copybook → table), interface catalogues, JCL
job documentation, decision records, runbooks, the glossary and the team's
conventions. Humans read and review there; that is where an agent's output
becomes visible to the people who did not ask for it.

So the plugin has to do three things, in this order of value:

1. **Read** — a spec, a glossary entry, a convention page, as context for a
   ticket the agent is working (`aee-confluence search` / `show`).
2. **Write** — publish the analysis page for a COBOL module, keep a data
   dictionary current, append a decision record — *without* ever silently
   overwriting what a human wrote (§7).
3. **Be woken** — a reviewer's inline comment on the agent's page, a spec
   page that changed, a new requirements page, a task ticked (§8). Same
   generic `plugin-event` wake as Jira.

## 2. Does Confluence pass the plugin screening rule?

`docs/plugin-system-concept.md` §8 requires at least one governance property
MCP does not provide. Confluence passes on the same three as Jira, plus one:

- **A credential that must not enter the agent container.** An Atlassian API
  token is site-wide and carries the *human's* permissions — every space that
  person can read, every page they can edit or delete.
- **Per-scope credential selection.** One broker, many teams, each with its
  *own* token (§4): the scope token names the team, the broker picks that
  team's credential, and Confluence's own space permissions do the rest.
  Team A cannot read team B's space because team A's token cannot — the
  broker adds no allowlist of its own on top (Jira works the same way:
  `aee-jira list --project X` reads whatever the token sees; watches only
  say what to *poll*). See §6.3.
- **An audited write gate.** A page edit is an outward-facing write humans
  read and, unlike a Jira transition, can *destroy* authored text. Writes are
  role-gated and ownership-tiered (§7) and every one is in the audit trail.
- **A loop-safe event source.** Comments/edits the agent makes come back as
  events under the token owner's name (the Jira `origin` problem,
  `docs/jira-plugin-events-implementation.md` §1.3) — the broker is the only
  party that can stamp provenance.

**Relation to the `wiki` MCP server and Knowledge Phase 5.** The reference
`mcp-servers/wiki/` stays what it is: a generic, credential-per-environment,
read-only *data-access* backend for any wiki behind a two-endpoint shim
(§7 of the plugin concept: "MCP servers stay for pure data-access backends").
The Confluence plugin is the governed path: per-team credential, writes,
events, audit. `docs/knowledge-sharing-concept.md` Phase 5's `knowledge search`
fan-out binds MCP sources today; a plugin-CLI provider (`aee-confluence
search` as a source, labelled `[confluence]`) is the natural extension and is
deferred to Phase 5 of this plan (§10). Nothing here changes the knowledge
system.

## 3. What Confluence Cloud actually offers (inventory)

The point of this section: the obvious "search & update" is a fifth of it.
Verdicts: **v1** (Phases 1–3), **v2** (Phase 4), **later** (Phase 5 / deferred),
**never** (out of scope by design). REST paths are `/wiki/api/v2/…` unless
marked v1 (`/wiki/rest/api/…` — the older API, still the only one for CQL and
attachments upload).

### 3.1 Content model

| Feature | What it is | Agent value | Verdict |
|---|---|---|---|
| **Spaces** | the top-level container (key + numeric id; global or personal); flat — no nesting | what the token's permissions are granted on; the poll unit and the default write target (§6.3) | v1 |
| **Pages** (`status: current`) | the document; body in `storage` (XHTML), `atlas_doc_format` (ADF — same JSON as Jira comments/descriptions), or `view` (rendered) | read as ADF → markdown; write ADF built from markdown (§6.4) | v1 |
| **Page hierarchy** (`parentId`, `/children`, `/ancestors`) | pages form a tree | "one page per COBOL program under *Migration Analysis / Batch*" — `create --parent`, `tree` | v1 |
| **Drafts** (`status: draft` on create) | an unpublished page only its author sees | *not* usable for "agent drafts, human publishes" — the author is the token owner, nobody else sees it | never |
| **Blog posts** | dated, non-hierarchical content per space | a weekly migration status post | v2 |
| **Versions** (`/pages/{id}/versions`, `version.message`, `minorEdit`) | full history; every update must send `version.number + 1`, may carry a message; restore via a new version | the **attribution channel** (message = "Updated by an agent on team X via Agent Studio"); optimistic concurrency (a stale number is a 409 — the agent re-reads, never clobbers) | v1 |
| **Content properties** (`/pages/{id}/properties`, JSON key/value) | hidden structured metadata on a page | `aee` property = ownership + provenance (`{team, createdAt, source: "KAN-6"}`) — survives state-volume loss, invisible to readers | v1 |
| **Labels** (`/pages/{id}/labels`; CQL `label = x`) | flat tags, searchable | the workflow signal humans can set from the UI in one click (`needs-agent-review`, `agent-editable`, `jira-KAN-6` for cross-lookup); the Confluence analogue of Jira status / GitHub label triggers | v1 (read/set), v2 (event) |
| **Attachments** (v2 read; v1 multipart upload, `X-Atlassian-Token: nocheck`) | files on a page | attach a generated diagram/CSV | v2 |
| **Whiteboards / Databases / Folders / Smart Links** | newer content types (v2 endpoints exist, read-mostly) | none for the domain yet | later |
| **Templates / blueprints** (v1) | page skeletons | the plugin ships its own markdown templates as a `companionSkill` instead — no Confluence template dependency | never (as API) |
| **Restrictions** (v1 `/content/{id}/restriction`) | per-page read/update ACLs | never modified by an agent; a 403 on write is surfaced as such | never (write) |
| **Space permissions** | per-space ACLs | the token's own permissions bound everything; the plugin never widens them | never |

### 3.2 Collaboration

| Feature | What it is | Agent value | Verdict |
|---|---|---|---|
| **Footer comments** (`/pages/{id}/footer-comments`, threaded replies) | the page-level discussion | the review channel: agent asks its open question here; human answers → `comment_added` wake | v1 |
| **Inline comments** (`/pages/{id}/inline-comments`, anchored to a text selection, `resolutionStatus: open/resolved/reopened/dangling`) | comment on a sentence | the *precise* review loop: reviewer highlights "this rule is wrong" → agent revises that section → agent (or human) resolves. Creating one needs `textSelection` + match index — the agent quotes the text it means | v1 (read, reply, resolve), v2 (create) |
| **Tasks** (`/tasks?assigned-to=&status=incomplete`; `PUT /tasks/{id}` complete) | `[ ]` checkboxes in pages, assignable, with due dates | a human-driven hand-off surface: a checklist page per module, "human ticks *Reviewed* → agent continues"; agent writes task lists in its own pages (ADF `taskList`) | v2 |
| **Mentions** (ADF `mention` node) | @user in a body | address the reviewer in a comment (`--mention`) — needs account-id lookup (v1 `/user/search`) | v2 |
| **Watchers / notifications** (v1) | Confluence e-mails watchers on change | none — the event source is the plugin's poll | never |
| **Likes / reactions** | — | none | never |

### 3.3 Organisation and "the features nobody uses but should"

| Feature | What it is | Agent value | Verdict |
|---|---|---|---|
| **Page Properties + Page Properties Report macros** | a page carries a small key/value table (`<ac:structured-macro ac:name="details">`); a *report* page in the space aggregates every page's table with a given label into one live table | **the portfolio dashboard for free**: every program-analysis page carries `Program · LOC · Complexity · Status · Owner · Jira`; one human-made report page labelled `program-analysis` shows all of them, sortable, always current. The plugin's `create --properties k=v,…` writes the macro; `docs` explain the one-time report page | v1 (write helper) |
| **Excerpt / Excerpt Include / Include Page** | reuse a block from one page in many | the canonical *Migration Conventions* excerpt included at the top of every generated page — one edit propagates | v2 |
| **Children Display / Content by Label** macros | auto-lists | index pages that need no maintenance; the plugin writes them once | v2 |
| **Status lozenge** macro | a coloured `DRAFT` / `REVIEWED` chip | human-readable state on the page; the *label* stays the machine-readable one | v2 |
| **Jira Issues macro** (`ac:name="jira"` with an issue key or JQL) | live issue card/table in a page | a generated page shows its source ticket live; the "open findings" page shows a JQL table | v1 (single key on `create --jira`), v2 (JQL tables) |
| **Table of Contents / Expand / Code / Info-Note-Warning panels** | layout macros | code macro for COBOL/JCL snippets with language; panels for caveats — markdown fences/blockquotes map onto them | v1 (code, panels via `> **Note:**` convention) |
| **Analytics** (views / viewers, Premium) | who reads what | "nobody has opened the report" signal | later |
| **Audit log** (admin) | site-level | not the plugin's concern — the broker keeps its own audit | never |
| **Export** (PDF/Word) | UI only, no stable API | never | never |

### 3.4 Search

| Feature | What it is | Verdict |
|---|---|---|
| **CQL** (v1 `GET /wiki/rest/api/search?cql=…&expand=…`) | `type in (page, blogpost, comment)`, `space in (…)`, `title ~`, `text ~` (full-text), `label =`, `ancestor =`, `creator`, `contributor`, `lastmodified >= now("-10m")`, `created`, `ORDER BY` | v1 — the read path *and* the poll query. The poll always adds `space in (<watched>)`; a CLI search adds `space` / `ancestor` only when the agent asks (`--space`, `--ancestor`) |
| v2 `/pages?title=` `/pages?space-id=` filters | exact-title and per-space listing | v1 — `show --title` |
| Atlassian cross-product search | site-wide, separate API | never |

### 3.5 What is missing that Jira had

- **No changelog.** A page's history is versions of its *body*; there is no
  per-field change record and no "labels changed" event. `label_added` needs a
  per-page label snapshot in the cursor and a diff (v2). `page_updated` is one
  event per new version *observed* — if three edits land between polls, one
  event with the latest version (the JQL/Jira window semantics, worse).
- **No webhooks without a Connect/Forge app** — same poll model as Jira.
- **Rate limits** (HTTP 429 + `Retry-After`) are hit sooner than on Jira;
  the client honours `Retry-After`, the SDK backoff covers the rest.

## 4. Credential

Answered by Jira plan D1: the generic per-scope plugin credential store
(`orchestrator/plugin-credential-store.js`) provisions the manifest's
`credentials[]`; the orchestrator pushes the per-scope map to the broker via
`PUT /internal/scope-credentials` (SDK `internalPushEndpoint`, `_internal`
token only). Same three keys as Jira — `site-url`, `email`, `api-token` — set
by a Team Admin on the Plugins page, `setBy`/`setAt` recorded, raw values
never returned.

**One Atlassian token for both products?** Kept as Jira §11 argued: **two
credential entries, one per plugin**, which may hold the same secret. Revoking
or rotating Jira never breaks Confluence silently; each plugin's Plugins-page
card shows its own state; the broker code stays identical. The only shared
thing is convention: the same `site-url` value (a Confluence Cloud site is
`https://<site>.atlassian.net/wiki` — the broker appends `/wiki`, the admin
enters the same bare subdomain as for Jira). A future "copy from Jira" button
on the Plugins page is a console nicety, not a design question.

## 5. Use cases in the migration flow (what the CLI has to make easy)

1. **Program analysis page** — Developer agent works `KAN-6` (COBOL
   `PAYROLL01`): `aee-confluence create --space MIG --parent "Batch Programs"
   --title "PAYROLL01 — analysis" --jira KAN-6 --properties
   "Program=PAYROLL01,LOC=2140,Complexity=High,Status=DRAFT" --body-file
   analysis.md`. The page lands under the right parent, carries the Jira
   macro, the properties table (→ the portfolio report), the `aee` ownership
   property, labels `program-analysis`, `jira-KAN-6`. The agent comments the
   URL on the Jira ticket.
2. **Review loop** — reviewer leaves an inline comment "the rounding rule is
   the other way around". Broker: `comment_added` (`inline: "true"`,
   `origin: "human"`) → Developer agent wakes, `show --comments`, revises
   the section, `update` (its own page — allowed), `comment --reply-to
   <id> "fixed in v4"`, `resolve <commentId>`.
3. **Spec change** — a BA edits *Interest Calculation Rules* (a human page).
   `page_updated` (`origin: "human"`, `label:spec = "true"` — the per-label
   presence keys of §8.2, because the platform filter is exact-match only) →
   the Developer agent's trigger *Only when… `origin = human` and
   `label:spec = true`* fires; it re-reads the spec and re-checks the pages
   derived from it.
4. **New requirement** — a new page appears under *Requirements* →
   `page_created` (`ancestorTitle`/`parentId`) → BA agent triages.
5. **Glossary / conventions lookup** — any agent: `aee-confluence search
   "COMP-3 conversion" --space MIG --label convention`, then `show <id>`.
   Read-only, no wake, the bulk of day-to-day use.
6. **Proposed change to a human page** — the agent believes the data
   dictionary is wrong. `update` on a human-owned page is refused (§7);
   `propose <pageId> --body-file …` creates a child page *"Proposed change:
   Data Dictionary"* labelled `agent-proposal` and a footer comment linking
   it. The human merges by hand (or labels the original `agent-editable`).
7. **Hand-off via tasks (v2)** — the checklist page *PAYROLL01 migration*
   has `[ ] Reviewed by BA`, `[ ] Test data approved`. Human ticks one →
   `task_completed` → the next role wakes.

## 6. The plugin — `plugins/confluence/`

### 6.1 Manifest (`plugin.json`)

```jsonc
{
  "pluginVersion": 1, "id": "confluence", "name": "Confluence",
  "sidecar": { "image": "localhost/aee-plugin-confluence:latest", "capabilities": ["egress"], "internalPort": 4010 },
  "cli": { "name": "aee-confluence", "entrypoint": "bin/aee-confluence.py", "runtime": "python3" },
  "credentials": [ { "key": "site-url", … }, { "key": "email", … }, { "key": "api-token", … } ],
  "events": [ /* §8.2 — page_created, page_updated, comment_added (v1); label_added, task_completed (v2) */ ],
  "platforms": ["podman"], "scopes": ["team"], "defaultScopeGranularity": "team",
  "quota": { "maxObjects": 500 },
  "policy": { "create": {"scopes":["team"]}, "update": {"scopes":["team"]}, "comment": {"scopes":["team"]},
              "resolve": {"scopes":["team"]}, "label": {"scopes":["team"]}, "propose": {"scopes":["team"]} },
  "requiresApproval": [],
  "ui": { "title": "Confluence", "routes": [ { "path": "/", "minRole": "team-member" }, { "path": "/admin", "minRole": "team-admin" } ] },
  "companionSkill": "confluence-authoring",
  "promptLine": "…"
}
```

- `requiresApproval` stays empty in v1 (D3 reasoning transfers: no delete, no
  move, no restriction change exist to approve). The ownership tier (§7) is
  the safety mechanism, and it is decidable server-side without a human.
- `companionSkill: confluence-authoring` — the *knowledge* half: page
  templates in markdown (analysis page, decision record, data dictionary
  entry), the properties-table conventions, "when to comment vs update vs
  propose". Ships under `plugins/confluence/skill/` and is seeded by the
  existing companion-skill mechanism; it is what makes agents produce
  consistent pages without hard-coding the templates in the CLI.

### 6.2 Broker modules (`broker/`) — the Jira layout, renamed

| module | mirrors | what differs |
|---|---|---|
| `server.js` | jira `server.js` | routes per §6.5; `deliver()` identical |
| `confluence-client.js` | `jira-client.js` | v2 pages/comments/labels/properties/tasks; v1 CQL search + attachment upload; `Retry-After`; `apiBaseFor()` appends `/wiki` |
| `cql.js` (pure) | `buildProjectJql` | builds the poll CQL (`space in (<watched>)` + window) and the search CQL from the agent's `--space`/`--label`/`--ancestor`/`--type`; quotes every value (the Jira `jqlQuote` lesson — CodeQL backslash escaping); an agent never passes raw CQL |
| `event-extract.js` (pure) | same | §8.1 extractors, ids, `origin` |
| `watch-store.js` | same | a watch = `{ spaceKey, spaceId, rootPageId?, events[] }` (§6.3); cursor per `<siteUrl>::<spaceKey>` |
| `inbox-store.js`, `activity-store.js`, `watch-health.js`, `viewer-headers.js` | same | **byte-identical copies** — the viewer-header verifier is parity-tested across brokers already; extend that test to the two stores or lift them into `broker-sdk/` first (D4) |
| `own-writes-store.js` | Jira events PR 4 | page versions, comment ids, the `aee` property cache |
| `ownership.js` (pure) | — | §7 decision table |
| `adf.js` (pure) | Jira `commentAdf` / `adfToText` | ADF ↔ markdown (D5, shared under `plugins/_shared/`) |
| `poller.js` | same | one CQL per scope (all its spaces), not per space; two queries (content, comments) |
| `broker-policy.js` | same | the write list above |

### 6.3 Watch config: what to poll, and where to write by default

**Visibility is Confluence's job, not the broker's.** The team's token
(§4) sees exactly the spaces its owner may see, and every read and write
goes out with that token — so `search` / `show` / `tree` work on whatever
the token reaches, with no broker-side allowlist. This is the Jira model
(`aee-jira list --project X` reads any project the token sees; watches say
what to *poll*), and it is the honest one: a broker allowlist could only ever
be *narrower* than the token, never safer than Confluence's own permissions,
and would have to be kept in sync with them by hand.

The admin config therefore has two parts:

```
{
  watches: [ { spaceKey, spaceId, rootPageId?: "<pageId>", events: ["comment_added", …] } ],
  defaultLocation?: { spaceKey, spaceId, rootPageId? }
}
```

- **`watches[]`** — which spaces (or subtrees of them) the poller queries
  and which event kinds there wake agents (opt-in per row, default `[]`). A
  site-wide CQL would be expensive and noisy; the poll is bounded to the
  rows. An empty list = no events for this team; reads still work.
- **`defaultLocation`** — where `create` lands when the agent gives no
  `--space` / `--parent`. This is the "correct space to update" question
  when one token reaches several teams' spaces: the *target* of a write is a
  per-call parameter with a team default, not a boundary. `--space` /
  `--parent` on the call always win.

**Subtrees ("subsites").** Confluence has no nested spaces; a section is a
page with everything under it, and several teams commonly share one space
that way. `rootPageId` on a watch narrows the poll to that page and its
descendants — `ancestor = <root>` is an indexed CQL field, but the check is
done on the response's `ancestors[]` so the poll stays one CQL per scope.
`rootPageId` on `defaultLocation` makes that page the default parent. The
admin UI validates a `rootPageId` on save (`GET /pages/{id}` must belong to
`spaceKey`). Rows may overlap (a whole space and a subtree of it); the most
specific row's `events` decide the wake, an event fires at most once.

What the token's permissions do **not** cover is authored *text*: a token
that may edit a page may also wipe it. That is the ownership tier's job (§7),
and it is the one gate the broker does add.

### 6.4 The body problem — markdown in, markdown out

Agents write markdown. The broker converts:

- **Write:** markdown → ADF (`atlas_doc_format`, the representation v2
  accepts on create/update). Subset: headings, paragraphs, emphasis, inline
  code, links, bullet/ordered lists (nested), GFM tables, fenced code
  (`codeBlock` with `language`), blockquotes → `panel(info)`, `- [ ]` →
  `taskList`, `---` → `rule`. Anything else degrades to a paragraph — never a
  refused write. Macros the API accepts in ADF as `extension` nodes: Jira
  issue, page properties (`details`), TOC. Attribution is the version
  **message**, not a paragraph (a page is not a comment — §7).
- **Read:** ADF → markdown (`show`), the lossy inverse; tables and code
  fences round-trip, macros render as `[macro: jira KAN-6]`.
- Storage-format XHTML is **not** parsed or emitted (v2 gives ADF for every
  page; only very old macro bodies come back as `extension` nodes with
  `bodyType: raw`, rendered as a placeholder).

### 6.5 CLI (`bin/aee-confluence.py`, dependency-free Python like `aee-jira`)

| subcommand | kind | notes |
|---|---|---|
| `spaces` | read | every space the token can see, the team's watched ones and default location marked |
| `search <query> [--space K] [--label L] [--type page\|blogpost\|comment] [--ancestor ID] [--limit N]` | read | CQL `text ~` over whatever the token sees; hits `{id, title, space, url, excerpt, lastModified, labels}` |
| `show <id\|--title T --space K> [--comments] [--raw-adf]` | read | markdown body + properties + labels + version; `--comments` appends footer + inline threads with ids and resolution state |
| `tree <id> [--depth N]` | read | children, for "where do I put this" |
| `create --space K --title T [--parent ID\|--parent-title T] --body-file F [--labels a,b] [--properties k=v,…] [--jira KEY]` | write | sets the `aee` property; `--jira` = Jira macro at top + label `jira-<KEY>` |
| `update <id> --body-file F [--title T] [--message M] [--minor]` | write | ownership-gated (§7); `version.number` read-then-write, 409 → `stale-version` error with the current number |
| `propose <id> --body-file F` | write | the child-page proposal (§5.6) |
| `comment <id> --body "…" [--reply-to CID]` | write | footer comment; attribution paragraph as in Jira |
| `resolve <commentId>` / `reopen` | write | inline comments only |
| `label <id> --add a,b [--remove c]` | write | any page the token may edit (labels are not body; a human can undo in one click) |
| `properties <id> [--set k=v,…]` | read/write | content property + the visible properties macro kept in sync (D6) |
| `inbox [--consume <id>…]` | read | identical contract to `aee-jira inbox` (ids from the wake payload only) |
| `attach <id> --file F` (v2) | write | v1 multipart |
| `tasks [--page ID] [--incomplete]` / `task <id> --complete` (v2) | read/write | |

Every write returns `{id, url, version}`; every error names its `code`
(`not-owned`, `stale-version`, `no-credential`, `no-default-location`,
and Confluence's own `forbidden` / `not-found` passed through with the
page id) so the agent's next step is unambiguous.

### 6.6 UI routes

- `/` (team-member): the team's spaces, a page finder (title search), the
  inbox, the Activity log (kind-aware from day one — the Jira events PR 1
  lesson), watch health. Read-only.
- `/admin` (team-admin, gated on `roleForTeam` like Jira F4): the watch
  rows (space, optional subtree, per-row event checkboxes), the default
  write location, the per-space health/retry, and the **ownership register**
  (pages this team's agents created, with "release" = drop the `aee`
  property so a human takes over).

## 7. Writes and the ownership tiers (the decision this plan turns on)

Jira writes were safe to role-gate because a transition is reversible and a
comment is additive. A page body update is neither in practice (version
history exists, but nobody watches it). The rule, decided **server-side** in
`ownership.js` from facts the broker holds:

| target page | `comment`, `label`, `propose` | `update` (body/title) | `resolve` |
|---|---|---|---|
| created by this team's agents (`aee.team == scopeId` property, or in the own-writes register) | allowed | **allowed** | allowed |
| labelled `agent-editable` (a human opt-in, one click, visible on the page) | allowed | allowed | allowed |
| any other page the token may edit | allowed | **refused** `not-owned` → the CLI says: comment, or `propose` | allowed (the agent may resolve a thread it replied to; contested — see open questions) |
| a page the token cannot see or edit | Confluence's own 403/404, passed through | same | same |

- Never offered: delete, trash, move, restriction/permission changes, space
  creation. Not "approval-gated" — absent, so no prompt can reach them.
- Every write carries attribution: comments as the italic first paragraph
  (Jira convention); page versions as `version.message` ("Updated by an agent
  on team X via Agent Studio" + the agent's own `--message`); created pages
  additionally carry the `aee` property.
- **Optimistic concurrency** on `update`: the broker sends `version.number`
  it read moments before; Confluence's 409 becomes `stale-version` — the agent
  re-reads and re-applies. It never force-wins.
- The ownership property is **the** durable fact (survives a lost state
  volume); the register is the fast path + the audit view.

Why refuse rather than park in the approval pen: an unattended run parked at
the first human-page edit stalls for hours (D3's argument), while `propose`
gives the agent a *productive* continuation and the human a diffable artifact.
If a team wants agents to edit human pages, `agent-editable` is a one-click,
per-page, visible consent. The pen stays wired for the day a genuinely
destructive op is added (same as Jira).

## 8. Events

### 8.1 Polling

One tick per scope with ≥ 1 watch and a credential:

1. **Content query** — CQL `type in (page, blogpost) AND space in (<all
   watched spaces>) AND lastmodified >= now("-<N>m") ORDER BY lastmodified
   ASC`, `expand=version,history,metadata.labels,ancestors`; subtree rows
   (`rootPageId`) add nothing to the query — the ancestor check is done on
   the response (`ancestors[]`) so it stays one call per scope.
2. **Comment query** — `type = comment AND space in (…) AND lastmodified >=
   now("-<N>m")`; v2 detail fetch only for inline comments (resolution state,
   anchored text) — bounded by the window.
3. Window widening after gaps, backoff, horizon gate, seen-id cursor,
   per-conversation burst digest, hour throttle — all the SDK primitives,
   unchanged. Cursor per `<siteUrl>::<spaceKey>`; one query per scope but
   the seen-set is kept per space so adding or removing a watch row never
   re-baselines the others.
4. Fan-out **per kind** from day one (the Jira lesson: a wake has one
   top-level `event`).

### 8.2 Kinds and payloads (all top-level strings; ids satisfy the Jira `EVENT_ID_RE`)

| kind | id | payload | v |
|---|---|---|---|
| `page_created` | `<pageId>:created` | `pageId, title, spaceKey, parentId, parentTitle, author, url, labels` (comma-joined — see below) | v1 |
| `page_updated` | `<pageId>:v<n>` | `pageId, title, spaceKey, version, author, origin, message, url, labels` | v1 |
| `comment_added` | `<pageId>:c<commentId>` | `pageId, title, spaceKey, commentId, inline ("true"/"false"), parentCommentId, author, origin, body (clamped), anchorText, url` | v1 |
| `comment_resolved` | `<pageId>:r<commentId>.<resolvedAtEpoch>` | `pageId, commentId, author, origin` | v2 |
| `label_added` / `label_removed` | `<pageId>:l<slug>.<version>` | `pageId, title, label, author` — from a per-page label snapshot diff in the cursor | v2 |
| `task_completed` | `<pageId>:t<taskId>.<updatedAtEpoch>` | `pageId, taskId, text, assignee, completedBy` | v2 |

**Labels in a filter.** The platform's `payloadFilter` is exact-match on a
string. `labels: "spec,requirements"` cannot be matched for "contains spec".
Two exact-match-friendly projections ride along instead: `label:<name>`
keys with value `"true"` for each label (so *Only when… `label:spec` =
`true`*) and, for `label_added`, the single `label` field. The key picker
lists `label:<name>` as a documented pattern (`example: "true"`). This is a
Confluence-payload convention, not a platform change.

`origin` (`human` | `agent`) on `page_updated`, `comment_added`,
`comment_resolved`: from the own-writes register (`<pageId>:v<n>` recorded
from the PUT response; comment ids from POST), fallback the attribution
marker in `version.message` / the comment's first paragraph. The docs say:
every `comment_added`/`page_updated` trigger carries `origin = human` unless
you know why not.

### 8.3 Manifest `events[]`

One entry per kind with every key described and an example; the trigger
form, key picker and help follow automatically. Parity test: `events[].name ⊆
KNOWN_EVENTS`; golden payload per kind asserted against the declared keys
(the same test shape as the Jira events plan §5).

## 9. What this plan deliberately does NOT do

- No storage-format XHTML authoring (ADF only). Old-macro edge cases render
  as placeholders; a page the converter cannot faithfully round-trip is still
  *readable*, and `update` on it is refused unless owned (it would be an
  agent page, so ADF-born).
- No two-way Jira↔Confluence sync. The `--jira` flag writes a macro and a
  label; the Jira plugin is unchanged. Cross-lookup is the `jira-<KEY>` label
  (CQL-searchable), not a content property (CQL cannot query those without an
  indexing app).
- No personal-space access, no space creation, no permission changes, no
  delete/move (§7).
- No webhook / Forge app.
- No page analytics, exports, templates API.
- Not a replacement for the `wiki` MCP server or the knowledge system (§2).

## 10. Rollout phases (each PR-sized, each shippable)

| Phase | Deliverable | Size | Gate |
|---|---|---|---|
| **0 — Spike** | `broker/spike.js` against a real site: CQL search with `space in`, page read as ADF, create/update with version message + property, footer + inline comment read, 429 handling. Notes into this doc. | S | Findings recorded (the Jira spike found the `expand`-must-be-a-string 400 — expect similar) |
| **1 — Read** | manifest (credentials, ui, no events), broker skeleton on the SDK, `confluence-client` reads, `cql.js`, watch-store (watches + default location), admin UI, credential push, CLI `spaces/search/show/tree/inbox(peek)`, `/` UI, `adf.js` read direction, Makefile/CI/Dockerfile wiring (hardcoded lists, Jira §8b), help topic, `docs/confluence-plugin.md` how-to. | L | agents can look things up; nothing writes |
| **2 — Write** | `adf.js` write direction, `ownership.js` + `aee` property + own-writes register, `create/update/propose/comment/resolve/label/properties`, `broker-policy`, attribution, `stale-version`, companion skill with the three templates, admin ownership register. | L | §5.1 and §5.6 work end to end; `update` on a human page is refused with the right hint |
| **3 — Events** | poller, extractors for `page_created/page_updated/comment_added` with `origin`, manifest `events[]`, activity log, watch-row checkboxes, `promptLine`, docs §"Give the agents a trigger". | L | §5.2–5.4 walkthrough on the test site; own comment never re-wakes an `origin = human` trigger |
| **4 — Organisation** | page-properties macro on `create --properties` + the report-page recipe in docs, `label_added`, inline-comment *create*, tasks (`tasks`, `task --complete`, `task_completed`), attachments, blog posts, mentions. | M | portfolio report renders from agent pages |
| **5 — Cross-cutting** | `aee-confluence search` as a `knowledge search` provider (Knowledge Phase 5 Style A); "copy credential from Jira" console nicety; lift the byte-identical stores into `broker-sdk/` (D4) once a third broker wants them. | M | deferred until asked |

Phase 1 is the honest MVP: most day-to-day value is reading, and nothing can
go wrong. Phase 2 before 3 because a wake without a way to act is noise.

## 11. Decisions

- **D1 — a separate plugin, separate credential entry** (§4). Same secret
  value allowed; no shared Atlassian credential object.
- **D2 — visibility is Confluence's, not the broker's.** The per-team token
  (§4) is the boundary; the broker adds no space allowlist on top, so reads
  work on whatever the token sees — the Jira model. The admin config only
  says what to *poll* (watches, space or subtree) and where to *write by
  default* (§6.3). An earlier draft made the watch list a read/write
  allowlist; dropped because it could only ever be narrower than the token,
  never safer than Confluence's own permissions, and would have to be kept
  in sync with them by hand.
- **D3 — ownership-tiered writes, refuse-and-propose over approval pen**
  (§7). `agent-editable` label = human consent per page.
- **D4 — copy, don't share, the stores in v1.** `inbox-store`, `activity-store`,
  `watch-health`, `viewer-headers` are copied byte-identical with a parity
  test (the viewer-headers precedent). Lifting them into `broker-sdk/` is a
  separate refactor once two consumers prove the seam — not on this plan's
  critical path.
- **D5 — ADF is the one body format, shared code lives in
  `plugins/_shared/atlassian-adf/`.** The registry skips `_`-prefixed dirs
  (`plugin-registry.js` `isPluginDirName`), both Dockerfiles `COPY` it beside
  `broker-sdk/`. The Jira events plan's `adfToText` (its PR 4) is the first
  resident; Confluence adds `markdownToAdf` / `adfToMarkdown`. One converter,
  two plugins, one test suite.
- **D6 — properties are written twice, on purpose.** The hidden content
  property (`aee`, machine-read: ownership/provenance) and the visible
  page-properties macro (human-read, feeds the report). Different audiences,
  different lifecycles; the CLI keeps the user-facing keys in sync.
- **D7 — per-kind fan-out from the first event PR**, per-issue→per-page
  conversation keys (`page:<id>`), shared across kinds (the Jira decision).
- **D8 — no drafts-as-review-gate.** A v2 draft is visible only to the token
  owner; `propose` (a labelled child page) is the visible, diffable
  alternative.

## 12. Open questions

- May an agent **resolve** an inline comment it did not open, on a page it
  does not own? Default in §7 is yes when it replied in the thread; the
  conservative alternative is "only on owned pages". Decide at Phase 2 with
  the first reviewer flow.
- **Comment body clamp** — same 2000-char default as Jira; inline comments
  also carry `anchorText` (the highlighted span, clamp 300).
- **`page_updated` granularity** — one event per observed version loses the
  intermediate ones; is a `versionsSkipped` count useful, or is "read the
  history with `show --versions`" enough?
- **A watch on a space the token cannot see** looks like "no events, ever"
  rather than an error (CQL just returns nothing). The admin UI validates
  each watch row's space key against `GET /spaces?keys=` on save (Phase 1),
  and watch health should flag a row whose space stopped resolving.
- **A token broader than the team** (a Team Admin who is also site admin)
  reaches other teams' spaces. Same situation as Jira, accepted the same way:
  the credential records `setBy`, the docs say to use a token whose owner's
  permissions match the team's, and the ownership tier still protects other
  teams' authored text from `update`.
- **Mentions** need account ids; user search exposes names/e-mails of the
  whole site to the broker — fine server-side, but never returned to the
  agent beyond the display name.

## 13. Deferred

- `comment_resolved`, `label_*`, `task_completed`, attachments, blog posts,
  mentions, inline-comment creation → Phase 4.
- Knowledge-search provider, credential copy, store lift → Phase 5.
- Whiteboards/databases/folders, analytics, Data Center — not planned.
