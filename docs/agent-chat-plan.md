# Implementation Plan: Integrated Agent Chat in Admin Console

**Status:** Draft v1 — open for iteration
**Last updated:** 2026-05-05

## 1. Goals & Scope

A lightweight 1:1 chat for talking to Matrix agents directly inside the Admin Console at `http://localhost:4000`, replacing the need to switch to Cinny for everyday agent interaction.

### In scope
- New left-nav entry **"Agent Chat"** with route `/chats` and `/chats/:agentId`.
- Agent selector showing all enabled agents.
- 1:1 DM room per agent, auto-created on first open, persisted.
- Two-pane layout:
  - **Chat panel** — high-level conversation (Markdown, code blocks, syntax highlighting). Mirrors what you would see in Cinny.
  - **Session log panel** (toggleable, right side) — structured timeline of internal agent activity (tool calls, Claude stream events, errors, timings).
- Live streaming of both panels (SSE).
- Pagination/backfill of message history.

### Out of scope (for now)
- E2E encryption, reactions, typing indicators, file/image upload.
- Multi-user auth (single admin user, token from `.env`).
- Threads, replies, edits.
- Custom Claude tool-approval gates — agents run fully autonomous in their sandbox.
- Mobile responsiveness beyond reasonable defaults.

---

## 2. Decisions Already Made

