---
schema: sase/briefing-pack/v3
id: 01fc27c00ba5
slug: test-standalone-dispatch
mission: "Test Standalone Dispatch Flow"
created: 2026-04-13
author:
  - Thorsten Maier
status: draft
rigor: standard
loop-script: skills/engineering/loops/standard.yaml
mentor-scripts:
  - mentorscripts/global.md
---

# Mission: Test Standalone Dispatch Flow

## Goal & Why

Verify end-to-end that a standalone root-level BP (no child BPs) moves correctly through the `draft → ready → dispatched` lifecycle in the BP Explorer Dashboard. This confirms that the approval gate and dispatch mechanism work for the simplest BP topology before validating more complex hierarchies.

## Acceptance Criteria

- [ ] **AC-1 Dashboard Visibility**: The BP appears in the "Drafts" section of the BP Explorer Dashboard (`http://bp-explorer.localhost`) when its frontmatter `status` is `draft`; it moves to the "Ready to Dispatch" section within 5 seconds (or after one manual page reload) when `status` is changed to `ready`.
- [ ] **AC-2 Approve Transition**: Clicking the Approve button triggers a server-side write that sets `status: ready` in `brief.md`; the Dashboard reflects the updated status without a full browser reload.
- [ ] **AC-3 Dispatch Action**: Clicking "Handover task to an agent" on a `ready` BP creates a git worktree at `.worktrees/{agent-id}-01fc27c00ba5/` and sets `status: dispatched` in `brief.md` within 10 seconds; `git branch --all | grep 01fc27c00ba5` lists the agent branch.

## Context

- **BP under test**: `artifacts/briefings/01fc27c00ba5-test-standalone-dispatch/brief.md`
- **Frontend (JS)**: `scripts/bp-explorer/app.js` — All dashboard logic (6665 LOC, 204 functions); search for `Ready to Dispatch` (~line 2474) and `Drafts` (~line 2475) to locate section filtering; `transitionBP` (~line 4800) for Approve/Dispatch button handlers
- **Frontend (HTML)**: `scripts/bp-explorer/index.html` — Static shell and glossary overlay (334 LOC, no JS functions)
- **Backend**: `scripts/bp-explorer/server.py` — HTTP API handlers; look for approve and dispatch endpoints
- **Worktree root**: `.worktrees/` (relative to repo root, gitignored by default)
- **Tools portal**: Start via `make tools`; Dashboard reachable at `http://bp-explorer.localhost`

## Constraints

- Do not modify `id`, `slug`, or `created` frontmatter fields during testing.
- Reset `status` back to `draft` after the test run to leave the repository in a clean state.
- If the BP Explorer is not already running, do not attempt to start it from within the agent session — raise a CRP instead.

## Gotchas

- The BP Explorer was read-only before the Agent SDK integration (BP `081b2b284bd4`); the Approve and Dispatch endpoints only exist once that BP's changes are deployed and the server is restarted.
- `git worktree add` fails if a branch for this BP hash already exists; run `git branch --all | grep 01fc27c00ba5` before dispatching and clean up stale branches first.
- The Dashboard may require a manual page reload to reflect status changes if SSE streaming is inactive.
- `app.js` defines 204 functions; before adding dashboard logic check for duplicate names via `grep -n "function <name>" scripts/bp-explorer/app.js`. JS hoisting means the last definition silently wins.

## Escalation Triggers

- If `http://bp-explorer.localhost` does not respond → raise CRP (infrastructure issue, out of scope for this BP)
- If the Approve or Dispatch endpoint is absent from `server.py` → raise CRP (feature gap; do not implement it here)
- If `git worktree add` fails with a non-duplicate-branch error → raise CRP (git state inconsistency)
- If the Dispatch button causes a Python traceback in the server log → raise CRP (Agent SDK not installed or misconfigured)
