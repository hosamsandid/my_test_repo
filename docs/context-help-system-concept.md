# Context-Sensitive Help System — Concept Document

> Status: concept for review
> Author: 2026-09-01
> Extends / partially supersedes: `docs/helper-chat-concept.md` (#1723)
> Epic: (to be filed)

---

## 1. Problem

Agent Studio's help is spread across ~95–110 disconnected surfaces and reads as passive
reference, not guidance:

- **Every peer admin page opens with a large "what this page is" box.** This is an explicit,
  documented convention — see the comment in `admin-console/src/pages/token-usage-view.js:214–222`
  ("Every peer admin page (MCP Servers, GitHub Tokens, SSH Keys, Model Providers, Working
  Environments, Skills) opens with a 'what this page is' banner"). These boxes push the actual
  UI below the fold and are ignored after the first read.
- **Concept-heavy features carry huge inline explainers** — the Knowledge "How it works" panel,
  the Agents role catalogue, the Flows "Welcome to Flows" banner, the repeated "why both an SSH
  key and a GitHub token" defense-in-depth prose duplicated across four credential surfaces.
- **Dedicated concept pages sit off to the side** — `/getting-started` (nav bottom-left) and
  `/plugin-system` (reachable only via a "Learn about plugins" link), plus scattered
  "Learn more →" jump-offs.
- Meanwhile the app **already ships a good app-wide help affordance** — the Helper Chat panel
  (#1735) with a `[Chat] [Tour]` tab bar, opened from the header Help button — but it is
  page-*unaware* beyond a single route-label string, and none of the scattered box content
  feeds it.

Net effect: users are shown a lot of text but get no single, coherent, context-aware place to
turn to. The result is overwhelm and drop-off — the exact problem `helper-chat-concept.md`
set out to solve, only half-finished: the *panel* exists, the *content* is still scattered on
the pages.

`helper-chat-concept.md` §5 deliberately left `/getting-started` and the on-page boxes in
place. This concept reverses that decision: the on-page boxes and Getting Started **move into
the panel**, and the panel becomes **page-aware by default**.

---

## 2. Solution overview — one panel, three faces, page-aware by default

The existing Helper Chat panel gains a **third face** and becomes the single home for all
help. Clicking the header **Help** button opens the panel on the face for the **current page**.

| Face | Tab label | What it is | Status |
|---|---|---|---|
| **This page** | `This page` | Curated help for the current route: what it is · key concepts · "how do I…" · related links · page-scoped questions that jump to *Ask*. **Default face when Help opens.** | **new** |
| **Ask** | `Ask` | The existing AI chat (`POST /api/helper/chat`), now additionally grounded on the **current page's help topic** so its answers are genuinely page-specific. | extended (was "Chat") |
| **Tour** | `Tour` | The existing guided screenshot tour. Unchanged. | unchanged |

**Overview (home)** is not a fourth tab: it is the **fallback content of the "This page" face**
for routes that have no dedicated topic (and the natural landing when there is nothing more
specific). It is where the former Getting Started content lives.

### 2.1 Product decisions (resolved)

1. **On-page decluttering (Q1 → "slim line + ? affordance").** When a page's big help box moves
   into the panel, the page keeps its **title + a single one-line description** and gains a small
   inline **"?" affordance** that opens the panel directly on this page's help. The large box is
   removed. (The header Help button also lands on this page's help — the "?" is the discoverable,
   in-context second entry point.)
2. **Content nature (Q2 → "curated static + smart Ask").** The "This page" face renders
   **author-curated static** help (fast, correct, cheap, no hallucination on a help surface).
   The **intelligence is Ask**: because Ask is now grounded on the page's topic, it is the smart
   escalation ("explain this for my case", "why is my agent not waking?"). No per-open LLM
   generation of the static face.

---

## 3. Content model

Help content is authored as small markdown **topics**, one per page/feature area.

### 3.1 Topic format

`admin-console/api/helper-chat/help-topics/<id>.md`, with a small metadata header:

```markdown
---
id: agents
routes: ["/agents"]
title: Agents
summary: One line shown under the page title and at the top of the panel.
seeAlso:
  - { label: "Working Environments", to: "/environments" }
  - { label: "Access", to: "/teams" }
askPrompts:
  - "What is the difference between an Agent, an Agent Team and an Orchestrator?"
  - "When should I disable vs reset-to-stub vs delete an agent?"
---

## What is an agent?
…curated markdown body (the content lifted out of the on-page box)…
```

- `routes` — one or more route paths the topic answers for. Dynamic routes (`/chats/:id`,
  `/plugins/:id/view`) resolve the same way `breadcrumbs.js` already resolves them.
- `askPrompts` — page-scoped suggested questions; clicking one switches to **Ask** with the
  question pre-seeded.
- `seeAlso` — the "Learn more →" jump-offs, now uniform.

### 3.2 Single source, two consumers

The `help-topics/` directory is the **single source**. It is read by:

1. **The client**, via a new `GET /api/helper/page-help` endpoint that returns the whole topic
   set once (a few KB; cached). The client resolves the current route → topic locally, so face
   switching is instant/offline.
2. **The chat grounding**, via `corpus.js` — the concatenated topic bodies are folded into the
   system prompt at the existing `[corpus is appended here at runtime]` marker
   (`admin-console/api/helper-chat/corpus.js:44–58`), and the handler's existing
   `currentRoute`/`currentRouteLabel` is used to point the model at the current page's topic.

Because both consumers read the *same* files, there is **no vendoring and no parity test** to
maintain (unlike the repo-root `docs/**` copies in the corpus, which stay as they are). The
files ship alongside the existing `helper-chat/docs/**`, `system-prompt.md` and
`tour-manifest.json` assets already present at runtime.

### 3.3 Pure modules (the #651 discipline)

- `admin-console/api/helper-chat/help-registry.js` — parse topics, build the `route → topic`
  index, `topicForRoute(pathname)` (dynamic-route aware), corpus-fold helper. Pure,
  `node --test`-covered.
- `admin-console/src/context/page-help-view.js` — client-side pure decisions: route→topic
  resolution, Overview fallback, `askPrompt` → Ask hand-off shaping. Unit-tested
  (`admin-console-src` CI job). The JSX face renderer stays uncovered per convention.

---

## 4. Panel UX

- The panel, tab bar, mount point and streaming chat are **unchanged infrastructure**
  (`HelperChatPanel.jsx`, `HelperChatContext.jsx`, `helper-chat-model.js`, `tour-view.js`).
- **New `mode` value** `'page'` alongside the existing `'chat'`/`'tour'`
  (`HelperChatContext.jsx:50`, default `'chat'` today). The header Help button
  (`Shell.jsx:611`, `toggleHelp`) opens the panel with `mode: 'page'` resolved for the current
  route.
- New context method **`openHelpFor(route?)`** (sibling of the existing `openTour()`,
  `HelperChatContext.jsx:65–68`) → `setMode('page')` + open, optionally for an explicit route.
  Exposed on `useHelperChat()`.
- Tab bar (`HelperChatPanel.jsx:127–165`) gains a `This page` tab (first) and renames `Chat` →
  `Ask`; `Tour` unchanged.
- **`PageHelpButton`** — a small shared "?" component pages drop next to their title; calls
  `openHelpFor(currentRoute)`.
- **This page** face renders the topic (sanitised markdown via the existing `SafeMarkdown`),
  its `seeAlso` links, and its `askPrompts` chips. No topic for the route → render **Overview**.
- **Overview** face renders the former Getting Started content (the six concept cards + "where
  to go next" + a "Take the tour" CTA calling the existing `openTour()`).
- **Overview / Home affordance.** The "This page" face carries an explicit **Home** control
  (e.g. a small "← Overview" link in the face header) that returns to the Overview from any page,
  so a user who lands on a specific page can still reach the big-picture concept overview without
  hunting. (Resolved decision — see §9.)
- **First-run auto-open.** The **first** time a user visits a given route in a session, the panel
  auto-opens on that route's "This page" face **once** (dismissible; never re-opens for the same
  route). "Seen" routes are tracked in `localStorage` (a per-user set, e.g.
  `help.seenRoutes.<username>`), so the nudge fires once per page and never fights a user who has
  closed it. Routes with no topic (Overview fallback only) do not auto-open. (Resolved decision —
  see §9.)

---

## 5. Getting Started — removed and folded in

- Delete the `/getting-started` route (`App.jsx:176`), its lazy import (`App.jsx:75`), and the
  **"Help" nav group** (`Shell.jsx:160–162`) — with Getting Started gone the group is empty and
  renders nothing (per the #1595 IA: an empty group shows no header).
- The six concept cards + "where to go next" CTAs (`GettingStarted.jsx:22–74`) become the
  **Overview** face content.
- Repoint every entry point to `useHelperChat()`:
  - the "Take the Tour" button (`GettingStarted.jsx:99–118`) → already uses `openTour()`; lives
    in Overview now.
  - the Agent Chat empty-state "New here? Read the Getting Started overview →"
    (`AgentChat.jsx:561–566`) → `openHelpFor()` (opens Overview) or `openTour()`.
- Clean the parallel route→label / document-title maps: `BREADCRUMBS`
  (`breadcrumbs.js:6–29`) and `ROUTE_TITLES` (`route-title.js`) drop `/getting-started`.

**As built (G1, #1874):** the *page* is deleted, but the **path** is kept as a redirect
(`GettingStartedRedirect` → opens the Help panel, then `<Navigate to="/chats">`) so an old
bookmark degrades gracefully (epic AC4) instead of resolving to a blank route — the app has no
catch-all. `/getting-started` therefore moves from `PAGE_ROUTES` to `ALLOWLIST` + `REDIRECTS`
(`help-routes.js` / `page-help-view.js`), joining `/blueprints` and `/briefings`. This is
**deliberately not** the treatment `/plugin-system` gets: E5 removes that one outright, per the
resolved decision above. The CTAs are carried by a new topic front-matter field `actions[]`
(`{label, to}` navigations plus `{label, action: "tour"}` → `openTour()`, one optional
`primary: true`), rendered as the CTA row of the "This page" face.

`/plugin-system` (`PluginSystemHelp.jsx`) is folded into the **Plugins** topic as a "deep dive"
section; the route is **removed outright** (no redirect — resolved decision, §9). The "Learn
about plugins" link on the Plugins page (`Plugins.jsx:257–263`) and the `PluginSystemHelp` page
component both go away; the Plugins page's "?" affordance replaces them. `BREADCRUMBS` and
`ROUTE_TITLES` drop `/plugin-system`. See E5.

---

## 6. Per-page extraction pattern

Every Phase-3 ticket follows the same shape:

1. **Author** the page's help topic(s) from its existing big box(es)/concept modal(s)/jump-offs.
2. **Remove** the big box from the page. Keep the page **title + one-line description**; the
   long prose now lives only in the topic.
3. **Add** the shared `PageHelpButton` ("?") next to the title.
4. Concept **modals** (EdgeDialogs, LabelRegistry, HumanRegistry, install/uninstall, credential
   success dialogs) keep a *short* in-context blurb but their long explanatory prose moves to the
   topic; the modal gains a "?" that opens the relevant topic.
5. **Verify** on the route: Help opens on "This page" showing the topic; Ask answers page
   questions from it; `askPrompts` present.

### 6.1 What moves vs. what stays

| Moves into the panel | Stays on the page |
|---|---|
| Large multi-paragraph "what this page is" boxes | The one-line page description (per #1847) |
| Role catalogues / concept tables (Agents roles, autonomy levels) | True field-level microcopy next to an input |
| "How it works" panels, "why both credentials" prose | Teaching **empty states** ("No agents yet…") — these are actionable, not overwhelming |
| Dedicated concept pages (`/getting-started`, `/plugin-system`) | Live/dynamic hints (e.g. token-format live feedback) |
| Long modal explainers + "Learn more →" jump-offs | Sentence-length tooltips — owned by #1850, not this epic |

---

## 7. Coordination with in-flight work

| Work | Relationship |
|---|---|
| **`helper-chat-concept.md` (#1723)** | This concept extends it and **reverses its §5** (which kept Getting Started + on-page boxes). The panel/Chat/Tour infrastructure is reused verbatim. |
| **#1847 — unify page headers** | #1847 keeps each page's *intro copy*. This epic narrows that: the **one-line description** stays (as #1847 intends); only the **large box** moves to Help. Coordinate so the "?" affordance sits with the new bold top-bar title. |
| **#1850 — unify tooltips** | Sentence-length tooltips remain #1850's domain. This epic takes only the large boxes, concept pages and doc jump-offs — never micro-tooltips. |
| **#1595 — sidebar IA** | Removing the "Help" nav group is consistent with the IA (empty group → no header). The header Help button becomes the sole help entry point. |

---

## 8. Phasing & tickets

### Phase 1 — Foundation

- **C1 — Content model, per-route registry, endpoint, chat grounding.** `help-topics/` format;
  `help-registry.js` (pure) + `page-help-view.js` (pure); `GET /api/helper/page-help`; fold
  topics into `corpus.js`; seed **one** pilot topic (Overview) end-to-end. Unit tests.
- **C2 — Panel "This page" face + entry points.** `mode:'page'`; tab bar `[This page][Ask][Tour]`
  (the `Chat` tab is **renamed to `Ask`**); header Help defaults to page face; `openHelpFor(route)`;
  `PageHelpButton`; page-scoped `askPrompts` → Ask hand-off; Overview fallback rendering; the
  **Home/Overview** affordance inside the face; **first-run auto-open** (once per route,
  `localStorage`-tracked).

### Phase 2 — Retire Getting Started

- **G1 — Remove Getting Started; fold into Overview.** Delete route/nav/lazy import; migrate the
  six cards + CTAs into the Overview face; repoint the Agent Chat empty-state link; clean
  `BREADCRUMBS`/`ROUTE_TITLES`.

### Phase 3 — Per-page extraction (one ticket per area)

| # | Area | Source content to lift (from inventory) |
|---|---|---|
| **E1** | Agents | Top intro box + full role catalogue (`ROLE_INFO`/`RoleDetailBanner`) + create-form callouts + skills/system-prompt field help + delete-dialog knowledge note |
| **E2** | Flows | "Welcome to Flows" banner + the existing Flows help panel + EdgeDialogs / LabelRegistry / HumanRegistry / RoutingSection / Copilot / toolbar-hint concept help |
| **E3** | Knowledge | The large "How it works" intro + autonomy/gates config explainer + domain primer + InfoTips |
| **E4** | Skills | 4-paragraph concept intro + "See how the knowledge system works →" jump-off + overwrite/merge dialog prose |
| **E5** | Plugins (+ Plugin System) | Plugins page intro + **fold `/plugin-system` in as a deep-dive**; **remove the route outright** (no redirect) + the `PluginSystemHelp` page + the "Learn about plugins" link; install/uninstall modal explainers |
| **E6** | Working Environments | Top intro box ("a reusable workspace recipe") |
| **E7** | Access | Top intro box incl. the **Team vs Agent Team** distinction; roles (System/Team Admin/Member) |
| **E8** | Model Providers | Top intro + the two auth-type descriptions + OAuth/probe dialog prose |
| **E9** | MCP Servers | Top intro (servers + credentials + env pairing) + the "where does 'required' come from" InfoTip |
| **E10** | Credentials & GitHub access | SSH Keys + GitHub Tokens + My Credentials intros + the duplicated **"why both / defense-in-depth"** prose + SetupWizard credential steps + success-dialog SSO instructions (author once, reuse) |
| **E11** | Token Usage | Intro banner + `COST_NOTE` + `TIER_SIGNAL_HELP` attribution-tier explainer |
| **E12** | GitHub Event Log | Intro (observational log; processed vs pending) |
| **E13** | Maintenance Mode | Intro + the "while active" behaviour box |
| **E14** | Creation & onboarding flows | Create launcher tiles + QuickStart prereq warnings / "what happens here" + Team Setup wizard step intros + `GoLiveNotice` + Role Templates field help |
| **E15** | Agent Chat side-panels | TriggersPanel trigger-type banners + OutcomesPanel empty-state explainer + AgentKnowledgePanel retire-dialog note |

Total: **2 (foundation) + 1 (Getting Started) + 15 (extraction) = 18 child tickets** under one epic.

---

## 9. Resolved decisions

1. **Tab label** — the `Chat` tab is **renamed to `Ask`** (faces: `This page · Ask · Tour`).
2. **`/plugin-system`** — **removed outright** (no redirect). The `PluginSystemHelp` page, its
   route, and the "Learn about plugins" link all go; its content becomes the Plugins topic
   deep-dive (E5).
3. **First-run** — the panel **auto-opens once per route** on first visit (dismissible,
   `localStorage`-tracked); routes with no topic do not auto-open (C2).
4. **Overview reachability** — the "This page" face carries an explicit **Home/Overview**
   affordance to return to the overview from any page (C2/§4).
5. **Chapter deep-linking** (#1972) — `openHelpFor(route, { section })` takes an optional
   chapter slug and the "This page" face scrolls the topic to the matching heading, so a
   page with several distinct surfaces can put a "?" on each one instead of a single
   page-level button. A chapter is addressed by the **slug of its heading text**
   (`sectionSlug` in `page-help-view.js`) rather than an authored anchor: the topics stay
   plain markdown, the shared `SafeMarkdown` pipeline is untouched, and no `{#id}` syntax
   leaks into the rendered prose. The trade-off is that a reworded heading breaks its link
   *silently* (the face just renders from the top), so a topic whose chapters are
   deep-link targets declares them in `help-topics-content.test.js` and its page-side
   guard asserts every slug a call site names is a real heading. That degradation is also
   the wanted behaviour for a surface the current agent does not have — a "?" is never
   empty or broken, it merely opens the chapter's topic at the top.

**Widened after the fact.** E15 deliberately scoped the Agent Chat topic to the three side
panels plus the session model. #1972 reopened it: the page's remaining surfaces (the agent
list, the header, the composer, the right rail) were left undocumented, so the topic became
a full per-surface reference and every surface gained a chapter-linked "?". This is a
product decision, not a regression of E15 — the extraction table above records what each
ticket *lifted*, not a ceiling on what a topic may later cover.

**Deferred (post-v1):** full-text help **search** — Ask already covers free-text; revisit only
if the topic set grows large.

---

## 10. Key files to read before implementing

| File | Why |
|---|---|
| `admin-console/src/components/HelperChatPanel.jsx` | Panel + tab bar (`:127–165`); add the third face |
| `admin-console/src/context/HelperChatContext.jsx` | `useHelperChat()` surface; `mode` (`:50`), `openTour` (`:65–68`) to mirror as `openHelpFor` |
| `admin-console/src/context/helper-chat-model.js` | Pure chat core; `SUGGESTED_PROMPTS` become page-scoped |
| `admin-console/api/helper-chat/corpus.js` | Fold topics at the runtime marker (`:44–58`) |
| `admin-console/api/helper-chat/handler.js` | `currentRoute`/`currentRouteLabel` already received; point grounding at the page topic |
| `admin-console/src/components/breadcrumbs.js` | Route→label map (`:6–29`); dynamic-route resolution pattern for the registry |
| `admin-console/src/components/Shell.jsx` | Help button (`:611`), panel mount (`:663`), "Help" nav group to remove (`:160–162`) |
| `admin-console/src/pages/GettingStarted.jsx` | Content to fold into Overview |
| `admin-console/src/pages/PluginSystemHelp.jsx` | Content to fold into the Plugins topic (E5) |
| `admin-console/src/pages/token-usage-view.js` | The `PAGE_INTRO` convention (`:214–222`) that every extraction ticket unwinds |
