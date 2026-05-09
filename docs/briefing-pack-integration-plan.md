# Briefing Pack Integration Plan

Integration of the ACE (Agent Command Environment) Briefing Pack system from `i-sase` into the `e-vgh-claw` Matrix-based agent stack.

Status: superseded. Sections describing a "multi-agent room" or central orchestrator-as-router no longer apply — the stack is now DM-only (one Matrix user + one DM room per agent, no shared room). The next iteration of this plan will replace BP-status messages in the multi-agent room with status updates posted to the orchestrator-agent's DM room with the human, and BP-instance agents will spawn as children of an orchestrator agent rather than appearing in a shared room. Treat the rest of this document as historical context.

---

## Table of Contents

1. Goal
2. Current State of Both Systems
3. Core Idea: BP ↔ Agent 1:1 Mapping
4. Physical Setup (Volumes, Containers)
5. Backend API (Express extensions)
6. Orchestrator Extensions
   - 6.1 BP-aware agent helper
   - 6.2 Dispatch pipeline
   - 6.3 BP watcher
7. Admin Console UI
8. Workflow Visibility in the Multi-Agent Room
9. Implementation Phases
10. Open Decisions
11. Risks and Mitigations
12. Out of Scope (V1)

---

## 1. Goal

Make every Briefing Pack a first-class chat partner inside the Admin Console:

- Each BP gets a dedicated Matrix agent (`@bp-<hash>:local`).
- The user can chat with that agent about the BP, ask it to dispatch / revise / approve.
- The user can edit the BP body through the agent (or directly in a markdown editor).
- A Briefing Pack Orchestrator watches the i-sase repo, posts state transitions into chat, and notifies the BP-agent when a dispatch happens.
- The full BP workflow is visible as a chat stream (multi-agent room).
- The BP Explorer functionality is reimplemented natively in the Admin Console for a single, integrated UI.

## 2. Current State of Both Systems

### i-sase (ACE)

- Pure Python (FastAPI) + Vanilla JS, no DB; everything is Git + YAML frontmatter.
- BP file: `artifacts/briefings/<12-char-hash>-<slug>/brief.md`.
- Index: `artifacts/briefings/.index.json` (status, parent/children, dependencies).
- Status lifecycle: `draft → ready → dispatched → claimed → completed → reviewed`, plus `stale`, `archived`.
- All status changes happen through deterministic Python scripts (`bp-transition.py`, `bp-info.py`, `validate-bp.py`, `worktree-ops.py`). They are the only authoritative writers; never let an LLM edit `status:` directly.
- Each dispatch creates a Git worktree at `.worktrees/<agent-id>-<bp-hash>/` on branch `agent/<agent-id>/<bp-hash>`.
- BP Explorer: FastAPI server on port 8765 with Vanilla-JS frontend.

### e-vgh-claw

- Matrix-based stack (Conduwuit + Cinny + Orchestrator + Admin Console).
- Orchestrator (`orchestrator.js`) creates Matrix users, seeds workspaces from a Working Environment (skills, optional Git clone, additional context), spawns one `agent-runner.js` child process per agent.
- Agents run the Claude CLI in `--permission-mode acceptEdits` with `--output-format stream-json`, with per-room session pinning (`<roomId>.current.json` + `--resume`).
- Per-agent triggers (`triggers.json`) for cron / once executions.
- Admin Console (React + Express) at `:4000` with pages for agents, environments, SSH keys, skills, jobs, models, MCP, knowledge, logs, and an embedded chat UI at `/chats/:agentId`.
- SSE infrastructure already exists for room messages, session logs, container logs.

## 3. Core Idea: BP ↔ Agent 1:1 Mapping

| ACE concept | e-vgh-claw concept | How they connect |
|---|---|---|
| Briefing Pack `brief.md` | Matrix agent `@bp-<hash>:local` | The BP hash is part of the agent ID |
| ACE `agent-id` (assigned at dispatch, 8-char hex) | Same string used as the Matrix agent suffix | Worktree path and Matrix identity stay in sync |
| BP frontmatter (mission, rigor, loop-script) | `AGENT-PROMPT.md` and `CLAUDE.md` of the agent | Generated when the BP-agent is provisioned, regenerated when the BP body changes |
| BP status transition | Message in the multi-agent room | "BP workflow stream" |
| `.worktrees/<agent-id>-<bp-hash>/` | The agent's `cwd` while dispatched | Bind-mounted into orchestrator |
| MentorScripts (`global.md`, `team.md`) | Working Environment `additionalContext` | Copied into CLAUDE.md at agent creation |
| BP Explorer UI (Vanilla JS) | Admin Console pages `/briefing-packs` | Reimplemented in React with the same data model |
| `/api/bp/{id}/dispatch` (FastAPI) | Express proxy that spawns Python scripts | Python remains source of truth |

