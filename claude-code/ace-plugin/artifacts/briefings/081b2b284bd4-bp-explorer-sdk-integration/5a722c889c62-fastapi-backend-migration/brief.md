---
schema: sase/briefing-pack/v3
id: 5a722c889c62
slug: fastapi-backend-migration
mission: "FastAPI Backend Migration"
status: completed
agent-id: fd6a89e3
claimed: 2026-03-31T10:00:00Z
last-heartbeat: 2026-03-31T10:40:00Z
phase: package
completed: 2026-03-31T10:40:00Z
rigor: standard
created: 2026-03-30
loop-script: standard.yaml
mentor-scripts:
  - mentorscripts/global.md
artifacts:
  - path: scripts/bp-explorer/server.py
    direction: output
    ac: AC-1
    description: "Migrated FastAPI server replacing stdlib BaseHTTPRequestHandler"
  - path: scripts/bp-explorer/requirements.txt
    direction: output
    ac: AC-2
    description: "Python dependencies (fastapi, uvicorn)"
---

# FastAPI Backend Migration

## Goal

Migrate the BP Explorer backend (`scripts/bp-explorer/server.py`) from Python stdlib `BaseHTTPRequestHandler` to FastAPI with uvicorn. All existing API endpoints must be ported 1:1 with identical response formats. This is a pure infrastructure change — no new features.

### Why

The current synchronous, single-threaded server cannot handle long-running Agent SDK calls (30s–5min) without blocking all other requests. FastAPI's async support is a prerequisite for Child BPs 2–4.

## Acceptance Criteria

- [ ] AC-1: **FastAPI Server** — `server.py` uses FastAPI + uvicorn instead of `BaseHTTPRequestHandler`. All existing endpoints (`/`, `/api/briefings`, `/api/phases`, `/api/mrp/{bp_id}`, `/api/preview`) return identical JSON responses. Output: `server.py` in `scripts/bp-explorer/`
- [ ] AC-2: **Minimal Dependencies** — A `requirements.txt` lists only `fastapi` and `uvicorn[standard]`. No other new dependencies. Output: `requirements.txt` in `scripts/bp-explorer/`
- [ ] AC-3: **Async-Ready** — All route handlers are declared `async def`. The data-loading functions (`load_all_briefings`, `build_phases`, etc.) remain synchronous but are called via `run_in_executor` or equivalent to avoid blocking the event loop.
- [ ] AC-4: **Backward Compatibility** — `python3 server.py` or `python3 server.py --port 8765` starts the server on the same default port. The `index.html` frontend works without any changes.
- [ ] AC-5: **CORS Headers** — Add CORS middleware allowing `*` origins (internal tool, no auth needed).

## Context

### Files
- `scripts/bp-explorer/server.py` — 604 LOC, current synchronous server
- `scripts/bp-explorer/index.html` — 3806 LOC, frontend (must not change)

### Dependencies
- `fastapi` — async web framework
- `uvicorn[standard]` — ASGI server

## Constraints

- All existing API response formats must remain identical (frontend depends on them)
- The `--port` CLI argument must continue to work
- Keep the existing business logic functions (`parse_frontmatter`, `load_all_briefings`, `build_phases`, etc.) unchanged — only replace the HTTP layer
- `index.html` must be served as a static file at `/` and `/index.html`

## Approach

1. Add `requirements.txt` with `fastapi` and `uvicorn[standard]`
2. Replace `BPHandler` class and `http.server` imports with FastAPI app and route decorators
3. Port each `_serve_*` method to an `async def` route handler
4. Move `make_handler()` logic into FastAPI lifespan (project root discovery)
5. Replace `main()` with `uvicorn.run()` call, preserving `--port` argument
6. Add `CORSMiddleware` with `allow_origins=["*"]`
7. Verify all endpoints return identical JSON by diffing responses against the current server

## Gotchas

- `parse_frontmatter()` does file I/O on every request — consider caching in a later BP, but do NOT change behavior now
- The `log_message` override for quieter logging needs an equivalent in uvicorn (configure log level)
- `Path(__file__).parent / "index.html"` for static file serving needs to work with FastAPI's `StaticFiles` or a manual `FileResponse`

## Escalation Triggers

- If FastAPI requires Python version > 3.10 and the project targets older versions
- If any existing endpoint response format must change to work with FastAPI
- Security: any auth, crypto, or permissions changes
- Scope: changes beyond `server.py` and `requirements.txt`
