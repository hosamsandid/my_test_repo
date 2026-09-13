# Admin Console Reference

The Admin Console at `http://localhost:4000` (configurable via `.env`) is the central management interface for agents, environments, credentials, and integrations.

## Navigation

The left sidebar is organised into task-based collapsible accordion groups (#1595). **Agent Chat** sits at the top (ungrouped, always-visible — and since #2035 genuinely so: the whole ungrouped top tier is rendered *outside* the scrolling nav, pinned directly under **+ Create**, so it stays in view at every scroll position; it used to be the first row *inside* the scroll container and scrolled away with the accordion groups). A persistent **+ Create** control sits above the groups — the single launcher (#1665, Phase B/C of epic #1661) for starting something new, ranked simplest → most advanced since #2027 (chat with one assistant · start from a ready-made team · describe what you need · design it on the canvas · configure an agent manually, the direct form added in #1956); it replaced the former separate **Single Agent** and **Agent Team Wizard** sidebar entries (those pages remain reachable as launcher targets and via their `/quickstart` / `/team-setup` deep links). Below it four collapsible groups appear in workflow order: **Agent Setup** (Flows · Agent Templates · Skills · Knowledge · Triggers — the **Agents** entry that led this group was removed with the page in #1930, since Agent Chat above the groups is where you manage agents now), **Connections** (Model Providers · MCP Servers · Plugins · SSH Keys · GitHub Tokens), **Insights** (Token Usage · GitHub Event Log), and **Administration** (Access · Environment Templates · Maintenance Mode) — the environments entry that used to lead Connections was removed with the page in #2170; a team edits its own environment from the Agent Chat Settings tab now, and the System-Admin catalog half is **Environment Templates**. A small always-visible **Account** cluster at the bottom holds My Credentials; there is no Help nav group — help lives in the header **Help** panel, whose "This page" face carries each page's help and whose Overview face carries the big-picture introduction that the retired `/getting-started` page used to hold (#1874). Help is not limited to pages: the **Settings** dialog has its own "?" and its own help topic (opening it shows the dialog's help, closing it returns the panel to the page underneath), the steps of the **Agent Team Wizard** show help for the step you are on rather than one whole-wizard blob, and the **first-run setup** screen — which renders before the console shell exists, so the panel is not mounted — shows the same model-provider / SSH-key / GitHub-token help inline under each step (#1892). The group containing the active page auto-expands; collapse state persists per user in `localStorage` under `nav.collapsedGroups.<username>`. Installed UI plugins appear as an additional collapsible **Plugins** group at the end of the accordion list (collapsed by default, so a long plugin list folds away); the bottom Account cluster stays pinned in view below the scrolling list. A group or cluster with no visible items for the current role renders no header (role gating is unchanged: `adminOnly` = System Admin; `credAdmin` = System Admin or Team Admin).

| Page | Route | Purpose |
|---|---|---|
| **Agent Chat** | `/` (redirects to `/chats`) | 1:1 chat with any agent; session log; workspace browser; trigger editor — the console's entry page |
| **Create** | `/create` | The unified creation launcher (#1665), explicitly ranked simplest → most advanced in three tiers by #2027 (which supersedes #1661's D1, the equal-tile grid): a full-width **hero** — *Chat with one assistant* (`/quickstart`, the one-assistant fast lane — a single agent is simply a team of one, #1667); then one bordered **flow group** headed *Or build a team of agents that work together (a flow)* holding *Start from a ready-made team* (template registry via the wizard), *Describe what you need* (Flow Copilot) and *Design it on the canvas* (blank Flows draft); then a collapsed **Advanced options** disclosure holding *Configure an agent manually* (#1956, renamed from *Create a single agent*), the direct create form, still hosted here in a side panel on `?form=agent` rather than on a route of its own. Every entry states what it opens as a `→ …` outcome line; the three **flow** cards additionally reveal a hand-drawn "what you get" schematic of that screen (hover, keyboard focus, or an eye control for touch) — #2034 narrowed the preview to that group, so the hero and the disclosure entry keep their outcome line and carry no schematic and no eye control at all. Nothing is rewired — each entry hands off to exactly the route it did before. The disclosure entry is the one place the launcher names the artifact: it is the "I know exactly what I want" path, so #1665's jargon-free-titles rule stays scoped to the intent entries. Opened from the persistent **+ Create** sidebar control or this route |
| ~~**Agents**~~ | `/agents` → `/chats` | **Removed (#1930)** — everyday agent management is the Agent Chat rail (#1928), configuration is its Settings tab (#1929), New/Import sit in that page's header (#1956) and creation is the **+ Create** launcher; the Orchestrator/BriefingPack half went with the model itself (#1961). The route and the older `/blueprints` alias that used to land on it both redirect to `/chats`, so old links do not dead-end |
| ~~**Environments**~~ | `/environments` → `/chats` | **Removed (#2170, epic #2166 A4)** — a team edits its own environment from the Agent Chat Settings tab's flat row of configuration tabs (#2167, flattened by #2236); the System-Admin catalog half of the old page is now **Environment Templates** below. The route redirects to `/chats`, so old links do not dead-end |
| **Environment Templates** | `/environment-templates` | System-Admin-only catalog of curated `isTemplate: true` environments — repos, MCP pairings, model provider, toolchain, additional context a new team can copy from at creation. Never a live-shared binding: no agent or team can be bound to one directly (`template-not-bindable`); credentials set here are never copied — a team that starts from a template supplies its own. Replaces the retired **Global** environment toggle (#2158) |
| **My Credentials** | `/my-credentials` | Self-service surface (any authenticated human, no `credAdmin` gate) to create/rotate/rename/delete your own **personal** SSH key and GitHub token; private to you (epic #1558). All three credential pages share **one** help topic; each header's **?** opens it at that page's own chapter (#1993) |
| **SSH Keys** | `/ssh-keys` | Register team/system SSH key pairs for private repository access (personal keys live on My Credentials) |
| **GitHub Tokens** | `/github-tokens` | Register team/system GitHub PATs for the GitHub event poller and HTTPS repository access (personal tokens live on My Credentials) |
| **Skills Registry** | `/skills` | Browse available skills; click to view skill content. The page's concept help (what a skill is, the Global/Team/Agent tiers, grant vs activation vs *Install into agent*, the promote/move/adopt/distill/merge/import-export actions, what an overwrite replaces) lives in the Help panel's "This page" face, and each action area carries its own **?** that opens the help at that verb's chapter rather than the top of the topic (#1990) |
| **Model Providers** | `/models` | Register and test model providers; discover available models; set per-agent model overrides |
| **MCP Servers** | `/mcp` | Manage the MCP server registry and credentials; the **Credential** column shows *required* for servers whose template uses `${credential}`, which the orchestrator substitutes from the environment binding at seed time |
| **Plugins** | `/plugins` | Install/uninstall governed capability plugins into the operator registry (System-Admin only; declared capabilities reviewed in plain language before the confirm). Each **installed** card also carries a team-assignment control (#1691) to grant/revoke the plugin for one or more teams directly — reuses the existing team activation path, applies immediately, and shows which teams already have it. The page's concept help (what a plugin is, install vs grant, permissions, plugins with their own UI, and a build-a-plugin deep dive) lives in the Help panel's "This page" face — the standalone `/plugin-system` page was removed in #1879 |
| **Administration** | `/users` | The single System-Admin surface (#2085), three tabs. **Users** — human user records: a sortable/filterable list with **Create** and **Edit** dialogs (display name, email and System-Admin status; the immutable `subject` is shown read-only), set/clear login password, and delete. **All Teams** — the D5 clean-up view over every Agent Team on the platform (owner, member agents, people, Team Admins, enabled state, and a *no admin* marker), with delete; it manages no memberships, that being the **Share…** dialog's job since #2082. **Resources** — the tiered ownership of agents and environments (D7/D12). The separate **Access** page (`/teams`) is **gone**, dissolved rather than renamed: `/teams` redirects here |
| **Flows** | `/flows` | Design and run orchestration flow graphs: inspect live Teams, author Drafts, use Flow Copilot; BriefingPack flows (orchestrator-managed BP dependency graphs) are a niche secondary mode |

## Authentication (#276)

The entire console is served behind a login screen — no page or `/api/*` data
endpoint is reachable without an active session. This is the minimal,
SSO-ready auth foundation described in [docs/multi-user-concept.md](./multi-user-concept.md).

**Login.** A password is checked against the **user store** and nothing else
(#2059). The environment pair below is no longer a credential the console
accepts — it is the **seed** the orchestrator consumes at first boot to create
the first System-Admin *user record*:

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Subject of the first System-Admin record, seeded once on a stack with no user records |
| `ADMIN_PASSWORD` | `admin` | Password written into that record at seeding; never read again afterwards |
| `AUTH_SESSION_SECRET` | random, persisted | Signs session cookies. When unset, a random 32-byte key is generated once and persisted at `/workspace/auth/session-secret` (`0600`), so sessions survive a restart; if that volume is unwritable the key is process-random and a restart signs everybody out (fails safe). Set an explicit value to rotate every session deliberately. |
| `AUTH_COOKIE_SECURE` | `false` | Set to `true` only when the console is served over HTTPS (adds the cookie's `Secure` attribute). |
| `AUTH_ENABLED` | `false` | Single-user ⇄ multi-user mode (#1457). Off (the default) is **single-user compatibility**: whoever signs in is the operator, and the team scope filter is a no-op — an existing stack upgrades with no change in behaviour. `true` enforces multi-user scoping, so a caller sees only what their user record's team memberships allow. It gates *authorization* only; the login itself is unchanged in both modes. |

> The defaults (`admin` / `admin`) are for first-boot local use only — but change
> them **on the Users page**: the seeded password lives in the record, so editing
> `.env` and restarting no longer revokes it. This is a placeholder until
> enterprise SSO replaces the credential check.

**Session.** On successful login the server issues an HMAC-signed, stateless
session token in an **HttpOnly, SameSite=Lax cookie** (`aee_session`, 7-day
TTL). A browser refresh re-validates via `GET /api/auth/session` rather than
re-prompting. A **Logout** item in the header **account menu** (#1802 — the
user-anchored control in the top-right cluster, alongside a **Settings** item)
clears the cookie and returns to the login screen; an expired session (any
`401`) does the same automatically.

**API surface** (all public — everything else under `/api` requires the cookie):
- `POST /api/auth/login` — `{ username, password }` → sets the cookie; `401` with an inline error on bad credentials, or `503` `user_store_unavailable` when the user store did not answer (the check is bounded by a 5 s timeout).
- `GET /api/auth/ready` — `{ ready }` (`200`/`503`): whether the stack has a user record to sign in as. A bring-up polls this before its first login attempt, so a still-seeding stack is not mistaken for a bad password.
- `GET /api/auth/session` — `{ authenticated, user }`.
- `POST /api/auth/logout` — clears the cookie.

**Per-user local passwords (#374, interim).** Human users created on the **Users**
page (#1844) can be given a local password (Users → Edit → Login password),
letting more than one person log in before SSO lands. Login resolves in **one**
step: the **user store** (match by `subject`, verify a salted **scrypt** hash held
in the user record and never returned by any API). Key properties:

- The first administrator is no exception. On a stack with zero user records the
  orchestrator seeds one real System-Admin record from
  `ADMIN_USERNAME`/`ADMIN_PASSWORD` — or, when `BOOTSTRAP_SYSTEM_ADMIN_SUBJECT`
  is set, from that instead, seeding a **password-less** record for an SSO stack.
  See [docs/teams-data-model.md](./teams-data-model.md).
- Every session's subject is a real user record's `subject`, so the audit trail
  (#305) names the real person.
- There is **no env-credential fallback** (#2059). Two consequences are
  deliberate and accepted: while the orchestrator — and with it the user store —
  is unreachable **nobody can sign in** (login answers `503`, not `401`), and
  recovering a lost identity is a **host-level** action on
  `/workspace/users/index.json`, not a console login.
- The last System Admin cannot be deleted or demoted (`409`, refused in the store
  and mirrored as a disabled control on the Users page).
- This is explicitly interim and is superseded by SSO (#307); there is no
  self-service signup, reset, policy, or MFA.

**SSO swap-point.** The credential check lives in a single `verifyViaUserStore()`
function in `admin-console/api/auth.js`. Swapping it for an OIDC/SAML token
exchange (and adding the IdP callback route) requires no change to the session
format, cookie handling, gate middleware, or the login UI/routing.

## Administration (#308, renamed #1726/#1910, dissolved #2085)

The **Administration** page (`/users`) is the one surface that exists only for a
System Admin. It absorbed the former **Access** page (`/teams`) in #2085 (epic
#2076 P6, D10): once sharing a team became self-service in the **Share…** dialog
(#2082), the central Access page had nothing left that a team's own admins could
not do, so it was **dissolved, not renamed** — `/teams` redirects to `/users`,
which now carries three tabs (**Users / All Teams / Resources**). The route, the
`/api/admin/{teams,…}` endpoints and the internal **Team** entity are unchanged;
the earlier "Teams" → "Access & Users" (#1726) → "Access" (#1910) renames were
UI-label-only and are what D10 declined to pay a third time.

Note the two tenancies the tabs straddle. **All Teams** lists **Agent Teams** —
a membership has pointed at one since epic #2076 P1, so that IS the team a
person is given access to. **Resources** assigns the older, coarser **access
scope** every resource is still stamped with; no new scope can be minted (#2081)
and none can be deleted from the console any more, the two tenancies being
collapsed into one by a later phase (`docs/decentralised-access-concept.md`
A3.3).

A System Admin can:
- **Users** — human user records (keyed by a stable `subject` an SSO login will later map onto) are created, edited (display name / email / System-Admin), given a login password, and deleted.
- **All Teams** — every Agent Team on the platform, including ones the caller is not a member of (D5). Delete runs the two cascades that already exist: the member agents go with the parent (#1960) and the memberships with the team (#2081), so the tab needs no endpoint of its own. It deliberately manages **no** memberships — a role dropdown here would be a second, differently-warned copy of an operation that can lock a team's own admins out.
- **Resources** — reassign an agent (an Agent Team moves as one unit, its members inheriting) and re-tier an environment. Scopes are **no longer created** (#2081, `POST /api/admin/teams` answers *410 Gone*) and no longer deleted from the console.
  An agent reassigns through `PUT /api/agents/:id { teamId }`. An environment does **not**: since #2083 it carries the same `{scope, teamId, assignedTeamIds}` tier a credential does, so the row sends the full ownership payload (`PUT /api/environments/:id { scope, … }`). A bare `{ teamId }` would normalize to `scope: 'team'` server-side — i.e. the pre-#2085 one-click selector silently **un-shared** a shared environment, which is the concrete reason the section was reworked rather than carried over.

The page is built on the `/api/admin/{teams,users,memberships}` endpoints
(proxied to the orchestrator's teams store). Per-role *enforcement* of these
actions — and per-resource visibility — landed with #302/#304 (`scope.js`), and
**whether it applies at all is now the `AUTH_ENABLED` mode** (#1457): with the
flag off (the default) every authenticated principal is the implicit System
Admin and can manage every team, which is the single-user behaviour this stack
has always had; with it on, `canManageTeam` narrows management to the caller's
own `team-admin` memberships.

## Agent Teams — the missing-role suggestion was removed (#1959)

The platform used to guess which "loop-closing" role an **Agent Team** was
missing and offer a one-click **Add `<role>` role** (#1375): a warning block on
the expanded team card of the (since-removed, #1930) Agents page, and extra
entries in the team's context menu in Agent Chat. **That capability is gone as of #1959 — removed, not moved.**

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
  takes the free-form branch and yields a blank `<teamId>-<n>` member inheriting
  the team's prompt), or wiring the role in the **Flow editor**, which is the
  surface that materialises a role *from a role template* (the route's
  `templateId` branch) and where the flow's actual gaps are visible as unconsumed
  labels and advisory lints rather than inferred. Both branches of the route
  survive; since #1958 they additionally accept a `materialize` preference (see
  *Adding a member without materializing it* below), so the Agent-Chat rail no
  longer posts an empty body.
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

Each row shows the agent's environment name below its display name. Inside a team group whose members all share one environment, that name is shown once on the collapsible group header instead of repeating on every row; a member on a different environment keeps its own line. Standalone agents (outside any group) always show their own environment line.

Reorder the list by dragging the grip handle (⠿, visible on hover) to relocate an item in one gesture; keyboard users can reorder the focused item with `Alt+↑`/`Alt+↓`. Groups, standalone agents, and members within a group each reorder independently; a drag cannot move an item out of its own list. Order persists in `localStorage` (`agentChat.sidebarOrder`) and survives reload. Group and standalone-agent reorder require the **All agents** filter (the other groups/singles are hidden under a filter, so a move would be ambiguous); member-within-a-group reorder is additionally available under a **single-team** filter, since that view shows the team's complete ordered member set and writes the same order it would unfiltered (#1725).

Manage agents in place, without the separate Agents page that used to own this (#1928; the page itself was removed in #1930). Open a row's context menu — the kebab revealed on hover, a right-click, or `Menu`/`Shift+F10` from the keyboard — for **Enable/Disable**, **Settings**, **Clone**, **Export (ZIP)**, **Save as template** and the confirmation-guarded **Reset to stub** / **Delete**; a team group header offers the team-wide **Enable/Disable** fan-out (with a partial-failure report), **Add member…**, **Team settings**, **Share…**, **Export team**, **Clone team…**, **Open in Flow Editor** and **Delete team** (the **Add `<role>` role** entries are gone — see *the missing-role suggestion was removed* above). The list-level **Import Agent** / **New Agent** actions sit in the Shell's page-action header like every other page's (#1956) — the rail **+** menu they replaced is gone, so neither is reachable from two places; **New Agent** hands over to the `/create` launcher, **Import Agent** opens the ZIP picker in one click and completes through the same import dialog, and the imported agent joins the list without a page reload (if the rail filter would hide it, the confirmation says so). Both are disabled with an honest reason for a caller who may not create agents, rather than hidden. The rail header row itself stays — it carries the filter, the disabled-agents opt-in and the list's "?" — and its empty state is now a text pointer at the header button instead of a competing call to action. Every action runs the dialog, confirmation and request the Agents page used to run — they are literally the same components, extracted into `pages/agent-lifecycle/` while both surfaces existed, which is what made removing the page a deletion rather than a rewrite. **Add member…** additionally opens a dialog and sends a materialization preference (#1958, see *Adding a member without materializing it* below); that was the one place the two surfaces deliberately differed, and it is now simply how adding a member works. **Share…** (#2082) opens the team's **member list** in a side panel — who may open the team and chat with its agents, and which of them administers it. A **Team Admin** adds an existing colleague, changes a role between *Team Admin* and *Team Member*, and removes people; a **Team Member** gets the same list **read-only**, which is why this is the one entry in that menu that is not greyed out without rights — reading who is on your own team is a member's right (#2041 D9), and the panel says what it will not let them do. The picker searches the **open user directory** and shows a display name and an email address only — never whether somebody is a System Admin, never a GitHub handle — and offers only people who already have an account (creating one stays a System-Admin step on the **Users** page). Removing or demoting the **last** Team Admin asks who takes over and does both in one write, so the team is never momentarily un-administrable. Sharing or unsharing also reaches the team's agent rooms immediately (#2174): a newly-added colleague is invited into every one of the team's already-materialized members' rooms right away, so their chat works without first sending a throwaway message, and removing them kicks them back out — best-effort and idempotent, so a colleague whose Matrix identity is still provisioning is simply skipped and picked up by the ordinary first-message invite once it has. **Clone team…** (#2171) opens a form that creates a brand-new team with the same repositories, MCP references, toolchain and additional context as the source — never its credentials, which are stripped in the copy. The new team's members are created as stubs (nothing cloned, no workspace) and a suggested label suffix keeps its flow labels from cross-triggering the source team's; the form then shows exactly which credentials the new team still needs before its members can be materialized. It is ungated like **Export team**, since reading a visible team's structure needs no more right than any other visible row has. Every write goes to `POST`/`DELETE /api/admin/memberships`, gated server-side on `canManageTeam` and refused with a 403 regardless of what the buttons look like. An action you may not perform is shown inert with a reason rather than failing at the server. A **show disabled agents** toggle (off by default, remembered per user) additionally lists paused agents so they can be re-enabled from here; a disabled agent is marked as such and cannot be opened as a chat until it is enabled — its **Settings** entry still opens its configuration in the right rail, so it can be reconfigured while paused (#1929). The same menu also leads with a chat-only **Mark as unread** entry — it flips the row back to its unread indicator and, unlike the management actions below it, never depends on your permissions; it is greyed out rather than hidden when it does not apply (the row is already unread, or is disabled/offline and has no chat to open). It replaces the mail icon that used to appear on row hover, so the drag grip no longer shifts sideways when you hover a row (#1938). The menu closes with a **What these actions do…** entry that opens the Help panel at the agent-list chapter of the Agent Chat topic — a menu cannot host the shared "?" button, so the affordance is an entry; it is always enabled, since it changes nothing (#1972). A team created with **deferred materialization** (`materializeMembers: false`, #1955) no longer reads as empty here: each team group ends with a collapsed **Not materialized yet (N)** section listing its **stub** members — configuration and triggers only, no chat account, no workspace, no clone — with the count visible without expanding, and no section at all for a team that has none (#1957). A stub row is badged *Not initialised* (the removed Agents page's own word, kept so the two never read as two different states) with its own muted status dot, so it is never mistaken for a *paused* agent, and it cannot be opened as a chat because there is no chat account to open. Its menu offers **Materialize** in place of *Enable* — the same request the Agents page's **Activate** button used to send, so the resulting agent is indistinguishable from one materialized at team-create time; the row shows it working (a role with repositories clones them now) and moves up into the active members on success, without a reload. *Stub* and *paused* are different states: the show-disabled opt-in has no effect on this section. A stub whose team is disabled gets an inert **Materialize** with *enable the team first*, as does a caller who may not manage it.

**Adding a member without materializing it (#1958).** **Add member** on a team
group header opens a dialog carrying a **Materialize now** checkbox — the same
choice the Agent Team Wizard's launch step offers, at the granularity of one
member. Ticked (the default, because a member you add on purpose is usually one
you want working) the behaviour is exactly what it was: Matrix user, workspace,
clone, container. Unticked, the member is created as a **stub** — configuration
and `triggers.json` only, `enabled: false`, no clone and no container — and lands
in that team's *Not materialized yet* section, where **Materialize** finishes the
job and yields an agent indistinguishable from one materialized at add time. The
label suffix and every `{{var}}` are resolved identically in both modes, so
deferring changes *when* the expensive part happens and nothing else. The
confirm button names the mode it will run in (*Add member* vs *Add member
(stub)*) and the notice afterwards reports the mode the **server** ran in rather
than the one that was asked for. This replaces the old workaround of creating a
member and immediately disabling it, which produced a *paused* agent — the clone
and the container had already happened — rather than a stub; that workaround was
removed in #1959 and this checkbox is what it was standing in for. The Agents page's **Add Member**, which stayed a bare immediately-materializing
POST while both surfaces existed, went with that page in #1930 — so this dialog
is now the only way a member is added from the console.

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
| **Workspace Browser** | Lazy-loading file tree of the agent's workspace directory. Click any text file to view its content (up to 512 KB). Hover over any file row to reveal a per-file **Download** button (works for binary files too; no size cap) and a **Reference in chat** (@) button that splices a `@<workspace-relative-path>` token for that file into the current agent's composer draft — the same reference convention an upload produces, so the agent resolves it without re-uploading (files only, never directories or `/context` host-mount rows). Supports file upload to the workspace (up to 500 files) and one-click ZIP export of the entire workspace. Binary files are flagged rather than displayed as garbage. A **repositories** button in the same toolbar lists every repository the agent has — inherited from its environment (read-only here) or attached to this agent alone — and is where an **additional repository is attached to that one agent** (#2067); the same panel is on the **Settings** tab. |
| **Triggers** | Inline editor for the agent's trigger schedule. Add, edit, or delete any trigger type; shows next execution time, last run status, and the webhook secret for HTTP triggers. |
| **Settings** | The agent's configuration, where you see its effect (#1929) — the *same* form the Agents page's edit panel renders (display name, system prompt including a team member's Inherit / Additional input / Exclusive override modes, skills, MCP overrides, plugin grants, host context folders, repositories with **Sync repositories** and — since #2067 — the agent-scoped repository panel that attaches an additional repository to this one agent). For a `role: 'team'` agent the form is instead **one flat row of tabs** (#2167, flattened into a single level by #2236) — General · Repositories · Model provider · Toolchain · MCP servers · Additional context · Skills · Plugins, always in that order and addressable by `?tab=<name>` in the URL (an unrecognised or missing value opens General). **General** carries the read-only ID, Display Name and Team Default Prompt; five tabs edit the team's bound environment in place, through that record's own `PUT /api/environments/:id` rather than this form's save (see [Environments](working-environments.md#editing-from-a-teams-settings-tab)); **Skills** and **Plugins** carry the team's own grant, at the same level as everything else rather than as separate sections — a team with nothing installed or configured still shows all eight tabs. Saving General or Skills goes through the same `PUT /api/agents/:id` an ordinary agent's form uses; the five environment tabs and Plugins keep their own, unrelated save/apply behaviour, and switching tabs never loses an edit in progress. Plugin grants and context folders keep their immediate-apply semantics; only in the chat, a context-folder change asks for confirmation first, because the re-provision it triggers ends the run you are watching. Unsaved edits are **preserved per agent** for the rest of the session: switching agents and back finds the form as you left it, behind an "unsaved changes" banner with a **Discard changes** button. Hidden for a caller who may not manage the agent. Normally the open chat's agent — a rail menu can point **Settings** at another one for an agent that has no chat to open, e.g. a disabled row (a **Back** control returns it to the conversation). A `role: 'team'` agent is different: selecting its row (or **Team settings…** on the group header) replaces the whole area right of the agent list — chat column and rail both — with this form alone, full width; there is no separate chat pane and no separate rail for a team (#2235). |

## Session Pinning

After every successful Claude run, the session ID is saved to a per-room pointer file. The next message resumes with `--resume <sessionId>` so Claude keeps the conversation in context. If the session is stale (e.g. after a CLI upgrade), the runner clears the pointer and retries once without it. Session pointers survive orchestrator restarts.

## Agent Export / Import

Agents can be snapshotted as a ZIP and restored on any compatible AEE instance.

**Export** — choose **Export (ZIP)** from an agent's row menu in the Agent Chat rail (the **Export** icon on an agent card in `/agents` until #1930 removed that page — the menu entry is the same request), or use the download button in the Workspace Browser toolbar. The ZIP contains the full agent workspace (excluding `sessions/`) plus a `manifest.json` with the agent id, export timestamp, and the orchestrator image name/tag/digest recorded at export time.

API: `GET /api/agents/:id/export` → streams `agent-<id>-export.zip`.

**Import** — click **Import Agent** at the top-right of Agent Chat (`/chats`, #1956) and select a ZIP produced by export. It was also at the top-right of `/agents` until #1930 removed that page; the surviving button opens the same dialog it always did, with two optional choices:

- **New Agent ID** — import the agent under a different id. Leave blank to keep the exported id. If that id is already taken the dialog surfaces the conflict and pre-fills a non-colliding suggestion, so you can re-id and retry without re-selecting the file.
- **Assign to Team** — graft the imported agent into an existing team as a `team-member`. It inherits the team's working environment but keeps its own imported system prompt as a per-member override — the **Exclusive overriding input** prompt mode (so a later team-prompt edit won't overwrite it; a member can instead be switched to **Inherit from team** or **Additional input** in its edit form, #1511). Leave as *Standalone* to import it as an independent `agent`.

The imported workspace (memory, skills, repo clone, prompt files) is preserved 1:1 — nothing the agent learned is re-seeded away. A **fresh Matrix identity** is provisioned on import (the exported credentials belong to the source homeserver and are dropped), and the agent is started immediately — open it in Agent Chat.

API: `POST /api/agents/import` (multipart, max 500 MB). Fields: `file` (the ZIP), optional `newId`, optional `parentTeamId`. → `201 { agentId, role, parentTeamId, image }`. On an id collision the response is `409 { error, code: "id-conflict", agentId }`. The admin-console stages the workspace on the shared volume and hands provisioning off to the orchestrator (`POST /internal/agents/import`), which owns the agent map and Matrix admin client.

## Hover Correlation

Every session log event carries the `correlationId` of the originating Matrix message (or a synthetic `trigger:<id>:<ts>` for scheduled runs). Hovering a chat bubble dims non-matching log rows, and vice versa — making it easy to trace which tool calls produced which reply.