Consequence: ACE Python scripts stay the only writers of BP state. Node code calls them via `child_process.spawn`. We do not reimplement the regex-based status edits or the worktree logic.

## 4. Physical Setup (Volumes, Containers)

Today: four services. Proposal: still four services, plus a new shared volume for the ACE repo.

```
conduwuit         (unchanged)
cinny             (unchanged)
admin-console     (+ new /api/bp/* routes, + new React pages)
orchestrator      (+ Python 3.11 + PyYAML in image, + bp-watcher.js, + bp-agent.js)
```

Shared bind-mount:

```
${ACE_REPO_PATH} -> /ace          (mounted read-write into orchestrator AND admin-console)
```

`.env` additions:

```
ACE_REPO_PATH=/Users/thorsten.a.maier/Projects/i-sase
ACE_WATCH_INTERVAL_SECONDS=30
ACE_BRIEFING_ENV_ID=briefing-pack
```

Orchestrator Dockerfile delta: install `python3` + `py3-yaml` (Alpine) or `python3 python3-pip` + `pip install pyyaml` (Debian-based, depending on current base image).

Recommendation: do NOT run the FastAPI BP Explorer as a fifth container. Instead, call the underlying Python scripts directly from Node. Reasons:

- The FastAPI dispatch endpoint also invokes Claude Agent SDK; we want the Matrix path instead.
- Avoids a second auth surface and CORS hops.
- The frontend is Vanilla JS that does not match the Admin Console design system; we reimplement it natively (see §7).

## 5. Backend API (Express extensions)

New file: `admin-console/api/bp.js`, mounted from `api.js` analogously to `matrix.js`.

| Method | Path | Purpose | Implementation |
|---|---|---|---|
| GET | `/api/bp` | List all BPs (status, slug, mission, agent-id, parent, dependencies) | Read `/ace/artifacts/briefings/.index.json` |
| GET | `/api/bp/:hash` | Resolved BP info incl. LoopScript and MentorScripts | Spawn `python3 /ace/scripts/bp-info.py <hash>` |
| GET | `/api/bp/:hash/raw` | Raw `brief.md` (for editor) | `fs.readFile` |
| PUT | `/api/bp/:hash/raw` | Edit body (NOT status fields) | Validate frontmatter unchanged, `fs.writeFile`, `git commit` |
| POST | `/api/bp/:hash/transition` | `approve\|claim\|complete\|review\|reset\|revise\|archive\|confirm-valid` | Spawn `bp-transition.py` |
| POST | `/api/bp/:hash/validate` | Pre-dispatch check | Spawn `validate-bp.py --json` |
| POST | `/api/bp/:hash/dispatch` | Full dispatch pipeline | See §6.2 |
| GET | `/api/bp/:hash/agent` | Return Matrix agent for BP, create if missing | Calls `ensureBpAgent` |
| GET | `/api/bp/:hash/worktrees` | Active worktrees for this BP | `git worktree list --porcelain` |
| GET | `/api/bp/stream` | SSE: BP state diffs from `.index.json` | Same backoff/reconnect contract as `useSSE.js` |

Security:

- All paths normalized against `path.resolve(ACE_REPO_PATH, 'artifacts/briefings')`. Reject any resolved path outside that root.
- BP hash regex-validated: `^[a-f0-9]{12}$`.
- PUT on `:hash/raw` rejects requests that mutate frontmatter status fields. Status only changes via `/transition` (which calls the Python script).

## 6. Orchestrator Extensions

### 6.1 BP-aware agent helper

New file: `orchestrator/bp-agent.js`.

`ensureBpAgent(bpHash)` is idempotent:

