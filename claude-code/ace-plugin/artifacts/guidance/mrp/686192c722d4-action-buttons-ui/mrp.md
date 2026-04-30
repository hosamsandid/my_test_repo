---
schema: sase/mrp/v1
id: d1dbaea59255
bp: 686192c722d4
status: pending-review
produced-by: c7388f11
auto-score: true
created: 2026-03-31
---

# Mission Review Protocol -- Action Buttons UI

## 1. Functional Completeness

All 5 Acceptance Criteria are met:

**AC-1: Dispatch Button** -- PASS. BPs with `status: ready` and all dependencies met show a "Dispatch" button in both the Overview (Queued section, dispatchable cards) and Dashboard (subtask card headers and phase header). Clicking triggers `POST /api/agent/invoke` with `prompt: '/ace:dispatch {bp_id}'` via the `sseClient()` utility. Agent output streams into the slide-out agent panel. The `isDispatchable()` helper function checks both status and dependency conditions.

**AC-2: Review MRP Button** -- PASS. BPs with `status: completed` and `has_mrp: true` show a "Review MRP" action button in Dashboard subtask cards. Clicking triggers agent invocation with `prompt: '/ace:review-mrp {bp_id}'`. This is distinct from the existing "Completion Report" button which opens the preview panel for direct MRP viewing.

**AC-3: Resolve CRP Button** -- PASS. After dashboard content renders, async CRP detection runs via `detectAndRenderCrp()` which calls `GET /api/crp/{bp_id}`. When a CRP exists, a row with an inline text input and "Resolve CRP" button appears below the subtask header. Submitting (via button click or Enter key) invokes the agent with `prompt: '/ace:resolve-crp {bp_id} --response "{text}"'`. A CRP cache (`crpCache`) prevents redundant API calls.

**AC-4: Agent Output Panel** -- PASS. A slide-out panel (`#agent-panel`) mirrors the existing preview panel pattern. Features include: monospace font for terminal-like output, real-time text rendering via `appendAgentOutput()`, tool usage indicators (styled badges), a Cancel button wired to `DELETE /api/agent/sessions/{id}`, a status bar with Done/Error/Cancelled indicators, auto-scrolling during streaming, and a "Show full log" toggle limiting display to the last 200 lines for long outputs.

**AC-5: Status Refresh** -- PASS. After agent completion (`onComplete` callback), `refreshAfterAgent()` re-fetches `/api/briefings`, rebuilds internal state, invalidates the CRP cache, and re-renders the current view (Overview or Dashboard) without page reload.

## 2. Sound Verification

**Structural validation performed:**
- HTML tag balance verified: all major tags (html, head, body, style, script, div) have matching open/close counts (div: 128/128)
- JavaScript bracket balance verified: parentheses, braces, and brackets all balance to 0
- All 20 new function definitions verified as present via automated script
- All onclick handlers verified to reference existing function definitions

**Edge cases addressed:**
- SSE parser handles split events across read() chunks (eventType/dataLines persisted across loop iterations)
- SSE parser handles non-JSON plain text data gracefully
- CRP cache prevents excessive API calls during re-renders
- Abort controller properly cleans up on cancel
- Agent panel and preview panel are mutually exclusive (opening one closes the other when not actively streaming)
- Double-dispatch prevention via `agentState.active` flag and disabled buttons

**No test suite configured.** The project has no `package.json`, `pyproject.toml`, or `Makefile` with test commands. The LoopScript gate-command could not be executed for this reason.

## 3. SE Hygiene

- All user-provided strings are escaped via `esc()` before HTML insertion -- XSS protection maintained
- Error handling: all async operations use try/catch; SSE client has comprehensive error callbacks; refresh failures are silently handled with fallback to manual reload
- No secrets, API keys, or tokens in source code
- No external dependencies added
- Code follows existing patterns: CSS variable usage, class naming conventions, function naming, indentation
- No linter configured for the project; manual code review performed

## 4. Clear Rationale

**Key design decisions:**

1. **Agent panel placement:** Added as a sibling of `#preview-panel` inside `#dashboard` (flex container). When the agent panel opens, it closes the preview panel. When a preview opens while the agent is not streaming, it closes the agent panel. This avoids both panels competing for space.

2. **SSE client as reusable utility:** Extracted `sseClient(url, body, callbacks)` as a standalone function returning `{cancel, getSessionId}`. This follows the BP approach for reusability by Child 4. Uses `fetch()` + `ReadableStream` (not `EventSource`) to support POST.

3. **Line limiting for long outputs:** Defaults to showing last 200 lines with a "Show full log" toggle button. This addresses the gotcha about long agent outputs without losing data.

4. **CRP detection is async:** Rather than blocking dashboard rendering, CRP status is checked asynchronously after the content is rendered. CRP rows are hidden by default and shown when a CRP is detected. Results are cached.

5. **Button disabled state:** All `.agent-action-btn` elements are disabled when `agentState.active` is true, preventing double-dispatch. This is enforced both at render time (initial `disabled` attribute) and dynamically via `updateAllActionButtons()`.

No CRPs were created during this mission.

## 5. Full Auditability

**Git trail:**

| Commit | Description |
| --- | --- |
| `8e2cbdc` | `claim(bp:686192): claimed by agent c7388f11` |
| `c652861` | `heartbeat(bp:686192): phase plan` |
| `80e3542` | `heartbeat(bp:686192): phase implement - action buttons and agent panel` |
| `22c431c` | `heartbeat(bp:686192): phase self-review - SSE parser fix, structural verification` |

**Files changed:**

| File | Description |
| --- | --- |
| `scripts/bp-explorer/index.html` | Extended with ~665 lines: CSS for agent panel and action buttons, HTML for agent panel structure, JS for SSE client utility, agent state management, dispatch/review/resolve action functions, CRP detection, and status refresh |
| `artifacts/briefings/081b2b284bd4-bp-explorer-sdk-integration/686192c722d4-action-buttons-ui/brief.md` | BP frontmatter updates (status, heartbeat, phase) |
| `artifacts/guidance/mrp/686192c722d4-action-buttons-ui/mrp.md` | This MRP |
