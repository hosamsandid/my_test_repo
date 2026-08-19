# Admin Console Reference

The Admin Console at `http://localhost:4000` (configurable via `.env`) is the central management interface for agents, environments, credentials, and integrations.

## Navigation

The left sidebar is organised into task-based collapsible accordion groups (#1595). **Agent Chat** sits at the top (ungrouped, always-visible). A persistent **+ Create** control sits above the groups — the single launcher (#1665, Phase B/C of epic #1661) for starting something new (describe it · start from a ready-made setup · build it yourself · one assistant to chat with); it replaced the former separate **Single Agent** and **Agent Team Wizard** sidebar entries (those pages remain reachable as launcher targets and via their `/quickstart` / `/team-setup` deep links). Below it four collapsible groups appear in workflow order: **Agent Setup** (Agents · Flows · Agent Templates · Skills · Knowledge · Triggers), **Connections** (Working Environments · Model Providers · MCP Servers · Plugins · SSH Keys · GitHub Tokens · Jira Credentials), **Insights** (Token Usage · GitHub Event Log), and **Administration** (Access & Users · Maintenance Mode). Small always-visible clusters at the bottom hold **Help** (Getting Started) and **Account** (My Credentials). The group containing the active page auto-expands; collapse state persists per user in `localStorage` under `nav.collapsedGroups.<username>`. Installed UI plugins appear as an additional collapsible **Plugins** group at the end of the accordion list (collapsed by default, so a long plugin list folds away); the bottom Help/Account clusters stay pinned in view below the scrolling list. A group or cluster with no visible items for the current role renders no header (role gating is unchanged: `adminOnly` = System Admin; `credAdmin` = System Admin or Team Admin).

| Page | Route | Purpose |
|---|---|---|
| **Agent Chat** | `/` (redirects to `/chats`) | 1:1 chat with any agent; session log; workspace browser; trigger editor — the console's entry page |
| **Create** | `/create` | The unified creation launcher (#1665): equally-ranked entries — *Describe what you need* (Flow Copilot), *Start from a ready-made setup* (template registry via the wizard), *Build it yourself* (blank Flows draft), *Just give me one assistant to chat with* (the one-assistant fast lane — a single agent is simply a team of one, #1667). Opened from the persistent **+ Create** sidebar control or this route |
| **Getting Started** | `/getting-started` | Persistent concept overview (Agents, Access & Users, Flows, Environments, Knowledge, Model Providers) — always-reachable alternative to the one-time setup wizard; also linked from the Agent Chat empty state |
| **Plugin System** | `/plugin-system` | Persistent, self-contained concept/help page — what a plugin is, how it works technically, typical use cases, and how to build one; ungated (any authenticated user); **no sidebar nav entry** — reached via the "Learn about plugins" link on the Plugins page (#1638); direct links and bookmarks still work |
| **Agents** | `/agents` | Manage the agents and teams you already have (edit, enable/disable, delete, export, clone, save as template, add members/roles); creation and import stay here as advanced affordances, but the primary "create" path is the **+ Create** launcher (#1661 Phase F) |
| **Working Environments** | `/environments` | Reusable workspace recipes (repos, GitHub token, model provider, MCP servers) |
| **My Credentials** | `/my-credentials` | Self-service surface (any authenticated human, no `credAdmin` gate) to create/rotate/rename/delete your own **personal** SSH key and GitHub token; private to you (epic #1558) |
| **SSH Keys** | `/ssh-keys` | Register team/system SSH key pairs for private repository access (personal keys live on My Credentials) |
| **GitHub Tokens** | `/github-tokens` | Register team/system GitHub PATs for the GitHub event poller and HTTPS repository access (personal tokens live on My Credentials) |
| **Jira Credentials** | `/jira-tokens` | Register Jira site + email + API token credentials for the Jira event poller |
| **Skills Registry** | `/skills` | Browse available skills; click to view skill content |
| **Scheduled Jobs** | `/jobs` | Cross-agent view of all triggers; add/edit/delete cron, one-shot, webhook, GitHub event, and Jira event triggers. Cron and one-shot (`once`) triggers also show a plain-language schedule (e.g. *"At 09:00, on Monday to Friday"* for cron, *"1 May 2026 at 09:00 UTC"* for a one-shot) — under each row in the table and as a live *Runs: …* / *Runs once: …* preview in the editor — so the page is readable without cron or ISO-timestamp knowledge, matching the plain-language confirmation the Agent-Chat trigger builder already gives (#1732, #1744). GitHub event triggers likewise show friendly event names (e.g. *"PR opened"*, *"Issue labeled"* instead of `pull_request.opened`, `issues.labeled`) — in the table and on the event-picker chips (raw keys kept on hover / as a muted sub-line) — via the same shared `eventLabel()` humanizer the trigger card and Event Log use |
| **Model Providers** | `/models` | Register and test model providers; discover available models; set per-agent model overrides |
| **MCP Servers** | `/mcp` | Manage the MCP server registry and credentials; the **Credential** column shows *required* for servers whose template uses `${credential}`, which the orchestrator substitutes from the Working Environment binding at seed time |
| **Plugins** | `/plugins` | Install/uninstall governed capability plugins into the operator registry (System-Admin only; declared capabilities reviewed in plain language before the confirm). Each **installed** card also carries a team-assignment control (#1691) to grant/revoke the plugin for one or more teams directly — reuses the existing team activation path, applies immediately, and shows which teams already have it; links to the Plugin System help page |
| **Access & Users** | `/teams` | Manage human access scopes (**Teams**, the tenant) and users: team CRUD, users, per-team roles, and assigning agents/environments to a team. Renamed from "Teams" (#1726) to avoid confusion with the *Agent Team* squad; the route, API and internal entity stay `team` |
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
re-prompting. A **Sign out** button in the header clears the cookie and returns
to the login screen; an expired session (any `401`) does the same automatically.

**API surface** (all public — everything else under `/api` requires the cookie):
- `POST /api/auth/login` — `{ username, password }` → sets the cookie, or `401` with an inline error.
- `GET /api/auth/session` — `{ authenticated, user }`.
- `POST /api/auth/logout` — clears the cookie.

**Per-user local passwords (#374, interim).** Human users created on the Access & Users
page (#308) can be given a local password (Access & Users → Manage Users → the
🔑 button), letting more than one person log in before SSO lands. Login then
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

## Access & Users (#308, renamed #1726)

The **Access & Users** page (`/teams`) is the UI for the human **Team** scope
(the tenant) introduced by the teams data model (#299). It is distinct from the
*Agent Team* squad created by the **Agent Team Wizard** — see
[docs/teams-data-model.md](./teams-data-model.md). The section was renamed from
"Teams" (#1726) because users kept confusing it with the *Agent Team* construct;
this is a UI-label rename only — the `/teams` route, the `/api/admin/{teams,…}`
endpoints and the internal **Team** entity are unchanged.

A System Admin can:
- **Team CRUD** — create / edit / delete teams. The `default` team cannot be deleted.
- **Manage Users** — create human users (keyed by a stable `subject` an SSO login will later map onto), toggle the global **System Admin** flag, and delete users (their memberships cascade).
- **Members & roles** — per team, add/remove human members and set their per-team role (**Team Admin** / **Team Member**). Membership is an upsert: re-adding a user updates their role.
- **Resource ownership** — reassign any agent or Working Environment to a team via a per-row team selector. Agents reassign through `PUT /api/agents/:id { teamId }`, environments through `PUT /api/environments/:id { teamId }`; both validate the target team exists.

The page is built on the `/api/admin/{teams,users,memberships}` endpoints
(proxied to the orchestrator's teams store). Per-role *enforcement* of these
actions — and per-resource visibility — arrive with later tickets (#302/#304);
today any authenticated operator can manage teams.

## Agent Teams — surfacing missing blueprint roles (#1375)

An **Agent Team** assembled piecewise from a reference process template (dev +
reviewer only, say) runs part of the SDLC loop and then stalls at the first
missing role's terminal label — a missing `merger` leaves `ready-to-merge` idle
(the final merge stays a manual click); a missing `reworker` leaves
`revisions-required` idle. The Agents page (`/agents`) surfaces that gap on the
expanded **Agent Team** card: below the member list it lists the roles the team
is missing relative to its source template, each with an **Add `<role>` role**
button.

- **Source-template inference.** The team config does *not* persist which template
  it came from (`POST /api/teams` flattens the bundle into members and discards the
  template identity). It is inferred client-side (pure `src/pages/missing-roles-view.js`,
  unit-tested) from two signals the team agent *does* persist: the gate/brake **label
  registry** (`team.labels[]`, #928 — the strongest fingerprint, since each shipped
  template has a distinct registry; matched by containment, suffix-stripped for #902)
  and the **present member role-ids** (recovered from each member id `<teamId>-<roleId>`).
  When nothing clearly matches, nothing is shown — the hint is purely additive, so
  unrelated or fully-covered teams sprout no buttons.
- **Which roles are missing** is decided once the template is known, by a template-
  aware, display-name-aware fulfilment check (`fulfilledRoleIds`, #1556) so a role a
  member visibly provides is never offered: a template role whose id ends in a digit
  (`developer-2`) is recognised as its own role and not collapsed onto the base
  (`developer`); a genuine second instance (`<teamId>-<roleId>-<n>` where only the base
  is a template role) still counts the base present; and a member whose id does not
  encode the template role id (a clone, a doubled `agent-` prefix) is matched to its
  role by display name.
- **One-click add.** The button reuses the existing member-create endpoint via its
  process-template branch — `POST /api/agents/:teamId/members { processTemplateId, roleId }`
  — which mirrors the Team-Setup wizard's per-role materialisation (systemPrompt +
  `{{var}}` substitution, `sessionPolicy`, triggers with repo/claim/transport, the
  team's own `labelSuffix`) for that one role, so the added member is identical to one
  created at team-setup time. The new member is then **disabled** (`PUT enabled:false`)
  so nothing wakes until the operator enables it; a toast confirms.

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

Pick any enabled agent. The status indicator shows current state: **Unread** (new message), **Busy** (active run), **Idle** (waiting), **Disabled** (amber — intentionally off, one-click enable to resume), **Offline** (red — container not running).

Each row shows the agent's Working Environment name below its display name. Inside a team group whose members all share one environment, that name is shown once on the collapsible group header instead of repeating on every row; a member on a different environment keeps its own line. Standalone agents (outside any group) always show their own environment line.

Reorder the list by dragging the grip handle (⠿, visible on hover) to relocate an item in one gesture; keyboard users can reorder the focused item with `Alt+↑`/`Alt+↓`. Groups, standalone agents, and members within a group each reorder independently; a drag cannot move an item out of its own list. Order persists in `localStorage` (`agentChat.sidebarOrder`) and survives reload. Group and standalone-agent reorder require the **All agents** filter (the other groups/singles are hidden under a filter, so a move would be ambiguous); member-within-a-group reorder is additionally available under a **single-team** filter, since that view shows the team's complete ordered member set and writes the same order it would unfiltered (#1725).

### Middle panel — Chat

Markdown rendering with syntax-highlighted code blocks (dual light/dark themes), sticky scroll, scroll-up backfill of older messages, and optimistic send. The session toolbar offers (session-active status is not repeated here — it is shown per agent in the left list):

- **Reset Session** — drop the session pointer so the next message starts fresh
- **Save & Learn** — summarize the conversation to memory and push durable lessons to the team knowledge base; the session stays open

### Right rail — Three tabs

Toggle with `Cmd/Ctrl+Shift+L`.

| Tab | What it shows |
|---|---|
| **Session Log** | Structured timeline of internal activity: tool calls, assistant text, errors, timings. Tool-use/tool-result pairs are folded into collapsible blocks. Filter by All / Tool Calls / Errors / Posted. |
| **Workspace Browser** | Lazy-loading file tree of the agent's workspace directory. Click any text file to view its content (up to 512 KB). Hover over any file row to reveal a per-file **Download** button (works for binary files too; no size cap) and a **Reference in chat** (@) button that splices a `@<workspace-relative-path>` token for that file into the current agent's composer draft — the same reference convention an upload produces, so the agent resolves it without re-uploading (files only, never directories or `/context` host-mount rows). Supports file upload to the workspace (up to 500 files) and one-click ZIP export of the entire workspace. Binary files are flagged rather than displayed as garbage. |
| **Triggers** | Inline editor for the agent's trigger schedule. Add, edit, or delete any trigger type; shows next execution time, last run status, and the webhook secret for HTTP triggers. |

## Session Pinning

After every successful Claude run, the session ID is saved to a per-room pointer file. The next message resumes with `--resume <sessionId>` so Claude keeps the conversation in context. If the session is stale (e.g. after a CLI upgrade), the runner clears the pointer and retries once without it. Session pointers survive orchestrator restarts.

## Agent Export / Import

Agents can be snapshotted as a ZIP and restored on any compatible AEE instance.

**Export** — click the **Export** (download) icon on any agent card in `/agents`, or the download button in the Workspace Browser toolbar. The ZIP contains the full agent workspace (excluding `sessions/`) plus a `manifest.json` with the agent id, export timestamp, and the orchestrator image name/tag/digest recorded at export time.

API: `GET /api/agents/:id/export` → streams `agent-<id>-export.zip`.

**Import** — click **Import Agent** at the top-right of `/agents` and select a ZIP produced by export. An import dialog opens with two optional choices:

- **New Agent ID** — import the agent under a different id. Leave blank to keep the exported id. If that id is already taken the dialog surfaces the conflict and pre-fills a non-colliding suggestion, so you can re-id and retry without re-selecting the file.
- **Assign to Team** — graft the imported agent into an existing team as a `team-member`. It inherits the team's working environment but keeps its own imported system prompt as a per-member override — the **Exclusive overriding input** prompt mode (so a later team-prompt edit won't overwrite it; a member can instead be switched to **Inherit from team** or **Additional input** in its edit form, #1511). Leave as *Standalone* to import it as an independent `agent`.

The imported workspace (memory, skills, repo clone, prompt files) is preserved 1:1 — nothing the agent learned is re-seeded away. A **fresh Matrix identity** is provisioned on import (the exported credentials belong to the source homeserver and are dropped), and the agent is started immediately — open it in Agent Chat.

API: `POST /api/agents/import` (multipart, max 500 MB). Fields: `file` (the ZIP), optional `newId`, optional `parentTeamId`. → `201 { agentId, role, parentTeamId, image }`. On an id collision the response is `409 { error, code: "id-conflict", agentId }`. The admin-console stages the workspace on the shared volume and hands provisioning off to the orchestrator (`POST /internal/agents/import`), which owns the agent map and Matrix admin client.

## Hover Correlation

Every session log event carries the `correlationId` of the originating Matrix message (or a synthetic `trigger:<id>:<ts>` for scheduled runs). Hovering a chat bubble dims non-matching log rows, and vice versa — making it easy to trace which tool calls produced which reply.