1. Run `python3 /ace/scripts/bp-info.py <hash>` to read frontmatter and body.
2. If `/workspace/agents/bp-<hash>/config.json` exists → return.
3. Otherwise call the existing `createAgent({ id: 'bp-<hash>', role: 'agent', environmentId: ACE_BRIEFING_ENV_ID, … })`.
4. Generate `AGENT-PROMPT.md` from BP mission, rigor, and LoopScript reference.
5. Append a BP-specific section to `CLAUDE.md` (template below).
6. Lazy-create the DM room when the user first opens the chat (the existing `/api/matrix/agents/:id/dm` flow already does this).

Working Environment `briefing-pack` (created once via Admin Console):

- `skills`: at least the `engineering` skill family (LoopScripts, MRP/CRP/VCR templates).
- `additionalContext`: the contents of `/ace/mentorscripts/global.md`.
- No `repository` field — the ACE repo is mounted globally at `/ace`, not cloned per agent.

CLAUDE.md BP section template:

```markdown
## Briefing Pack Context

You are the dedicated agent for Briefing Pack `<hash>` ("<mission>").

- BP file: `/ace/artifacts/briefings/<hash>-<slug>/brief.md`
- Status: <status>
- LoopScript: <path>
- Worktree (when dispatched): `/ace/.worktrees/<your-agent-id>-<hash>/`

### Authoritative tools for state changes

- `python3 /ace/scripts/bp-transition.py <action> <hash>`  (never edit `status:` in the markdown directly)
- `python3 /ace/scripts/validate-bp.py <hash>`              (pre-dispatch check)
- `python3 /ace/scripts/worktree-ops.py ...`                (manage your isolated worktree)

### Your responsibilities

1. Discuss the BP with the user (mission, rigor, dependencies, blockers).
2. Edit the BP body when the user requests changes (`brief.md`, NOT the status field).
3. Execute the BP when dispatched (the orchestrator will message you in your DM room).
4. Report status to the multi-agent room as transitions occur.
```

Lifecycle:

- BP `archive` → agent `enabled: false` (keep config + history); reactivated on `restore`.
- BP `revise` → agent stays; the watcher posts a notification.
- BP physically deleted (rare) → agent fully deleted via the existing DELETE flow.

### 6.2 Dispatch pipeline

Triggered by `POST /api/bp/:hash/dispatch` from the UI or by the agent itself in chat.

```
1. validate-bp.py <hash> --json                                  (must pass)
2. ensureBpAgent(<hash>)                                         (idempotent)
3. bp-transition.py dispatch <hash>                              (status -> dispatched, sets agent-id)
   IMPORTANT: pass --agent-id = the Matrix agent suffix so worktree id and Matrix id match
4. worktree-ops.py create --agent-id <id> --bp-hash <hash> --push --json
5. bp-info.py <hash>                                             (resolved context for the agent)
6. Post a Matrix message into the BP-agent's DM room:
   "Dispatch received.
    Worktree: /ace/.worktrees/<agent-id>-<hash>/
    LoopScript: <path>
    Mentorscripts: [...]
    Please start with phase 1 (Understand) of the LoopScript."
```

The agent-runner sees that DM message exactly like any other chat input and invokes Claude with `cwd` set to the worktree path. Correlation: dispatch event is tagged `correlationId = "dispatch:<bpHash>:<ts>"` so the Admin Console can pair it with subsequent log entries.

Override path: if the user types "please start" in the BP-agent chat, the agent itself can call `bp-transition.py dispatch` and `worktree-ops.py create` (with user confirmation since we run `acceptEdits`, not `bypassPermissions`). Both routes converge on the same Git state.

### 6.3 BP watcher

New file: `orchestrator/bp-watcher.js`. Started inside the orchestrator process; not a separate container.

Loop (every `ACE_WATCH_INTERVAL_SECONDS`):

1. If `/ace/.git` has a remote: `git -C /ace fetch --quiet`.
2. Snapshot diff: previous `.index.json` vs. current.
3. For each change emit:
   - **New BP**: call `ensureBpAgent(hash)`, post in multi-agent room: "New BP `<slug>` created (status: draft)".
   - **Status transition**: post in multi-agent room: "`<slug>`: `<old>` → `<new>`".
   - **Transitioned to `dispatched` externally** (CLI / another dev): also DM the BP-agent with the dispatch payload from §6.2 step 6, so it picks up the work.
   - **Transitioned to `completed`**: post the MRP path in the multi-agent room.
   - **Transitioned to `stale`** (cascade): DM the BP-agent: "Upstream BP `<x>` revised. Run `confirm-valid` or wait for revision."
