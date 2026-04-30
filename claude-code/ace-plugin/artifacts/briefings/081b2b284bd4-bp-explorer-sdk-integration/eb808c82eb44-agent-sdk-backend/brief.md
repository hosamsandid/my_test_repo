---
schema: sase/briefing-pack/v3
id: eb808c82eb44
slug: agent-sdk-backend
mission: "Agent SDK Backend Integration"
status: completed
agent-id: 5457a919
claimed: 2026-03-31T10:00:00Z
last-heartbeat: 2026-03-31T11:15:00Z
phase: package
completed: 2026-03-31T11:15:00Z
rigor: standard
created: 2026-03-30
depends-on:
  - 5a722c889c62
loop-script: standard.yaml
mentor-scripts:
  - mentorscripts/global.md
artifacts:
  - path: scripts/bp-explorer/agent_bridge.py
    direction: output
    ac: AC-1
    description: "Agent SDK wrapper module with session management"
  - path: scripts/bp-explorer/server.py
    direction: output
    ac: AC-2
    description: "Extended server with agent API endpoints"
---

# Agent SDK Backend Integration

## Goal

Integrate the Claude Agent SDK into the BP Explorer backend, providing API endpoints for invoking Claude agents and streaming their output via SSE (Server-Sent Events). This creates the foundation for all interactive features in Child BPs 3 and 4.

### Why

Without a backend bridge to the Agent SDK, the frontend cannot trigger any Claude Code operations. This BP establishes the programmatic interface between the web UI and Claude's agentic capabilities.

## Acceptance Criteria

- [ ] AC-1: **Agent Bridge Module** — A new `agent_bridge.py` module wraps the Claude Agent SDK's `query()` function and `ClaudeSDKClient`. It exposes: (a) `invoke(prompt, system_prompt?, session_id?) -> AsyncIterator` that yields structured events, (b) `cancel(session_id)` to interrupt a running agent via `ClaudeSDKClient.interrupt()`, (c) `list_sessions()` to list active/recent sessions. Uses `ClaudeAgentOptions` to configure model, tools, permissions, and cwd. The `ClaudeSDKClient` is used as an async context manager (`async with ClaudeSDKClient(options=...) as client`). Message dispatch uses `isinstance` checks over the `Message` union type (`AssistantMessage`, `ResultMessage`, `SystemMessage`, `StreamEvent`, `UserMessage`, `RateLimitEvent`) and content block types (`TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`) to map SDK output to SSE event types. Output: `agent_bridge.py` in `scripts/bp-explorer/`
- [ ] AC-2: **SSE Streaming Endpoint** — `POST /api/agent/invoke` accepts `{prompt, system_prompt?, session_id?}` and returns a FastAPI `StreamingResponse` with `media_type="text/event-stream"`. Each SSE event is formatted as `data: {json}\n\n` with event types: `assistant_text`, `tool_use`, `tool_result`, `result`, `error`. Includes `:keepalive\n\n` heartbeat every 15s. Output: endpoint in `server.py` in `scripts/bp-explorer/`
- [ ] AC-3: **Session Management** — `GET /api/agent/sessions` lists active sessions. `DELETE /api/agent/sessions/{id}` cancels a running session via `ClaudeSDKClient.interrupt()` or `asyncio.Task.cancel()`. The SDK's `resume` parameter in `ClaudeAgentOptions` is used for multi-turn continuity.
- [ ] AC-4: **Project Context Injection** — The agent bridge configures `ClaudeAgentOptions(cwd=project_root, system_prompt=...)` with CLAUDE.md content and briefings directory location, so the agent operates with full project awareness.
- [ ] AC-5: **Error Handling** — `CLINotFoundError` (Claude Code CLI not installed) returns HTTP 503 with setup instructions. `CLIConnectionError`, `ProcessError`, and `CLIJSONDecodeError` are caught and streamed as `{type: "error"}` SSE events. Note: `CLINotFoundError` is a subclass of `CLIConnectionError`. Missing `ANTHROPIC_API_KEY` returns HTTP 503 at startup check. No unhandled exceptions crash the server.
- [ ] AC-6: **CRP Detection Endpoint** — `GET /api/crp/{bp_id}` checks for CRP files in `artifacts/crp/{bp_id}-*/` and returns `{exists: bool, path?: string, body?: string}`. Required by Child 3 for the Resolve CRP button.

## Context

