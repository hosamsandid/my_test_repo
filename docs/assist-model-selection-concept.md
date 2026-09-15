# Assist Model Selection — global, team-scoped model-provider selector for cross-cutting AI helpers

Status: in progress — Phase 1 shipped (#1210 `assistSelectableEndpoint` + `GET /api/assist/model-options`; #1211 `resolveAssistTarget` enforcement + provenance; #1212 header selector UI + `ModelSelectionProvider` + `X-Assist-Model` transport); Phase 2 §4.6 shipped — team-derived `assistLlmEndpointId` + `_synthesizeSkillMd` binding for curator auto-promotion/distillation (#1213) and domain-bootstrap pass-through with user selection forwarded through the console proxy, token resolved locally in the orchestrator (#1214). Phase 3 (cross-tab sync, per-feature override, assist-spend rollup) not yet ticketed.

## 1. Problem

Model Providers carry team visibility (`scope: 'team' | 'system'`, `teamId`, `assignedTeamIds` — #800), and the **agent runtime** honors it end-to-end: an agent can only be bound to a provider from `usableEndpointsForTeam(teamId)`, and its container is spawned with exactly that provider's credentials.

The **cross-cutting AI helpers** ("assist calls") ignore all of this. Every LLM call the stack makes *outside* the per-agent Claude CLI runtime — the Flow Copilot, "Generate agent prompt", wiring/outcome suggestions, the Knowledge drafting features, skill merge previews — goes through `resolveGenerationTarget()` (`admin-console/api/api.js:8671`), which silently picks:

1. the caller-named endpoint (`preferredEndpointId`) — **no client ever sends one today**,
2. else the **first registered** non-oauth provider (`endpoints[0]`),
3. with a forced sonnet-class model (`kind: 'sonnet'`, else the provider default),
4. else the `.env` `ANTHROPIC_*` fallback.

Consequences:

- **Billing bleeds across teams.** Two independent teams with separate API keys and separate invoicing both burn the key of whichever provider happens to be registered first. There is no way to make assist costs land on the right key.
- **Visibility rules are bypassed.** A user whose teams were never assigned provider X still causes spend on X's key via any assist feature.
- **No model choice.** The sonnet preference is hardcoded; the user cannot pick a cheaper/stronger model for assist work.

Three orchestrator-side autonomous synthesis features (`_synthesizeSkillMd`, `orchestrator/orchestrator.js:4794` — curator auto-promotion, skill distillation, knowledge-domain bootstrap) don't even have a selection seam: they read raw `process.env.ANTHROPIC_*`.

## 2. Goals

- One **global assist model selector** (originally in the console header; **moved to Settings → Model** in #1805, reached via the account-menu **Settings** item): current Model Provider + model, always switchable.
- The selectable list is **restricted to the providers the logged-in user may use** (team-visibility rules), enforced **server-side** on every assist call — the client selection is a convenience, never the authority.
- Every assist feature uses the selected provider + model, so **all assist API costs land on the selected provider's key**.
- Works for future assist features by default (central plumbing, not per-feature wiring).

### Non-goals

- **Agent chats / agent runtime stay untouched.** Per-agent provider/model selection (`llmEndpointOverride` / `modelOverride`, `PATCH /api/agents/:id/{provider,model}`) already works and is out of scope.
- No change to provider CRUD, credential storage, or the `visibleCredential` management rules on the Model Providers page.
- No new billing/metering subsystem — this concept only makes *attribution* correct; usage statistics build on it later (see §9).

## 3. Current state (inventory)

### Family A — console one-shot generation (all via `resolveGenerationTarget` → `POST /v1/messages`)

| # | Feature | UI entry | Route | Fallback on LLM failure |
|---|---------|----------|-------|-------------------------|
| 1 | Flow Copilot | `FlowCopilotPanel.jsx` (the wizard `StepProcess.jsx` inline copilot branch was removed in #1703) | `POST /api/process/copilot` (`api.js:6047`) | none (hard 400) |
| 2 | Generate agent prompt | Add-role dialog (`ProcessCanvas.jsx`) | `POST /api/agent-prompt/generate` (`api.js:8734`) | none (400) |
| 3 | Port/wiring suggestion | wizard composer | `POST /api/agent-ports/suggest` (`api.js:8767`) | heuristic |
| 4 | Outcome suggestion | Routing tab | `POST /api/agent-outcomes/suggest` (`api.js:8800`) | heuristic |
| 5 | Promotion SKILL.md draft | KnowledgeFlow | `POST /api/knowledge/promotion-suggestions/:id/draft` (`api.js:4706`) | heuristic |
| 6 | Ad-hoc knowledge draft | KnowledgeFlow | `POST /api/knowledge/draft` (`api.js:4760`) | heuristic |
| 7 | Skill extend-draft | KnowledgeFlow | `POST /api/knowledge/extend-draft` (`api.js:4863`) | heuristic |
| 8 | Knowledge summaries backfill | KnowledgeFlow | `POST /api/knowledge/summaries/backfill` (`api.js:4799`) | display-only heuristic |
| 9 | Skills merge-draft | SkillsRegistry / KnowledgeFlow | `POST /api/skills/merge-draft` (`api.js:7925`) | heuristic |

All nine already pass `req.body.llmEndpointId` into `resolveGenerationTarget` — the server seam exists; **no client sends it**, and there is no model-within-provider override (sonnet-class is force-picked).

### Family B — orchestrator autonomous synthesis (raw `.env`, no seam)

| # | Feature | Trigger | Code |
|---|---------|---------|------|
| 10 | Auto-promotion skill synthesis | curator cron / autonomy 3 | `orchestrator.js:4832` |
| 11 | Skill distillation pass | N amendments threshold | `orchestrator.js:5038` |
| 12 | Knowledge-domain bootstrap | user-triggered (proxied) | `orchestrator.js:10900` |

Related but not a completion: provider test-connection / discover-models (`GET /v1/models`, falling back to a free `POST /v1/messages/count_tokens` when that route doesn't exist, #2306) — bills a single metadata request to the probed provider itself; correct as-is, out of scope.

## 4. Concept overview

A per-user **assist model selection** `{ endpointId, modelId }`, chosen in a new header control, transported on every console API call, and **validated + resolved server-side** on every assist route.

```
Header selector (Shell.jsx)
  └─ ModelSelectionContext  ── persists per user (localStorage assistModel.<username>)
       └─ apiCall()/stream fetches add header  X-Assist-Model: <endpointId>:<modelId>
            └─ assist routes call resolveAssistTarget(req)
                 ├─ getScope(req)  → user's team memberships
                 ├─ validate endpoint visibility (403 if not usable by this user)
                 ├─ validate modelId ∈ endpoint.models[] (else provider default)
                 └─ read token from _keys/ → {baseUrl, token, model, endpointId}
```

### 4.1 Which providers a user may select (visibility semantics)

**Selection-visibility is membership-based (any role), not management-visibility.** Rationale: `visibleCredential` (`scope.js:132`) is the *management* rule (Team-Admin-oriented — who may see/edit the provider record). But a plain **Team Member** must be able to run the Flow Copilot billed against their team's provider — exactly as their agents already do: `usableEndpointsForTeam(teamId)` (`api.js:3219`) is role-independent. The selector reuses that semantics:

> A user may select provider **P** iff `scope.all` (env admin / System Admin), **or** P is usable by at least one team the user is a member of (any role): P is team-scoped with `P.teamId ∈ scope.teamIds`, or system-scoped with `assignedTeamIds ∩ scope.teamIds ≠ ∅`.

Additional filters:

- **`authType: 'oauth-token'` providers are excluded** — same rule `resolveGenerationTarget` applies today: subscription CLI-seat tokens must not be spent on server-side `/v1/messages` calls (Consumer-Terms single-user constraint, and no `baseUrl`).
- The synthetic `.env` fallback (`__env__`) is **never selectable**. It applies only in the bootstrap case (§4.4).

New pure helper in `admin-console/api/scope.js` (unit-testable next to `visibleCredential`):

```js
// scope.js — selection (usage) visibility, distinct from management visibility
function assistSelectableEndpoint(scope, ep) {
  if (!scope || !ep) return false;
  if (ep.authType === 'oauth-token') return false;
  if (scope.all) return true;
  const c = normalizeCredential(ep);
  if (c.scope === 'team') return scope.teamIds.has(c.teamId);
  return c.assignedTeamIds.some(t => scope.teamIds.has(t));
}
```

### 4.2 Options endpoint

`GET /api/assist/model-options` → for the calling session:

```json
{
  "providers": [
    { "id": "ep-team-a", "name": "Team A production key", "scope": "team",
      "models": [ { "id": "claude-sonnet-4-6", "displayName": "Sonnet 4.6", "kind": "sonnet" } ],
      "defaultModelId": "claude-sonnet-4-6" }
  ],
  "envFallbackActive": false
}
```

- Filtered by `assistSelectableEndpoint`; **masked** — never `authTokenId`/`baseUrl` internals beyond what the selector needs (id, name, scope, models catalog, default).
- `envFallbackActive: true` only when **zero providers are registered platform-wide** and `ANTHROPIC_BASE_URL` is set — the selector then renders a read-only "Built-in (.env)" chip instead of a picker.
- Distinct from `GET /api/llm-endpoints` (management list, `visibleCredential`-filtered) — the two rules intentionally differ (§4.1).

### 4.3 Header UI

> **Update (#1805):** this control was later moved out of the Shell header into **Settings → Model** (`SettingsModal.jsx` Model section, opened from the account-menu **Settings** item). The placement described below is the original #1212 design; the popover markup, states, and `ModelSelectionProvider` wiring are unchanged by the move.

- New control in the header right-cluster (`admin-console/src/components/Shell.jsx:395-456`), left of the theme toggle, styled like the existing bordered icon-buttons: a compact button showing `<Provider name> · <model displayName>` (truncated), with a sparkle/cpu icon.
- Click opens a popover: providers as groups (with a `team`/`system` badge), models as radio items, provider-default model marked. One click selects provider+model; selecting a provider without expanding models takes its default model.
- States:
  - **No selection yet, ≥ 2 selectable providers** → attention styling ("Select assist model") — see §4.5 for why we do not silently default.
  - **Exactly one selectable provider** → auto-selected (its `defaultModelId`), no attention state.
  - **Zero selectable providers, env fallback active** → read-only "Built-in (.env)" chip (bootstrap installs behave exactly as today).
  - **Zero selectable providers, no fallback** → chip "No assist model available"; assist buttons stay visible but calls fail with the §4.5 error.
- State lives in a new `ModelSelectionProvider` (React context, sibling of `AuthProvider` in `App.jsx`), which loads `/api/assist/model-options` after auth, validates any stored selection against it, and exposes `{ selection, options, select() }`.

### 4.4 Persistence

- Per-user localStorage key `assistModel.<username>` = `{ "endpointId": "...", "modelId": "..." }` — same per-user pattern as `flows.lastSelected.<username>` (`Briefings.jsx:383`). Cheap, survives sessions, per-browser.
- On load, a stored selection that no longer validates (provider deleted, team unassigned, model removed from the catalog) is dropped silently and the control returns to its unselected/auto-select state.
- Cross-tab sync via the `storage` event (nice-to-have, phase 1 optional).
- Deliberately **not** stored server-side on the user record: the selection is a UI preference; the *authority* is the per-request server-side validation, so server persistence buys little and adds a write path to the user store.

### 4.5 Transport and server-side enforcement

**Transport.** The central wrapper `apiCall()` (`admin-console/src/hooks/useApi.js:48`) gains one line: if a selection is set (module-level getter, fed by `ModelSelectionProvider`), add header `X-Assist-Model: <endpointId>:<modelId>` to every request. The few raw streaming `fetch` call sites (Flow Copilot NDJSON in `FlowCopilotPanel.jsx`) add the same header explicitly. Non-assist routes ignore the header — zero cost, and any *future* assist route inherits the selection for free.

**Server.** New `resolveAssistTarget(req, { requireSelection = true } = {})` in `api.js`, replacing the bare `resolveGenerationTarget(req.body.llmEndpointId)` call in all nine Family-A routes:

1. Parse `X-Assist-Model` (fallback: legacy `req.body.llmEndpointId` for API compatibility).
2. `getScope(req)`; look up the endpoint; **403 `assist-endpoint-not-permitted`** if it fails `assistSelectableEndpoint` — a client can never spend on a provider its user cannot see.
3. Validate `modelId` against the provider's `models[]`; unknown/absent → provider `defaultModelId` (else first model). **The hardcoded sonnet-kind preference is dropped when an explicit model is given**; it remains only as the default-pick heuristic.
4. No header and **≥ 1 selectable provider exists** → **400 `assist-model-not-selected`** ("Select an assist model in Settings → Model", #1805). We deliberately do *not* fall back to `endpoints[0]` — that silent default is precisely the billing bug this concept removes.
5. No header and **zero providers registered platform-wide** → `.env` fallback exactly as today (bootstrap installs keep working with no configuration).
6. Return `{ baseUrl, token, model, endpointId, endpointName }`; the HTTP call itself (`buildMessagesUrl` + `httpPostJson`) is unchanged.

The frontend maps the two error codes to a friendly nudge that opens the header popover.

**Provenance.** Every assist response gains `meta: { assist: { endpointId, model } }` (the copilot NDJSON stream emits it as its first event), and the audit line for assist mutations carries the same pair — so "which key paid for this" is answerable after the fact.

### 4.6 Family B — orchestrator autonomous synthesis (phase 2)

Curator auto-promotion (#10) and distillation (#11) run with **no user session**, so the header selection cannot apply. Correct attribution there is *team*-derived:

- New optional team-agent config field `assistLlmEndpointId`. The orchestrator resolves it the same way it already resolves spawn bindings (it has the `llm-endpoints` index + `_keys/` on the shared volume — `resolveLlmBinding`, `orchestrator.js:181`), filtered by the same rules (non-oauth, usable by that team). Unset → `.env` as today.
- `_synthesizeSkillMd(env, request)` grows an optional `binding` parameter `{ baseUrl, token, model }`; the three call sites pass the team-resolved binding when present.
- Domain bootstrap (#12) *is* user-triggered (console proxy `POST /api/knowledge/domains {op:'bootstrap'}` → orchestrator internal). Phase 2 forwards the validated `endpointId`+`modelId` from the user's header selection through the proxy; the orchestrator reads the token locally from `_keys/` (the token itself never travels over the internal HTTP hop).

Editing `assistLlmEndpointId` is exposed via the **Knowledge page's ConfigurePanel** (`KnowledgeFlow.jsx`, the autonomy/gates/storage slide-out — `GET /api/agents/:teamId/model-options` fetches the current value and the selectable providers; `PUT /api/agents/:teamId { assistLlmEndpointId }` persists it). Team-Admin-gated by the existing `canManageAgent` gate, same as other team-agent config on that panel.

## 5. Decided design points

1. **Selection-visibility = membership (any role), management-visibility unchanged.** A Team Member may *use* their team's provider for assist calls (as their agents already do) but still cannot open/edit it on the Model Providers page.
2. **No silent default when multiple providers are selectable.** One-time explicit pick (persisted per user) beats a deterministic-but-wrong billing default. Single-provider users are auto-selected and never notice.
3. **Header transport over per-dialog body params.** One line in `apiCall` + two streaming call sites covers all nine features today and every future assist route; body `llmEndpointId` stays accepted as a legacy/explicit override.
4. **oauth-token providers stay excluded** from assist selection (subscription seat tokens are not server-side API keys).
5. **`.env` fallback survives only in bootstrap installs** (zero registered providers). As soon as one provider exists, every assist call must be attributable to a registered key.
6. **localStorage over server-side preference storage** — the server validates every call anyway; the stored value is only a convenience.

## 6. Edge cases

- **Provider deleted / team unassigned mid-session** → next assist call returns 403; the client drops the stored selection, refetches options, opens the picker. `DELETE /api/llm-endpoints/:id` needs no new in-use guard: assist selections are per-user preferences, not persistent bindings.
- **Model removed from the catalog** (`PUT .../:id/models`) → server falls back to the provider default and reports the actually-used model in `meta.assist`; the client updates its stored `modelId`.
- **User in multiple teams** → sees the union of both teams' providers; the pick decides which team's key pays. The header control makes the active choice permanently visible, which is the requested safeguard.
- **Summaries backfill** (#8, up to 40 sequential calls) → resolve the target **once** per request, not per entry, so a mid-loop selection change or provider edit cannot split one backfill across two keys.
- **IAP / per-user sessions** → selection keys off `user.username` exactly like `flows.lastSelected`; env-admin fallback login works the same way.

## 7. Security

- The header value is untrusted client input; the server re-derives permission from the session scope on **every** call (fail-closed 403/404 semantics, mirroring `GET /api/llm-endpoints/:id`).
- Tokens never leave the server: the options endpoint returns masked records; the internal orchestrator hop (phase 2) transports only ids.
- No new mutating endpoints in phase 1; the options endpoint is read-only and session-gated like all `/api` routes.

## 8. Rollout

**Phase 1 — console assist calls (the user-facing gap).**
`assistSelectableEndpoint` in `scope.js` (+ unit tests) · `GET /api/assist/model-options` · `resolveAssistTarget` + wiring in the nine Family-A routes (+ 400/403 tests) · `ModelSelectionProvider` + header control in `Shell.jsx` · header injection in `apiCall` + the copilot streaming fetches · `meta.assist` provenance + audit fields · error-code handling (nudge → open picker).

**Phase 2 — orchestrator synthesis.**
`assistLlmEndpointId` on the team agent + Teams-page setting · `_synthesizeSkillMd` binding parameter + three call sites · domain-bootstrap pass-through of the user selection.

**Phase 3 (optional polish).**
Cross-tab `storage` sync · per-feature transient override (e.g. "run this one draft on Haiku") layered on the same header · assist-spend rollup in usage statistics keyed by `meta.assist.endpointId` (ties into the cost-attribution work, #643).

## 9. Out of scope, noted for later

- Metering/quotas per provider (this concept only fixes attribution).
- Model *capability* routing (e.g. auto-pick a cheap model for summaries): the explicit selector deliberately replaces implicit heuristics first; smart routing can layer on top later as a user-visible option, never a silent one.