4. Persist last-seen commit hash to `/workspace/bp-watcher-state.json` so a restart does not replay history as new events.

Failure handling:

- If `.index.json` is missing or malformed: pause, expose health state `bp-index-missing` on `GET /api/health`, surface in the Dashboard.
- If a Matrix DM cannot be sent: exponential backoff per agent, log to the Admin Console logs page.
- Overlap protection: only one watcher tick may run at a time (same pattern as the trigger scheduler).

## 7. Admin Console UI

### 7.1 Sidebar

`Shell.jsx` NAV array gets a new section between WORKSPACES and CONFIGURATION:

```
BRIEFING PACKS
  Übersicht          → /briefing-packs
  Workflow-Stream    → /briefing-packs/workflow
```

### 7.2 `/briefing-packs` (`pages/BriefingPackList.jsx`)

Three-column layout, EB tokens (no Tailwind, matches the rest of the console):

- Left: filter sidebar (status, author, rigor, search, "show archived").
- Center: card grid. Each card shows status badge, mission, slug, author, child count, agent presence indicator.
- Card click → `/briefing-packs/:hash`.
- "+ New BP" opens a modal: mission, rigor, parent (optional). Backend wires this to whichever BP-creation script ACE provides; if none exists today, V1 can create the directory and `brief.md` from a template directly in Express, then run `validate-bp.py` to confirm shape.

### 7.3 `/briefing-packs/:hash` (`pages/BriefingPackDetail.jsx`)

Header: mission, status badge, action buttons (Approve, Validate, Dispatch, Reset, Revise, Archive, Confirm Valid). Buttons are enabled/disabled based on current status.

Tabs:

| Tab | Content |
|---|---|
| Brief | Markdown editor on `brief.md` body. Frontmatter shown read-only above. Save → `PUT /api/bp/:hash/raw`. |
| Chat | Reuses `<ChatPanel agentId="bp-<hash>">` from `agent-chat/ChatPanel.jsx`. Triggers `ensureBpAgent` on first open. |
| Workflow | Vertical timeline from `git log --grep='bp:<hash>'` plus state transitions. Hover-paired with chat bubbles via `correlationId` (same mechanism as SessionLogPanel). |
| Children | For parent BPs: mini-cards for each sub-BP with their own status. |
| Worktrees | Active `.worktrees/...` with branch name and diff stats. |
| Logs | Embedded `<SessionLogPanel agentId="bp-<hash>">`. |

### 7.4 `/briefing-packs/workflow`

A live SSE feed of BP transition events from `GET /api/bp/stream`, sorted by time, with click-through to detail pages. This is the user-facing "see the entire workflow as chat" view.

### 7.5 Replacing the existing BP Explorer

Recommendation: do not embed the FastAPI BP Explorer (no iframe, no proxy). Reimplement in React natively. Reasons:

- Vanilla-JS UI does not match the Admin Console design system.
- Iframe would require shared cookies / CORS handling and a second auth surface.
- The native React reimplementation is roughly 2–3 days and gives correlation BP ↔ chat ↔ logs for free.

Fallback if the user wants to keep the existing Explorer running: add an "External BP Explorer" link in the sidebar pointing at `http://localhost:8765`. No integration work, no shared state.

## 8. Workflow Visibility in the Multi-Agent Room

The existing multi-agent room becomes the shared BP logbook. The BP watcher and all BP-agents post there. Example transcript:

```
[orchestrator]   New BP `auth-refactor` created (status: draft)
[user]           bp-a3f7c2: review the mission
[bp-a3f7c2]      Mission "Refactor Authentication Module", rigor=standard …
[user]           ok, approve
[bp-a3f7c2]      Status -> ready (commit a3b1...)
[orchestrator]   `auth-refactor`: ready -> dispatched (agent: fd6a89e3)
[bp-a3f7c2]      Worktree created: .worktrees/fd6a89e3-a3f7c2/. Phase 1 (Understand) starting.
[bp-a3f7c2]      Phase 4 (Verify) done, MRP at artifacts/guidance/...
[orchestrator]   `auth-refactor` completed
[user]           review
[bp-a3f7c2]      VCR created, status -> reviewed
[orchestrator]   `auth-refactor`: completed -> reviewed
```

This is the "see the full workflow in chat" view the user asked for.

## 9. Implementation Phases