### Files
- `scripts/bp-explorer/server.py` — FastAPI server (after Child 1 migration)
- `.claude/` — Skills, agents, and project configuration
- `CLAUDE.md` — Project instructions for agent context

### Dependencies
- `claude-agent-sdk>=0.1.50,<0.2.0` — Claude Agent SDK for Python (async-first wrapper around Claude Code CLI, bundles CLI since recent versions)
- `fastapi` — already present from Child 1
- Claude Code CLI — bundled with pip package; separate installation optional but supported via `ClaudeAgentOptions(cli_path=...)`

## Constraints

- API key must come from environment variable `ANTHROPIC_API_KEY` (never hardcoded, never sent to frontend)
- Agent sessions must not block other HTTP requests (async execution)
- SSE stream must include heartbeat events (`:keepalive\n\n` every 15s) to prevent proxy/browser timeouts
- The agent bridge should be a separate module (`agent_bridge.py`), not inline in `server.py`

## Approach

1. Create `agent_bridge.py` with an `AgentBridge` class wrapping `claude_agent_sdk.query()` and `ClaudeSDKClient`
2. Implement `invoke()` as an async generator that uses `ClaudeSDKClient` as async context manager, calls `client.query(prompt)`, iterates `client.receive_response()` (yields `Message` union), and dispatches via `isinstance` checks: `AssistantMessage` → extract `TextBlock`/`ToolUseBlock`/`ToolResultBlock`/`ThinkingBlock` content blocks; `ResultMessage` → final result with `session_id`; `StreamEvent` → partial streaming tokens; `RateLimitEvent` → rate limit info. Each maps to an SSE event type (`assistant_text`, `tool_use`, `tool_result`, `thinking`, `result`, `error`, `rate_limit`)
3. Configure `ClaudeAgentOptions(cwd=project_root, system_prompt=..., model="claude-sonnet-4-6", permission_mode="acceptEdits")`
4. Add session tracking: store active `ClaudeSDKClient` instances per session in an in-memory dict (enables `interrupt()` for cancel and `client.query()` for follow-ups). Use `ResultMessage.session_id` as the session key for `resume`-based continuity
5. Add FastAPI routes: `POST /api/agent/invoke`, `GET /api/agent/sessions`, `DELETE /api/agent/sessions/{id}`, `GET /api/crp/{bp_id}`
6. Use `StreamingResponse(media_type="text/event-stream")` with `async def event_generator()` for SSE
7. Add `claude-agent-sdk` to `requirements.txt`
8. Add startup check: verify Claude Code CLI is installed and `ANTHROPIC_API_KEY` is set
9. Test with a simple prompt to verify end-to-end streaming

## Gotchas

- **CLI Dependency**: The Agent SDK is a wrapper around Claude Code CLI — it spawns `claude` as a subprocess. Recent SDK versions bundle the CLI in the pip package, but a separate installation may still be present. If the CLI is not found, `CLINotFoundError` (subclass of `CLIConnectionError`) is raised. The server must handle this gracefully at startup.
- **SSE Formatting**: SSE requires `data: ...\n\n` — newlines in agent output must be escaped or split into multiple `data:` lines per the SSE spec
- **Model Selection**: Default to `claude-sonnet-4-6` for interactive use (cost-efficient). Allow override via request parameter for power users.
- **Browser EventSource**: Only supports GET — the frontend will need `fetch()` with a `ReadableStream` reader for POST SSE parsing
- **Permission Mode**: Use `permission_mode="acceptEdits"` to avoid the SDK prompting for tool approval (there's no terminal to respond to)
- **Concurrent Sessions**: Multiple users hitting `/api/agent/invoke` simultaneously will spawn multiple Claude CLI processes — monitor resource usage
- **SDK Version**: Pin `claude-agent-sdk>=0.1.50,<0.2.0` in `requirements.txt` — the API has been evolving rapidly (53+ releases). The `ClaudeSDKClient` async context manager pattern and `Message` union type are stable since 0.1.50
- **Message Type Dispatch**: `Message` is a union of 6 types, and `AssistantMessage.content` contains a list of content blocks (`TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`). The `invoke()` generator must handle all combinations to avoid `AttributeError` on unexpected message/block types

## Escalation Triggers

- If the Agent SDK does not support async/streaming in Python
- If the SDK requires features not available in the installed Python version
- If project context injection requires reading more than CLAUDE.md (e.g., loading all skills)
- Security: any auth, crypto, or permissions changes
- Scope: changes beyond `server.py`, `agent_bridge.py`, and `requirements.txt`
