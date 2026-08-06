# Admin Console Reference

The Admin Console at `http://localhost:4000` (configurable via `.env`) is the central management interface for agents, environments, credentials, and integrations.

## Navigation

| Page | Route | Purpose |
|---|---|---|
| **Agent Chat** | `/` (redirects to `/chats`) | 1:1 chat with any agent; session log; workspace browser; trigger editor — the console's entry page |
| **Getting Started** | `/getting-started` | Persistent concept overview (Agents, Teams, Flows, Environments, Knowledge, Model Providers) — always-reachable alternative to the one-time setup wizard; also linked from the Agent Chat empty state |
| **Agents** | `/agents` | Create, edit, enable/disable, delete, export, and import agents |
| **Working Environments** | `/environments` | Reusable workspace recipes (skills, repos, GitHub token, model provider) |
| **SSH Keys** | `/ssh-keys` | Register SSH key pairs for private repository access |
| **GitHub Tokens** | `/github-tokens` | Register GitHub PATs for the GitHub event poller and HTTPS repository access |
| **Skills Registry** | `/skills` | Browse available skills; click to view skill content |
| **Scheduled Jobs** | `/jobs` | Cross-agent view of all triggers; add/edit/delete cron, one-shot, webhook, and GitHub event triggers |
| **Model Providers** | `/models` | Register and test model providers; discover available models; set per-agent model overrides |
| **MCP Servers** | `/mcp` | Manage the MCP server registry and credentials; the **Credential** column shows *required* for servers whose template uses `${credential}`, which the orchestrator substitutes from the Working Environment binding at seed time |
| **Teams** | `/teams` | Manage human **Teams** (tenant scope): team CRUD, users, per-team roles, and assigning agents/environments to a team |
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

**Per-user local passwords (#374, interim).** Human users created on the Teams
page (#308) can be given a local password (Teams → Manage Users → the
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

## Teams (#308)

The **Teams** page (`/teams`) is the UI for the human **Team** scope (the
tenant) introduced by the teams data model (#299). It is distinct from the
*Agent Team* squad created by the **Agent Team Wizard** — see
[docs/teams-data-model.md](./teams-data-model.md).

A System Admin can:
- **Team CRUD** — create / edit / delete teams. The `default` team cannot be deleted.
- **Manage Users** — create human users (keyed by a stable `subject` an SSO login will later map onto), toggle the global **System Admin** flag, and delete users (their memberships cascade).
- **Members & roles** — per team, add/remove human members and set their per-team role (**Team Admin** / **Team Member**). Membership is an upsert: re-adding a user updates their role.
- **Resource ownership** — reassign any agent or Working Environment to a team via a per-row team selector. Agents reassign through `PUT /api/agents/:id { teamId }`, environments through `PUT /api/environments/:id { teamId }`; both validate the target team exists.

The page is built on the `/api/admin/{teams,users,memberships}` endpoints
(proxied to the orchestrator's teams store). Per-role *enforcement* of these
actions — and per-resource visibility — arrive with later tickets (#302/#304);
today any authenticated operator can manage teams.

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

Reorder the list by dragging the grip handle (⠿, visible on hover) to relocate an item in one gesture; keyboard users can reorder the focused item with `Alt+↑`/`Alt+↓`. Groups, standalone agents, and members within a group each reorder independently; a drag cannot move an item out of its own list. Order persists in `localStorage` (`agentChat.sidebarOrder`) and survives reload. Reordering is disabled while a filter is active.

### Middle panel — Chat

Markdown rendering with syntax-highlighted code blocks (dual light/dark themes), sticky scroll, scroll-up backfill of older messages, and optimistic send. The session toolbar shows whether a Claude session is active and offers:

- **Reset Session** — drop the session pointer so the next message starts fresh
- **Save & Learn** — summarize the conversation to memory and push durable lessons to the team knowledge base; the session stays open

### Right rail — Three tabs

Toggle with `Cmd/Ctrl+Shift+L`.

| Tab | What it shows |
|---|---|
| **Session Log** | Structured timeline of internal activity: tool calls, assistant text, errors, timings. Tool-use/tool-result pairs are folded into collapsible blocks. Filter by All / Tool Calls / Errors / Posted. |
| **Workspace Browser** | Lazy-loading file tree of the agent's workspace directory. Click any text file to view its content (up to 512 KB). Hover over any file row to reveal a per-file **Download** button (works for binary files too; no size cap). Supports file upload to the workspace (up to 500 files) and one-click ZIP export of the entire workspace. Binary files are flagged rather than displayed as garbage. |
| **Triggers** | Inline editor for the agent's trigger schedule. Add, edit, or delete any trigger type; shows next execution time, last run status, and the webhook secret for HTTP triggers. |

## Session Pinning

After every successful Claude run, the session ID is saved to a per-room pointer file. The next message resumes with `--resume <sessionId>` so Claude keeps the conversation in context. If the session is stale (e.g. after a CLI upgrade), the runner clears the pointer and retries once without it. Session pointers survive orchestrator restarts.

## Agent Export / Import

Agents can be snapshotted as a ZIP and restored on any compatible AEE instance.

**Export** — click the **Export** (download) icon on any agent card in `/agents`, or the download button in the Workspace Browser toolbar. The ZIP contains the full agent workspace (excluding `sessions/`) plus a `manifest.json` with the agent id, export timestamp, and the orchestrator image name/tag/digest recorded at export time.

API: `GET /api/agents/:id/export` → streams `agent-<id>-export.zip`.

**Import** — click **Import Agent** at the top-right of `/agents` and select a ZIP produced by export. An import dialog opens with two optional choices:

- **New Agent ID** — import the agent under a different id. Leave blank to keep the exported id. If that id is already taken the dialog surfaces the conflict and pre-fills a non-colliding suggestion, so you can re-id and retry without re-selecting the file.
- **Assign to Team** — graft the imported agent into an existing team as a `team-member`. It inherits the team's working environment but keeps its own imported system prompt as a per-member override (so a later team-prompt edit won't overwrite it). Leave as *Standalone* to import it as an independent `agent`.

The imported workspace (memory, skills, repo clone, prompt files) is preserved 1:1 — nothing the agent learned is re-seeded away. A **fresh Matrix identity** is provisioned on import (the exported credentials belong to the source homeserver and are dropped), and the agent is started immediately — open it in Agent Chat.

API: `POST /api/agents/import` (multipart, max 500 MB). Fields: `file` (the ZIP), optional `newId`, optional `parentTeamId`. → `201 { agentId, role, parentTeamId, image }`. On an id collision the response is `409 { error, code: "id-conflict", agentId }`. The admin-console stages the workspace on the shared volume and hands provisioning off to the orchestrator (`POST /internal/agents/import`), which owns the agent map and Matrix admin client.

## Hover Correlation

Every session log event carries the `correlationId` of the originating Matrix message (or a synthetic `trigger:<id>:<ts>` for scheduled runs). Hovering a chat bubble dims non-matching log rows, and vice versa — making it easy to trace which tool calls produced which reply.
