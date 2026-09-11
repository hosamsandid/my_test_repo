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
   **Since #2006 that fold is route-scoped** (`foldTopicsForContext` in `help-registry.js`): the
   request's context resolves to *one* topic through the very same `resolveHelpContext` the panel
   uses — overlay → step → route → canonical route, alias-aware — and the prompt carries that
   topic plus the topics its `seeAlso` links point at, not all of them. The narrowing is stated
   in the prompt so the assistant says "open that page and ask again" instead of inventing an
   answer about a page whose topic it was not given. See §9 for why and what it costs.

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
- **The panel never opens on its own.** It appears only when someone asks for it: the header
  **Help** button, a page's or panel's "?" (`PageHelpButton`), the Help entry in the Agent Chat
  row menu, or a "Take the tour" CTA. Not on navigation, not on a first visit, not on first
  login. C2 originally shipped a **first-run auto-open** nudge here — once per topic-bearing
  route per user, tracked in `localStorage help.seenRoutes.<username>` — but Phase 3/4 gave
  nearly every route its own topic, which turned a one-off discovery nudge into an unrequested
  panel on almost every page; it was removed in **#2069**. (Resolved decision 3 — see §9.)

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
  **Home/Overview** affordance inside the face; ~~**first-run auto-open** (once per route,
  `localStorage`-tracked)~~ — shipped, then removed by #2069 (see §4 and resolved decision 3).

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
3. **First-run** — ~~the panel **auto-opens once per route** on first visit (dismissible,
   `localStorage`-tracked); routes with no topic do not auto-open (C2).~~
   **Superseded by #2069: the panel never opens without an explicit user action.** The decision
   was sound for the shape the system had when C2 shipped — a handful of topic-bearing routes, so
   "once per route" was a handful of nudges in total. Phase 3/4 (#1875–#1892, #1981, #1996) then
   gave nearly every route a topic, and the same rule became a panel on almost every page a user
   opened. The mechanism, its `help.seenRoutes.<username>` key and the panel-registration counter
   that kept the nudge off the first-run wizard are all removed; existing keys are left inert
   (nothing reads or writes them). The reversal is recorded rather than erased, because *why* it
   once auto-opened is the part worth keeping: the general lesson is that a "once per surface"
   nudge is bounded by the eventual number of surfaces, not by the frequency per surface.
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

The epic's children widen their own E-ticket the same way, and record it here rather than
leaving the next reader to read the growth as scope creep. So far: **E4 → #1990** (Skills:
six chapters, "?" on every action surface) and **E12 → #1995** (GitHub Event Log: E12 lifted
only the intro and the two tab leads, so the *columns* of the Processed-events table, the
`source` the UI never renders, the polled-vs-never-polled rule and the queue's no-expiry
promise were undocumented anywhere; the topic is now four chapters — what the log is ·
Processed events · Outcomes · Pending queue — with a "?" on the table toolbar, the outcome
legend and the Pending-queue tab), and **E11 → #1994** (Token Usage: a per-surface reference
with chapter deep-links, where E11 had lifted only the intro banner, `COST_NOTE` and the
`TIER_SIGNAL_HELP` attribution-tier explainer), and **E10 → #1993** (Credentials: a
per-surface reference with a "?" on each of the three pages the one topic serves —
`/ssh-keys`, `/github-tokens` and `/my-credentials`), and **E3 → #1985** (Knowledge: a
per-surface reference with a deep-linked "?" on each surface, written deliberately leaner
than its siblings — ~4.7k rather than ~12k — because the grounding budget was nearly spent),
and **E14 → #1992** (Create & Quickstart: E14 lifted the launcher's tile prose and both
"what happens here" branches into one flat topic, which left the *surfaces* of two pages
reaching it from the top; the topic is now four chapters — the entry paths · a single agent
is a team of one · the repository fast lane · what you need before you start — with a "?" on
the launcher header, the one-assistant header, the prerequisite checklist and the
team-of-one note; #2045 removed that last surface with the footer note it hung off, leaving
three affordances and one chapter reachable only by scrolling — which is the documented
fallback, not a gap),
and **E9 → #1989** (MCP Servers: E9 lifted the intro box and the *required* `InfoTip`, which
left the two **create forms** — the page's only real decision surfaces — reaching that
explanation from the top; the topic is now five chapters — the three-part model · the server
registry and its transports · the credential store and `${credential}` substitution ·
environment pairing and the seed-time merge · deleting — with a "?" on the page header, each
create panel and the *required* column marker),
and **E2 → #1984** (Flows: the console's busiest page — a canvas, six side panels, a docked
Copilot rail and a family of edge dialogs — behind one page-level "?"; the topic is now ten
chapters with ten deep-linked affordances, and the seven Flow-editor `SidePanel`s finally
publish a help subject),
and **E8 → #1988** (Model Providers: E8 left the page's two real decision surfaces — the
auth-type choice and the probe buttons — a whole document away from their own subject; the
topic is now six chapters — what a Model Provider is · API key / proxy authentication ·
Anthropic subscription authentication · Test connection and Discover models · Health ·
changing credentials and deleting — with a "?" on the page header, the *Authentication* row,
the OAuth box, the Test/Discover row and the **Health** column header. The auth-type row is
**one** control serving two chapters, so its "?" follows the selection rather than naming a
fixed chapter — the first child where a surface is not one-to-one with a chapter).

