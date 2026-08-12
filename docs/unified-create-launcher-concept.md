# Unify the agent & team creation entry points into one "Create" launcher — Concept

Status: **concept / decision document — shipped (Phases A–F)**. No new implementation code is delivered by this document; it is the plan of record for the entry-point consolidation, decomposed into the per-phase issues #1664–#1669 (all merged, see §7). This document specifies the information architecture completely enough that the phase issues were derived from it (see §6/§7).

Tracking issue: [#1661](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1661).

---

## Table of Contents

1. [Starting point and goal](#1--starting-point-and-goal)
2. [Current state before the change (grounded)](#2--current-state-before-the-change-grounded)
3. [The vision — one launcher, organised by starting material](#3--the-vision--one-launcher-organised-by-starting-material)
4. [The six moves (A–F)](#4--the-six-moves-af)
5. [Scope](#5--scope)
6. [Acceptance criteria (concept-level)](#6--acceptance-criteria-concept-level)
7. [Phasing and delivery](#7--phasing-and-delivery)
8. [Resolved decisions](#8--resolved-decisions)
9. [Edge cases, constraints, dependencies](#9--edge-cases-constraints-dependencies)

Acceptance-criteria map (issue #1661): AC1 → §3/§4B · AC2 → §4A · AC3 → §3/§4B/§4C · AC4 → §4D · AC5 → §4E · AC6 → §4B (D4) · AC7 → §4F · AC8 → §4B/§4F · AC9 → §7.

---

## 1 — Starting point and goal

### The problem

Starting an agent in Agent Studio meant choosing between **five different surfaces and roughly fifteen separate "create" actions** — QuickStart (two paths), the Agent Team Wizard (three Step-1 entries), the Agents page (four create actions), the Flows canvas, and the Materialize dialog. The choices were framed in the system's own vocabulary — *single agent vs. team vs. flow vs. template vs. orchestrator* — so a newcomer had to learn that taxonomy before they could begin, and several of the doors led to the exact same backend outcome.

The creation surface was split along the **wrong axis** (internal artifact type) and heavily duplicated. That raised the learning cost for new users and created maintenance drift, because multiple front doors called the same backend endpoints. The recently-shipped nav regroup (#1595) tidied *where* these entries sit but did not reduce *how many* there are.

### The goal

Replace that sprawl with **one unified "Create" entry** presenting a small set of **equally-ranked, plainly-labelled ways to start** — *describe it in your own words*, *start from a ready-made setup*, or *build it yourself on the canvas* — plus a fast lane for a single chat agent. Crucially, **whether the result is a single agent or a whole team becomes an outcome the system right-sizes**, not a fork the user must pick up front. Fewer doors, less jargon, a much shorter path from "I have an idea" to "an agent is running." The existing structured wizard and manual paths are preserved underneath as the advanced / edit layer — nothing removed, only re-layered.

---

## 2 — Current state before the change (grounded)

Grounded against `origin/main @184364e` at the time the concept was accepted:

| Surface | File / route | Produced | Sub-modes | Endpoint(s) |
|---|---|---|---|---|
| Single Agent | `QuickStart.jsx` `/quickstart` | 1 agent | 2 paths: *from repo* / *LLM-only* | `POST /api/quickstart`, `POST /api/quickstart/llm` |
| Agent Team Wizard | `TeamSetup.jsx` `/team-setup` | team | 3 Step-1 entries: *template* / *describe* / *blank canvas* | `POST /api/teams/stream`, `/api/process/copilot`, `/api/process/drafts` |
| Agents page | `Agents.jsx` `/agents` | agent / member | *+ New Agent* (roles agent/team/orchestrator), *Add Member*, *Add role*, *Save as template*, *Import* | `POST /api/agents`, `POST /api/agents/:teamId/members`, … |
| Flows / Canvas | `Briefings.jsx` + `ProcessCanvas.jsx` `/flows` | flow draft → team | *New process*, *Describe flow*, *Import template*, *Import briefings*, *Materialize* | `POST /api/process/drafts`, `/api/flows/graph`, `/api/teams` |
| Materialize dialog | `MaterializeDialog.jsx` | team | create / extend | `POST /api/teams` |

**Duplication highlights**
- *"Describe the flow"* existed in both the Team Wizard (`StepProcess.jsx`) and Flows (`Briefings.jsx`) — the same `POST /api/process/copilot`.
- Team Wizard *"Start blank in canvas"* merely navigated to `/flows`.
- Team Wizard submit (`POST /api/teams/stream`) and the Materialize dialog (`POST /api/teams`) were two front doors to the same outcome (a running team).
- A single standalone agent is conceptually a "team of one".

---

## 3 — The vision — one launcher, organised by starting material

One **"Create"** launcher, organised by **starting material** rather than by result type. It offers a small set of **equally-ranked** entries — none a forced default (D1):

1. **Describe it** — conversational (Flow Copilot).
2. **From a ready-made setup** — template / pattern.
3. **Build it yourself** — canvas / manual.
4. **Fast lane** — one agent to chat with, right now.

"Single agent vs. team" is determined by the described need / chosen template — an **outcome**, not an up-front question. Titles deliberately avoid the words *agent / team / flow / template / orchestrator* so a newcomer can start without first learning the taxonomy (AC3/AC7).

The launcher is reachable **both** from a persistent global **"+ Create"** control and from its own dedicated route `/create` — both open the same launcher (D4/AC6), so real usage of each door can be observed before committing to one.

---

## 4 — The six moves (A–F)

### A. Merge QuickStart's two paths *(AC2)*
Repo-first vs LLM-only is not a *mode* but a single **optional repo field** on one form (Name + Model Provider + optional Repo URL). The mode toggle disappears; whether a repo URL was entered is the single fork that decides the endpoint (`POST /api/quickstart` vs `/api/quickstart/llm`, both unchanged), the request body, and whether the GitHub-token / SSH-key prerequisites apply. Model Provider stays required in both cases. This simplifies the split just shipped in #1624.

### B. Introduce one "Create" launcher *(AC1, AC6, AC8)*
A single launcher organised by starting material, folding QuickStart + Team-Wizard Step 1 + the Flows "new/describe/import" entries into it. Reachable both from a persistent global "+ Create" control and from a dedicated `/create` route (D4). The four entries are equally-ranked with no forced default (D1). The separate *Single Agent* and *Agent Team Wizard* sidebar entries are removed — those pages stay reachable via `/quickstart` / `/team-setup` and as launcher targets.

### C. Offer the existing Flow Copilot as one equal entry *(AC3)*
The Flow Copilot (`POST /api/process/copilot`) is one of the equal entries — a conversational creator with a live flow-graph preview and a confirm-to-create step. It is one tile among peers, **not** the default. The structured 5-step wizard remains as the advanced / edit layer.

### D. Adopt "a single agent is a team of one" *(AC4)*
The framing so the user never chooses single-vs-team; the flow right-sizes the output. This is a **UX framing over the existing separate endpoints — not a backend merge** (D5). Concretely: the fast lane drops the "Single Agent" mode heading and the wrong-mode nudges, and reframes the forward link as *growth* ("Grow into a full team →") — a team is this scaled up, not an either/or the user picks up front.

### E. Collapse team creation to one shared "Launch" action *(AC5)*
Unify the Team-Wizard submit and the Materialize dialog so "turn a design into running agents" is one consistent step, reachable both from the wizard end and from the canvas. Both front doors render **one shared component** over one pure decision core (body, validation, NDJSON streaming), so they can no longer diverge.

### F. Reframe the Agents page as *manage*, not *create* *(AC7, AC8)*
Keep "+ New Agent" (incl. the orchestrator role), Add Member and Add role as explicit advanced/manual affordances, but stop presenting them as peer entry points: the page leads with a *manage* subtitle, the "+ New Agent" action is demoted from a primary to a secondary button, and the empty-state / "What is an agent?" CTAs route through the `/create` launcher instead of the legacy create pages. No creation capability is removed — the orchestrator role remains an Agents-page-only option (D3).

---

## 5 — Scope

**In:** the creation-entry-point information architecture and the unified launcher (reachable both from a persistent global "+ Create" control and from its own route — D4); merging the two single-agent paths; one shared "Launch" step; reframing the Agents page as manage-first; folding the already-shipped foundations (#1624 / #1623 / #1595) into the new launcher rather than leaving them as separate doors.

**Out (this concept):** the backend business logic of agent/team creation (the endpoints stay as-is); the Flow editor's graph-editing itself; the internal data model of agents vs teams (D is a UX framing only — any technical unification is a separate future ticket, see D5).

---

## 6 — Acceptance criteria (concept-level)

1. A single, discoverable **"Create"** entry point exists; every current creation surface is either reachable from it or explicitly demoted to an advanced/manage context.
2. Starting a single agent no longer requires choosing a "repo vs LLM" mode — repo is one **optional** input on one form.
3. The launcher presents a **small set of equally-ranked entries** (describe / template / build-yourself / fast-lane); a user can start **without** knowing the words *agent / team / flow / template / orchestrator*, and no single entry is forced as the default.
4. Whether a single agent or a team is produced is decided by the described need / chosen template, **not** by a mandatory up-front toggle.
5. There is exactly **one** action that turns a design into running agents (no separate Wizard-submit vs Materialize divergence for the same outcome).
6. The launcher is reachable **both** from a persistent global "+ Create" control **and** from a dedicated route/page (both open the same launcher).
7. The Agents page presents creation as an advanced/manual affordance, not as a primary entry point equal to the launcher; the orchestrator role remains an Agents-page-only option.
8. The structured 5-step Team Wizard and the manual/import paths remain available as the advanced/edit layer (nothing removed, only re-layered) — power users keep their paths.
9. The concept is decomposed into per-phase implementation issues (A–F), each with its own verifiable acceptance criteria, before build starts.

---

## 7 — Phasing and delivery

Each phase became its own implementation issue, decomposed **after** this concept was accepted (as was done for #1558 → #1567–#1571). All phases have shipped:

| Phase | Issue | What shipped | Key files |
|---|---|---|---|
| **A** — merge the two single-agent paths | #1664 *(shipped)* | Removed the repo-vs-LLM mode toggle from QuickStart; one form (Name + Model Provider + optional Repo URL); repo URL is the only fork | `admin-console/src/pages/QuickStart.jsx`, pure `quickstart-view.js` (+ test) |
| **B/C** — the unified launcher | #1665 *(shipped)* | Four equal entries, no forced default; global "+ Create" control + `/create` route; removed the Single Agent / Agent Team Wizard sidebar entries | `admin-console/src/pages/Create.jsx`, pure `create-launcher-view.js` (+ test), `components/Shell.jsx`, `Briefings.jsx` (`?new=describe|blank`) |
| **D** — "team of one" framing | #1667 *(shipped)* | UX/copy only: dropped the mode heading + wrong-mode nudges; "Grow into a full team →"; launcher fast-lane copy | `QuickStart.jsx`, pure `quickstart-view.js` (`QUICKSTART_COPY`), `create-launcher-view.js`, `Shell.jsx` breadcrumb |
| **E** — one shared "Launch" step | #1668 *(shipped)* | Wizard submit + Materialize render one shared component over one pure core (body/validation/NDJSON stream); repo-less environments selectable in the wizard env step | `admin-console/src/pages/process/LaunchStep.jsx`, pure `launch-team.js` (+ test), `MaterializeDialog.jsx`, `TeamSetup.jsx` |
| **F** — Agents page as manage-first | #1669 *(shipped)* | Manage subtitle; "+ New Agent" demoted to a secondary button; empty-state / role-table CTAs route through `/create` | `admin-console/src/pages/Agents.jsx`, pure `agents-view.js` (`AGENTS_PAGE_COPY`, + test) |

Delivered on the `integration/epic-1661` branch and merged to `main`. Every phase followed the repo's `#651` convention — the load-bearing decisions live in a pure, `node --test`-covered `*-view.js` / `*.js` module (`quickstart-view.js`, `create-launcher-view.js`, `launch-team.js`, `agents-view.js`), with the `.jsx` page a thin renderer over it — and each synced `docs/admin-console.md`'s navigation description as its surface changed.

---

## 8 — Resolved decisions

Captured from stakeholder review — these were the concept's open questions, now settled:

- **D1 — Entry prominence.** The conversational entry is **one of several equally-ranked tiles**, not a forced default. The launcher is a peer-choice grid (describe / template / build-yourself / fast-lane).
- **D2 — Structured Team Wizard.** **Keep** the existing 5-step wizard as the "Advanced" layer behind the launcher; it is not retired in this concept.
- **D3 — Orchestrator role.** Stays on the **Agents page** (advanced/manual "+ New Agent"); the launcher does not offer it.
- **D4 — Launcher invocation.** **Both** — a persistent global "+ Create" control **and** a dedicated page/route open the same launcher, so real usage of each can be observed before committing to one.
- **D5 — "Team of one" depth.** **UX framing only** for this concept. Any technical unification of the single-agent (`/api/agents`) and team (`/api/teams`) paths is deferred to a **separate future technical ticket**, out of scope here.

---

## 9 — Edge cases, constraints, dependencies

- **Repo-less must stay first-class** in the launcher (foundation shipped via #1623) — including in the Team-Wizard env selection, which previously blocked repo-less environments (`StepEnvironmentSelect` cards not selectable). Phase E made repo-less environments selectable in the wizard env step + validation.
- **Must build on the new sidebar IA from #1595** — the four creation entries previously lived in the "Agent Setup" group; the launcher *replaces*, not duplicates, those entries (the separate Single Agent / Agent Team Wizard sidebar items were removed in Phase B/C).
- **Import** (agent ZIP, process-template JSON, BriefingPack) remains reachable (from the Agents page and the Flows canvas).
- **Backward compatibility** — existing deep links (`/quickstart`, `/team-setup`, `/flows`) keep working; the pages stay reachable directly and as launcher targets.

### Dependencies & related
- Builds on (all merged): **#1624** (2nd single-agent path), **#1623** (repo-less teams), **#1595** (sidebar IA).
- Adjacent onboarding/entry work: **#1465** (pattern-driven end-user entry point), **#1473** (Patterns catalog "Create team" pre-filled), **#1472** (remove Patterns Catalog current form).
- Prior simplification precedent: **#1190** (removed the Team Wizard "Compose a process" option — closed).
- Potential follow-up (not part of this concept): a separate technical ticket for D5 (unify the single-agent / team data-model paths).
