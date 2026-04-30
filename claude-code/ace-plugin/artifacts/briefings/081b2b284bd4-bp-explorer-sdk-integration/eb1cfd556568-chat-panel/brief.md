---
schema: sase/briefing-pack/v3
id: eb1cfd556568
slug: chat-panel
mission: "Chat Panel"
status: completed
completed: 2026-03-31T17:15:00Z
rigor: standard
created: 2026-03-30
agent-id: 6226f89d
claimed: 2026-03-31T16:51:36Z
last-heartbeat: 2026-03-31T17:15:00Z
phase: package
depends-on:
  - eb808c82eb44
  - 686192c722d4
loop-script: standard.yaml
mentor-scripts:
  - mentorscripts/global.md
artifacts:
  - path: scripts/bp-explorer/index.html
    direction: output
    ac: AC-1
    description: "Extended frontend with chat panel view"
  - path: scripts/bp-explorer/server.py
    direction: input
    description: "FastAPI server with agent endpoints (from Child 1+2)"
  - path: scripts/bp-explorer/agent_bridge.py
    direction: input
    description: "Agent SDK bridge module (from Child 2)"
---

# Chat Panel

## Goal

Add a freeform chat panel to the BP Explorer that allows users to converse with Claude in full project context. The chat supports multi-turn conversations with streaming responses, providing a browser-based alternative to the Claude Code CLI.

### Why

Not every interaction fits a predefined action button. Users need to ask ad-hoc questions ("What does DMDH001P do?", "Which BPs are blocked and why?", "Explain the dependency between Phase A and B"), run exploratory analyses, or give freeform instructions. A chat panel provides this flexibility without leaving the BP Explorer.

## Acceptance Criteria

- [ ] AC-1: **Chat View** — A fourth view tab "Chat" is added alongside Overview, Dashboard, and Graph. The view contains a message input area at the bottom and a scrollable message history above. Output: updated `index.html` in `scripts/bp-explorer/`
- [ ] AC-2: **Streaming Responses** — User messages are sent to `POST /api/agent/invoke` with session context. Claude's response streams in real-time via SSE, rendered as markdown in the chat history. Tool usage is shown as collapsible blocks (tool name + result summary).
- [ ] AC-3: **Session Continuity** — Conversations maintain context across multiple turns within the same browser session. The backend holds a `ClaudeSDKClient` instance per chat session, which automatically maintains conversation context across `client.query()` calls. Alternatively, the `resume` parameter (via `session_id` from `ResultMessage.session_id`) can be used with the standalone `query()` function. The `ClaudeSDKClient` approach is preferred as it avoids manual session ID tracking.
- [ ] AC-4: **Context-Aware** — The chat agent has access to: (a) the full project context (CLAUDE.md, project root), (b) the currently selected BP (if any) as additional context, (c) all standard Claude Code tools (Read, Grep, Bash, etc.) via the Agent SDK.
- [ ] AC-5: **Input Controls** — The input area supports: (a) multi-line input (Shift+Enter for newline, Enter to send), (b) a send button, (c) a "Stop" button visible during streaming, (d) a "New conversation" button to reset the session.

## Context

### Files
- `scripts/bp-explorer/index.html` — 3806 LOC, three existing view tabs
- `scripts/bp-explorer/server.py` — FastAPI server with Agent SDK endpoints (after Child 1+2)

### Dependencies
- Agent SDK backend endpoints from Child 2 (`POST /api/agent/invoke`, session management)
- SSE client utility `sseClient()` and agent output panel from Child 3 (reuse directly)

## Constraints

- No JavaScript frameworks — continue vanilla JS
- Chat history is in-memory only (no persistence across page reloads)
- Markdown rendering should reuse the existing `renderMarkdown()` function
- The chat view should not interfere with the other three views (clean view switching)
- Message input must not submit empty messages

## Approach

1. Add "Chat" tab button to the view switcher bar
2. Create chat view container with message history area and input controls
3. Implement message rendering (user messages right-aligned, assistant left-aligned)
4. Reuse `sseClient()` utility from Child 3 for SSE streaming
5. Add session management: on first message, the backend creates a `ClaudeSDKClient` instance (async context manager) and stores it in the session registry. Follow-up messages call `client.query()` on the same instance — session context is maintained automatically without manual `resume`/`session_id` passing. "New conversation" discards the client and creates a fresh one
6. Add "currently viewing BP" context injection when a BP is selected in other views
7. Reuse tool-use rendering from Child 3's agent output panel as collapsible blocks
8. Add keyboard shortcuts (Enter to send, Shift+Enter for newline, Escape to cancel)

## Gotchas

- The existing `renderMarkdown()` is basic — may need extension for code blocks with syntax highlighting in chat responses
- Session continuity uses `ClaudeSDKClient` instances held in the backend session registry. The client maintains conversation state automatically across `client.query()` calls. If the server restarts, all chat sessions are lost (in-memory only). Alternatively, `ResultMessage.session_id` + `resume` parameter can serve as a fallback for session recovery
- Long conversations will grow the DOM — consider virtualizing or limiting visible history
- The "currently selected BP" context requires cross-view state sharing — currently each view has its own state object; introduce a minimal `appState.selectedBpId` shared across views

## Escalation Triggers

- If markdown rendering needs a full library (marked.js, etc.) to handle chat output quality
- Security: any auth, crypto, or permissions changes
- Scope: changes beyond `index.html`