| Topic | Decision | Rationale |
|---|---|---|
| Acting user | Single admin user (`@admin:local`), token from `.env` (`MATRIX_ACCESS_TOKEN`) | Matches current reality, no auth layer needed |
| Token storage | Server-side only (in `admin-console/api`); browser never sees Matrix tokens | Security; no localStorage hacks |
| Browser ↔ Conduwuit | Always via `/api/matrix/*` proxy in `admin-console/api/api.js` | CORS-free, single token boundary |
| Source of truth | Matrix is canonical for messages; the chat UI is just a viewer | Cinny and our UI stay in sync; autonomous agent posts also appear |
| `agentId → roomId` mapping | JSON file `/workspace/agents/<id>/dm-room.json` | Consistent with `config.json`, `triggers.json` |
| Session log format | JSONL at `/workspace/agents/<id>/sessions/<roomId>.jsonl` | Append-only, file-tail-friendly, survives restarts |
| Live updates | SSE (Server-Sent Events) | Matches existing `/api/logs/stream` pattern, simpler than WebSocket |
| Markdown rendering | `react-markdown` + `remark-gfm` + `rehype-pretty-code` (Shiki) | Best visual quality, VS Code-grade syntax highlighting, well-maintained |
| Tool-use visibility | **Not in chat** — only in session log panel | Matches user intent: chat stays clean; details on demand |
| Tool approval / sandbox | **None** — agents run with `--permission-mode bypassPermissions` in their isolated workspace | Explicit user direction; agents are fully autonomous in sandbox |
| Data model | Reuse bp-explorer `contentBlocks: [{type, ...}]` shape for log events | Proven, supports interleaved tool/text streaming |

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  React UI                                                              │
│  ┌─────────────┐  ┌─────────────────────────┐  ┌──────────────────┐   │
│  │ AgentList   │  │ ChatPanel               │  │ SessionLogPanel  │   │
│  │ (250px)     │  │ react-markdown +        │  │ (350px, toggle)  │   │
│  │             │  │ rehype-pretty-code      │  │ tool blocks,     │   │
│  │             │  │ + remark-gfm            │  │ events, timings  │   │
│  └─────────────┘  └─────────────────────────┘  └──────────────────┘   │
└────────────────┬─────────────────────────────┬──────────────────────────┘
                 │ fetch /api/matrix/*         │ SSE /api/agents/.../session/...
                 │ SSE  /api/matrix/.../stream │
                 ▼                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Express API (admin-console/api/api.js)                                │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐   │
│  │ /api/matrix/*                │  │ /api/agents/:id/session/...  │   │
│  │ - list agents                │  │ - GET backfill               │   │
│  │ - createOrGetDmRoom          │  │ - GET stream (tail JSONL)    │   │
│  │ - send / receive messages    │  │                              │   │
│  │ - sync stream (SSE)          │  │                              │   │
│  └──────────────┬───────────────┘  └──────────────┬───────────────┘   │
└─────────────────┼──────────────────────────────────┼───────────────────┘
                  │ HTTP                             │ fs.watch
                  ▼                                  │
┌────────────────────────────────────┐               │
│  Conduwuit (Matrix homeserver)     │               │
│  http://conduwuit:6167             │               │
└──────────────┬─────────────────────┘               │
               │ Matrix events                       │
               ▼                                     │
┌────────────────────────────────────────────────────┴──────────────────┐
│  agent-runner.js (per-agent process)                                  │
│  - listens to room.message in any joined room                         │
│  - DM detected via 2-member-room heuristic → respond                  │
│  - calls claude --output-format stream-json --verbose                 │
│  - parses NDJSON, appends events to sessions/<roomId>.jsonl           │
│  - posts final assistant text to Matrix room                          │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Schemas

### 4.1 Session Log Event (JSONL)

```jsonc
// Wrapper events emitted by agent-runner.js itself
{ "ts":"2026-05-05T10:12:00.000Z", "type":"message.received",
  "correlationId":"$evt:abc",  "from":"@admin:local", "body":"..." }
{ "ts":"...", "type":"claude.invoke",       "correlationId":"$evt:abc", "promptChars":1234 }
{ "ts":"...", "type":"message.posted",      "correlationId":"$evt:abc", "eventId":"$evt:def" }
{ "ts":"...", "type":"error",               "correlationId":"$evt:abc", "stage":"claude", "message":"..." }

// Events forwarded from claude --output-format stream-json
{ "ts":"...", "type":"assistant_text",      "correlationId":"$evt:abc", "text":"..." }
{ "ts":"...", "type":"tool_use",            "correlationId":"$evt:abc", "tool":"Read",
  "toolId":"toolu_01...", "input":{ "file_path":"..." } }
{ "ts":"...", "type":"tool_result",         "correlationId":"$evt:abc",
  "toolId":"toolu_01...", "ok":true, "content":"..." }
{ "ts":"...", "type":"thinking",            "correlationId":"$evt:abc", "text":"..." }
{ "ts":"...", "type":"result",              "correlationId":"$evt:abc",
  "durationMs":12345, "tokens":{ "input":1200, "output":340 } }

// A trigger firing. `triggerType` mirrors the trigger's `type`. A loop
// iteration additionally carries its 1-based number + cap (#1155), so the log
// renders it as "Loop · iteration N of M" and the composer can show live
// progress; both fields are absent on non-loop firings.
{ "ts":"...", "type":"trigger.fired",       "correlationId":"trigger:lp:...",
  "triggerId":"lp", "triggerType":"loop", "loopIteration":3, "loopMaxIterations":25 }

// A parent-ticket binding change (#1383). Appended by the admin console when a
// human binds/rebinds or unbinds the GitHub issue this room is about. No
// correlationId (it is an out-of-band human action, not a chat turn).
{ "ts":"...", "type":"ticket.bound",   "repo":"owner/name", "number":1383,
  "url":"https://github.com/owner/name/issues/1383", "title":"..." }
{ "ts":"...", "type":"ticket.unbound" }
```

`correlationId` is the Matrix event ID of the user message that triggered this work — lets the UI highlight log entries belonging to a chat bubble.

### 4.2 Frontend Message Model (React state)

```ts
type ChatMessage = {
  eventId: string;            // Matrix event id
  sender: 'user' | 'agent';
  ts: number;                 // origin_server_ts
  body: string;               // raw markdown
};

type LogEvent = {
  ts: string;
  type: 'message.received' | 'claude.invoke' | 'assistant_text' | 'tool_use'
       | 'tool_result' | 'thinking' | 'result' | 'message.posted' | 'error';
  correlationId?: string;
  // type-specific fields
  [k: string]: unknown;
};
```

### 4.3 DM Room Persistence

`/workspace/agents/<agentId>/dm-room.json`:
```json
{ "roomId": "!abcd:local", "createdAt": "2026-05-05T...", "createdBy": "@admin:local" }
```

---

## 5. Phased Delivery

Five mergeable PRs. After PR #3 the feature is usable end-to-end; #4 and #5 are additive.

### PR #1 — Backend Matrix Proxy (Phase 1)
**Effort:** 6–8 h
**Files:**
- `admin-console/api/api.js` — add `/api/matrix/*` route group after the existing `/api/mcp` block (~line 410).
- New helper module `admin-console/api/matrix.js` with `matrixFetch(token, path, opts)` and a token resolver that reads `/workspace/agents/<id>/config.json`.
- `docker-compose.yml` — verify `admin-console` container has `/workspace` mounted (currently does); else add.
- `.env` consumption — read `MATRIX_ACCESS_TOKEN` and `CONDUWUIT_INTERNAL_URL` (default `http://conduwuit:6167`).

**Endpoints:**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/matrix/agents` | List agents with userId, displayName, dmRoomId (if known) |
| POST | `/api/matrix/agents/:agentId/dm` | Idempotent create/get DM room; persist `dm-room.json`; invite + auto-join admin |
| GET | `/api/matrix/rooms/:roomId/messages?from=<token>` | Paginated history (proxy to `/_matrix/client/v3/rooms/{}/messages`) |
| POST | `/api/matrix/rooms/:roomId/messages` | Send `m.text` as admin; body: `{ body: "markdown..." }` |
| GET | `/api/matrix/rooms/:roomId/stream` | SSE; long-poll `/_matrix/client/v3/sync` filtered to room; heartbeat every 15 s |

**Sync token persistence:** small file `/workspace/admin-console/sync.json` so we don't lose events across API restarts.

**Tests:** curl-driven smoke tests committed as `admin-console/api/test-matrix.sh`.

### PR #2 — Agent-runner: DM auth + Stream-JSON Logging (Phase 2)
**Effort:** 6–8 h
**Files:**
- `orchestrator/agent-runner.js` lines 316–336 — replace `ADMIN_USER_ID` hardcode with 2-member-room heuristic via `client.getJoinedRoomMembers(roomId)`.
- `orchestrator/agent-runner.js` `callClaude()` — switch from current invocation to:
  ```bash
  claude --output-format stream-json --verbose --permission-mode bypassPermissions -p "<prompt>"
  ```
- New helper `orchestrator/session-log.js`:
  - `appendEvent(agentId, roomId, event)` — atomic append to JSONL, fsync on close.
  - NDJSON line parser that maps Claude stream events → our schema (see § 4.1).
- `admin-console/api/api.js` — two new endpoints:
  | Method | Path | Purpose |
  |---|---|---|
  | GET | `/api/agents/:agentId/session/:roomId?since=<offset>` | Static backfill |
  | GET | `/api/agents/:agentId/session/:roomId/stream?since=<offset>` | SSE tail with `fs.watch`; heartbeat 15 s |

**Notes:**
- `--permission-mode bypassPermissions` reflects the user's decision to grant agents full sandbox autonomy. No PreToolUse gating in the UI.
- Log retention: emit-only for now. Cleanup is Phase 5 (or never — JSONL is small).

### PR #3 — Frontend: Chat View (Phase 3)
**Effort:** 6–8 h
**New files:**
- `admin-console/src/pages/AgentChat.jsx` — top-level page, owns layout state (which agent, log panel open/closed).
- `admin-console/src/pages/agent-chat/AgentList.jsx` — left rail.
- `admin-console/src/pages/agent-chat/ChatPanel.jsx` — main column; hosts a per-user transcript font-size −/+ stepper in the session toolbar (#1437 — default 12px, range 10–18px). The message scroll container sets a scoped `--chat-font-size` CSS var that the message bubble reads; the chosen size is persisted server-side on the user record (`PUT /api/me/preferences` → `describeAuthz.chatFontSize` in the session), with a per-username `agentChat.fontSize.<username>` localStorage fallback for the env single-admin. Pure clamp/step/persist logic in `chat-font-size.js`.
- `admin-console/src/pages/agent-chat/Message.jsx` — single message bubble with `react-markdown`; the bubble font-size reads `var(--chat-font-size, var(--eb-text-md))` so it scales with the toolbar stepper and falls back to the 14px token outside the chat view.
- `admin-console/src/pages/agent-chat/MessageInput.jsx` — textarea, optimistic insert; a user-configurable send keybinding (`agentChat.sendKeybinding`: `ide` = Cmd/Ctrl+Enter sends / Enter newline, default; `chat` = Enter sends / Shift+Enter newline) with OS-aware (`⌘` vs `Ctrl`) placeholder + Send-tooltip hints — pure logic in `message-send-keybinding.js`. The keybinding selector is configured in **Settings → Behavior** (`SettingsModal.jsx`, #1804), not the composer footer; the composer consumes the preset read-only and re-reads it on the same-tab `SEND_KEYBINDING_CHANGED_EVENT` / cross-tab `storage` event, so a change applies to the active chat immediately. The composer draft is persisted per agent under `agentChat.draft.<agentId>` (pure logic in `message-draft.js`) so text typed for one agent survives switching to another agent and back — restored on mount, cleared on a successful send (#1388). While the agent is busy on a chat turn or a launched loop, the primary-action button switches from Send to a single unified **Stop** (⏹) control (#1427) that aborts whatever is running via the existing session-stop path (`POST /api/agents/:id/session/:roomId/stop`) — the loop control is then launch-only (no second stop affordance), and a turn stop drops a distinct "Stopped by user" marker into the transcript. The Send-vs-Stop mode decision is the pure `composer-action.js`.
- `admin-console/src/hooks/useSSE.js` — generic SSE hook with reconnect (exponential backoff) and `since` offset support, modeled on bp-explorer `sseClient()` (app.js:4518–4631).

**Edits:**
- `admin-console/src/components/Shell.jsx` lines 9–30: add `{ path: '/chats', label: 'Agent Chat', Icon: MessageCircle }` under `OVERVIEW` group.
- `admin-console/src/components/Shell.jsx` lines 32–43: add breadcrumb entry.
- `admin-console/src/App.jsx` lines 5–14, 20–31: lazy-import + route `/chats` and `/chats/:agentId`.

**Dependencies (`admin-console/package.json`):**
```json
"react-markdown": "^9.0.0",
"remark-gfm": "^4.0.0",
"rehype-pretty-code": "^0.13.0",
"shiki": "^1.0.0"
```
Shiki gives VS Code-grade syntax highlighting and looks markedly better than highlight.js. We pre-compile a small theme bundle to keep bundle size under control.

**UX details:**
- Stick-to-bottom scroll behavior (only auto-scroll if user is already near bottom).
- Live streaming bubble: while the agent is replying (i.e. there are unresolved log events for the last user message), show a small "thinking…" indicator. The actual streaming text comes from Matrix when the agent posts (we don't expose Claude's raw token stream in the chat — that's the log panel's job).
- Optimistic local echo of sent messages, replaced by canonical Matrix event when sync confirms.

### PR #4 — Session Log Panel (Phase 4)
**Effort:** 3–5 h
**New files:**
- `admin-console/src/pages/agent-chat/SessionLogPanel.jsx` — right rail, toggleable.
- `admin-console/src/pages/agent-chat/LogEvent.jsx` — single event row.
- `admin-console/src/pages/agent-chat/ToolBlock.jsx` — collapsible tool_use + tool_result pair (ported from bp-explorer `renderToolBlock()` app.js:6055–6087, restyled to match admin-console CSS variables).

**Features:**
- SSE subscription via `useSSE` to `/api/agents/:id/session/:roomId/stream`.
- Filter chips: All / Tool Calls / Errors / Posted.
- Toggle visibility (Cmd+Shift+L), persisted in `localStorage`.
- Connection-status dot.
- Hover correlation: hovering a chat bubble dims log entries with non-matching `correlationId`, and vice versa.

### PR #5 — Polish (Phase 5)
**Effort:** 3–4 h
- Backfill on scroll-up in ChatPanel (uses `from` token from `/api/matrix/rooms/:id/messages`).
- Empty states, loading skeletons, error banners.
- HTML sanitization (`rehype-sanitize`) — defensive, even though body is plain markdown.
- Persisted last-opened agent in `localStorage`.
- README and `CLAUDE.md` updates: new endpoints, session log format, navigation.
- Dark/light theme matching for Shiki blocks (admin-console uses CSS variables — wire one Shiki theme per mode).

---

## 6. Effort Summary

| PR | h |
|---|---|
| #1 — Backend Matrix proxy | 6–8 |
| #2 — Agent-runner DM + stream-json + log API | 6–8 |
| #3 — Chat UI (no log panel) | 6–8 |
| #4 — Session log panel | 3–5 |
| #5 — Polish | 3–4 |
| **Total** | **24–33 h** (~3–5 person-days) |

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Conduwuit `/sync` drift if API restarts without saved sync token | Lost messages between restarts | Persist sync token to `/workspace/admin-console/sync.json` after every batch |
| Long Claude runs (`CLAUDE_TIMEOUT=3600s`) cause SSE proxy timeouts | Chat appears stuck | 15 s heartbeat comments; client auto-reconnect with `since` offset |
| `claude --output-format stream-json` schema changes upstream | Log panel renders garbage | Wrap parser in try/catch per line; emit `error` event on parse failure; never crash the runner |
| `dm-room.json` race when two API processes try to create simultaneously | Duplicate rooms | Use atomic write (`writeFile` to tmp → rename); check Matrix `joined_rooms` before creating |
| Agent token in `config.json` becomes invalid (Conduwuit data loss) | DM fails silently | API returns 502 with diagnosis; surface in UI as "agent offline" |
| JSONL files grow unbounded | Disk fill on long-running agents | Phase 5 (or later): rotation script; for now monitor; events are small (<200 B avg) |
| Shiki bundle size | Slow page load | Tree-shake to a single theme + the languages we actually use (cobol, jcl, sql, js, ts, json, bash) |
| Two-member-room heuristic misclassifies a 1:1 with another agent as a DM | Wrong agent answers in inter-agent room | Add explicit guard: only respond if other member is not in the agent registry |

---

## 8. Open Questions for Future Iteration

1. **Multi-DM-rooms per agent** — useful for "topical" conversations? For now: 1 room per agent. Reconsider if Cinny usage shows demand.
2. **Trigger output styling** — autonomous agent posts arriving via cron triggers in the same DM room: visually mark as "autonomous" or treat as regular agent message?
3. **Session log retention policy** — manual cleanup, time-based rotation, or size-based truncation. Defer until we have real usage data.
4. **Admin user multi-tenancy** — if more humans want to use the console, we need an auth layer in front of `/api`. Out of scope for this iteration.

---

## 9. Concrete File/Line Reference Cheat Sheet

| Task | File | Line(s) | Action |
|---|---|---|---|
| Add nav entry | `admin-console/src/components/Shell.jsx` | 9–30 | Insert `{ path: '/chats', label: 'Agent Chat', Icon: MessageCircle }` |
| Add breadcrumb | `admin-console/src/components/Shell.jsx` | 32–43 | `'/chats': 'Agent Chat'` |
| Add route | `admin-console/src/App.jsx` | 5–14, 20–31 | Lazy import + `<Route path="/chats" />` and `/chats/:agentId` |
| Backend Matrix proxy | `admin-console/api/api.js` | after ~410 | New `/api/matrix/*` route group |
| Backend session log | `admin-console/api/api.js` | new section | New `/api/agents/:id/session/:roomId(/stream)` |
| DM auth | `orchestrator/agent-runner.js` | 316–336 | Replace `ADMIN_USER_ID` check with 2-member heuristic |
| Stream-JSON | `orchestrator/agent-runner.js` | `callClaude()` | Switch to `--output-format stream-json --verbose --permission-mode bypassPermissions` |
| Session log writer | `orchestrator/session-log.js` | new file | NDJSON parser + JSONL append |

---

## 10. Reuse from `bp-explorer` (`/Users/thorsten.a.maier/Projects/i-sase/scripts/bp-explorer`)

Patterns/code we adapt rather than reinvent:

| Concept | bp-explorer source | Adaptation |
|---|---|---|
| `contentBlocks` data model | `app.js:6100–6151` | Direct reuse for log panel events |
| Tool-block UI (collapsible, spinner→check) | `app.js:6055–6087`, `styles.css:4074–4172` | Port to React `ToolBlock.jsx`, restyle to admin-console CSS |
| SSE client with reconnect + offset | `app.js:4518–4631` | Adapt as `useSSE` React hook |
| Event dispatch / message-type mapping | `agent_bridge.py:579–673` | Port logic to JS in `session-log.js` (NDJSON parsing) |
| In-memory event buffer with offset replay | `agent_bridge.py:63–124` | Not needed — we use JSONL on disk; offset replay from file byte position |
| Smart auto-scroll, MAX_VISIBLE_MESSAGES | `app.js:5571, 6181` | Port behavior into ChatPanel/SessionLogPanel |
| Markdown renderer | `app.js:1064–1184` | **Discarded** — we use `react-markdown` + `rehype-pretty-code` for better quality |
| BP-context injection, embedded-vs-standalone duplication | various | Not relevant, ignored |
