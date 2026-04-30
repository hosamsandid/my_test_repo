---
schema: sase/briefing-pack/v3
id: 686192c722d4
slug: action-buttons-ui
mission: "Action Buttons UI"
status: completed
completed: 2026-03-31T12:50:00Z
agent-id: c7388f11
claimed: 2026-03-31T12:00:00Z
last-heartbeat: 2026-03-31T12:50:00Z
phase: package
rigor: standard
depends-on:
  - 081b2b284bd4
---

# Action Buttons UI

Add interactive action buttons to BP Explorer frontend that trigger ACE operations (Dispatch BP, Review MRP, Resolve CRP) via Agent SDK backend. Each action streams real-time agent output into a side panel.

## Acceptance Criteria

- AC-1: **Dispatch Button** -- BPs with `status: ready` and all dependencies met show a "Dispatch" button in Overview and Dashboard views. Clicking triggers `POST /api/agent/invoke` with prompt equivalent to `/ace:dispatch {bp_id}`. Agent output streams into slide-out panel.
- AC-2: **Review MRP Button** -- BPs with `status: completed` and existing MRP show "Review MRP" button. Triggers agent with `/ace:review-mrp {bp_id}`.
- AC-3: **Resolve CRP Button** -- When CRP exists (via `GET /api/crp/{bp_id}`), show "Resolve CRP" button with inline text field for response.
- AC-4: **Agent Output Panel** -- Slide-out panel (right side, reuse preview panel pattern) with: real-time text rendering, tool usage indicators, Cancel button, Done indicator. Auto-scrolls during streaming.
- AC-5: **Status Refresh** -- After agent completion, re-fetch `/api/briefings` without page reload.

## Constraints

- No JavaScript frameworks -- continue vanilla JS
- Reuse existing UI patterns (status colors, card styles, panel slide-out)
- SSE parsing via `fetch()` + `ReadableStream` (not native `EventSource` which is GET-only)
- Buttons disabled while agent in progress (prevent double-dispatch)

## Approach

1. Add SSE client utility function wrapping `fetch()` for POST SSE streams
2. Add agent output panel component (reuse preview panel HTML/CSS pattern)
3. Add "Dispatch" button to dispatchable BPs in Overview and Dashboard
4. Add "Review MRP" button to completed BPs with MRPs
5. Add "Resolve CRP" button with inline text input
6. Wire each button to invoke agent endpoint
7. Add status refresh on agent completion
8. Add cancel button wired to `DELETE /api/agent/sessions/{id}`

## Gotchas

- Preview panel opens on right side -- agent output panel should replace it or use tabs
- Long outputs: consider limiting to last N lines with "Show full log" toggle
- CRP detection uses `GET /api/crp/{bp_id}` from Child 2
- Debounce needed to prevent double-dispatch
- The SSE utility must handle POST (not GET) -- create reusable `sseClient(url, body)` function

## Output Artifacts

- `scripts/bp-explorer/index.html` (extended with action buttons and agent output panel)