| Phase | Scope | Estimated Effort |
|---|---|---|
| 0 | docker-compose: mount i-sase volume, add Python+PyYAML to orchestrator image, new env vars. | 0.5 day |
| 1 | `admin-console/api/bp.js` read-only endpoints (`GET /api/bp`, `GET /api/bp/:hash`, `GET /api/bp/:hash/raw`, SSE). | 1 day |
| 2 | `BriefingPackList.jsx` and `BriefingPackDetail.jsx` (Brief tab + Workflow tab read-only). Sidebar entry. No editing yet. | 1.5 days |
| 3 | `bp-agent.js` (`ensureBpAgent`), Working Environment `briefing-pack`, `bp-watcher.js` (read-only, posts to multi-agent room). | 1.5 days |
| 4 | Chat tab in detail page (reuse `ChatPanel`), automatic DM-room creation on first open. | 0.5 day |
| 5 | Write endpoints: transitions, dispatch, BP-body editing. Action buttons in detail page. | 1.5 days |
| 6 | Correlation Workflow ↔ chat bubbles via `correlationId="dispatch:..."` and `bp:<hash>:<ts>`. Hover-pair behavior. | 0.5 day |
| 7 | Edge cases: stale cascades, archive flow, failure states, watcher health. | 1 day |
| 8 | Optional: workflow-stream page with filtered SSE; "+ New BP" modal. | 1 day |

Total: ~8–9 person-days. Phase 1+2 already deliver visible value (BP browser inside the Admin Console); from phase 4 the chat integration is usable.

## 10. Open Decisions

These need a decision before phase 0 starts.

1. **Where does the i-sase repo live physically?**
   Bind-mount the existing local path `/Users/thorsten.a.maier/Projects/i-sase`, or have the stack maintain its own clone in a podman volume and pull from a remote? Local bind-mount is simpler; podman-volume + remote is more "server-mode".

2. **Multi-tenant?**
   Exactly one ACE project per stack instance (V1 recommendation), or should the Admin Console manage several ACE projects in parallel?

3. **Replace or coexist with FastAPI BP Explorer?**
   Recommendation: replace (native React). Confirm.

4. **Are status transitions allowed via chat?**
   Should the BP agent be able to call `bp-transition.py` itself? Recommendation: yes. With `acceptEdits` permission mode the user is asked to approve each Bash invocation, so there is a safety prompt. Source of truth stays in Git.

5. **Child BPs.**
   Each leaf BP gets its own agent; parent BPs get a "coordinator" agent that talks to its children's agents. Confirm.

6. **Author identity.**
   ACE BPs have an `author` field. The Admin Console currently has only the `admin` user. Per existing memory, no personal names go into code or configs — so the `author` rendered in BP creation forms uses `admin` (or a configurable but neutral identifier).

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| LLM edits the `status:` frontmatter directly, bypassing transition rules | CLAUDE.md section explicitly forbids it; PUT endpoint rejects status mutations; review code in Phase 5 to enforce. |
| Worktree paths and Matrix agent ids drift apart | Always pass `--agent-id` derived from the Matrix agent suffix when calling `worktree-ops.py create`. |
| BP watcher replays history after restart | Persist last-seen commit and last-seen index hash; on startup compare against current and only emit forward diffs. |
| Concurrent writes to `brief.md` (UI editor + chat agent) | Use file mtime / Git working-tree status as a soft lock; surface a "BP modified externally" banner in the editor. |
| `acceptEdits` mode means each Bash call prompts the user | Acceptable for V1; revisit if users complain about prompt fatigue. Do NOT silently switch to `bypassPermissions`. |
| Mounting host i-sase repo into a container risks `:Z` / SELinux issues on Linux hosts | Document `:Z` flag in compose for SELinux hosts; on macOS (current environment) bind-mounts work as is. |
| Python script ABI changes between ACE versions | Pin a known-good ACE commit in `.env` (`ACE_REPO_REF`) and document the upgrade procedure. |

## 12. Out of Scope (V1)

- N-Version comparison via parallel agent dispatches (`/ace:compare`).
- CRP / MRP / VCR rendering as Matrix message threads with reactions for approval.
- Blueprint instantiation through chat ("create a new BP from blueprint X").
- Multi-tenant ACE projects.
- Editing MentorScripts through the UI.
- Graph view for BP dependency trees.

These can be added in a later iteration once the BP ↔ agent foundation is in place.
