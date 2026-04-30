---
schema: sase/briefing-pack/v3
id: 081b2b284bd4
slug: bp-explorer-sdk-integration
mission: "BP Explorer — Claude Agent SDK Integration"
status: completed
completed: 2026-03-31T17:15:00Z
rigor: high
created: 2026-03-30
loop-script: high-rigor.yaml
mentor-scripts:
  - mentorscripts/global.md
execution-order:
  - 5a722c889c62
  - eb808c82eb44
  - 686192c722d4
  - eb1cfd556568
---

# BP Explorer — Claude Agent SDK Integration

## Goal

Extend the BP Explorer (`scripts/bp-explorer/`) with a Claude Agent SDK backend to enable direct interaction with Claude Code from the web UI. Users should be able to dispatch BriefingPacks, review MRPs, resolve CRPs, and chat with Claude in project context — all without leaving the browser.

### Why This Matters

The current BP Explorer is read-only. Every action (dispatch, review, status change) requires switching to the terminal and running Claude Code CLI commands. This creates friction and limits accessibility to users comfortable with CLI workflows. Embedding the Agent SDK removes this barrier and turns the BP Explorer into a full ACE control plane.

### Strategic Context

This is an internal tooling improvement that directly accelerates all other project work. Every BP dispatched faster, every MRP reviewed in-browser, saves context-switching overhead across the entire mainframe modernization effort.

---

## Shared Context

### Current Architecture

| Aspect | Value |
|--------|-------|
| Backend | `scripts/bp-explorer/server.py` — Python stdlib `BaseHTTPRequestHandler`, 604 LOC |
| Frontend | `scripts/bp-explorer/index.html` — Vanilla JS + HTML/CSS, 3806 LOC |
| Dependencies | Zero (Python stdlib only) |
| Views | Overview, Dashboard, Graph |
| API Endpoints | `/api/briefings`, `/api/phases`, `/api/mrp/{id}`, `/api/preview` |

### Key Technical Constraints

- The Claude Agent SDK (`claude-agent-sdk`) is an async-first Python wrapper around the Claude Code CLI — it requires Claude Code CLI to be installed on the host machine
- Agent calls are long-running (30s–5min) and stream results via `AsyncIterator[Message]`
- The current `BaseHTTPRequestHandler` is synchronous and single-threaded — incompatible with long-running requests
- SSE (Server-Sent Events) via FastAPI `StreamingResponse` is the preferred streaming mechanism for agent output
- The zero-dependency philosophy should be relaxed minimally: FastAPI + uvicorn + claude-agent-sdk

### Reference Documents

- Claude Agent SDK: `pip install claude-agent-sdk`
- ACE skills in `.claude/skills/` (dispatch, review-mrp, resolve-crp, status)
- Existing BP structure: `artifacts/briefings/`

---

## Decomposition

| # | Child BP | Scope | Dependencies |
|---|----------|-------|-------------|
| 1 | `5a722c889c62` fastapi-backend-migration | Migrate server.py to FastAPI/async, port all endpoints 1:1 | None |
| 2 | `eb808c82eb44` agent-sdk-backend | Integrate Agent SDK, add invoke/session endpoints, SSE streaming | Child 1 |
| 3 | `686192c722d4` action-buttons-ui | Dispatch BP, Review MRP, Resolve CRP buttons in frontend | Child 2 |
| 4 | `eb1cfd556568` chat-panel | Freeform chat panel with project context and streaming display | Child 2, Child 3 |

Children 3 and 4 must run **sequentially** (3 before 4) because both modify `index.html`. Child 4 reuses the SSE client utility and agent output panel created by Child 3.
