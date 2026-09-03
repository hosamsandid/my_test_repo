# Actionable Helper Chat — Concept Document

> Status: concept for review (#1973)
> Author: 2026-09-03
> Continues: `docs/context-help-system-concept.md` (epic #1870) — "help explains" → "help acts"
> Builds on: `docs/helper-chat-concept.md` (#1723, #1734, #1735), `docs/assist-model-selection-concept.md` (#1211)
> Deliverable of this ticket: **this document only.** Nothing here is implemented.

---

## 1. Problem

The in-console Help assistant can describe the product and, since #1872/#1874, the
**current page**. It cannot do anything.

`POST /api/helper/chat` (`admin-console/api/helper-chat/handler.js`) is:

- **Stateless** — the browser resends the whole `messages` array every turn; the server keeps
  nothing. `trimMessages` caps it at `MAX_TURNS = 20`, `MAX_TOKENS = 4000`.
- **Corpus-grounded** — the system prompt is `corpus.buildSystemPrompt(currentRouteLabel, currentRoute)`
  over the vendored documentation set plus the page's help topic.
- **Tool-less** — `buildHelperChatPayload` sends `{ system, messages, max_tokens }`. There is no
  `tools` array, so the model has no way to name an operation, let alone perform one.
- **Streamed to the browser, single-shot upstream** — the route emits NDJSON `delta`/`done`
  lines, but the upstream provider call is one non-streaming `httpPostJson`, emitted as a
  single `delta`. (The ticket calls this "a single, stateless, non-streaming call"; the precise
  version is: *the client contract is already a stream; the LLM call underneath it is not, and
  there is no loop around it.*)

So a user who asks *"create an agent for me"* gets a paragraph explaining where the button is.

The product already contains every ingredient of an acting assistant — but no design that
connects them:

| Ingredient | Where it lives today | What it proves |
|---|---|---|
| Static navigation CTAs in help | `actions:` front-matter in `help-topics/*.md`, parsed by `help-registry.js:parseCtaObject` and `src/context/page-help-view.js:topicActions` (#1874) | Help is *already allowed* to render buttons that move the user. Its whole verb vocabulary is `to: <route>` plus one panel verb, `action: 'tour'` — and that verb's allowlist is hard-coded in **three** places with no dispatch table (`help-registry.js:68`, `page-help-view.js:273`, `HelperChatPanel.jsx:259`). |
| "LLM drafts, human materializes" | Flow Copilot, `POST /api/process/copilot` → human confirms → `POST /api/teams`, through the pure seam `api/materialize-flow.js` | The confirmation-before-effect pattern is established and accepted. The copilot writes **nothing**; the audited mutation is a separate, explicitly-clicked call. |
| Structured clickable cards inside a chat transcript | `AskQuestionCard` / `io.aee.ask-question` + `io.aee.ask-answer`, normalized by `src/pages/agent-chat/ask-question-view.js` (#1663) | A chat message can carry a machine-readable payload *alongside* prose, and render as controls. Its dispatch, though, is **sending a chat message** — not calling an API. There is no generic card-action dispatcher anywhere in the product. |
| Governed API surface | session gate + `api/scope.js` + `api/audit.js` | Every mutation is already authenticated, role-gated, team-scoped and audited. |

Two further gaps worth naming up front, because they shape the design:

- **The chat endpoint knows nothing about who is asking.** `buildSystemPrompt(currentRouteLabel, currentRoute)` takes a route and a label. The handler never reads `req.user` or the caller's scope beyond `resolveAssistTarget`. An assistant that must not offer more than the user may do (D4) needs that input first.
- **Helper Chat calls are deliberately absent from `/token-usage`.** They are one-shot console assist calls; the only accounting artifact is `req.assistMeta`. A tool-use loop multiplies the per-turn cost of a surface whose cost is currently invisible (§9.3).

The gap is not capability. It is **a design for what the assistant may do, how the human
confirms it, and how it is prevented from exceeding the human's own rights.**

---

## 2. Requester decisions (fixed)

Recorded 2026-09-03 on #1973. These are inputs to the design, not conclusions of it, and are
reproduced verbatim.

- **D1 — Target picture:** the chat is a full second interaction surface. It both *guides* the
  human through the UI and *acts itself* on the user's behalf; after an action the user
  immediately sees the result reflected in the UI (e.g. the created agent appears / the view
  navigates to it).
- **D2 — First slice:** navigation, read-only status queries, and "create agent" as a prefilled
  hand-off to the existing create dialog.
- **D3 — Confirmation model:** every mutation is confirmed individually by the user before
  execution. No batch approval, no auto-approve, no standing consent.
- **D4 — Role sensitivity:** whether an action is available/executable follows the caller's role
  (System Admin / Team Admin / Team Member) and team scope. The assistant must never offer more
  than the logged-in user may do.

---

## 3. Solution overview — three capability stages

The assistant grows along one axis: **how much of the operation it performs itself.** The
human's control point moves later at each stage, and never disappears.

| | **Stage 1 — Guide** | **Stage 2 — Prepare** | **Stage 3 — Execute** |
|---|---|---|---|
| **What the assistant may do** | Navigate the console; answer read-only status questions ("is my agent running?", "which providers are unreachable?") from `GET` endpoints | Everything in Stage 1, plus: open an existing create/edit dialog with fields prefilled from the conversation | Everything in Stages 1–2, plus: call a mutating `/api/*` endpoint directly after the user confirms one action card |
| **Who performs the mutation** | Nobody — no mutation exists | **The human**, in the existing dialog, with its existing Submit button | **The human's click on the action card**, which issues the request |
| **Risk** | Low. Worst case is a wrong route or a stale read. | Low. The dialog's own validation and warnings are still the gate; a wrong prefill is visible and editable before Submit. | Medium. The card is the only thing between a hallucinated parameter and a real write — so the card must show every resolved value, and the server must re-check rights. |
| **Infrastructure required** | Action registry (read-only + navigate tiers); the caller's identity/scope reaching the system prompt; the assistant must be able to *name* an action → structured payload in the reply; panel renders it as a control | Registry gains `dialog-prefill` targets; each target dialog must become openable-with-prefill from outside its own page (today none are); prefill must be validated against the action's parameter schema | Registry gains `api` targets and risk tiers; confirmation card; **server-side tool-use loop** in the transport; audit `via` marker; failure surfacing |
| **Transport** | Unchanged single-shot call — the reply carries a structured action payload the panel renders | Unchanged single-shot call | **Changed**: multi-turn tool-use loop (§9) |

**Stage 1 and Stage 2 are implementable on today's transport.** That is the phase cut in §12:
the model returns a structured suggestion in one reply, the panel renders it, and the user
clicks. No loop is needed, because nothing has to come *back* into the model.

Stage 3 is where the model must see a tool result and continue — and only there does the
transport change.

### 3.1 Relationship to the existing `actions:` front-matter

The topic-level `actions:` list (#1874) is the **static** ancestor of this registry: one fixed
list per page, authored by hand, with the verb vocabulary `{ to, action: 'tour' }`. It stays
exactly as it is — it is the page's "where to go next", not a conversational capability.

The action registry is the **dynamic** sibling: the set of operations the *assistant* may
propose in a conversation, with parameters resolved per turn. Where a registry action is
purely navigational the two overlap in effect, and the registry entry should reuse the same
route strings so a topic CTA and an assistant suggestion can never disagree about where
"Working Environments" is.

---

## 4. The action registry

**One curated file is the single source of truth for everything the assistant may do.** Not the
model's imagination, not a generic "call any endpoint" tool. If an action is not in the
registry, the assistant cannot propose it, cannot execute it, and — because the registry is
also what is summarized into the system prompt — does not know it exists as a capability.

Proposed home: `admin-console/api/helper-chat/action-registry.js` (pure data + resolvers,
CommonJS, sibling of `help-routes.js`), with the browser-side mirror in
`admin-console/src/context/helper-action-view.js` — the same deliberate duplication
`help-routes.js` ↔ `page-help-view.js` already carries, and for the same reason (the api
runtime cannot import from `src/`, the browser cannot `require` CommonJS), guarded by tests on
both sides.

### 4.1 Entry schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, kebab-case, unique | yes | Stable identifier. What the model names in its tool call / structured suggestion. Never renamed once shipped; retire by removal + a `RETIRED` note. |
| `label` | string | yes | Human-readable action name, imperative — "Create an agent", "Open Working Environments". Rendered as the card title and used in prose. |
| `summary` | string | yes | One line the model is given so it can decide *when* the action applies. |
| `params` | object schema | yes (may be `{}`) | Per-parameter `{ type, required, enum?, pattern?, maxLength?, resolvesTo? }`. **Validated before anything happens** — a parameter that fails validation aborts the proposal, it does not get "fixed". |
| `target` | discriminated union | yes | Where the action lands. One of: `{ kind: 'navigate', to }` · `{ kind: 'dialog', to, prefill }` · `{ kind: 'api', method, path }`. |
| `risk` | `'read'` \| `'mutating'` \| `'destructive'` | yes | Drives confirmation (§5) and stage eligibility (§7). |
| `minRole` | `'member'` \| `'team-admin'` \| `'system-admin'` | yes | Minimum role. Mirrors — never replaces — the server gate (§6). |
| `teamScoped` | boolean | yes | Whether the action operates inside one team; if true, `params` must carry the `teamId` the check applies to. |
| `confirmCopy` | string template | when `risk != 'read'` | The sentence on the confirmation card, with `{param}` placeholders — "Create agent **{displayName}** in team **{teamId}**, connected to **{url}**." |
| `resultView` | object | yes for `api` targets | How the UI reflects success (§7): `{ navigateTo?: template, refresh?: [routes], message?: template }`. |
| `stage` | `1` \| `2` \| `3` | yes | Which stage ships this action. Lets the registry be authored ahead of the transport. |

Illustrative entries (shapes, not final copy):

```js
{
  id: 'open-environments',
  label: 'Open Working Environments',
  summary: 'Show the list of Working Environments.',
  params: {},
  target: { kind: 'navigate', to: '/environments' },
  risk: 'read', minRole: 'member', teamScoped: false, stage: 1,
},
{
  id: 'list-unreachable-providers',
  label: 'Check model-provider health',
  summary: 'Report which Model Providers are currently unreachable.',
  params: {},
  target: { kind: 'api', method: 'GET', path: '/api/llm-endpoints' },
  risk: 'read', minRole: 'member', teamScoped: false, stage: 1,
  resultView: { message: '{unreachableCount} of {total} providers are unreachable.' },
},
{
  id: 'create-agent',
  label: 'Create an agent',
  summary: 'Open the New Agent form, prefilled, on the Agents page.',
  params: {
    displayName:   { type: 'string', required: true, maxLength: 64 },
    role:          { type: 'string', required: false, enum: ['agent', 'team', 'orchestrator'] },
    environmentId: { type: 'string', required: false, resolvesTo: 'environment' },
    systemPrompt:  { type: 'string', required: false, maxLength: 8000 },
  },
  // The dialog is the AgentCreateForm SidePanel on /agents — it has no route of
  // its own, so the target names the page plus the panel to open (§8.1).
  target: {
    kind: 'dialog', to: '/agents', panel: 'create',
    prefill: ['displayName', 'role', 'environmentId', 'systemPrompt'],
  },
  risk: 'mutating', minRole: 'team-admin', teamScoped: true, stage: 2,
  confirmCopy: 'Open the New Agent form for **{displayName}** in **{environmentId}**.',
}
```

### 4.2 Enforcing registry coverage and consistency by test

`help-coverage.test.js` is the pattern to copy. It does not *describe* coverage, it **derives**
it: `extractAppRoutes()` parses the route literals out of `App.jsx`, `classifyAppRoutes()`
returns `unclassified` and `stale` sets, and the test fails when either is non-empty. A gap is
only tolerated through an explicit `TOPIC_PENDING` entry, and a further test asserts every
`TOPIC_PENDING` value **names an owning ticket** (`assert.match(owner, /#\d+/)`). The guard is
itself verified against synthetic sources so it cannot silently stop detecting.

`action-registry.test.js` takes the same shape:

1. **Schema validity** — every entry has all required fields; `risk`, `minRole`, `stage` and
   `target.kind` are from their enums; `id` is unique and kebab-case.
2. **Targets resolve to something real** —
   - `navigate` / `dialog`: `target.to` must be a route `help-routes.js` knows (reuse
     `PAGE_ROUTES` ∪ `ALIASES` ∪ `REDIRECTS`), so a registry entry cannot point at a route that
     was renamed or deleted. This is the direct analogue of the App.jsx ratchet.
   - `api`: `target.path` must appear as a literal in `admin-console/api/api.js`, extracted the
     same way `extractAppRoutes` extracts from `App.jsx`. A removed endpoint fails CI.
3. **Prefill integrity** — every name in `target.prefill` exists in `params`, and the target
   page's pure view module accepts it (for `/quickstart`: every prefill key is a field
   `quickstart-view.js:quickstartBody` actually reads).
4. **Confirmation completeness** — every entry with `risk != 'read'` has `confirmCopy`, and
   every `{placeholder}` in it names a declared `param`. No card can render a value it did not
   resolve.
5. **Result view completeness** — every `api` target has `resultView`; its `navigateTo`
   placeholders resolve against the response shape declared for the action.
6. **Mirror parity** — the api-side registry and the `src/`-side mirror expose the same ids,
   risks and roles. (`help-routes.js` ↔ `page-help-view.js` is guarded the same way.)
7. **The stage ratchet** — an entry with `stage: 3` may not ship while the tool-loop transport
   is absent; a `PENDING` map, keyed by id, excuses a declared-but-unimplemented action and
   **must name the owning ticket**, exactly as `TOPIC_PENDING` does.
8. **The guard is verified** — synthetic fixtures prove each check still reports a planted
   violation, so the ratchet cannot rot into a no-op.

All of this is pure-module logic with no DOM and no server, so it lands in the existing
`admin-console-src` / api CI jobs under the #651 convention.

---

## 5. The confirmation flow (D3)

**Every mutating or destructive action is confirmed individually, immediately before it runs.**
No batching, no "always allow", no standing consent, no remembered decision.

### 5.1 The action card

The assistant's reply carries a structured payload alongside its prose — the mechanism
`AskQuestionCard` already proves (`io.aee.ask-question` next to the Markdown body, normalized
by a pure `ask-question-view.js`, rendered by a thin component). The Help panel gains the same
split: `io.aee.helper-action` next to the reply text, normalized by a pure
`helper-action-view.js`, rendered as an **action card**.

The card must state, in the user's language, **exactly what will happen**:

- the action `label`;
- the rendered `confirmCopy` with **every resolved parameter value shown** — not "with your
  settings", but the literal display name, repository, team and provider that will be sent;
- for `api` targets, the effect in one line ("This creates an agent. It cannot be undone
  automatically — you would delete it afterwards.");
- one primary **confirm** control and one **dismiss** control.

Rules:

- **Nothing executes without an explicit click on the card's confirm control.** Sending another
  chat message is not confirmation. Pressing Enter in the composer is not confirmation.
- **A dismissed card never fires.** Dismissal is terminal for that card: it is marked spent in
  the transcript and its control is removed, not merely hidden.
- **An edited-away card never fires.** If the user continues the conversation and the assistant
  proposes a revised action, the previous card is superseded and spent. At most one live card
  per conversation.
- **Read-only actions are exempt from confirmation.** Navigating to a page and answering "is my
  agent running?" are things the user just asked for; interposing a modal for them would train
  the user to click confirm without reading, which is precisely the failure mode D3 exists to
  prevent. Read actions still appear in the transcript as what they were ("I checked the
  provider list") so nothing is invisible.
- **A card carries a nonce and its conversation position.** Confirming is idempotent and
  single-use; see §11 on multiple tabs.

### 5.2 Why the card, and not a free-text confirmation

Asking the user to type "yes" would let the model interpret the answer. The card removes the
model from the confirmation path entirely: the payload is fixed when the card renders, the
click executes *that* payload, and the model does not get to re-render its meaning in between.
This is also the mitigation for hallucinated parameters (§10).

---

## 6. Role and scope sensitivity (D4)

**There is no second permission system.** `api/scope.js` stays the only authority. Role
sensitivity is applied at three places, and only the third one is a security boundary:

| # | Where | What it does | Nature |
|---|---|---|---|
| a | **Proposal** — the system prompt lists only the registry actions whose `minRole` the caller meets, for the teams in the caller's scope | The assistant does not offer what the user may not do | *Product quality.* Prevents pointless offers. Not a boundary — a model can still name an unlisted id. |
| b | **Card render** — the panel filters again from the session's own authz descriptor | An action the caller may not perform never gets a clickable card | *Defence in depth.* Client-side, therefore not a boundary either. |
| c | **Execution** — the existing route's own gate runs unchanged | 403 regardless of what the model or the panel believed | **The boundary.** |

The inputs are already there. `describeAuthz()` returns `{ admin, envAdmin, systemAdmin,
userId, teams: [{ teamId, role }] }` and the browser already holds it via `useAuth()` — the
console uses it today to hide System-Admin-only pages. Filtering the action list is the same
computation, so it belongs in a pure module (`helper-action-view.js:availableActions(registry,
authz)`), unit-tested, with the JSX a thin renderer.

The server-side helpers stay untouched and unwrapped: `canManageTeam`, `canManageAgent`,
`canManageEnvironment`, `visibleAgent`, `canViewUsageStatistics`. A Stage-3 execution is an
ordinary request to an ordinary route; it hits exactly the same `computeScope` result as a
click in the UI would.

### 6.1 Honest refusal

When the user asks for something their role does not allow, the assistant must **say so and say
why**, not fail opaquely and not pretend the feature does not exist:

> Creating an agent in *platform-team* needs Team Admin there — you're a Team Member. A Team
> Admin of that team can do it, or a System Admin can grant you the role on the Access page.

This requires the registry's `minRole` to be legible to the model even for actions it may not
propose. The system prompt therefore carries two lists: **available** actions (proposable) and
**known but not permitted** actions with their required role (explicable, never proposable).
The registry test asserts the second list is derived from the first's complement, so an action
can never fall out of both.

---

## 7. Immediate result feedback (D1)

An action the user cannot see the result of has not been performed, as far as they are
concerned. Every executed action ends in a visible change.

**On success**, driven by the entry's `resultView`:

- **`navigateTo`** — the panel routes to the created/changed resource. The console already does
  exactly this after its own creates: `QuickStart.jsx` navigates to `/chats/<agent.id>` on
  success, so the assistant reuses the destination the page itself would have picked.
- **`refresh`** — for actions whose result is a row in a list the user is already looking at,
  the affected route's data is refetched so the change appears without a manual reload. Again
  this mirrors the pages: `Agents.jsx:handleCreateAgent` ends in `closePanel(); refetch()`.
- **`message`** — the transcript gains a short confirmation naming the actual result
  ("Created **research-bot**. Opening its chat."), rendered from the *response*, never from the
  request. If the server named the resource something else than requested, the message says the
  server's name.

**On failure** — validation error, 403, 409, provider down, network error — the failure is
reported into the conversation **honestly and specifically**:

- the HTTP status and the server's own `error`/`code` string are surfaced, not paraphrased away
  (the console already carries `data.error` / `data.code` through this way in `QuickStart.jsx`);
- the assistant states what did **not** happen ("The agent was not created.");
- the card is marked failed and spent — retry means a fresh proposal, so the user re-reads the
  parameters;
- **the assistant never reports success it did not observe.** This is a hard rule for the system
  prompt and a test on the result-rendering module: success copy is only reachable from a 2xx
  response object.

---

## 8. Stage 2 in detail — the `create-agent` pilot (D2)

D2 names the first mutating slice: *"create agent" as a prefilled hand-off to the existing
create dialog.* This section fixes what that means concretely, because "the existing create
dialog" turns out to be two different things.

### 8.1 Which dialog

| Surface | What it is | Verdict |
|---|---|---|
| **`AgentCreateForm`** — the **New Agent** side panel on `/agents` (`Agents.jsx:556`, rendered in a `SidePanel` at `:1851`) | The console's actual create-an-agent dialog. Fields: `id` (auto-derived from Display Name, **immutable after creation**), `displayName`, `role` (`agent` / `team` / `orchestrator`), `environmentId`, `systemPrompt`, `briefingsPath` (orchestrator only), `skills[]`. Submits `POST /api/agents`. | **The pilot target.** |
| **`/quickstart`** — the "just give me one assistant" fast lane | Creates *environment + agent + chat* in one move from a repository URL; reuses an existing environment and even an existing agent on that repo. A different operation with a different result. | Reachable as a **separate** registry action (`quickstart-agent`), not as this one. |

Conflating them would be a quiet lie: a user who says "create an agent" and lands on
`/quickstart` may get an *existing* agent back with a "reused" notice — a legitimate outcome of
that lane, and a confusing one to arrive at by proxy.

**The dialog has no route.** It is a `SidePanel` opened by the page's **New Agent** button, so
`navigate('/agents')` alone cannot open it prefilled. Two mechanisms already exist in the
codebase for exactly this; either is acceptable and the implementing ticket should pick one:

- **A query-param page intent**, the precedent `create-launcher-view.js` already uses
  (`/flows?new=describe`, `/flows?new=blank`) — `/agents?new=agent` with prefill values as
  further params.
- **A panel-open request object** carried through the router state, the pattern Agent Chat uses
  for `railTabRequest` / `resumeRequest` / the workspace-browser `@`-reference hand-off.

Whichever is chosen, `target.panel` in the registry entry names the panel; the mechanism is an
implementation detail behind one helper, not a per-action decision.

### 8.2 Which fields arrive prefilled

`displayName` · `role` · `environmentId` · `systemPrompt`. Deliberately excluded:

- **`id`** — auto-derived from `displayName` by `useAutoDerivedId` and immutable after creation.
  Letting the assistant name a permanent, URL- and filesystem-visible identifier is exactly the
  kind of irreversible detail a user should type or accept themselves.
- **`skills[]`** — a grant, not a form value. Proposing skills by name invites hallucinated
  skill ids; the picker shows the real pool.
- **`briefingsPath`** — orchestrator-only and auto-filled by the form when the environment has
  exactly one repo. The form does this better than the model can.

`environmentId` is a `resolvesTo: 'environment'` reference (§10.1 #2): it is resolved against the
environments the caller can actually see, in their scope, or dropped.

### 8.3 The dialog stays the final gate

This is the rule that makes Stage 2 low-risk, and it is not negotiable:

- **`describeAgentSubmitState(form)`** (`src/pages/agent-create-submit-state.js`) remains the
  sole submit authority. It returns `{ canSubmit, reasons }`, and the same call drives both the
  disabled button and the *"Create Agent is disabled until you: …"* checklist — so they cannot
  disagree. A prefill that does not satisfy it lands the user in a form that explains itself.
- **The page's warnings still fire**: the amber "no Working Environments — create one first"
  notice, and the accented *"Consider using the Agent Team Wizard instead"* box for the `team`
  role. The assistant may not suppress or pre-answer either.
- **The server still gates**: `POST /api/agents` re-checks `canManageAgent(getScope(req), { teamId })`
  and returns 403 regardless of what was prefilled.

The assistant's contribution is saving typing, not skipping review. A prefilled form the user
submits unchanged is a decision they made; the moment that stops being true, the feature has
drifted out of D3.

---

## 9. Transport evolution

### 9.1 Today

`buildHelperChatPayload` → `{ system, messages, max_tokens: 4000 }` → one `httpPostJson` →
`extractMessageText` → NDJSON `{type:'assist', endpointId, model}` → one `delta` → `done`.
Provider resolution happens *before* the stream opens (`resolveAssistTarget(req)`, driven by the
caller's `X-Assist-Model: <endpointId>:<modelId>` header), so a selection error is a clean
`400 assist-model-not-selected` / `403 assist-endpoint-not-permitted` rather than a half-written
stream. The `assist` provenance event is already the first line on the wire — the loop below
extends that contract rather than inventing one.

### 9.2 Stages 1–2: no transport change

The model returns prose plus one structured action payload — a single reply, exactly the
current shape. The panel renders the card; the *user's click* performs the navigation or opens
the prefilled dialog. Nothing needs to return to the model, so no loop exists. **This is what
makes Phase 1 deliverable without touching the transport.**

The only server-side change is the system prompt: the corpus builder additionally receives the
caller's available actions (§6a) and the output contract for the structured payload.

### 9.3 Stage 3: a server-side tool-use loop

Direct execution needs the model to see a result and continue ("I created it; here it is").
That is a loop:

```
request → resolveAssistTarget → [ model call → tool_use? → execute → tool_result → model call ]* → final text
```

Consequences, stated plainly because they are the cost of Stage 3:

- **Cost.** Each iteration resends the system prompt and the full transcript. A two-tool-call
  turn is roughly three provider calls instead of one, and the system prompt dominates the input
  tokens — it is the whole vendored corpus plus every help topic, guarded at
  `SYSTEM_PROMPT_CHAR_LIMIT = 300_000` characters. Multiplying *that* by the round-trip count is
  the real cost of Stage 3, and it is currently **invisible**: Helper Chat produces no usage
  record and never appears on `/token-usage`. Two mitigations belong in C1 — prompt caching where
  the selected provider supports it, and route-scoped corpus folding (already flagged in
  `corpus.js` as the structural fix if the prompt grows again). Measure before shipping broadly.
- **Latency.** Sequential round-trips; the NDJSON contract already lets the panel show progress
  between them, so the user sees "checking your teams…" rather than a frozen spinner.
- **Bounded iterations.** A hard cap on tool-call rounds per turn, with an honest "I could not
  complete that in one turn" rather than an unbounded loop.
- **Billing is unchanged in principle.** Every call in the loop goes through `resolveAssistTarget(req)`
  and therefore bills against **the caller's own Assist-Model selection** (#1211), exactly like
  the Flow Copilot and every other assist call. `resolveAssistTarget` stamps `req.assistMeta`
  with `{ endpointId, model }`, which `audit.js` already records as the event's `assist` field —
  so "which key paid for this assistant action" stays answerable. The loop makes a turn cost
  *more*, not cost *differently*.

### 9.4 Where a Stage-3 execution physically runs — recommendation

Two options, both real:

| | **Browser-side** (recommended) | **Server-side, inside the loop** |
|---|---|---|
| Session | The browser's existing session cookie; `fetch('/api/…')` is byte-identical to what the page itself would send | The session must be threaded into the tool executor; the helper-chat route would call `/api/*` on the user's behalf |
| Audit actor | Naturally the human — `audit.js` reads `req.user.username` off a normal request | Same *if* threaded correctly; a bug here mis-attributes a mutation, which is the worst possible audit failure |
| Maintenance mode | **Inherited for free** (see §11) — the client-side lock is what actually blocks mutations today | Bypassed unless separately re-implemented |
| Rate limiting, CSRF, gates | All existing per-route middleware applies unchanged | Same, but only because the request re-enters the same stack; an in-process shortcut would skip it |
| Confirmation coupling | The click *is* the request — there is no window between confirming and executing | The confirmation must travel back to the server and be matched to a pending tool call |
| Cost | The model does not see the result until the next turn; the panel has to feed it back | The model sees the result inline |

**Recommendation: browser-side execution after confirmation.** The determining argument is not
convenience, it is that the browser is where the user's authority actually lives. A server-side
executor has to *reconstruct* the user's identity, scope and client-side locks; the browser
already **is** them. The panel feeds a compact result summary back into the next turn so the
model can talk about what happened — that is a normal message, not a privileged channel.

The tool-use loop (§9.3) is still needed for *multi-step read* turns ("check the providers,
then tell me which agents use the broken one"), where the model genuinely needs an intermediate
result. Reads are safe to run server-side inside the loop; **mutations return to the browser as
a card.** That split — *reads in the loop, writes through the card* — is the concrete rule.

---

## 10. Hallucinated parameters, and destructive actions

### 10.1 Hallucination

The model will occasionally invent a plausible team id, repository URL, or agent name. Three
layers, in order:

1. **Schema validation before the card renders.** Every parameter is checked against the
   registry's `params` — type, `enum`, `pattern`, `maxLength`. A failure is not repaired; the
   proposal is dropped and the assistant asks for the missing value.
2. **Existence resolution for reference parameters.** A `resolvesTo: 'team' | 'environment' |
   'llmEndpoint' | 'agent'` parameter is resolved against a live list the caller may see, in the
   caller's scope. An unresolvable reference is a dropped proposal, never a guess.
3. **The card shows every resolved value.** The last line of defence is the human reading the
   literal values before clicking. This is exactly why §5.1 forbids summarised card copy.

### 10.2 Destructive actions — recommendation

Deleting an agent, respawning a container, offboarding a user, deleting a credential:
irreversible or disruptive, and each already has a warning dialog with its own consequence copy
(and, for agent deletion, a knowledge-retention note).

**Recommendation: destructive actions stay Stage-2-only in the first cuts.** The assistant may
*navigate to* and *prefill* the existing warning dialog; it may not execute the deletion itself.
Reasons:

- Those dialogs carry consequence text that took real work to get right; a generic action card
  would either duplicate it (and drift) or lose it (and mislead).
- Several require typed confirmation of a resource name — a deliberate friction that exists
  precisely to stop reflexive clicking. Reproducing it on a card reproduces the friction without
  the context.
- The risk asymmetry is stark: a wrong create is a stray agent, a wrong delete is lost work.

This is a recommendation, not a permanent constraint. The registry already encodes
`risk: 'destructive'`, so promoting an action to Stage 3 later is a data change plus its own
ticket — and the stage ratchet test (§4.2 #7) makes the promotion explicit rather than
accidental.

---

## 11. Edge cases

| Situation | Resolution |
|---|---|
| **Role/scope changed, or session expired, between proposal and confirmation** | The **server-side check at execution time is authoritative**, full stop. The proposal-time filter (§6a/b) is a UX filter and is explicitly *not* trusted. An expired session yields the normal 401 path (`UNAUTHORIZED_EVENT` already drops the app back to login); a changed role yields a 403 that surfaces per §7 as an honest failure. |
| **The action fails server-side** (validation, 403, 409, provider down) | §7: status + server `error`/`code` surfaced verbatim, an explicit statement that the operation did *not* happen, card marked failed and spent. Never a fabricated success. |
| **Long-running / streaming operations** (team creation streams NDJSON progress) | **Stage-2-only.** A confirmation card is a single request/response affordance; an NDJSON progress stream needs a live progress surface, cancellation, and partial-failure reporting, all of which the launch UI already has. The assistant navigates to the launch step with the draft prepared and hands over. Revisit only after Stage 3 is proven on single-shot mutations. |
| **Stale entity reference** (renamed or deleted since it was mentioned) | Reference parameters are re-resolved at card-render time (§10.1 #2) and again implicitly by the server at execution. A vanished entity produces "**research-bot** no longer exists — it may have been renamed or deleted", not a 404 dumped into the transcript. |
| **Maintenance mode** | Maintenance mode is a **cooperative flag, not a middleware**: `api/maintenance-mode.js` says in its own header that it "deliberately does NOT enforce anything" — it owns the persisted state (`/workspace/maintenance/state.json`: `{ active, activatedAt, gracePeriodSec, graceEndsAt }`) and **no `/api` route is blocked by it**. Three independent readers honour it: the console (`MaintenanceModeContext` polls every 5 s → composer `disabled`, `maintenance-banner.js`), the orchestrator (its scheduled sweeps bail early), and each agent container (`_maintenance_active()`). **The Help panel must become the fourth reader**: while maintenance is active, mutating and destructive cards render disabled with the maintenance reason; read and navigate actions stay available. Browser-side execution (§9.4) makes this a one-line addition to a component that already sits next to `MaintenanceModeContext` — a server-side executor would have to re-derive a lock that exists nowhere on the server, which is the strongest single argument in §9.4. If a future ticket adds real server-side enforcement under epic #508, assistant-initiated mutations inherit it automatically, because they are ordinary requests. |
| **Multiple tabs** | Each card carries a **single-use nonce** bound to the conversation and its position in it. Confirming spends the nonce; a card whose conversation has advanced elsewhere renders as superseded and its control is inert. The nonce is checked where the request is issued and — for anything with a natural idempotency key — re-checked server-side, so a duplicate confirm cannot double-create. |

---

## 12. Phasing

### Phase 1 — D2's first slice: navigation + read-only queries + prefilled create-agent

**Deliverable in full without the tool-loop transport change** (§9.2) — that is the point of the
cut. Five tickets, in dependency order; A1–A3 are shippable on their own (see the note below the
phase), B1–B2 complete the slice.

- **A1 — Action registry foundation.** `action-registry.js` + `src/context/helper-action-view.js`
  mirror; the schema of §4.1; the ratchet test of §4.2 (checks 1–3, 6, 8); seed the navigation
  and read-only actions. Pure modules, unit-tested, no UI.
- **A2 — Structured action payload + panel rendering.** `io.aee.helper-action` alongside the
  reply; `helper-action-view.js:normalizeHelperAction` (defensive, mirrors
  `ask-question-view.js`); the Help panel renders navigate/read cards; system prompt carries the
  caller's available actions (§6a) and the output contract; role filtering (§6b) from `useAuth()`.
- **A3 — Read-only status queries.** The read-tier `api` targets and their `resultView` message
  rendering; honest failure surfacing (§7).
- **B1 — Prefill hand-off mechanism.** `dialog` targets; prefill validation against `params`; one
  helper that opens a **routeless** panel with prefill (§8.1) — no console dialog accepts external
  prefill today, so this is the ticket that makes "open X, filled in" possible at all.
- **B2 — The `create-agent` pilot (D2), end to end.** Registry entry, conversation → parameters,
  confirmation card (opening a prefilled form is itself confirmed, since it is the first step of
  a mutating intent), hand-off into `AgentCreateForm` on `/agents` (§8), and the explicit rule
  that **the dialog's own validation and warnings remain the final gate** — its
  `describeAgentSubmitState` blocked-submit checklist, the no-environments notice and the
  use-the-wizard-instead box (§8.3).

> **A1–A3 are a shippable increment on their own.** They already answer "take me to X" and
> "is Y running?" — the two most common asks — and carry no mutation at all. If the slice has to
> be released in two drops, that is the seam; the phase is not complete until B2 lands.

### Phase 2 — the rest of Stage 2 (still no transport change)

- **B3 — Destructive actions as Stage-2 hand-offs.** Navigate-and-open the existing warning
  dialogs; registry entries carry `risk: 'destructive'`, `stage: 2` and are barred from Stage-3
  promotion without their own ticket (§10.2).
- **B4 — Widen the Stage-2 registry.** One ticket per area (agents · environments · credentials ·
  models · flows), each adding entries plus their tests — the per-area cadence epic #1870 used
  for help topics.

### Phase 3 — Stage 3: the assistant can execute

- **C1 — Tool-use loop transport.** The loop of §9.3, bounded iterations, `resolveAssistTarget`
  per call, progress events on the existing NDJSON contract, cost/latency measured and recorded.
- **C2 — Confirm-and-execute cards.** Browser-side execution (§9.4), nonce lifecycle,
  `resultView` navigation/refresh, failure surfacing, maintenance-mode gating on the card.
- **C3 — Audit provenance.** The `via` marker (§13) plus its test.
- **C4 — Promote registry entries to Stage 3.** Per area, and per entry: promoting an action from
  `stage: 2` to `stage: 3` is a data change plus a deliberate decision, which the stage ratchet
  (§4.2 #7) forces into the open rather than letting it happen by omission.

**Total: 5 + 2 + 4 = 11 child tickets under one epic.** The count matters less than the seam:
everything before C1 ships on today's transport, so the expensive, uncertain part of this concept
is deferred until the cheap part has proven the interaction model in real use.

---

## 13. Audit provenance

An assistant-initiated mutation must be **distinguishable** in the audit trail while the actor
stays the human who confirmed it.

`audit.js:auditMutations` is mounted on `/api` *before* the auth gate, records on the response's
`finish` event for mutating methods, and builds `{ ts, actor, action, method, resource, teamId,
status, outcome, ip }` — plus `assist: { endpointId, model }` when `req.assistMeta` is set. There
is no origin/`via` field today.

Proposal: the browser stamps a request header (`X-AEE-Via: helper-chat`) on assistant-executed
requests, and `buildEvent` adds `...(via ? { via } : {})` from a small allowlist of known values.

- The **actor remains the human** — `req.user.username`, unchanged. The assistant is not an
  identity, it is a route the human took.
- The field is **additive and optional**, so every existing consumer keeps working — the same
  discipline `assist` was added under.
- It is an **honesty marker, not a permission**: a forged header changes nothing about what the
  request may do, because authorization never consults it. Its only job is to let an operator
  reading the trail answer "was this clicked in the UI or confirmed in the chat?".

---

## 14. Open questions — positions

The ticket raises four. This concept takes a position on each; the reviewer decides.

1. **Where Stage-3 execution runs.** → **Browser-side after confirmation**, with reads allowed
   server-side inside the tool loop. Rationale in §9.4; the maintenance-mode argument (§11) is
   the decisive one.
2. **Multi-step chains, and whether each step is confirmed.** → **Each mutating step is
   confirmed individually** (D3 admits no other reading). The assistant may *describe* a
   multi-step plan in prose — that is helpful — but a described plan grants nothing: it produces
   one card at a time, and the next card is only proposed after the previous action's real
   result is known. This also fails safe: if step 2 becomes impossible because of step 1's
   actual outcome, no pre-approved step 2 is sitting there waiting to fire. Chains of *read*
   actions need no confirmation and may run inside one turn.
3. **Panel layout.** → **Keep the current slide-in for Phases 1–2.** The cards are small and the
   surrounding page is exactly the context the user needs to see the result appear in (D1). A
   dockable/wider layout should be driven by observed friction in Phase 3, not designed ahead of
   it. Deferred, not rejected.
4. **Naming.** → **Keep one surface, named Help**, and let the tab label carry the shift. The
   panel's faces are already `This page · Ask · Tour`; the acting assistant *is* Ask, grown up.
   A second name would force the user to guess which assistant to open for a given question —
   the exact fragmentation epic #1870 spent 18 tickets removing. Honesty about partial coverage
   is better served by §6.1's explicit refusals than by a name. **Reviewer input welcome — this
   is the softest of the four.**

---

## 15. Key files to read before implementing

| File | Why |
|---|---|
| `admin-console/api/helper-chat/handler.js` | The endpoint to grow: `validateHelperChatRequest`, `buildHelperChatPayload`, the NDJSON `delta`/`done` plumbing, `MAX_TURNS`/`MAX_TOKENS` |
| `admin-console/api/helper-chat/help-routes.js` | The topology + resolver pattern the action registry mirrors (`ALIASES`, `REDIRECTS`, `DYNAMIC`, `PAGE_ROUTES`, `TOPIC_PENDING`) |
| `admin-console/api/helper-chat/help-coverage.test.js` | **The ratchet to copy** — derive coverage from source, excuse gaps only with a named ticket, verify the guard itself |
| `admin-console/api/helper-chat/help-registry.js` | `parseCtaObject` — today's entire `actions:` vocabulary (`to`, `action: 'tour'`, `primary`) |
| `admin-console/src/context/page-help-view.js` | `topicActions`, `TOPIC_CTA_ACTIONS` — the browser-side mirror pattern and its defensive normalisation |
| `admin-console/src/pages/agent-chat/ask-question-view.js` | The precedent for a structured payload beside prose (`io.aee.ask-question` / `io.aee.ask-answer`) and its pure normaliser |
| `admin-console/api/scope.js` | `computeScope` (`{ all, teamIds, roles, userId }`), `describeAuthz`, `canManageTeam` / `canManageAgent` / `canManageEnvironment` — the authority Stage 3 reuses unchanged |
| `admin-console/src/auth/AuthContext.jsx` | `useAuth()` → `{ admin, envAdmin, systemAdmin, userId, teams: [{teamId, role}] }`, already used to gate admin-only pages |
| `admin-console/api/audit.js` | `buildEvent` / `auditMutations` — where the `via` marker lands, and how `assist` was added additively |
| `admin-console/api/api.js` | `resolveAssistTarget` (≈`:11012`) and its `req.assistMeta` stamp; `POST /api/process/copilot`; `POST /api/teams` and `/api/teams/stream` |
| `admin-console/api/maintenance-mode.js` | The state file, and the explicit note that this module enforces nothing — the basis of §11 |
| `admin-console/src/context/MaintenanceModeContext.jsx` + `src/pages/agent-chat/composer-action.js` | How the cooperative maintenance lock actually reaches a control (`disabled`) — the pattern the action card copies |
| `admin-console/src/pages/Agents.jsx` (`AgentCreateForm` `:556`, `SidePanel` `:1851`, `handleCreateAgent` `:1457`) | **The D2 pilot target** (§8): the fields, the routeless side panel, and the `closePanel(); refetch()` that `resultView.refresh` reproduces |
| `admin-console/src/pages/agent-create-submit-state.js` | `describeAgentSubmitState` — the validation that stays the final gate (§8.3) |
| `admin-console/src/pages/QuickStart.jsx` + `src/pages/quickstart-view.js` | The *other* create lane (a separate registry action, not the pilot): environment+agent+chat in one, reuse semantics, and the post-create `navigate('/chats/…')` |
| `admin-console/src/pages/create-launcher-view.js` | Which "create" lane is which, and the existing query-param page-intent precedent (`/flows?new=describe`) |
| `admin-console/src/components/HelperChatPanel.jsx`, `src/context/HelperChatContext.jsx` | The panel and its context — where the card renders and where execution is dispatched |
