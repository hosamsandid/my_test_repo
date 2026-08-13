# Helper Chat — Concept Document

> Status: concept approved, implementation planned
> Issue: https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1723
> Author: business-analyst agent, 2026-08-13

---

## 1. Problem

Users consistently report that Agent Studio is hard to use without hand-holding:

- Core concepts are not obvious (Team vs. Agent Team, Working Environment, Trigger, Flow…)
- It is not clear where to click or in what order to do things
- There is no one to ask when something unexpected happens
- Errors and unexpected states are not self-explaining
- The existing `/getting-started` page and static `InfoTip` tooltips are passive reference material, not interactive guidance

Result: drop-off, support overhead, dependency on training.

---

## 2. Solution overview

Two layers, independently shippable:

| Layer | What it is | When |
|---|---|---|
| **1 — Helper Chat** | Persistent AI chat panel, available on every page | Phase 1 (MVP) |
| **2 — Guided Tour** | Structured walkthrough of the 6 core use cases, built on journey artifacts | Phase 2 |

---

## 3. Layer 1 — Helper Chat

### 3.1 User experience

- A **launcher button** in the Shell header (top-right cluster, next to theme toggle/logout) opens and closes the panel.
- The panel docks to the right as a **non-blocking slide-in** — no full-screen backdrop, users keep working in the main area.
- The panel survives navigation: it is mounted once in `Shell.jsx` above `<main>`, like `<TranscriptionOverlay />`.
- Users type questions in natural language (any language). Examples:
  - *"How do I connect a GitHub repository to my agent?"*
  - *"What is the difference between a Trigger and a Flow?"*
  - *"My agent is not responding — what should I check?"*
  - *"Where do I configure model providers?"*
- The assistant answers in the language of the question and gives **UI-level answers** (where to click, what page, in what order) — not code or internal architecture.

### 3.2 Context injection

Every message sent to the API includes the **current route** resolved to a human label via the `BREADCRUMBS` map that already exists in `admin-console/src/components/Shell.jsx` (line ~170). This allows the assistant to say: *"You are on the Flows page — to add a trigger, open the trigger panel on the left."*

Future extension: inject additional page-level state (selected agent, current flow ID).

### 3.3 Knowledge base (grounding corpus)

The assistant is grounded on a curated subset of `docs/`, vendored into `admin-console/api/helper-chat/` — the same pattern used by the **Flow Copilot** (`admin-console/api/flow-copilot.js` vendors `docs/process-template-format.md` with a byte-identical parity test at `admin-console/api/flow-copilot.test.js:31`).

**Included** (user-facing, current behaviour):

| Source file | Topic |
|---|---|
| `docs/walkthrough/01-team-setup.md` | Setting up the first agent team |
| `docs/walkthrough/02-working-with-agents.md` | The IBAN loop — the core collaboration cycle |
| `docs/walkthrough/03-triggers.md` | The four trigger types |
| `docs/walkthrough/04-flows.md` | Designing flows on the canvas |
| `docs/walkthrough/05-agent-templates.md` | Using the role-template catalog |
| `docs/walkthrough/06-knowledge.md` | Skills vs. learned knowledge |
| `docs/admin-console.md` | Page-by-page UI reference |
| `docs/agent-roles.md` | Agent role catalogue |
| `docs/triggers.md` | Trigger reference |
| `docs/skills-system.md` | Skills concept |
| `docs/working-environments.md` | Working Environments concept |
| `docs/glossary.md` | All terms, incl. "the four collisions" (Team/Agent Team etc.) |
| `docs/agent-chat-troubleshooting.md` | "My agent is not responding" runbook |
| `docs/collaboration-mode-faq.md` | Team-usage FAQ |
| `docs/model-providers.md` | Connecting LLM endpoints |
| `docs/credentials.md` | SSH keys + GitHub tokens |

**Excluded** (must NOT be in the corpus):
- `*-concept.md` / `*-plan.md` — proposals for unfinished or future work
- `docs/Historical/` — describes removed architecture
- `CLAUDE.md` — developer internals, not user-facing
- `docs/guides/` — developer setup (mac-setup, onboarding, etc.)

A parity test verifies that vendored copies stay byte-identical to the source files (same pattern as `flow-copilot.test.js:31`). CI fails on drift.

### 3.4 Server-side architecture

**New endpoint:** `POST /api/helper/chat`

