# Agent Outcomes — structured outcome / switch model (concept, #784)

> Status: **agreed design** for #784. This document is the deliverable of the concept ticket; the
> implementation is split into the follow-up tickets listed in §10. No code ships with this concept.

## 1. Problem

A trigger describes **how an agent starts**. There is no equivalent model for **how an agent ends**:
which possible **outcomes** it has, which signal (label, PR, issue) it sets per outcome, and whether
those outcomes are mutually exclusive. Today that information exists in three unsatisfying forms:

1. **Agent-level `emits`** (#414) — a flat label list on `config.json`. Canonical for the graph
   edges, but without semantics: it says "these labels *can* be set", not "the agent has *exactly
   these* mutually exclusive outcomes, one of which is chosen per run".
2. **Prompt prose** — the actual branching logic ("if review clean → `ready-to-merge`, else
   `revisions-required`") lives only in free text. The retired heuristic `emits-derivation.js`
   (#783) demonstrated why guessing structure from prose is unreliable.
3. **GitHub channel ports** (#380) — model *that* a producer opens a PR/issue and *that* a consumer
   reacts to it, but a channel carries at most one optional routing label and a human-gate flag.
   The only historical two-way branching construct (`kind: "pr-review"` approve/reject) was
   deliberately dropped when channels replaced it (`normalizeLegacyReview`,
   `admin-console/api/process-template.js`).

### 1.1 Reference cases

**Dispatcher.** A dispatcher receives `dispatch`-labelled issues from two Business Analysts and
routes each task to Developer 1 (`ready`) or Developer 2 (`ready-2`). Which developer gets which
task is a per-run decision — today it is describable only in prompt prose, invisible and
unconfigurable in the Flow Editor.

**Code reviewer.** Two mutually exclusive outcomes on a PR: *accepted* → `ready-to-merge` vs.
*revisions required* → `revisions-required`. The graph should render this as a real switch, not as
two unrelated label edges.

### 1.2 The input-side twin problem: duplicate listeners

Investigating the dispatcher surfaced a second, structural defect that this concept fixes alongside
(it is a prerequisite for trustworthy routing): **identical listeners multiply**.

- The derived channel trigger id embeds the producer:
  `channelTriggerId = <consumer>-on-<artifact>-<producer>` (`process-template.js`). Two channels
  from different producers with the same label therefore create **two** triggers with identical
  `events` + `labelFilter`.
- The `from` field of a channel only draws the graph edge. The poller deliberately performs **no
  source/origin filtering** (`orchestrator/github-poller.js` — matching is event type + history
  horizon + `labelFilter` only), so both triggers fire on *any* matching event.
- Reconcilers only manage their own derived triggers (`channel: true` / `dataFlow: true`, exact-id
  guard). A manually authored trigger with the same `(events, labelFilter)` is left standing next
  to them; there is no content-level dedup anywhere.

Net effect in the reference installation: **three** functionally identical `issues.labeled
"dispatch"` triggers on the dispatcher — every dispatch issue wakes it three times.

## 2. Design decisions (resolving the open questions of #784)

| # | Question | Decision |
|---|---|---|
| 1 | Relationship to agent `emits` | **`outcomes` replaces `emits`.** A flat `emits` list is read as the degenerate outcome set (`anyOf`, no conditions) — see §7. The `emits` field is retired after the editor + migration ship (phase 6). |
| 2 | Switch vs. multi-emission | **Both modes from the start**: `exactlyOne` (real switch) and `anyOf` (several outcomes may apply per run). `anyOf` is required anyway as the migration target for flat `emits`, so supporting only the switch would not simplify anything. |
| 3 | Relationship to GitHub channels (#380) | **Unify on the producer side**: "opens a PR", "opens an issue", and "sets a label" become outcome *action types* in one model. The consumer side (`channels` port, derived listener triggers) stays as is. `github.producesPr/producesIssue` becomes a projection of outcomes and is retired in phase 6. |
| 4 | Runtime linkage | **Declarative only, for now.** The agent still sets its signals itself via the generated prompt block (§8). A later, separate ticket may add *soft verification* (a feed warning when a run ended without any declared outcome signal) — never hard enforcement. |
| 5 | Author ergonomics | Outcomes are **LLM-suggested, human-confirmed**: the Add-role dialog gains an outcome suggestion step analogous to the existing prompt generation (`POST /api/agent-prompt/generate`), and the Routing tab offers suggestions on demand. Nothing is persisted without confirmation. |

## 3. Data model

A new declarative port on the agent/role — a sibling of `channels`, `dataFlow`, `parentMemberId`,
`stage` (and, until retirement, `emits`):

```jsonc
"outcomes": {
  "mode": "exactlyOne",            // "exactlyOne" (switch) | "anyOf" (zero or more per run)
  "options": [
    {
      "id": "to-developer",        // stable slug, unique within the agent
      "title": "Route to Developer",          // display name (node port + Routing tab)
      "when": "Frontend/UI task, or Developer 2 is at capacity",   // human-readable condition
      "actions": [
        { "type": "setLabel", "label": "ready" }
      ]
    },
    {
      "id": "to-developer-2",
      "title": "Route to Developer 2",
      "when": "Backend/database task",
      "actions": [ { "type": "setLabel", "label": "ready-2" } ]
    },
    {
      "id": "hold",
      "title": "Hold for clarification",
      "when": "Task is ambiguous — human input needed",
      "actions": [ { "type": "none" } ],
      "notify": "dm"               // optional: post a DM summary when this outcome is chosen
    }
  ]
}
```

**Action types** (extensible):

| `type` | Fields | Semantics |
|---|---|---|
| `setLabel` | `label` | Apply this GitHub label (to the issue/PR the run concerns). |
| `openPr` | — | Open a pull request (absorbs `github.producesPr`). |
| `openIssue` | — | Open an issue (absorbs `github.producesIssue`). |
| `none` | — | Terminal outcome — no outbound signal. Renders as a dead-end port *without* triggering the `dead-end-emitter` lint. |

Rules:

- An outcome may carry **several actions** ("open an issue *and* label it `ready`"). Several
  outcomes may set the **same label** (allowed, but linted under `exactlyOne` — §9).
- `human:*` labels and the brakes (`hold`, `needs:human`) are **forbidden as outcome actions**
  (existing gate convention, #333): a human gate is by definition not agent-emitted. Lint severity
  `error`, same as today's `gate-violation`.
- `when` is free text — it is documentation *and* prompt material (§8), never evaluated by code.
- Bundle schema: role-level `outcomes` in the process-template bundle
  (`processTemplateVersion: 1`), validated by `validateProcessTemplate`, exported by
  `buildProcessTemplate`, applied by `templateToCustomRoles` → member config. Template variables
  (`{{stagePrefix}}` etc.) are substituted inside `label`/`when` exactly like in trigger fields.

## 4. Input-side consolidation (prerequisite)

Independent of the outcome model, the listener derivation changes from *one trigger per channel* to
**one trigger per `(event set, labelFilter)`**:

- `expandGithubChannels` / `reconcileTeamGithubChannels` group all channels of a consumer that
  resolve to the same `(events, labelFilter)` into **one** derived trigger. The trigger id drops the
  producer: `<consumer>-on-<artifact>[-<label>]`. The contributing producers are recorded on the
  trigger as informational metadata (`sources: [producerId, ...]`) — for the graph and the Routing
  tab, with **no** runtime meaning (origin filtering stays deliberately absent).
- `stampDerivedActivation` keeps working: on id-scheme change, the reconciler carries the oldest
  prior `activatedAt` of the triggers being merged onto the consolidated trigger, so the poller's
  history horizon cannot jump to "now" and drop a pending event.
- A new **`duplicate-listener` lint** (severity `warning`) flags any two triggers of one agent with
  identical `(events, labelFilter)` — this is what catches the *manual* trigger standing next to a
  derived one. Derived triggers never conflict among themselves any more by construction.
- The graph still draws one edge per channel (producer → consumer); edges simply map onto the
  shared listener. No visual change.

This immediately fixes the "dispatcher fires three times" defect: the two channel triggers collapse
into one, and the pre-existing manual trigger is surfaced by the lint for the operator to delete.

## 5. Graph & editor representation

### 5.1 Node rendering

- Every outcome renders as a **named output port** on the node (same pattern as the PR/Issue ports
  from #380). Port label = `title` (fallback `id`).
- `mode: "exactlyOne"` adds a **switch glyph (◇)** to the node header; outgoing outcome edges are
  labelled with the outcome title, so `Code Reviewer ◇ → [accepted] → Merger` /
  `→ [revisions required] → Reworker` reads as a real branch.
- Edge derivation (in `unified-graph.js` / `process-graph.js`): an outcome edge `A →(outcome o)→ B`
  exists when an action of `o` sets a signal some trigger of `B` listens on — `setLabel` matches a
  `labelFilter` listener (today's emit index, now keyed by outcome), `openPr`/`openIssue` matches a
  `channels` port with `from: A`. The flat-emit index remains only as the degenerate read path (§7).

### 5.2 The Routing tab — one place for the whole decision

A new **Routing** tab in the node inspector (next to Details / Triggers / Connections), showing both
directions of the agent in one view:

```
┌─ Dispatcher · Routing ──────────────────────────────────────┐
│ INPUTS (what wakes this agent)                              │
│   ▸ Issue · label "dispatch"            1 listener          │
│       ← Business Analyst  ← Business Analyst 2              │
│   ▸ PR merged                           1 listener          │
│   ⚠ duplicate-listener: manual trigger "…" matches the      │
│     derived "dispatch" listener                             │
│                                                             │
│ OUTCOMES                     mode: ● exactly one  ○ any of  │
│   1. Route to Developer                                     │
│      when: frontend/UI task            → label "ready"      │
│      consumers: Developer                         [✎] [🗑]  │
│   2. Route to Developer 2                                   │
│      when: backend/DB task             → label "ready-2"    │
│      consumers: Developer 2                       [✎] [🗑]  │
│   3. Hold for clarification                                 │
│      when: ambiguous                   → no signal · DM     │
│   [+ add outcome]   [suggest outcomes…]                     │
└─────────────────────────────────────────────────────────────┘
```

- **Inputs** lists the consolidated listeners with their contributing sources and inlines the
  `duplicate-listener` lint. Read-mostly; "delete duplicate" is offered inline.
- **Outcomes** is the single, unified configuration surface the flat per-edge dialogs cannot
  provide: per row condition, action(s), and the **derived** consumers (read-only, computed from
  the graph; "no consumer" warning inline). The mode toggle sits above the list.
- **suggest outcomes…** calls the LLM suggestion endpoint (§2, decision 5); results land in the
  list unconfirmed-highlighted until saved.

### 5.3 Canvas interactions

- Dragging from an outcome port onto a node opens the existing `CreateHandoffDialog` pre-filled
  with the outcome's label (creating/reusing the listener on the target).
- Clicking an outcome edge opens the Routing tab focused on that outcome (replaces the
  per-edge-type dispatch in `EditHandoffDialog` for outcome edges; other edge kinds keep their
  dialogs).
- Draft and live editing run identically through `edit-adapters.js`: a new `setOutcomes` /
  `getOutcomes` op pair on `liveOps` (via `PUT /api/agents/:id { outcomes }`, reconciler re-derives
  prompt block + listeners) and `makeDraftOps` (bundle mutation). Dialogs never branch on mode.
- The `upsertChannel` keying `(artifact, from)` is relaxed to `(artifact, from, label)` so a
  producer can feed the same consumer through differently-labelled channels (required for
  switch fan-in on one target).

## 6. Prompt synchronisation

The structured declaration is the source of truth; the prompt instruction is its **generated
projection** — same pattern as the `github-io` block (#380):

- A marker-delimited block `<!-- outcomes:start -->` … `<!-- outcomes:end -->` under an
  `## Outcomes` heading, appended idempotently (strip-then-reappend) by the expander at
  materialise and by the live reconciler on every `outcomes` write.
- Generated text (schematically, `exactlyOne`):

  > At the end of every run you choose **exactly one** of the following outcomes:
  > 1. **Route to Developer** — when: frontend/UI task. Then: apply label `ready`.
  > 2. **Route to Developer 2** — when: backend/DB task. Then: apply label `ready-2`.
  > 3. **Hold for clarification** — when: ambiguous. Then: set no label; report to the user in the DM.
  >
  > Never apply more than one of these labels in a single run.

  (`anyOf` variant: "choose all outcomes that apply — zero is allowed".)
- This closes an existing gap: today's `producePrText`/`produceIssueText` never mention the routing
  label the consumer filters on — agent-driven labelling only works if the author remembered to put
  it in prose. With outcomes, the projection is guaranteed consistent.
- The block absorbs the produce block for agents whose PR/issue opening is modelled as an outcome;
  during coexistence (phase-wise rollout) both blocks may appear, each idempotent under its own
  markers.

## 7. Migration & coexistence

- **Read path (`liftAgentEmits` successor):** an agent/role with flat `emits` and no `outcomes` is
  interpreted on read (graph build, export, materialise) as
  `outcomes: { mode: "anyOf", options: emits.map(l => ({ id: slug(l), actions: [{type:"setLabel", label: l}] })) }`
  — no `when`, no titles. Nothing is rewritten on disk until the agent is edited in the Routing
  tab, which persists the lifted structure (one-way upgrade, mirroring `liftTriggerEmits`).
- **Backward compatibility:** agents/bundles without `outcomes` work unchanged; old bundles
  round-trip through export/import/materialise losslessly (the lift happens on read at every
  entry point). `PUT /api/agents/:id` accepts both fields during coexistence; writing `outcomes`
  clears `emits`.
- **Shipped templates/catalog:** `core-sdlc`, `extended-sdlc`, `dispatched-sdlc` and the agent
  templates are migrated to authored `outcomes` (with real `when` texts) in the retirement phase;
  the registry CI guard (render lint-clean) covers them.
- **Retirement (last phase):** `EmitsEditor` and the `emits` field are removed once the Routing tab
  ships and templates are migrated; `github.producesPr/producesIssue` collapses into outcome
  actions the same way. #414 is thereby superseded.
- `users`-visible invariant throughout: **no runtime behaviour change** from migration alone —
  outcomes stay declarative (decision 4), and lifted flat emits generate byte-identical graph
  edges.

## 8. Lints

| Lint | Severity | Condition |
|---|---|---|
| `duplicate-listener` | warning | Two triggers of one agent share `(events, labelFilter)` (§4). |
| `outcome-without-consumer` | warning | An outcome's signal has no listener anywhere in the flow (successor of `dead-end-emitter` for outcome edges; `none` actions are exempt). |
| `switch-with-one-option` | info | `exactlyOne` with fewer than two options — not a branch. |
| `same-label-multiple-outcomes` | warning | Under `exactlyOne`, two options set the same label — the consumers cannot distinguish the branches. |
| `label-target-mismatch` | warning | A `setLabel` lands on a PR (or an issue) — explicit `target: 'pr'\|'issue'`, else implied by an `openPr`/`openIssue` in the same outcome or by the producer's PR-only / issue-only triggers — but a consumer on that label only listens on the other `*.labeled` event, so it never wakes (#2629). |
| `human-label-as-outcome` | error | An outcome action sets a `human:*` / brake label (extends today's `gate-violation`). |

Existing lints keep working: `orphan-listener` unchanged; `dead-end-emitter` computes over the
lifted outcome index; `competing-stage` unchanged.

## 9. Runtime posture

Unchanged and deliberate: outcomes are **declarative**. The agent sets labels/opens PRs itself,
guided by the generated prompt block; the poller performs no origin filtering; no gate blocks a
run. A possible later addition (own concept/ticket, not in scope): *soft verification* — after a
triggered run, compare the signals actually set against the declared outcome set and post a feed
warning on mismatch. Never enforcement.

## 10. Phase plan / follow-up tickets

Each phase is independently shippable; order is the dependency order.

| Phase | Ticket | Content |
|---|---|---|
| 1 | listener consolidation | One derived listener per `(events, labelFilter)` + `sources` metadata + `duplicate-listener` lint (§4). Fixes the acute multi-fire defect; no new data model. |
| 2 | outcomes data model | `outcomes` on config + bundle: schema, validation, `PUT /api/agents/:id`, export/import/materialise round-trip, read-path lift of flat `emits`, outcome-keyed graph edges (§3, §5.1, §7). |
| 3 | Routing tab & canvas | Routing tab (inputs + outcomes), outcome output ports, switch glyph, edge labelling, dialogs, `edit-adapters` ops, channel keying relaxation (§5). LLM outcome suggestion included here. |
| 4 | prompt sync | Generated `outcomes` prompt block, expander + live reconciler, idempotent markers (§6). |
| 5 | lints | The four new outcome lints + `dead-end-emitter` over the lifted index (§8). |
| 6 | migration & retirement | Template/catalog migration to authored outcomes, `emits` + `EmitsEditor` removal, `github.produces*` unification (§7). |

## 11. Reference-case walkthrough

**Dispatcher** (after phases 1–4): inputs collapse to one `dispatch` listener fed by both BAs (the
manual trigger flagged and removed). Outcomes as in §3: `exactlyOne` with `ready` / `ready-2` /
`hold`. The canvas shows `Dispatcher ◇` with three named ports, two wired to the developers, one
dead-end-by-design. The generated prompt block makes the routing rule explicit; changing the rule is
an edit of the `when` texts in the Routing tab — no prompt surgery.

**Code reviewer**: `exactlyOne`, options `accepted → setLabel ready-to-merge` and
`revisions-required → setLabel revisions-required`. The Reworker's existing
`pull_request.labeled "revisions-required"` trigger and a merge-side listener consume the two
branches; the graph renders the switch that `normalizeLegacyReview` once flattened away.