**Rolled out to every page (epic #1981).** #1972 was liked enough to become the pattern for
the rest of the console: epic #1981 replicates it page by page (13 children, Tier 1 = the
densest pages first), each ticket adding only prose, a `<page>-help-sections.js` slug
registry, the `section=` props and the two guards — the deep-link mechanism above is already
generic, so there is no shared plumbing left to build. Two things every child inherits:

1. **The extraction table is not a ceiling** (the paragraph above) — a child widening its
   page's E-ticket scope records that in this section rather than reading as a regression.
2. **A "?" over a modal surface needs an overlay subject.** `panelZIndex` lifts the panel
   above the `Modal` layer *only* while an overlay subject is published (§9.5 / E17), so a
   `PageHelpButton` inside a `SidePanel` (z-index 60/61) or a bespoke dialog opens the panel
   **behind** the very surface it explains unless that surface calls `useHelpSubject()`. The
   Skills child (#1990) registers `modal:skill-detail` + `modal:skills-merge` for exactly
   this — neither claims a topic, so resolution still falls through to `/skills` and the
   registration buys only the z-index lift. Two latent instances of the same bug have since
   been found and fixed by the child that touched the page rather than by a sweep: `/flows`'
   `EdgeDialogs` "?" (added by E2) by #1984, which registered all seven Flow-editor panels,
   and the OAuth box's "?" on `/models` (added by E8, behind the form since it shipped) by
   #1988. The lesson for a remaining child is that an *existing* "?" inside an overlay is as
   suspect as one it adds — check the surfaces the E-ticket already left behind, not only the
   new ones.

**A multi-route topic is the strongest case for chapters, not an exception to them.** The
Credentials child (#1993) is the first where one topic file is claimed by *three* routes
(`/ssh-keys`, `/github-tokens`, `/my-credentials`, since E10 #1884). Before chapters, every
one of those pages' "?" opened the same shared explanation at the top — so two of the three
pages always started their reader a third of a document away from their own subject. The
pattern applies unchanged (one `credentials-help-sections.js`, one `section=` per page
header, the two guards); what is new is that the per-page chapters and the *cross-page*
chapters live in one file, which settles the "does every chapter need its own affordance?"
question for the rest of the epic: **no.** The panel renders the whole topic and merely
scrolls to the requested heading, so a chapter with no "?" is one scroll from wherever a deep
link lands — never unreachable. A child should therefore give a "?" to a **surface**, and let
the shared concept chapters be found by reading on. Two things a multi-route child must check
that a single-route one need not: whether an **alias** in `CONTEXT_KEYS` renders the topic
somewhere else (the SetupWizard's two credential steps alias `/ssh-keys` and `/github-tokens`
and render the *whole body* inline via `SetupStepHelp`, so expanding the topic lengthens that
collapsible too), and whether a page's "?" sits inside a permission branch (My Credentials'
must stay outside its `canOwn` branch — the single-admin who cannot own personal credentials
is exactly the reader who needs the chapter explaining why).

**Grounding-budget consequence — settled by #2006, not by a fourth raise.** The paragraph below
is kept as the history that made the case; what it predicted has now happened. `corpus.js` folds
only the **current context's** topic plus its `seeAlso` neighbours (§3.2), so the ceiling no longer
absorbs the growth of every page's help at once. What the number means changed with it: it is now
"docs corpus + the biggest single page neighbourhood", measured by `measureWorstCaseSystemPrompt()`
over every context a topic claims *and* the no-route fallback, and asserted by `corpus.test.js`.
`SYSTEM_PROMPT_CHAR_LIMIT` is **unchanged at 340,000**; the worst context is **`/quickstart`** —
the `create.md` topic plus its `seeAlso` neighbours — at **315,448 — 92.8% used,
24,552 left** (re-measured on the real post-merge commit — #2170's own "overlaid onto main"
estimate had read 314,890/92.6%/25,110 left, undercounting by 558 chars in a way
`corpus.test.js`'s `< 340,000`-only assertion never catches; the lesson generalizes the
existing "never trust a branch's self-report" rule to overlay estimates too) (#2170 SHRANK this crown, a rare direction for the number to move: removing the
Working Environments page retired the `/environments` help topic outright (349 lines) rather than
folding it whole into a survivor — the still-live half (repositories, credentials, MCP references,
the propagation dialog) moved into the existing `agent-chat.md` (+61 net lines) and the
System-Admin-only Toolchains half moved into a new, small `environment-templates.md` that is
**not** on `/quickstart`'s `seeAlso` chain at all (only System Admins reach it, from
Administration) — down from the previously-stamped 324,900, net of the usual small pre-existing
drift from unstamped intervening merges. #2179 added +408 via a new `team-setup.md` bullet — "Create team" disabled with
the guidance message when the platform has no registered model provider — landing on an
already-stale 324,492 live on `main`: +2,019 over the 322,473 this paragraph previously stamped,
from intervening merges (#2175/#2176's credential-resolution doc growth, #2193's undocumented
system-event rendering) that earned a live-budget check but no restamp at the time, since neither
touched a `/quickstart` `seeAlso` topic the way this one does. #2195 added +93 via `working-environments.md` and the `/environments`/`/mcp`
help topics, correcting the ownership-picker-removal description, still unmerged when the
figure below was stamped — re-measured on this merge rather than trusted, per the #1996 lesson.
#2175/#2187 added +1,260 via `credentials.md`'s acting-sender/SSH-equivalent
section, counted on every context, not just a seeAlso neighbourhood; the prior restamp (321,120)
was verified exact against the immediate pre-#2187 main tip, so this delta is cleanly attributable
to #2187 alone. #2168 added +265 via `team-setup.md`, stating that a Working Environment is now
optional at team creation; several unrelated merges landed against this crown since the last
restamp without one, accounting for the rest of the gap from the 318,602 figure this paragraph
previously carried) (the crown moved BACK off `/chats`, which had held it at 314,511: #2085 dissolved
the Access page, folding `access-users.md` into `users.md` and DROPPING the `/teams` link
`agent-chat.md` carried rather than re-pointing it — the successor surface for what that link
promised is the Share dialog on `/chats` itself, and Administration is System-Admin-only — so
`/chats` lost a whole neighbour topic and fell out of first place) (#2068 made flow drafts private-by-default and shareable, adding an eleventh
`flows.md` chapter *Sharing a draft*; `create.md` names `/flows` among its `seeAlso`, so it
lands on this crown in full: +2,673, re-measured on the merge and not summed on a stale base.
#2067 (per-agent scoped repositories) landed on main while this branch was open and grew the
same crown by +4,631, so the baseline is not #2066's 296,639 but main's post-#2067 crown of
301,270 → 303,943. Two things worth carrying
forward: a feature whose surfaces sit on `/chats` pays this crown twice, once through the
`seeAlso` link and once through whichever `CORPUS_FILES` reference doc has to agree with it; and
when two PRs append to this running figure in parallel, the auto-merge keeps both entries and
leaves one number with two successors — re-chain them in ticket order and re-measure on the
merge, which is why the figure above is one total rather than a per-PR sum. #2066 replaced the manual **Sync all agents** button on the Working Environments
form with an offer the save itself makes, and the figure went UP by 4,689 — the biggest single
move in this chain, from a ticket whose user-visible change was *removing* a control. The topic
had to grow +3,848 to carry the three change classes, the clean-and-pushed safety rule and the
removal warning, because nothing on the form states any of it any more; and
`docs/working-environments.md` grew +1,033, which being in `CORPUS_FILES` lands on EVERY context.
`/quickstart` sees both halves in full, since `create.md` names `/environments` as a neighbour —
so the delta here and on `/environments` itself (257,549 → 262,238) is identical, which is the
signature of a change that is partly in the always-counted docs half.
It stood at 291,950 after #2065, which gave a human chat message a named badge and a
viewer-dependent side, needing a chapter `agent-chat.md` had no equivalent of — who wrote a
message, why the badge and the side deliberately answer different questions, and what the neutral
icon on un-attributable history means: +2,572, landing in full for the same `seeAlso` reason.
It stood at 289,378 after #2057, which made a direct hand-off read as a consumer on the Outcomes and Routing
surfaces, which voided `agent-chat.md`'s `## Outcomes` claim that a label is what wakes the next
agent — the same claim the panel itself was making: +895 for the two-mechanism table, landing in
full because `create.md` names `/chats` as a neighbour. It stood at 288,483 after #2053, which
renamed the design → live-team action from *Materialize* to **Create team…** everywhere a user
reads it, rewriting `create.md` — this context's own topic — its `seeAlso` neighbour `flows.md`,
and the every-context `walkthrough/04-flows.md` + `glossary.md`; that took the crown from
286,374 to 288,483, +2,109 stated as one total measured together since all four grow the same
crown. #2052 had
replaced chapter 2's documented dead end — growing could not convert an
existing assistant — with the **Convert into a team…** action that now can, and documented it
in the row menu's own chapter as well: +1,229 in `create.md`, which IS this context's topic,
and +835 in `agent-chat.md`, which it names as a neighbour, so both land in full; the review
then caught the same dead end still asserted in `walkthrough/01-team-setup.md` and fixing it to
name both grow paths added a further +110, which — being in `CORPUS_FILES` — lands on EVERY
context. It stood at 284,200 after #2051, which gave the Working Environments form an MCP server/credential picker and
rewrote the two topics that documented its absence: +916 in `environments.md`, which `create.md`
names as a neighbour, and +147 in `mcp.md`, which it does not — so this context moved by the
former alone while `/environments` and `/mcp`, which name each other, each moved by both, to
255,315 and 255,298. It stood at 283,284 after #2045 removed the one-assistant form's team-of-one footer and its repo-URL help
text and the figure went UP by 593: a page-copy removal is not a grounding saving, because the
facts the copy carried still have to be answerable — +249 in `create.md`, which IS this context's
topic, and +348 in `walkthrough/01-team-setup.md`, which lands on every context. It stood at
282,691 after #2031 added the direct-hand-off chapter to `flows.md`, +2,067 measured on its own
branch and re-measured on the merge with #2035 in — `create.md` names `/flows` in its
`seeAlso`, so a Flows-topic edit lands on this figure), where the all-topics fold route-scoping
replaced stood at 322,243 (94.8%). #1930
moved the crown here by removing the Agents page: `/flows` lost its `/agents` `seeAlso` neighbour
and fell to 258,761, the no-route Overview fold dropped too, and `create.md` (which claims
`/create` and `/quickstart`) links to `/chats`, whose topic absorbed the deleted `agents.md` — so
the biggest single neighbourhood is the one `/quickstart` sees. It had held the no-route fallback
at 262,568 since the #1996 child, and stood at 279,693 before #2034 narrowed the launcher's
preview to the flow cards (+250 in `create.md`, which IS this context's topic, and +395 in the two
vendored docs, which land on every context) and 280,338 before #2035 pinned the Agent Chat nav
entry (+286, all of it in `admin-console.md`, so it lands on every context equally and changes no
context's rank). Re-measure rather than trust this line:
`node -e "console.log(require('./helper-chat/corpus').measureWorstCaseSystemPrompt())"` from
`admin-console/api`. (#1992 is consequence 2 below in the flesh: it widened the *Create* topic,
which `/flows`' `seeAlso` names, so the worst case moved by exactly that topic's growth even
though the ticket touched neither `/flows` nor the docs corpus.)

Measured again on the MCP Servers child (#1989), which grew its topic from 6 946 to 9 327 chars:
the worst context is **still `/flows` at 229,272**, unmoved, because nothing in that
neighbourhood links to `/mcp`; `/mcp`'s own context sits at **207,122 — 60.9% used**. That is the
first child measured after #2006 landed, and it is what consequence 2 below looks like in
practice: the growth is paid for by the expanded page's own neighbourhood, not by every page at
once.

The small-page collection child (#1996) is the first one to move the crown to a **different
context**. It deepened six topics and moved `/flows` by **nothing** — none of the six is in that
neighbourhood — but `access-users.md` (`/teams`) *is* named by the Overview topic's `seeAlso`, and
on main the no-route fallback stood at 259,283 against `/flows`' 259,301: **18 characters apart**.
Expanding Access by ~3.3k in that fold was therefore enough to overtake it, 259,301 → **262,568**.
The lesson is not about Access: once two contexts converge, the worst case stops being a property
of the busiest page, and a child that only ever checks `/flows` will report "unmoved" while having
moved it. Sweep with `measureWorstCaseSystemPrompt()` and read the `context` it returns, not just
the length.

The Model Providers child (#1988) grew its topic from 5 426 to 11 512 chars and moved `/flows`
by **nothing**, for the same reason — but its docs-sync commit moved it by 688, because two of
the docs it corrected (`model-providers.md`, `working-environments.md`) are `CORPUS_FILES` and
that half still counts in full on *every* context. Worth knowing while reading the three
consequences below: they are about the *topic* half. A one-paragraph correction to a corpus doc
is charged to every page at once, which is the asymmetry that makes the corpus the next
structural step if this ever gets tight again.

Three consequences a remaining #1981 child should know:

1. **A new page's topic costs the worst case nothing** — it adds a *candidate* context of its own
   size, and only enlarges an existing one if some topic links to it.
2. **Expanding an existing topic still costs**, but against the largest single neighbourhood
   rather than the sum of thirteen: it grows the contexts of its own page and of the pages whose
   `seeAlso` names it. `help-registry.test.js` asserts exactly that, so the limit is documented as
   a test rather than as a promise.
3. **The no-route fallback is the Overview topic plus its neighbours**, deliberately *not* every
   topic — an all-topics fallback would leave the worst case exactly where it was and make every
   new topic move it by its full size again. It is also what the panel does when no route
   resolves, so the two consumers narrow identically.

The docs `CORPUS_FILES` half is untouched and still counts in full on every request (~162,800
chars); if this ever gets tight again, route-scoping *that* is the next structural step — not a
fourth raise, and never trimming a topic.

**The original case (kept for the record).** Each child grows `corpus.js`'s folded topic set: #1990's
Skills topic alone fit under the old 300k ceiling (~297.9k), but #1956's unrelated
`docs/admin-console.md` additions landing on main in the same window took the assembled prompt
to ~301.7k, so #1990 raised `SYSTEM_PROMPT_CHAR_LIMIT` to **340,000** as a deliberate stop-gap
sized for roughly the next handful of children. The remaining children cannot all be absorbed
by raising the number again — **route-scoped folding** (fold the current route's topic plus its
`seeAlso` neighbours, not all of them) is the structural fix this epic finally makes urgent, and
it is still a separable ticket because it changes what the assistant can answer about *other*
pages. **That ticket is now open: #2006** — filed by the Knowledge child (#1985), which is the
one topic the previous measurement said would still fit. **Running total, measured on each merge
so the next child need not:** with the Skills (#1990), GitHub Event Log (#1995), Token Usage
(#1994) and credentials (#1993) children in, the assembled prompt was **322 243 of 340 000 —
94.8% used, 17 757 left**; the Knowledge child (#1985) adds ~4 700 (a deliberately restrained
expansion: it grew the topic from 5 914 to 10 637 chars rather than the ~12k the last two
children ran to) and takes it to **326 901 — 96.1% used, 13 099 left**. That is *no longer one
topic of typical size*, with eight children still open (#1984 Flows, #1985's tier-1 siblings
#1986 Plugins, #1987 Working Environments, #1988 Model Providers, #1989 MCP Servers, #1991 Agent
Team Wizard, #1992 Create & Quickstart, #1996 the small pages). **#2006 is now a blocker in
practice, not a recommendation:** the next child should land it first rather than raise the limit
a fourth time or trim its own topic to fit.

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
