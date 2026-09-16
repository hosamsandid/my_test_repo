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

> **Superseded by #2027** — the flat, equally-ranked list above became an
> explicit ranking, simplest → most advanced, in three tiers: the fast lane as a
> full-width hero, the three flow paths in one named group, and the direct form
> (#1956) behind a collapsed *Advanced options* disclosure. See
> "Superseded after the fact — #2027" in §8.

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
The framing so the user never chooses single-vs-team; the flow right-sizes the output. This is a **UX framing over the existing separate endpoints — not a backend merge** (D5). Concretely: the fast lane drops the "Single Agent" mode heading and the wrong-mode nudges, and frames a team as this scaled up rather than an either/or the user picks up front. #1667 carried that with a *growth* link on the form itself ("Grow into a full team →"); **#2045 removed it** — the promise is now made where the choice is made (the launcher hero's "grow it into a team whenever you're ready", #2027) and the consequence lives in the `create` help topic, so the form is left with one call to action. The framing is unchanged; only the surface carrying it moved.

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
3. The launcher presents a **small set of equally-ranked entries** (describe / template / build-yourself / fast-lane); a user can start **without** knowing the words *agent / team / flow / template / orchestrator*, and no single entry is forced as the default. *(Scoped to those four intent entries by #1956, and the equal-ranking half superseded by #2027's three-tier ranking — see §8.)*
4. Whether a single agent or a team is produced is decided by the described need / chosen template, **not** by a mandatory up-front toggle.
5. There is exactly **one** action that turns a design into running agents (no separate Wizard-submit vs Materialize divergence for the same outcome).
6. The launcher is reachable **both** from a persistent global "+ Create" control **and** from a dedicated route/page (both open the same launcher).
7. The Agents page presents creation as an advanced/manual affordance, not as a primary entry point equal to the launcher; the orchestrator role remains an Agents-page-only option. *(That last clause was re-opened by #1956 — see "Widened after the fact" in §8.)*
8. The structured 5-step Team Wizard and the manual/import paths remain available as the advanced/edit layer (nothing removed, only re-layered) — power users keep their paths.
9. The concept is decomposed into per-phase implementation issues (A–F), each with its own verifiable acceptance criteria, before build starts.

---

## 7 — Phasing and delivery

Each phase became its own implementation issue, decomposed **after** this concept was accepted (as was done for #1558 → #1567–#1571). All phases have shipped:

| Phase | Issue | What shipped | Key files |
|---|---|---|---|
| **A** — merge the two single-agent paths | #1664 *(shipped)* | Removed the repo-vs-LLM mode toggle from QuickStart; one form (Name + Model Provider + optional Repo URL); repo URL is the only fork | `admin-console/src/pages/QuickStart.jsx`, pure `quickstart-view.js` (+ test) |
| **B/C** — the unified launcher | #1665 *(shipped)* | Four equal entries, no forced default; global "+ Create" control + `/create` route; removed the Single Agent / Agent Team Wizard sidebar entries | `admin-console/src/pages/Create.jsx`, pure `create-launcher-view.js` (+ test), `components/Shell.jsx`, `Briefings.jsx` (`?new=describe|blank`) |
| **D** — "team of one" framing | #1667 *(shipped)* | UX/copy only: dropped the mode heading + wrong-mode nudges; "Grow into a full team →" (**removed again by #2045** — the framing moved to the launcher hero + the `create` topic, leaving the form one call to action); launcher fast-lane copy | `QuickStart.jsx`, pure `quickstart-view.js` (`QUICKSTART_COPY`), `create-launcher-view.js`, `Shell.jsx` breadcrumb |
| **E** — one shared "Launch" step | #1668 *(shipped)* | Wizard submit + Materialize render one shared component over one pure core (body/validation/NDJSON stream); repo-less environments selectable in the wizard env step | `admin-console/src/pages/process/LaunchStep.jsx`, pure `launch-team.js` (+ test), `MaterializeDialog.jsx`, `TeamSetup.jsx` |
| **F** — Agents page as manage-first | #1669 *(shipped)* | Manage subtitle; "+ New Agent" demoted to a secondary button; empty-state / role-table CTAs route through `/create` | `admin-console/src/pages/Agents.jsx`, pure `agents-view.js` (`AGENTS_PAGE_COPY`, + test) |

Delivered on the `integration/epic-1661` branch and merged to `main`. Every phase followed the repo's `#651` convention — the load-bearing decisions live in a pure, `node --test`-covered `*-view.js` / `*.js` module (`quickstart-view.js`, `create-launcher-view.js`, `launch-team.js`, `agents-view.js`), with the `.jsx` page a thin renderer over it — and each synced `docs/admin-console.md`'s navigation description as its surface changed.

---

## 8 — Resolved decisions

Captured from stakeholder review — these were the concept's open questions, now settled:

- **D1 — Entry prominence.** The conversational entry is **one of several equally-ranked tiles**, not a forced default. The launcher is a peer-choice grid (describe / template / build-yourself / fast-lane). *(Superseded by #2027 — see below.)*
- **D2 — Structured Team Wizard.** **Keep** the existing 5-step wizard as the "Advanced" layer behind the launcher; it is not retired in this concept.
- **D3 — Orchestrator role.** Stays on the **Agents page** (advanced/manual "+ New Agent"); the launcher does not offer it. *(Re-opened by #1956 — see below.)*
- **D4 — Launcher invocation.** **Both** — a persistent global "+ Create" control **and** a dedicated page/route open the same launcher, so real usage of each can be observed before committing to one.
- **D5 — "Team of one" depth.** **UX framing only** for this concept. Any technical unification of the single-agent (`/api/agents`) and team (`/api/teams`) paths is deferred to a **separate future technical ticket**, out of scope here. *(That ticket landed as epic #2229 — see below.)*

### Widened after the fact — #1956 (epic #1925)

These decisions record what was settled *then*; they are not a ceiling on the topic. Two of them were deliberately re-opened by **#1956**, which moved Agent Chat's create/import actions into the page-action header and therefore had to give the **direct create form** a home that survives the Agents page's retirement. Noted here so a later reader does not read that change as a regression against this concept:

- **AC7 / D3 — the orchestrator role is no longer an Agents-page-only option.** The launcher gained a fifth entry, *Create a single agent*, which hosts the Agents page's own create form (moved unchanged to `admin-console/src/pages/agent-lifecycle/AgentCreateForm.jsx` and rendered by **both** surfaces, so they cannot drift). Its role picker includes `orchestrator`, so the launcher does now offer it. D3's *reasoning* survives in the shape of the change rather than in its letter: the fifth entry sits apart from the four peer tiles instead of joining them, so the guided path a newcomer walks is unchanged.
- **AC3 / D1 — the jargon-free-title rule now scopes to the four intent tiles.** *Create a single agent* names the artifact on purpose: it is the "I already know exactly what I want" path, and a vaguer title would be indistinguishable from the fast lane directly above it. The four peer tiles keep both properties — no internal vocabulary, no forced default.

### Superseded after the fact — #2027

**D1 is superseded, deliberately.** The five entries are no longer a peer-choice grid; they are **explicitly ranked, simplest → most advanced, in three tiers** — a full-width hero (*Chat with one assistant*), one bordered group of three flow paths headed *Or build a team of agents that work together (a flow)*, and a collapsed *Advanced options* disclosure holding the direct form (*Configure an agent manually*, renamed from *Create a single agent*). D1's reasoning above is left intact and legible: no-forced-default was the right call for the sprawl this concept replaced, where the danger was one door being promoted over four that had just been consolidated. What the shipped launcher then taught, and what #2027 answers:

- **Five equal tiles answered "what can I do", not "where do I begin".** Nothing on the page signalled a starting point, so the choice was left entirely to a newcomer who by definition had the least basis for making it.
- **The two single-agent paths read as near-duplicates — with the expert one sounding simplest.** *Create a single agent* sat under the wordiest title on the page (*Just give me one assistant to chat with*) and looked like the plainer of the two, while actually being the specialist form. It is now the disclosure entry, renamed after what it costs you; the fast lane is the hero.
- **The three flow paths were never named as a flow.** Describe / template / build-yourself were three unrelated-looking tiles; the group heading is the first place the product says *a flow is several agents that hand work off to each other*, and states that all three end in the same flow and differ only in how you start.
- **No tile said what screen you would land on.** Each entry now carries a `→ …` outcome line, and the three flow cards additionally reveal a hand-drawn "what you get" schematic of the *kind* of screen they open. #2027 gave one to all five; **#2034 narrowed it to the flow group**, where the destination is genuinely non-obvious — on the hero it was a large drawing of a chat window saying that a chat is a chat, and on the disclosure entry it showed a form to the one reader who already knows what a form is. Both outcome lines stayed; only the schematic and its eye control were removed, and removed rather than hidden, so neither card leaves an orphan focus target behind.

Nothing was rewired: every entry still hands off to exactly the route it did before, so this is a re-sort, a re-label and a preview. AC1/AC4/AC5/AC6/AC8 are untouched. AC3's jargon-free-title intent survives in a sharper form rather than by the letter: the titles a newcomer meets no longer require vocabulary they do not have, and where one does use a word like *team* or *flow* the group heading defines it on the spot — the disclosure entry keeps the #1956 exemption above and names the artifact on purpose. The `hasForcedDefault()` helper that asserted D1 in `create-launcher-view.js` was **deleted** rather than left asserting a rule the product no longer follows.

### D5 fulfilled — epic #2229 ("every agent is a team of one from creation")

D5 deferred the technical unification of the single-agent and team data-model paths as out of scope. Epic #2229 is that ticket: Phase A (#2230) generalised `team-conversion.js`'s target-shape logic into a shared core (`buildTeamOfOnePlan`) driven by a normalized input rather than a live config, and Phase B (#2231) wired it into all three single-agent creation lanes (`POST /api/quickstart`, `/api/quickstart/llm`, `/api/agents` with `role: 'agent'` and no `teamId`) — none of them can produce a standalone `role: 'agent'` any more; each now mints a `role: 'team'` record plus one `team-member` in the same request. D5's own framing ("UX framing only... not a backend merge") is superseded by this: it is now a real backend unification, not just copy. See `orchestrator/team-conversion.js`'s Key Files entry in `CLAUDE.md` for the mechanism.

**Epic #2229 completed — Phase C (#2232).** The cleanup half: a one-time, operator-invoked sweep (`orchestrator/team-of-one-migration.js`) brought every agent created *before* Phase B up to the same team-of-one shape, and the manual `POST /api/agents/:id/convert-to-team` bridge (#2052) was retired outright — both routes, the row-menu entry and its dialog are gone. Growing a single assistant is now the same **Add member** action any team uses, documented in `help-topics/create.md`. One known gap is flagged rather than closed: **Clone** and **Import** still build their config directly and can still land a standalone `role: 'agent'` after the sweep has run once; the migration sweep is idempotent and safe to re-run, which is the recommended recovery rather than a new per-agent UI action.

### AC7 / D3 superseded — #2233 (Phase D of #2229)

The AC7 paragraph above ("its role picker includes `orchestrator`") had already gone stale once #1964 (BP removal) dropped the `orchestrator` card from `AgentCreateForm.jsx`, leaving only `agent`/`team` selectable — that drift predates this ticket. #2233 removes what was left of the choice outright, per D2 of #2229: after Phase B there is no real distinction between "a lone agent" and "a team" (both mint a team, differing only in member count), so the `agent`/`team` role picker and its backing catalogue (`agent-lifecycle/agent-form-fields.jsx`, `ROLE_INFO`/`RoleHelpTip`) are deleted rather than left offering a choice with no answer. **Configure an agent manually** now asks for an id, a Working Environment, skills and a system prompt — nothing else — and always creates a plain agent (itself a team of one, #2231). This is the last word on D3: no role is picked on this form any more, `orchestrator` included.

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