- NDJSON streaming response (same as `POST /api/process/copilot`)
- Rate-limited with `heavyLimiter` (already used by Flow Copilot)
- Model selection via `resolveAssistTarget(req)` from `admin-console/api/assist-target.js` — honours the user's `X-Assist-Model` header / model selection context
- System prompt: grounding text assembled from vendored corpus + the full route→label map (all `BREADCRUMBS` entries from Shell, serialised as a plain list) + a short persona instruction ("You are the Agent Studio help assistant. Answer only about how to use the UI…")
- Prompt length measured against `SYSTEM_PROMPT_CHAR_LIMIT` (pattern from `flow-copilot.js`)

Request body:
```json
{
  "messages": [{"role": "user", "content": "How do I add a trigger?"}],
  "currentRoute": "/flows",
  "currentRouteLabel": "Flows"
}
```

### 3.5 Client-side architecture

**State provider:** `src/context/HelperChatContext.jsx`
- Mounted in `index.jsx` above `BrowserRouter` — same position as `TranscriptionSessionProvider`
- Holds: `isOpen`, `toggle()`, `messages[]`, `sendMessage()`, streaming state
- `sendMessage` calls `POST /api/helper/chat` via `useApi` + `assistHeaders()` from `src/context/assist-transport.js`
- Injects `currentRoute` from `useLocation()` (react-router)

**Panel component:** `src/components/HelperChatPanel.jsx`
- Mounted once in `Shell.jsx` alongside `<TranscriptionOverlay />`
- Renders only when `isOpen === true`
- Layout: fixed right panel, no backdrop, `z-index` below `SidePanel` (which is modal)
- Message rendering: reuse `Message.jsx` from `src/pages/agent-chat/` (sanitised markdown, Shiki highlighting, both themes via `data-theme`)
- Input: adapt `MessageInput.jsx` from Agent Chat

**Launcher button:** added to the Shell header right-cluster (`Shell.jsx` lines ~626–688)

---

## 4. Layer 2 — Guided Tour

### 4.1 User experience

- Entry: **"Take the Tour"** button inside the Helper Chat panel and on the `/getting-started` page.
- The tour opens in the Helper Chat panel as a **chapter list** (6 chapters).
- User selects a chapter or starts from Chapter 1.
- Within a chapter: **step carousel** — each step shows:
  - The `voiceover` text from the journey YAML (1–3 sentences, user-facing, second person)
  - A **screenshot** of the relevant UI state (from the e2e artifact manifest)
  - A **"Go there"** button that navigates to the chapter's route
- The user can exit and resume at any time; progress stored in `localStorage['helper-chat.tour-progress']`.

### 4.2 Content source: journey system

The existing e2e journey system (`e2e/journeys/*.yaml`) already contains everything needed:

| Asset | Location | Count | Use |
|---|---|---|---|
| `voiceover` fields | In each step of the journey YAML | ~36 | Tour step copy (already user-facing language) |
| Screenshot artifacts | `e2e/artifacts/<journeyId>/<slug>.png` | ~37 | Tour step imagery |
| Artifact manifest | `e2e/artifacts/<journeyId>/manifest.json` | 1 per journey | Maps step IDs to PNG paths |

Journeys are only published when the e2e run passes — screenshots are provably non-stale.

### 4.3 Chapter map

