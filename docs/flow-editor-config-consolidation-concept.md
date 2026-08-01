# Flow Editor — unified agent-configuration concept (Routing · Triggers · Connections)

> Status: **proposed UX concept**. Consolidates the three flow-wiring tabs of the node inspector
> into one coherent model without losing any capability. Builds directly on the agreed outcome
> model (`docs/agent-outcomes-concept.md`, #784) and completes what its phase 6 started: the data
> model is already unified — this concept makes the **UI** tell the same story.

## 1. Problem

An agent node in the Flow Editor is configured across four tabs: **Details · Routing · Triggers ·
Connections**. Three of them (Routing, Triggers, Connections) cut *across* one underlying data
model instead of partitioning it. A newcomer cannot answer "where do I configure X?" without
knowing the project's history, and several controls edit the same fact from different angles:

| Redundancy / confusion | Where today |
|---|---|
| **Emit labels, twice, in two models.** Flat `emits` chips (Connections → `EmitsEditor`) vs. outcome `set label` actions (Routing). The backend already treats them as mutually exclusive — saving non-empty `outcomes` clears `emits` (`api.js`) — but the UI still shows both editors side by side. | Connections vs. Routing |
| **`Opens pull requests` / `Opens issues` checkboxes** (Connections, `github.producesPr/Issue`) vs. outcome actions `open PR` / `open issue` (Routing). #784 decision 3 already declares the checkboxes a projection of outcomes, slated for retirement. | Connections vs. Routing |
| **Wake sources in three places.** Raw triggers (Triggers tab), the read-mostly Inputs mirror (Routing tab, github-event only), and the consumer-side connection ports — `channels[]` ("reacts to" chips) and `dataFlow.inputs/dependsOn` — in Connections. All four surfaces describe the same question: *what wakes this agent?* | Routing + Triggers + Connections |
| **Derived-trigger footgun.** `channel: true` / `dataFlow: true` triggers appear as ordinary editable triggers in the Triggers tab, but every reconcile (`reconcileTeamGithubChannels` / `reconcileTeamDataFlow`) strips and regenerates them — manual edits are silently lost. The canonical object (the channel / data-flow port) lives in a different tab. | Triggers vs. Connections |
| **"Connections" is a grab bag.** Parent (structure), emits (output, legacy), GitHub outputs (output, legacy), reacts-to channels (input), data-flow chips (input *and* output) — five concerns, no shared question. Most chips are remove-only; creation happens on the canvas. | Connections |

The result: the most powerful and most clearly defined surface (**Routing**, #828) is the newest,
but the two older tabs still carry overlapping fragments of the same model.

### 1.1 What is already right

The consolidation is **not** a data-model change. Since #783/#784/#380 the canonical, declarative
ports on an agent/role are:

- **Output side:** `outcomes` (supersedes `emits` and `github.produces*`), `dataFlow.outputs`
- **Input side:** manual `triggers` (cron / once / http / github-event), `channels[]`,
  `dataFlow.inputs` / `dependsOn`
- **Structure:** `parentMemberId`, `stage`

Everything else (channel/data-flow triggers, `github.produces*` flags on the graph, graph edges) is
derived. This concept only re-sorts the *controls* along that canonical model.

## 2. Target mental model — three questions

Every control on an agent answers exactly one of three questions. The tabs partition along them:

| Question | Tab | Content |
|---|---|---|
| **Who am I?** | **Details** | Name, id, prompt/persona, and *structure*: stage, parent |
| **What wakes me, and what do I deliver?** | **Routing** | **Inputs** (all wake sources, full CRUD) + **Outcomes** (signals & artifacts) |
| — | *(Connections and Triggers tabs are retired; see §6)* | |

Target tab bar: **Details · Routing** — two tabs, one flow surface. "Routing" is kept as the name
because it is the established, most clearly defined concept; it simply absorbs the remaining
input-side editing and the output-side leftovers.

```
┌ Details ──────────────┐  ┌ Routing ─────────────────────────────────────┐
│ Name, ID              │  │ INPUTS — what wakes this agent          [+Add]│
│ Agent prompt          │  │  ▸ PR merged (any repo)            [on] [✎]  │
│ ─ Structure ─         │  │  ▸ Issue labeled `dispatch`        [on] [✎]  │
│ Stage    [Build ▾]    │  │      sources: BA-1, BA-2                     │
│ Parent   [— none ▾]   │  │  ▸ PR from Developer  ⟲ derived → connection │
│                       │  │  ▸ Every day 03:12 (self-curation) [on] [✎]  │
└───────────────────────┘  │ ──────────────────────────────────────────── │
                           │ OUTCOMES — how a run ends    (● one ◇ / any) │
                           │  1. Ticket ready → set label `ready`         │
                           │     consumers: Developer                     │
                           │  2. Blocked → open issue                     │
                           │     ⚠ no consumer                            │
                           │ ARTIFACTS — files this agent publishes       │
                           │  ▸ analysis-report        consumers: Dev     │
                           └──────────────────────────────────────────────┘
```

## 3. Routing → Inputs: one list for every wake source

The Inputs panel (today a read-mostly mirror of github-event triggers) becomes the **single editor
for everything that wakes the agent**. One homogeneous row model over heterogeneous sources:

**Row anatomy.** Every input renders as a plain-language sentence + status, regardless of kind:

```
[icon] "Wakes when an issue is labeled `dispatch`"     [enabled ⬤] [✎] [🗑]
       sources: BA-1, BA-2 · lint: ⚠ duplicate listener
```

| Input kind | Backing data (canonical) | Editable via |
|---|---|---|
| GitHub event (incl. label listeners) | manual `triggers[]` entry, `type: github-event` | inline detail editor (today's TriggersPanel form: events, labelFilter, repo, prompt, pre-check, enabled) |
| Schedule / one-shot / webhook | manual `triggers[]` entry (`cron` / `once` / `http`) | same detail editor |
| PR / Issue from another agent | `channels[]` port (`{artifact, from, label, gate}`) | **channel editor** (today's `EditChannelDialog` content, inlined) — *not* the derived trigger |
| Artifact push from upstream | `dataFlow.inputs` / `dependsOn` port | data-flow port editor — *not* the derived trigger |

**Derived rows are links, not editors.** A `channel: true` / `dataFlow: true` trigger never renders
as a raw trigger. It renders as its *source*: "PR from Developer ⟲ derived from connection", and
the edit action opens the **port** editor. This removes the footgun of §1 outright — there is no
longer any UI path that edits a value the reconciler will overwrite. (The generated wake prompt of
a derived trigger stays generated; a per-channel prompt override is a possible later extension,
noted in §8.)

**Add input.** One `[+ Add input]` button opens a chooser with the same plain-language tiles the
canvas `CreateEdgeDialog` uses, so canvas and inspector share one vocabulary:

> *GitHub event* · *Label applied* · *PR / Issue from another agent* · *Schedule* · *Webhook* ·
> *Artifact from another agent*

Choosing "PR/Issue from another agent" or "Artifact…" writes the port (`addChannel` /
`addDependency`/`addArtifact`) — the same ops the canvas drag uses. This closes today's asymmetry
where those inputs are **create-on-canvas, remove-only in the inspector**.

**Lints stay attached.** The `duplicate-listener` lint renders on the affected rows with its
one-click "delete duplicate trigger" fix, as shipped in #828. Tab badge: a warning dot on the
Routing tab when any of its lints fire, so problems are findable without opening the tab.

## 4. Routing → Outcomes: the only output editor

The Outcomes panel stays as shipped (#828): mode toggle (`exactly one` ◇ / `any of`), options with
title / when / actions (`set label`, `open PR`, `open issue`, `no signal`), computed
`consumers: …` line, "no consumer" warning, `Suggest outcomes…`. Three additions complete the
output side:

1. **`emits` disappears from the UI.** The `EmitsEditor` (Connections) is removed. Legacy flat
   `emits` continue to *read* as the degenerate outcome set (`liftOutcomes`) and render as editable
   outcomes; the first save through the Routing tab persists them as `outcomes` and clears `emits`
   (already the backend behaviour). This is #784 phase 6, executed as part of this concept.
2. **The `Opens pull requests` / `Opens issues` checkboxes are removed.** An agent that opens a PR
   expresses it as an outcome action (`open PR`); `github.produces*` remains as a server-side
   projection (`outcomesToGithub`) so the graph, channel dialogs ("recommended" tiles) and
   materialise prompts keep working unchanged.
3. **Artifacts get a home on the output side.** `dataFlow.outputs` (what the agent publishes via
   `aee-artifact`) renders as an **Artifacts** block below Outcomes — name, hint, computed
   consumers, remove; add via the canvas drag or a small "+ Add artifact" inline form. (A later
   unification of artifacts into outcome *actions* — "publish artifact X" — is possible but out of
   scope; the two blocks side by side already answer "what does this agent deliver" in one place.)

## 5. Canvas ↔ inspector contract: the shortcut doctrine

The user-facing rule that keeps redundancy from creeping back:

> **Every fact has exactly one full editor (the inspector). Everything else — canvas drags, edge
> dialogs, suggestion buttons, wizard steps — is a shortcut that writes the same canonical field
> and can be refined later in that one editor.**

Concretely:

- **Canvas drags stay.** Outcome-port drag, ● connect drag, actor drag — they are the fastest way
  to wire and they already write the canonical ports. Nothing changes.
- **Edge dialogs become thin.** Create dialogs keep their current scope (they *are* the shortcut).
  Edit dialogs shrink to the two actions that make sense in-place (edit the one obvious field,
  remove) plus a **"Open in Routing"** link that jumps to the owning row in the inspector —
  extending the pattern #828 already established for outcome edges (`setRoutingFocus`) to *all*
  edge types. Long-term, per-type edit dialogs can be dropped entirely in favour of that jump.
- **`Suggest outcomes…` and prompt generation stay** — suggestions are shortcuts by definition
  (LLM-suggested, human-confirmed, nothing persisted without save).
- **Two different editors for the same field in two different models** (the emits chips vs. outcome
  actions situation) are the one thing the doctrine forbids. That is why §4 removes, rather than
  relocates, the legacy output controls.

## 6. What happens to each existing control

| Today | Fate | Where it goes |
|---|---|---|
| Details tab (name, id, prompt, stage) | **stays** | Details |
| Connections → Parent | **moves** | Details → *Structure* (with stage — both are static placement, not flow) |
| Connections → Emits labels (`EmitsEditor`) | **removed** (#784 phase 6) | superseded by outcome `set label` actions |
| Connections → GitHub outputs checkboxes | **removed** (#784 phase 6) | superseded by outcome `open PR/issue` actions; field kept as projection |
| Connections → "reacts to" channel chips (remove-only) | **upgraded & moves** | Routing → Inputs (full CRUD via channel editor) |
| Connections → depends on / inputs chips (remove-only) | **upgraded & moves** | Routing → Inputs (data-flow rows) |
| Connections → outputs chips (remove-only) | **upgraded & moves** | Routing → Artifacts block |
| **Connections tab** | **retired** | — |
| Triggers tab → manual triggers (cron/once/http/github-event), incl. prompt, pre-check, enable, cron builder | **moves, nothing lost** | Routing → Inputs detail editor (the existing `TriggersPanel` form, reused as the row editor) |
| Triggers tab → derived `channel:`/`dataFlow:` triggers (editable, footgun) | **replaced** | Routing → Inputs derived rows linking to their port editor |
| **Triggers tab** | **retired** after Inputs reaches CRUD parity | a "view raw `triggers.json`" disclosure remains for transparency (workspace-transparency principle: the file stays the browsable truth) |
| Routing → Inputs (read-mostly mirror) | **upgraded** | becomes the canonical input editor (§3) |
| Routing → Outcomes | **stays** | + Artifacts block (§4) |

Capability check: every field reachable today (trigger prompt, pre-check script, labelFilter,
repo scope, channel gate/label, artifact name/hint, parent, stage, emits-equivalent, produce
flags) remains reachable — most of them *more* directly than before. Nothing is dropped, only the
two legacy output controls whose successors already ship.

## 7. Newcomer guidance

The consolidation is what *enables* simple guidance — with two tabs and three questions, the empty
states can teach the model:

- **Details** empty prompt: "Describe what this agent does — or generate a draft from the role
  name." (existing LLM generation as the CTA)
- **Inputs** empty state: "Nothing wakes this agent yet. Add an input here, or drag a connection
  from another agent on the canvas." with the `[+ Add input]` chooser as CTA.
- **Outcomes** empty state: "How does a run of this agent end? Define outcomes so downstream
  agents can react — or let the assistant suggest them from the prompt." (`Suggest outcomes…` as
  CTA)
- Every row is a **plain-language sentence** ("Wakes when…", "Sets label…", "Publishes…") — the
  technical fields (event keys, cron expressions) appear only inside the detail editor.
- The mode toggle gets its one-line explanation inline: *exactly one — the agent picks exactly one
  outcome per run (switch)* / *any of — zero or more may apply*.

Terminology (used consistently in UI copy, docs, and lints): **Input** (wake source), **Outcome**
(how a run ends), **Action** (signal an outcome sets), **Artifact** (published file), **Consumer**
(agent that reacts), **Connection** only as the generic word for a drawn edge — never as a config
surface again.

## 8. Phasing

Deliberately incremental; each phase ships alone and leaves the editor consistent. Epic: #864.

1. **Restructure (pure moves, no behaviour change)** — #865. Parent → Details/Structure. Artifacts
   block + channel/data-flow rows appear in Routing (still remove-only, linking derived triggers to
   ports). Connections tab retired. Edge-dialog "Open in Routing" jump for all edge types.
2. **Inputs CRUD parity** — #866. Reuse the `TriggersPanel` form as the Routing input-row detail
   editor; `[+ Add input]` chooser incl. channel/data-flow creation from the inspector. Derived
   triggers disappear as raw rows. Retire the Triggers tab (keep the raw-`triggers.json`
   disclosure).
3. **Legacy output removal (#784 phase 6)** — #831 (the pre-existing phase-6 ticket; it also
   covers template migration with `when` conditions, adapter/export retirement, and the
   `github-io` prompt-block unification, and depends on #829/#830). Remove `EmitsEditor` +
   produce checkboxes; migrate templates/drafts still carrying flat `emits`.
4. **Optional later** — #868: per-channel wake-prompt override on derived inputs; artifacts as
   outcome actions; dropping the per-type edge edit dialogs in favour of the Routing jump.

Open (product) questions, non-blocking, defaults chosen above: (a) whether the Triggers tab
survives as a read-only "advanced/raw" view instead of a disclosure — default: disclosure only;
(b) whether stage stays on Details or joins a small "Placement" popover on the canvas — default:
Details.
