# Admin Console Reference

The Admin Console at `http://localhost:4000` (configurable via `.env`) is the central management interface for agents, environments, credentials, and integrations.

## Navigation

The left sidebar is organised into task-based collapsible accordion groups (#1595). **Agent Chat** sits at the top (ungrouped, always-visible). A persistent **+ Create** control sits above the groups — the single launcher (#1665, Phase B/C of epic #1661) for starting something new (describe it · start from a ready-made setup · build it yourself · one assistant to chat with · create a single agent, the direct form added in #1956); it replaced the former separate **Single Agent** and **Agent Team Wizard** sidebar entries (those pages remain reachable as launcher targets and via their `/quickstart` / `/team-setup` deep links). Below it four collapsible groups appear in workflow order: **Agent Setup** (Agents · Flows · Agent Templates · Skills · Knowledge · Triggers), **Connections** (Working Environments · Model Providers · MCP Servers · Plugins · SSH Keys · GitHub Tokens), **Insights** (Token Usage · GitHub Event Log), and **Administration** (Access · Maintenance Mode). A small always-visible **Account** cluster at the bottom holds My Credentials; there is no Help nav group — help lives in the header **Help** panel, whose "This page" face carries each page's help and whose Overview face carries the big-picture introduction that the retired `/getting-started` page used to hold (#1874). Help is not limited to pages: the **Settings** dialog has its own "?" and its own help topic (opening it shows the dialog's help, closing it returns the panel to the page underneath), the steps of the **Agent Team Wizard** show help for the step you are on rather than one whole-wizard blob, and the **first-run setup** screen — which renders before the console shell exists, so the panel is not mounted — shows the same model-provider / SSH-key / GitHub-token help inline under each step (#1892). The group containing the active page auto-expands; collapse state persists per user in `localStorage` under `nav.collapsedGroups.<username>`. Installed UI plugins appear as an additional collapsible **Plugins** group at the end of the accordion list (collapsed by default, so a long plugin list folds away); the bottom Account cluster stays pinned in view below the scrolling list. A group or cluster with no visible items for the current role renders no header (role gating is unchanged: `adminOnly` = System Admin; `credAdmin` = System Admin or Team Admin).

| Page | Route | Purpose |
|---|---|---|
| **Agent Chat** | `/` (redirects to `/chats`) | 1:1 chat with any agent; session log; workspace browser; trigger editor — the console's entry page |
| **Create** | `/create` | The unified creation launcher (#1665): equally-ranked entries — *Describe what you need* (Flow Copilot), *Start from a ready-made setup* (template registry via the wizard), *Build it yourself* (blank Flows draft), *Just give me one assistant to chat with* (the one-assistant fast lane — a single agent is simply a team of one, #1667) — plus *Create a single agent* (#1956), the direct create form, hosted here in a side panel on `?form=agent` rather than on a route of its own. That fifth entry is the one place the launcher names the artifact: it is the "I know exactly what I want" path, so #1665's jargon-free-titles rule is deliberately scoped to the four intent tiles. Opened from the persistent **+ Create** sidebar control or this route |
| **Agents** | `/agents` | Manage the agents and teams you already have (edit, enable/disable, delete, export, clone, save as template, add members/roles); creation and import stay here as advanced affordances, but the primary "create" path is the **+ Create** launcher (#1661 Phase F) |
| **Working Environments** | `/environments` | Reusable workspace recipes (repos, GitHub token, model provider, MCP servers) |
| **My Credentials** | `/my-credentials` | Self-service surface (any authenticated human, no `credAdmin` gate) to create/rotate/rename/delete your own **personal** SSH key and GitHub token; private to you (epic #1558). All three credential pages share **one** help topic; each header's **?** opens it at that page's own chapter (#1993) |
| **SSH Keys** | `/ssh-keys` | Register team/system SSH key pairs for private repository access (personal keys live on My Credentials) |
| **GitHub Tokens** | `/github-tokens` | Register team/system GitHub PATs for the GitHub event poller and HTTPS repository access (personal tokens live on My Credentials) |
| **Skills Registry** | `/skills` | Browse available skills; click to view skill content. The page's concept help (what a skill is, the Global/Team/Agent tiers, grant vs activation vs *Install into agent*, the promote/move/adopt/distill/merge/import-export actions, what an overwrite replaces) lives in the Help panel's "This page" face, and each action area carries its own **?** that opens the help at that verb's chapter rather than the top of the topic (#1990) |
| **Model Providers** | `/models` | Register and test model providers; discover available models; set per-agent model overrides |
| **MCP Servers** | `/mcp` | Manage the MCP server registry and credentials; the **Credential** column shows *required* for servers whose template uses `${credential}`, which the orchestrator substitutes from the Working Environment binding at seed time |
| **Plugins** | `/plugins` | Install/uninstall governed capability plugins into the operator registry (System-Admin only; declared capabilities reviewed in plain language before the confirm). Each **installed** card also carries a team-assignment control (#1691) to grant/revoke the plugin for one or more teams directly — reuses the existing team activation path, applies immediately, and shows which teams already have it. The page's concept help (what a plugin is, install vs grant, permissions, plugins with their own UI, and a build-a-plugin deep dive) lives in the Help panel's "This page" face — the standalone `/plugin-system` page was removed in #1879 |
| **Users** | `/users` | Dedicated full-page user management (#1844, System-Admin only): a sortable/filterable list of all human users with **Create** and **Edit** dialogs (edit display name, email and System-Admin status; the immutable `subject` is shown read-only), set/clear login password, and delete. Split out of the former slide-out on the **Access** page so users are managed end-to-end in one place |
| **Access** | `/teams` | Manage human access scopes (**Teams**, the tenant): team CRUD, per-team roles, and assigning agents/environments to a team. User *records* now live on the dedicated **Users** page (#1844); this page links to it. Renamed from "Teams" to "Access & Users" (#1726) to avoid confusion with the *Agent Team* squad, then shortened to "Access" (#1910) once user records moved to the **Users** page; the route, API and internal entity stay `team` |
| **Flows** | `/flows` | Design and run orchestration flow graphs: inspect live Teams, author Drafts, use Flow Copilot; BriefingPack flows (orchestrator-managed BP dependency graphs) are a niche secondary mode |

## Authentication (#276)

The entire console is served behind a login screen — no page or `/api/*` data
endpoint is reachable without an active session. This is the minimal,
SSO-ready auth foundation described in [docs/multi-user-concept.md](./multi-user-concept.md).

**Login.** A single credential pair, read from environment variables so it can
change without a redeploy:

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Console login username |
| `ADMIN_PASSWORD` | `admin` | Console login password |
| `AUTH_SESSION_SECRET` | derived from the credentials | Signs session cookies. When unset, a stable secret is derived from the credentials, so sessions survive a server restart and are auto-invalidated when the password changes. Set an explicit value to rotate sessions independently. |
| `AUTH_COOKIE_SECURE` | `false` | Set to `true` only when the console is served over HTTPS (adds the cookie's `Secure` attribute). |

> The defaults (`admin` / `admin`) are for first-boot local use only — change
> them for any shared deployment. This is a placeholder until enterprise SSO
> replaces the credential check.

**Session.** On successful login the server issues an HMAC-signed, stateless
session token in an **HttpOnly, SameSite=Lax cookie** (`aee_session`, 7-day
TTL). A browser refresh re-validates via `GET /api/auth/session` rather than
re-prompting. A **Logout** item in the header **account menu** (#1802 — the
user-anchored control in the top-right cluster, alongside a **Settings** item)
clears the cookie and returns to the login screen; an expired session (any
`401`) does the same automatically.

**API surface** (all public — everything else under `/api` requires the cookie):
- `POST /api/auth/login` — `{ username, password }` → sets the cookie, or `401` with an inline error.
- `GET /api/auth/session` — `{ authenticated, user }`.
- `POST /api/auth/logout` — clears the cookie.

**Per-user local passwords (#374, interim).** Human users created on the **Users**
page (#1844) can be given a local password (Users → Edit → Login password),
letting more than one person log in before SSO lands. Login then
resolves in two steps: first the **user store** (match by `subject`, verify a
salted **scrypt** hash held in the user record and never returned by any API),
then the **env single-admin** credential. Key properties:

- A per-user session's subject is the user's `subject`, so the audit trail (#305)
  names the real person.
- The env `ADMIN_USERNAME`/`ADMIN_PASSWORD` **always** works — the per-user check
  is best-effort and calls the orchestrator's internal user store; if that store
  is unreachable, login falls through to the env admin (no operator lock-out).
- This is explicitly interim and is superseded by SSO (#307); there is no
  self-service signup, reset, policy, or MFA.

**SSO swap-point.** The credential check lives in a single `verifyCredentials()`
function in `admin-console/api/auth.js` (with the per-user store check alongside
it in the login route). Swapping it for an OIDC/SAML token exchange (and adding
the IdP callback route) requires no change to the session format, cookie
handling, gate middleware, or the login UI/routing.

## Access (#308, renamed #1726, #1910)

The **Access** page (`/teams`) is the UI for the human **Team** scope
(the tenant) introduced by the teams data model (#299). It is distinct from the
*Agent Team* squad created by the **Agent Team Wizard** — see
[docs/teams-data-model.md](./teams-data-model.md). The section was renamed from
"Teams" to "Access & Users" (#1726) because users kept confusing it with the
*Agent Team* construct, and shortened to "Access" (#1910) once user records
moved to their own **Users** page; both are UI-label renames only — the `/teams` route, the `/api/admin/{teams,…}`
endpoints and the internal **Team** entity are unchanged.

A System Admin can:
- **Team CRUD** — create / edit / delete teams. The `default` team cannot be deleted.
- **Manage Users** — a **Manage Users** button links to the dedicated **Users** page (`/users`, #1844) where human user records (keyed by a stable `subject` an SSO login will later map onto) are created, edited (display name / email / System-Admin), given a login password, and deleted. The former in-page "Manage users" slide-out was removed so there is a single place to manage users.
- **Members & roles** — per team, add/remove human members and set their per-team role (**Team Admin** / **Team Member**). Membership is an upsert: re-adding a user updates their role.
- **Resource ownership** — reassign any agent or Working Environment to a team via a per-row team selector. Agents reassign through `PUT /api/agents/:id { teamId }`, environments through `PUT /api/environments/:id { teamId }`; both validate the target team exists.

The page is built on the `/api/admin/{teams,users,memberships}` endpoints
(proxied to the orchestrator's teams store). Per-role *enforcement* of these
actions — and per-resource visibility — arrive with later tickets (#302/#304);
today any authenticated operator can manage teams.

## Agent Teams — the missing-role suggestion was removed (#1959)

The platform used to guess which "loop-closing" role an **Agent Team** was
missing and offer a one-click **Add `<role>` role** (#1375): a warning block on
the expanded team card on `/agents`, and extra entries in the team's context menu
in Agent Chat. **That capability is gone as of #1959 — removed, not moved.**

- **Why.** It rested on an *inference*, because the team config never persists
  which process template it came from (`POST /api/teams` flattens the bundle into
  members and discards the template identity). The source template had to be
  guessed from the team's label registry and its members' ids, and the guess was
  conservative to the point of being unhelpful: on the teams where a gap was real
  it often matched nothing and showed nothing, and where it did match, "missing"
  was a statement about a template the team may deliberately have diverged from.
  A suggestion an operator cannot check is worse than no suggestion, and it was
  retired by requester decision rather than re-homed.
- **What replaces it.** Growing a team is now always an explicit choice:
  **Add member** (same menu, same `POST /api/agents/:teamId/members` route — it
  posts no body, so it takes the free-form branch and yields a blank
  `<teamId>-<n>` member inheriting the team's prompt), or wiring the role in the
  **Flow editor**, which is the surface that materialises a role *from a role
  template* (the route's `templateId` branch) and where the flow's actual gaps are
  visible as unconsumed labels and advisory lints rather than inferred. Both
  branches of the route are unchanged.
- **What went with it.** The pure inference module (`src/pages/missing-roles-view.js`),
  the team-card warning block, the `add-role:*` menu entries, and the
  `{ processTemplateId, roleId }` shape of `POST /api/agents/:teamId/members`.
  That request shape is now **refused** with a `400` and the code
  `process-template-role-removed` rather than quietly doing something else — a
  fall-through would have created a member named after the role but without the
  template's prompt, session policy or triggers.
- **Existing members are unaffected.** Anything added through the old branch keeps
  working exactly as before; only the way of creating new ones is gone. Nothing
  about the Team-Setup wizard, the Flow Editor's role handling or team creation
  changed.

## Audit trail (#305)

Every **mutating** API action (`POST`/`PUT`/`PATCH`/`DELETE` under `/api`)
produces one append-only audit entry naming the acting human — a separate log
from the Matrix chat history, which does not capture config mutations. See
[docs/multi-user-concept.md](./multi-user-concept.md) §7.

- **Storage:** append-only JSONL at `/workspace/audit/audit-<YYYY-MM-DD>.jsonl`
  (override the directory with `AUDIT_DIR`).
- **Each entry:** `ts`, `actor` (the logged-in username from #276, or the
  attempted username for a login, or `anonymous`), `action` (`<METHOD> <path>`),
  `method`, `resource`, `teamId` (when the request body carries one — full
  per-resource team attribution arrives with team scoping, #302), `status`,
  `outcome` (`success` / `denied` / `error`), and `ip`.
- **Coverage:** the logger is a global middleware, so it captures *all* mutating
  endpoints — agent create/delete, credential create/delete, skill promotion,
  handover, team-membership and environment changes — plus denied and
  unauthenticated attempts (`outcome: denied`).
- **Read API:** `GET /api/audit?limit=<n>` (protected; newest first, capped at 1000).

**Safety:** auditing is strictly best-effort. It runs from a response-`finish`
handler (after the response is already sent) and every file operation is
swallowed on error, so a logging failure can never block or break a request.

## Agent Chat

The Agent Chat page (`/chats/:agentId`) embeds a full Matrix chat client with a three-panel layout.

### Left panel — Agent list

Pick any enabled agent. The status indicator shows current state: **Unread** (new message), **Busy** (active run), **Idle** (waiting), **Disabled** (amber — intentionally off, one-click enable to resume), **Offline** (red — container not running), **Not initialised** (muted — a stub that was never provisioned; materialize it to chat, #1957).

Each row shows the agent's Working Environment name below its display name. Inside a team group whose members all share one environment, that name is shown once on the collapsible group header instead of repeating on every row; a member on a different environment keeps its own line. Standalone agents (outside any group) always show their own environment line.

Reorder the list by dragging the grip handle (⠿, visible on hover) to relocate an item in one gesture; keyboard users can reorder the focused item with `Alt+↑`/`Alt+↓`. Groups, standalone agents, and members within a group each reorder independently; a drag cannot move an item out of its own list. Order persists in `localStorage` (`agentChat.sidebarOrder`) and survives reload. Group and standalone-agent reorder require the **All agents** filter (the other groups/singles are hidden under a filter, so a move would be ambiguous); member-within-a-group reorder is additionally available under a **single-team** filter, since that view shows the team's complete ordered member set and writes the same order it would unfiltered (#1725).

Manage agents in place without a trip to `/agents` (#1928). Open a row's context menu — the kebab revealed on hover, a right-click, or `Menu`/`Shift+F10` from the keyboard — for **Enable/Disable**, **Settings**, **Clone**, **Export (ZIP)**, **Save as template** and the confirmation-guarded **Reset to stub** / **Delete**; a team group header offers the team-wide **Enable/Disable** fan-out (with a partial-failure report), **Add member**, **Team settings**, **Export team**, **Open in Flow Editor** and **Delete team** (the **Add `<role>` role** entries are gone — see *the missing-role suggestion was removed* above). The list-level **Import Agent** / **New Agent** actions sit in the Shell's page-action header like every other page's (#1956) — the rail **+** menu they replaced is gone, so neither is reachable from two places; **New Agent** hands over to the `/create` launcher, **Import Agent** opens the ZIP picker in one click and completes through the same import dialog, and the imported agent joins the list without a page reload (if the rail filter would hide it, the confirmation says so). Both are disabled with an honest reason for a caller who may not create agents, rather than hidden. The rail header row itself stays — it carries the filter, the disabled-agents opt-in and the list's "?" — and its empty state is now a text pointer at the header button instead of a competing call to action. Every action runs the *same* dialog, confirmation and request as its Agents-page counterpart, and an action you may not perform is shown inert with a reason rather than failing at the server. A **show disabled agents** toggle (off by default, remembered per user) additionally lists paused agents so they can be re-enabled from here; a disabled agent is marked as such and cannot be opened as a chat until it is enabled — its **Settings** entry still opens its configuration in the right rail, so it can be reconfigured while paused (#1929). The same menu also leads with a chat-only **Mark as unread** entry — it flips the row back to its unread indicator and, unlike the management actions below it, never depends on your permissions; it is greyed out rather than hidden when it does not apply (the row is already unread, or is disabled/offline and has no chat to open). It replaces the mail icon that used to appear on row hover, so the drag grip no longer shifts sideways when you hover a row (#1938). The menu closes with a **What these actions do…** entry that opens the Help panel at the agent-list chapter of the Agent Chat topic — a menu cannot host the shared "?" button, so the affordance is an entry; it is always enabled, since it changes nothing (#1972). A team created with **deferred materialization** (`materializeMembers: false`, #1955) no longer reads as empty here: each team group ends with a collapsed **Not materialized yet (N)** section listing its **stub** members — configuration and triggers only, no chat account, no workspace, no clone — with the count visible without expanding, and no section at all for a team that has none (#1957). A stub row is badged *Not initialised* (the Agents page's own word) with its own muted status dot, so it is never mistaken for a *paused* agent, and it cannot be opened as a chat because there is no chat account to open. Its menu offers **Materialize** in place of *Enable* — the same request the Agents page's **Activate** button sends, so the resulting agent is indistinguishable from one materialized at team-create time; the row shows it working (a role with repositories clones them now) and moves up into the active members on success, without a reload. *Stub* and *paused* are different states: the show-disabled opt-in has no effect on this section. A stub whose team is disabled gets an inert **Materialize** with *enable the team first*, as does a caller who may not manage it.

### Middle panel — Chat

Markdown rendering with syntax-highlighted code blocks (dual light/dark themes), sticky scroll, scroll-up backfill of older messages, and optimistic send. The session toolbar offers (session-active status is not repeated here — it is shown per agent in the left list):

- **Reset Session** — drop the session pointer so the next message starts fresh (the primary, always-visible button). There is no manual "save to memory" action: the agent is instructed to consolidate its memory files and share durable lessons with the team knowledge base on *every* invocation, so consolidation never has to be asked for.
- **`…` (More session actions)** — a keyboard-accessible overflow menu holding the rare, destructive actions:
  - **Clear History** — permanently delete all messages in this chat (asks for confirmation first)

### Right rail — Tabs

Toggle with `Cmd/Ctrl+Shift+L`.

| Tab | What it shows |
|---|---|
| **Session Log** | Structured timeline of internal activity: tool calls, assistant text, errors, timings. Tool-use/tool-result pairs are folded into collapsible blocks. Filter by All / Tool Calls / Errors / Posted. |
| **Workspace Browser** | Lazy-loading file tree of the agent's workspace directory. Click any text file to view its content (up to 512 KB). Hover over any file row to reveal a per-file **Download** button (works for binary files too; no size cap) and a **Reference in chat** (@) button that splices a `@<workspace-relative-path>` token for that file into the current agent's composer draft — the same reference convention an upload produces, so the agent resolves it without re-uploading (files only, never directories or `/context` host-mount rows). Supports file upload to the workspace (up to 500 files) and one-click ZIP export of the entire workspace. Binary files are flagged rather than displayed as garbage. |
| **Triggers** | Inline editor for the agent's trigger schedule. Add, edit, or delete any trigger type; shows next execution time, last run status, and the webhook secret for HTTP triggers. |
| **Settings** | The agent's configuration, where you see its effect (#1929) — the *same* form the Agents page's edit panel renders (display name, system prompt including a team member's Inherit / Additional input / Exclusive override modes, skills, MCP overrides, plugin grants, host context folders, repositories with **Sync repositories**). Saving goes through the same `PUT /api/agents/:id`, so an identical edit yields an identical stored config. Plugin grants and context folders keep their immediate-apply semantics; only in the chat, a context-folder change asks for confirmation first, because the re-provision it triggers ends the run you are watching. Unsaved edits are **preserved per agent** for the rest of the session: switching agents and back finds the form as you left it, behind an "unsaved changes" banner with a **Discard changes** button. Hidden for a caller who may not manage the agent. Normally the open chat's agent — a rail menu can point it at another one: **Team settings** on a group header edits the team agent, and **Settings** on a disabled row edits an agent that has no chat to open (a **Back** control returns it to the conversation). |

## Session Pinning

After every successful Claude run, the session ID is saved to a per-room pointer file. The next message resumes with `--resume <sessionId>` so Claude keeps the conversation in context. If the session is stale (e.g. after a CLI upgrade), the runner clears the pointer and retries once without it. Session pointers survive orchestrator restarts.

## Agent Export / Import

Agents can be snapshotted as a ZIP and restored on any compatible AEE instance.

**Export** — click the **Export** (download) icon on any agent card in `/agents`, or the download button in the Workspace Browser toolbar. The ZIP contains the full agent workspace (excluding `sessions/`) plus a `manifest.json` with the agent id, export timestamp, and the orchestrator image name/tag/digest recorded at export time.

API: `GET /api/agents/:id/export` → streams `agent-<id>-export.zip`.

**Import** — click **Import Agent** at the top-right of `/agents` or of Agent Chat (`/chats`, #1956) and select a ZIP produced by export. Both surfaces open the same dialog with two optional choices:

- **New Agent ID** — import the agent under a different id. Leave blank to keep the exported id. If that id is already taken the dialog surfaces the conflict and pre-fills a non-colliding suggestion, so you can re-id and retry without re-selecting the file.
- **Assign to Team** — graft the imported agent into an existing team as a `team-member`. It inherits the team's working environment but keeps its own imported system prompt as a per-member override — the **Exclusive overriding input** prompt mode (so a later team-prompt edit won't overwrite it; a member can instead be switched to **Inherit from team** or **Additional input** in its edit form, #1511). Leave as *Standalone* to import it as an independent `agent`.

The imported workspace (memory, skills, repo clone, prompt files) is preserved 1:1 — nothing the agent learned is re-seeded away. A **fresh Matrix identity** is provisioned on import (the exported credentials belong to the source homeserver and are dropped), and the agent is started immediately — open it in Agent Chat.

API: `POST /api/agents/import` (multipart, max 500 MB). Fields: `file` (the ZIP), optional `newId`, optional `parentTeamId`. → `201 { agentId, role, parentTeamId, image }`. On an id collision the response is `409 { error, code: "id-conflict", agentId }`. The admin-console stages the workspace on the shared volume and hands provisioning off to the orchestrator (`POST /internal/agents/import`), which owns the agent map and Matrix admin client.

## Hover Correlation

Every session log event carries the `correlationId` of the originating Matrix message (or a synthetic `trigger:<id>:<ts>` for scheduled runs). Hovering a chat bubble dims non-matching log rows, and vice versa — making it easy to trace which tool calls produced which reply.
