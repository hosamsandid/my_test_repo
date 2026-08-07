# Flow Editor — Hand-off-centric wiring UX (unification concept)

> Status: **proposed concept**. Successor to the seam problems left between four shipped
> concept generations: connection model (#409–#414, `docs/flow-connection-model.md`),
> outcomes (#784/#827–#831, `docs/agent-outcomes-concept.md`), inspector consolidation
> (#864–#866, `docs/flow-editor-config-consolidation-concept.md`), and label
> registry / named human roles (#928/#981/#987). Each of those was internally consistent;
> this concept unifies the **seams between them**, where flows currently break.

## 1. The evidence — one reproduction, four defects

Reproduction (draft flow, 2026-07-30): add Business Analyst + Developer from templates,
add a human role "BA Human". Drag BA → BA Human (issue delivery — works). Drag
BA Human → Developer, gate label `ready`, submit. Result:

| # | Observed | Root cause |
|---|---|---|
| D1 | Developer's listener wakes on **both** `issues.labeled` **and** `pull_request.labeled`; edge renders as "ready · Issue+/PR+" | `HumanGateForm.submit()` (`admin-console/src/pages/process/EdgeDialogs.jsx:623-640`) hardcodes `events: ['issues.labeled', 'pull_request.labeled']`. It is the **only** creation path in the codebase that still writes a multi-event trigger — the single-event migration landed 2026-07-05, `HumanGateForm` was added 2026-07-30 (#987/PR #988) without following it. There is no server-side one-event enforcement to catch it. |
| D2 | Opening the created edge immediately shows the yellow migration warning "This trigger still listens on several events … saving keeps only the selected one" | Same as D1 — the create path violates the rule the edit path (`LegacyMultiEventNote`, `EdgeDialogs.jsx:49-59`) enforces. A user is shown a data-migration warning about a trigger the UI itself created seconds earlier. |
| D3 | The listener carries no claim label → advisory `unclaimed-listener` lint | The *channel-checkbox* gate path auto-stamps `deriveClaim(label)` (`process-template.js:787,805`); the *human-drag* gate path stamps nothing. Two gate-authoring paths, two conventions. |
| D4 | BA's outcome "Opens issue" warns **"no consumer — nothing listens for this outcome's signal"** although BA Human demonstrably reviews that issue (bound via the GitHub-artifacts picker) | Outcome-consumer derivation does not count a bound human reviewer as a consumer for `openIssue`/`openPr` actions. #986 fixed the sibling case for brake labels ("hands off to a person"); the artifact-review case was missed. |

D1–D3 are regressions/inconsistencies to fix immediately (Phase 0). D4 is a lint gap.
But none of them is the real problem — they are the *fourth* round of this class of bug.

## 2. Why it keeps breaking — structural diagnosis

**The user's mental unit is a hand-off; the UI's authored unit is per-node config.**
A flow designer thinks "the BA writes a ticket, [person] approves it, then the Developer
builds it" — one sentence, one thing. The data model stores that sentence as **four
writes in three places**: an outcome on the producer, a `consumes` entry and an `emits`
entry on the humans registry (team agent), and a listener trigger on the consumer.
Nothing owns the sentence.

Consequences, all confirmed in the current code:

1. **Every dialog re-implements the write path.** `CreateHandoffDialog`,
   `CreateChannelDialog`, `HumanGateForm`, `HumanDeliveryForm`, the Routing-tab pickers
   and `AddInputDialog` each hand-roll their own sequence of ops calls, each encoding
   conventions (single event, claim stamping, produce flags, registry updates) locally.
   A new dialog (#987) simply *missed* three conventions — nothing enforced them.
2. **Assembly orders don't converge.** BA→Dev "with approval" vs. BA→Human then
   Human→Dev produce different persisted states (channel+gate vs. human emit+manual
   trigger), different claims, different edit dialogs. The user can't predict what a
   gesture creates.
3. **Parallel models at the seams.** `github.producesPr/Issue` is *not* derived from
   `openPr`/`openIssue` outcome actions — dual source of truth (#784 decision 3 was
   never finished). The Routing tab therefore needs a *separate* "GitHub artifacts —
   who reviews them" block that shows produce-flag data the Outcomes editor can't show,
   is not configurable in place, and duplicates the outcome row above it.
4. **Signals point nowhere.** An outcome says *what* it sets, never *who* should
   receive it. The consumer is derived and surfaced only as a warning ("no consumer"),
   with no affordance to fix it in place — the user must leave, find the target node,
   and author the listener half themselves.
5. **Port semantics are inconsistent on the canvas.** Yellow outcome squares are
   draggable; the yellow-ish "Opens issue/PR" badges are not (drag pills removed in
   #411, before outcomes existed). Dragging from an outcome port pre-fills a dialog;
   dragging from the generic ● port opens a type picker — two gestures, two vocabularies
   for the same act.

## 3. Scenario catalog — what users actually build

Persona: a team lead / process owner. Vocabulary: participants (*agents, people, the
outside world*), work carriers (*issue, PR, label, file, chat message*), verbs (*opens,
reviews, approves, implements, reacts to, escalates to*).

| # | Scenario | Shape |
|---|---|---|
| S1 | Work intake — person files issue, Triage reacts | GitHub → agent (`issues.opened`) |
| S2 | Label hand-off — Triage labels `req:refine`, BA wakes | agent → agent (label) |
| S3 | **Review gate** — BA authors ticket, PO approves, Developer implements | **agent → person → agent** (the canonical three-party pattern) |
| S4 | Implementation produces a PR | outcome `open PR`, unconsumed until wired |
| S5 | Automated PR review with branch — approve / request changes | agent → agent via PR channel; `exactlyOne` switch |
| S6 | Rework loop — Reworker on `revisions-required` | agent → agent (label, cycle) |
| S7 | Human merge gate — person reviews `ready-to-merge` PRs, optionally labels `approved` → Merger | agent → person (→ agent) |
| S8 | Post-merge follow-up — doc-sync on merged PR | GitHub → agent |
| S9 | Escalation — a run ends "blocked, needs human" | outcome → person (brake / DM) |
| S10 | Review rejection — PO requests changes instead of approving | gate's rejection path back to producer |
| S11 | File artifact hand-off — Analyst report → Developer | dataFlow (exists, keep) |
| S12 | Dispatcher fan-out — `ready` → Dev 1, `ready-2` → Dev 2 | `exactlyOne` outcomes, each with a consumer |
| S13 | Schedule / external webhook | timer / http (exists, keep) |

S3 (+ its variants S7, S10) is the single most common pattern **and the one with no
first-class representation** — which is exactly where the reproduction of §1 broke.

## 4. Target model

### 4.1 Principle: the hand-off is the authored unit; ports stay the stored unit

No new persisted object. The ports (`outcomes`, `channels`, `triggers`, `dataFlow`,
`humans`, `labels`) remain the source of truth, exactly as the shipped concepts decided.
What changes: **all authoring goes through one composite wiring engine** that writes
both/all sides of a hand-off atomically and encodes every convention exactly once.

**Wiring engine** — a pure module (`process/wiring-engine.js`), unit-tested, used by
every dialog, picker and drag handler; it receives `ops`/`humanOps` and never branches
on mode (adapter contract unchanged):

```
wireLabelHandoff(A, B, {label, artifact})        // outcome action on A + single-event listener (+claim) on B
wireChannel(A, B, {artifact, label?, gate?})     // producer outcome + channel on consumer
wireReviewGate(A, P, B, {artifact, gateLabel,    // the S3 triangle in one call:
                         rejectLabel?})          //   A outcome (openIssue/openPr) + P.consumes {artifact, from:A}
                                                 //   + P.emits gateLabel + single-event listener (+claim) on B
                                                 //   + optional rejection listener on A
wireHumanDelivery(A, P, {artifact|file})         // review-only delivery, no gate
wireEscalation(A, P, {outcomeId})                // brake/DM escalation outcome bound to a person
unwire*(…)                                       // symmetric cleanup: orphaned produce flags, emits,
                                                 //   listeners, registry entries — no leftovers
```

Conventions the engine owns (today scattered per dialog): **one event per trigger**
(picked from artifact context, never both); **claim auto-stamp** `deriveClaim(label)`
with `autoClaim` opt-out; produce-flag/outcome consistency; gate/brake classification
from the label registry; convergence (see 4.5).

### 4.2 Outcomes become routable: the consumer picker

Every outcome row in the Routing tab gains the missing half:

```
1. [Opens issue]  when: the issue is authored and ready for review
   action: open issue
   → reviewed by  [👤 BA Human ▾]          (replaces the separate GitHub-artifacts block)
   → then wakes   [Developer ▾]  gate label [ready]   (creates/reuses the listener via the engine)
```

- **"→ wakes: <picker>"** on every outcome (agents and, for delivery/escalation,
  people). Picking a target calls the engine; "no consumer" turns from a dead-end
  warning into a call-to-action with the picker inline.
- **The "GitHub artifacts — who reviews them" block is retired.** Its reviewer picker
  moves onto the owning outcome row (`open issue` / `open PR` actions). The block's
  data (`github.produces*` + human `consumes`) is unchanged — only the surface merges.
- **`github.producesPr/Issue` becomes a pure projection** of `openPr`/`openIssue`
  outcome actions (server-side `outcomesToGithub`, kept for graph/channel-recommendation
  compatibility). Finishes #784 decision 3; removes the dual source of truth.

### 4.3 Exactly four create dialogs, one shell

Direction + endpoint kinds fully determine the dialog. Same visual shell everywhere
(sentence title, same field order, same button row), one vocabulary (see 4.6):

| Drag | Dialog (sentence-titled) | Content |
|---|---|---|
| agent → agent | "How does **B** learn about **A**'s work?" | A's existing outcomes listed first as one-click tiles (recommended); then create-new: label hand-off / issue channel / PR channel / file artifact; structure (dependency, hierarchy) under a collapsed "Structure" group |
| agent → person | "**P** reviews **A**'s work" | artifact from A's outcomes (pre-selected if unambiguous); optional step "on approval, wake…" — inline consumer picker + gate label → creates the full S3 triangle in ONE dialog |
| person → agent | "**P** approves → **B** wakes" | gate label (default derived); **artifact context inferred from what P already reviews** (P.consumes) → single event, correct kind; claim stamped; optional rejection path ("on rejection, wake [producer]") |
| source → agent | GitHub event / webhook / schedule | as today, restyled to the shell |

Dragging **from a yellow outcome port** skips even that: it opens the matching form
pre-typed by the outcome's action (label listener for `setLabel`, channel for
`openPr`/`openIssue`) — never the generic type picker. The "Opens issue/PR" badges are
outcome ports now, so they become draggable again (heals the #411 amputation).

### 4.4 The review gate is one editable object

Clicking **any** edge of an S3 triangle (delivery edge, gate edge, or the gate node)
opens the same **"Review gate"** editor showing all three parties: producer + artifact,
reviewer, gate label, consumer, optional rejection path, claim. Edits and deletes go
through the engine (atomic, symmetric cleanup). The per-leg dialogs (`HumanDeliveryForm`,
`HumanGateForm`) are retired.

### 4.5 Convergence guarantee

All assembly orders produce **identical persisted state**: BA→Dev "with approval" ≡
BA→P then P→Dev ≡ outcome-row pickers in the Routing tab. The engine dedupes/reuses on
wire (same keying the reconcilers use), so re-running a gesture is idempotent, and
re-opening the result always shows the same editor. This is testable and *must* be
tested (property-style unit tests over the engine + e2e journeys per scenario S1–S13).

### 4.6 Vocabulary and shell normalization

One term set across canvas, dialogs, Routing tab, lints: **Input** (what wakes an
agent) · **Outcome** (how a run ends) · **Action** (signal an outcome sets) ·
**Artifact** (issue / PR / file an outcome produces) · **Consumer** (who reacts) ·
**Reviewer** (person a delivery goes to) · **Gate** (approval label a person applies) ·
**Brake** (label that pauses). The three prompt-field names ("Listener prompt", "Wake
prompt override", "Prompt") collapse into one: **"Wake instruction — what the consumer
is told"**. Edge/dialog titles are sentences, not type names.

### 4.7 Open ends are first-class

The model does **not** require closed graphs. Legitimate open ends exist on both sides:
terminal deliverables (a merged PR *is* the product), zero-signal runs under `any of`,
consumers invisible to the graph (GitHub Actions, a sibling team on the same repo —
the #902 scenario — external tooling), audience-type outputs (reports for the
organization), state-marker labels no trigger should listen on, lazily consumed
artifacts (knowledge, memory) — and humans are frequently *absorbing* endpoints
(approve, merge, close) with no modelable output; their spontaneous inputs and
off-platform hand-offs can never be enumerated. Forcing closure would make users
invent fake edges. Consistent with the platform doctrine: a wake, not a start-gate —
an open end just means "nothing wakes the next party automatically".

What changes instead: an open end becomes **declarable** so the editor can tell
*intentional* from *forgotten*:

- **Terminal by design** — "this outcome is the end product". The `none` action already
  expresses this for signals; an equivalent `terminal: true` marker is added for
  `openPr`/`openIssue`/artifact outcomes. Renders as a proper endpoint, no lint.
- **External consumer / audience** — "consumed outside this flow" (`external: true` +
  optional free-text note, e.g. "CI workflow", "platform team"). No lint; note shown at
  the port.
- **Open (undecided)** — neither wired nor declared. Only this raises the hint, and as
  a call-to-action with three options: *pick a consumer · mark terminal · mark external*.

Both markers live on the outcome option (bundle + config), round-trip through
export/materialise, and feed the flow-anomaly detector (#959): a terminal outcome with
no successor is not an anomaly.

### 4.8 Enforcement moves server-side

- `PUT /api/agents/:id` triggers + draft trigger writes: **reject multi-event
  `github-event` triggers on create** (validator in `process-template.js`, mirrored in
  the API layer). The edit-dialog migration note remains only for pre-existing data.
- Claim convention validator already exists (`claimError`) — extend the graph lint so a
  *gate* listener without claim is `info` (as today) but a *newly created* one can't
  happen (engine stamps it).
- D4 lint fix: a human reviewer bound to an `openIssue`/`openPr` outcome counts as its
  consumer ("reviewed by 👤 X" replaces "no consumer").

## 5. Reference walkthrough — S3 before/after

**Today (broken):** 2 drags, 2 differently-shaped dialogs, 4 hidden writes, result: a
two-event listener, a migration warning on first edit, an unclaimed-listener lint, a
false "no consumer" warning, and an edge label ("Issue+/PR+") nobody authored.

**Target, path A (one gesture):** drag BA → Developer → dialog: "How does Developer
learn about Business Analyst's work?" → tile "BA opens an issue" (recommended — the
outcome exists) → checkbox "a person approves first" → pick BA Human, gate label
`ready` (prefilled) → **Create**. One dialog. Graph shows BA → issue → 👤 BA Human →
`ready` ⇥ `ready:wip` → Developer. Zero warnings.

**Target, path B (two gestures, same result):** drag BA → BA Human ("BA Human reviews
BA's issue", with "on approval, wake…" left empty), then BA Human → Developer (context
inferred: issue; label `ready`; claim stamped). Same persisted state as path A.

## 6. What this deliberately does **not** change

- No new persisted edge object; ports + derived triggers stay canonical
  (`docs/flow-editor-config-consolidation-concept.md` §5 doctrine holds).
- No runtime semantics change: poller still does no origin filtering; gates stay
  wake-labels, not start-gates; claim stays best-effort observability.
- The Routing tab's Inputs panel, artifact dataFlow, stages, label registry, weaver,
  and templates keep working unchanged — they are consumers of the engine, not victims.

## 7. Phase plan

| Phase | Scope | Tickets (proposed) |
|---|---|---|
| **0 — regression fixes** (small, immediate) | D1: `HumanGateForm` single event with artifact-context inference + kind selector; D2 disappears with D1; D3: stamp `deriveClaim`; D4: human reviewer counts as outcome consumer; edge label renders one event | 1–2 issues |
| **1 — wiring engine** | Extract composite ops incl. `wireReviewGate` + `unwire*` + convergence tests; port all existing dialogs/pickers to it (no visible UX change) | 1 issue |
| **2 — routable outcomes** | Consumer picker + reviewer picker on outcome rows; retire the GitHub-artifacts block; `github.produces*` as projection (#784 decision 3 completed); `terminal`/`external` open-end markers incl. round-trip + lint reclassification (§4.7) | 1–2 issues |
| **3 — dialog unification** | The four sentence-titled dialogs on one shell; pre-typed outcome-port drag; draggable produce badges; one-dialog review gate (create + edit); retire `HumanGateForm`/`HumanDeliveryForm`/per-leg edit dialogs | 2 issues |
| **4 — hardening** | Server-side one-event rejection (raw layers A11/A12/A17); prompt-projection extension (V4); template/weaver/catalog migration + CI-lint extension (A13/A14); vocabulary sweep; e2e journeys for S1–S13 (esp. S3 both paths → identical state) | 2–3 issues |

Each phase ships alone and leaves the editor consistent; Phase 0 is independent of the
rest and should ship first. **Every phase PR walks the §8 surface inventory** and marks
each surface touched or explicitly n/a — that walk is the review gate that keeps this
concept from repeating its predecessors' missed corners.

## 8. Surface inventory — the completeness contract

Wiring is created, edited, and *seen* in far more places than the Flow Editor. Every
phase PR must walk this inventory; a surface that a change does not touch must be
explicitly marked "n/a" in the PR description, not silently skipped. (This table is the
direct lesson from the last four concept generations, each of which missed corners.)

### 8.1 Authoring surfaces (write paths) — must go through / conform to the engine

| # | Surface | Today | Prescription |
|---|---|---|---|
| A1 | Canvas drags (● port, outcome ports, actor ports; agent/human/source × agent/human targets) | per-dialog ops sequences | engine calls only (Phases 1, 3) |
| A2 | Edge-click edit dialogs (`EditHandoffDialog` router: label, channel, timer, loop, event, webhook, dependency, artifact, parent) | mixed edit/remove-only shapes | engine `unwire*`/update ops; review-gate triangle opens the one gate editor (4.4) |
| A3 | In-card trigger rows (⏰/🐙/🏷/⚡/↻ → `onSelectEdge`) | same dialogs as A2 | follows A2 automatically — verify in e2e |
| A4 | Routing tab: Inputs panel + `AddInputDialog` | own ops sequences | engine calls; tile set matched with canvas dialog (same vocabulary, 4.6) |
| A5 | Routing tab: Outcomes editor + consumer/reviewer pickers (new) | outcome save only | engine for wiring side-effects; explicit Save semantics unchanged |
| A6 | Routing tab: Artifacts block + `HumanDeliveryPicker` | direct `humanOps` | engine `wireHumanDelivery` |
| A7 | Routing tab: GitHub-artifacts block | direct `humanOps` | **retired** (Phase 2) — pickers move onto outcome rows |
| A8 | Details tab: Structure (stage, parent) | direct ops | unchanged (structure ≠ hand-off), stays outside the engine |
| A9 | Human registry panel + human node inspector (`emits`/`consumes` editing) | raw label-list editing | keep, but gate-label edits offer the same "on approval, wake…" picker; same vocabulary |
| A10 | Label registry panel (gate/brake flags) | separate toolbar panel | unchanged as registry; gate editor links to it |
| A11 | **Agent-Chat right rail `TriggersPanel`** (full trigger CRUD, also embedded in draft inspector) | bypasses all wiring context | declared the **raw layer**: stays fully capable, but server-side validators (one event, claim shape) apply, and label-listener creation gets the same claim/default stamping; a hint links to the Flow Editor for wired triggers |
| A12 | **Agent runtime self-managed `triggers.json`** (Trigger-management prompt block; scheduler sync) | no validation | raw layer like A11: validated at scheduler sync/API write, deviations surfaced as graph lints — never silently rewritten (self-management is a feature) |
| A13 | Team-Setup wizard `StepProcess` (template pick / Flow-Weaver compose / blank) | weaver hand-builds triggers | weaver emits engine-conformant bundles (it already emits single-event + claims); CI guard extended to the new conventions |
| A14 | Agent templates (`skill-pool/agent-templates/*.json`) + process-template registry bundles | preset triggers/outcomes | migrated to conventions (one event, claims, terminal/external markers where applicable); registry CI lint extended |
| A15 | LLM suggestion endpoints (`/api/agent-ports/suggest`, outcomes suggest, prompt generate) | free-form suggestions | suggestions validated through the engine before display; never persist non-conformant wiring |
| A16 | Export → Edit-as-draft → materialise round-trip (`process-template.js` validators, expanders) | round-trips ports + humans | new fields (`terminal`, `external`, gate objects' claim opt-out) round-trip losslessly; validator coverage |
| A17 | Direct API/file edits (`PUT /api/agents/:id`, raw `triggers.json` in the workspace browser) | unvalidated | same server-side validators as A11/A12; the raw-file disclosure stays (workspace-transparency principle) |
| A18 | BP mode (`makeBpOps`, dependency/artifact only) | capability matrix | unchanged; engine respects the capability matrix — no human/gate wiring in BP mode |

### 8.2 Visibility surfaces (read paths) — must render the unified model

| # | Surface | Impact |
|---|---|---|
| V1 | Canvas: edges, badges, gate rendering, claim badges, lint markers | one-event edge labels; draggable produce badges; terminal/external endpoint rendering; CTA-style open-end hint |
| V2 | Read-only modes (blueprint, viewer, import preview, BP flows) via capability matrix | same rendering, no ports; verify no regressions per mode |
| V3 | Routing tab consumer/reviewer lines + warnings | CTA with three-way choice (4.7) |
| V4 | **Prompt projections** (#829 outcomes block, github-io block, trigger-management block; `prompt-assembly.js` + preview panel) | extended: reviewer/consumer context in the outcomes block ("open the issue; *BA Human* reviews it; do **not** set `ready` yourself"); gate labels explicitly forbidden in prose; preview stays byte-identical to seed |
| V5 | Agent-Chat `OutcomesPanel` (read-only, #963) | renders consumer, reviewer, terminal/external markers |
| V6 | Graph endpoint consumers: Flows view, wizard inline preview, bp-explorer viewer | shared builders (`process-graph.js`/`unified-graph.js`) — update once, verify all three |
| V7 | Lints (shared between Flows + wizard preview) | new/changed: open-end three-way classification replaces blanket `no consumer`; `duplicate-listener`, `unbound-gate`, `unclaimed-listener` unchanged in spirit |
| V8 | Flow-anomaly detector (#959) | consumes terminal/external markers (4.7); review-gate triangles give it the reviewer expectation |
| V9 | GitHub Event Log page | no change, but the e2e verification of S3 uses it (claim trail visible) |
| V10 | e2e journeys + docs | existing `outcomes-routing` journey updated per phase; new S1–S13 journeys (Phase 4); FAQ/release notes per phase |

### 8.3 Consistency rules across surfaces

1. **One writer discipline:** every A-surface either calls the engine or is declared
   raw layer (A11, A12, A17) — raw layers are guarded by the same server-side
   validators and surfaced by the same lints, so they can deviate *visibly*, never
   silently.
2. **Convergence includes presets:** the engine's dedupe/reuse keying treats
   template-preset triggers (A13/A14) as first-class — wiring a review gate onto a
   template role reuses its preset listener instead of adding a second one.
3. **One vocabulary everywhere** (4.6) — including chat-rail panels, wizard step,
   template descriptions, lint texts, and docs.
4. **Shared builders stay the single render path** (V6) — no surface may derive edges
   or consumers with local logic (today's `outcome-consumers.js` remains the one
   derivation module, extended for reviewers/markers).

## 9. Open (product) questions

1. **Rejection-path default (S10):** offer "on rejection, wake [producer]" in the gate
   dialog with a default rejection label (e.g. reuse the intake label) — or keep
   rejection as a manually wired hand-off? Default chosen here: offered, off by default.
2. **Escalation action type (S9):** introduce `escalateTo: <humanId>` as a first-class
   outcome action (rendering the red edge without a brake label), or keep brake labels
   as the only mechanism? Default: keep brake labels, bind them via the picker.
3. **DM delivery:** should "notify person in chat" become a pickable delivery target on
   outcomes (the `notify: "dm"` idea from the outcomes concept)? Default: out of scope.