| Order | Chapter | Source journey | Route target |
|---|---|---|---|
| 1 | Setting up an Agent Team | `team-setup` | `/team-setup` |
| 2 | Working with Agents | `iban-story` | `/chats` |
| 3 | Triggers | `triggers` | `/jobs` |
| 4 | Designing Flows | `flows-draft` | `/flows` |
| 5 | Agent Templates | `agent-templates` | `/role-templates` |
| 6 | Knowledge & Skills | *(journey not yet authored — #TBD)* | `/knowledge` |

### 4.4 Tour manifest

A generated `admin-console/api/helper-chat/tour-manifest.json` drives the tour UI:

```json
{
  "generated": "2026-08-13T12:00:00Z",
  "chapters": [
    {
      "id": "team-setup",
      "order": 1,
      "title": "Setting up an Agent Team",
      "route": "/team-setup",
      "steps": [
        {
          "id": "select-process",
          "voiceover": "The first step is the process — it comes first on purpose, because it is the central decision.",
          "screenshot": "team-setup/select-process.png"
        }
      ]
    }
  ]
}
```

**Generation script:** `e2e/journey-runner/build-tour-manifest.js`
- Reads each journey YAML
- Extracts steps that have both a `voiceover` and a `screenshot` field
- Cross-references with `e2e/artifacts/<journeyId>/manifest.json` to confirm the PNG exists
- Writes `admin-console/api/helper-chat/tour-manifest.json`

**Makefile target:** `make tour-manifest` (runs after `make journeys`)

**CI:** `tour-manifest:check` — fails if committed manifest is stale (same pattern as `journeys:catalog:check`).

### 4.5 Screenshot serving

The tour manifest references PNGs by relative path. The admin-console API serves them as static assets from `admin-console/api/helper-chat/screenshots/` (symlinked or copied from `e2e/artifacts/` as part of the build). Alternative: serve directly from `e2e/artifacts/` at a dedicated route `GET /api/helper/screenshot/:journey/:slug`.

---

## 5. Integration with existing help surfaces

| Existing surface | Relationship |
|---|---|
| `/getting-started` (6 concept cards) | Stays as persistent concept overview. "Take the Tour" CTA added. |
| `InfoTip.jsx` inline tooltips | Remain as micro-hints. Helper Chat is the escalation path. |
| `FlowCopilotPanel.jsx` | Stays scoped to the Flows canvas. Helper Chat is the app-wide equivalent. |
| `agent-chat-troubleshooting.md` | Folded into the Helper Chat corpus. Troubleshooting becomes a suggested prompt chip. |

---

## 6. Phasing

### Phase 1 — Chat only (MVP)
- Vendored docs corpus + parity tests
- `POST /api/helper/chat` endpoint (streaming)
- `HelperChatContext` provider
- `HelperChatPanel` component in Shell
- Launcher button in header
- Current-route context injection

Deliverables: tickets #HC-1 through #HC-4

### Phase 2 — Screenshot tour
- Tour manifest generation script + Makefile target + CI check
- Chapter/step carousel UI in `HelperChatPanel`
- "Go there" navigation buttons
- localStorage progress
- "Take the Tour" CTA on `/getting-started`

Deliverables: tickets #HC-5 and #HC-6

### Phase 3 — Interactive tour (future, not in scope now)
- Per-step anchor selectors exported from `e2e/steps/*.js` as a `tourAnchors()` convention
- Browser-side tour runner (spotlight + tooltip overlay)
- Requires deliberate design to avoid selector fragility (no `data-testid`s in the codebase)

---

## 7. Open questions

- Should the assistant use a dedicated model config, or always follow the user's selected assist model?
- Conversation history: session-only, or persisted server-side (like Agent Chat sessions)?
- Should the assistant be able to suggest navigation ("Shall I take you to Model Providers?") that the user can confirm, or is it read-only guidance in v1?
- Who authors the tour chapter for Knowledge & Skills (journey not yet written)?
- First-run auto-open: should the tour be offered automatically to new users?
- Who is responsible for keeping vendored docs in sync when source docs change?

---

## 8. Key files to read before implementing

| File | Why |
|---|---|
| `admin-console/api/flow-copilot.js` | Exact pattern to follow for the API endpoint |
| `admin-console/api/flow-copilot.test.js` | Parity test pattern (line 31) |
| `admin-console/api/assist-target.js` | Model selection — use `resolveAssistTarget(req)` |
| `admin-console/api/assist-model-options.js` | Model options helper |
| `admin-console/src/context/assist-transport.js` | `assistHeaders()` for client requests |
| `admin-console/src/context/TranscriptionSessionContext.jsx` | App-level provider pattern to copy |
| `admin-console/src/components/Shell.jsx` | Mount point, BREADCRUMBS map, header right-cluster |
| `admin-console/src/components/SidePanel.jsx` | Existing slide-in (modal — need backdrop-less variant) |
| `admin-console/src/pages/agent-chat/ChatPanel.jsx` | Message streaming UI pattern |
| `admin-console/src/pages/agent-chat/Message.jsx` | Message rendering with sanitised markdown |
| `admin-console/src/pages/process/FlowCopilotPanel.jsx` | Inline copilot panel reference |
| `admin-console/src/pages/GettingStarted.jsx` | Where to add "Take the Tour" CTA |
| `e2e/journeys/*.yaml` | Journey YAML schema + voiceover/screenshot fields |
| `e2e/journey-runner/schema.js` | Journey schema validator |
| `docs/journey-spec-concept.md` | Full journey system design-of-record |
