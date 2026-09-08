# Concept: Journey Specs — one source of truth for E2E tests, documentation, video and PR visual evidence

**Status:** concept / plan of record — v1 (2026-07-17).
**Relates to:** `docs/e2e-testing-concept.md` (#651/#666 — the E2E harness this builds on), #262 (Playwright visual-regression agent), `2026-07-14-Agent-Studio-IBAN-Demo.pptx` (the hand-authored deck this concept makes reproducible).

![Journey spec overview: one YAML source of user journeys fans into a test lane (generated E2E tests → Playwright run → timing-marked screenshots) and a narration lane (per-step narrative texts → text-to-speech → audio stream), which together feed three consumers — PowerPoint (notes = narration), an interactive in-app tour, and a video with audio and shots synced.](images/journey-spec-overview.png)

*One journey source (YAML), two derivation lanes — screenshots from a green E2E run and audio narration via TTS — feeding three consumers: PowerPoint, the interactive tour, and a synced video.*

## 0. The core idea (TL;DR)

Today the walkthrough of the Agent Studio exists twice, disconnected: as hand-authored
PowerPoint slides with speaker notes, and (beginning with F0) as Playwright specs. Both
describe the same flows; neither can prove the other is still true.

The resolution is a **journey spec**: a neutral, structured description of each user
flow — step by step, each step carrying a *narrative*, a *semantic UI action*, an
*assertion*, and an optional *named screenshot point*. One journey, four consumers:

```
e2e/journeys/*.yaml                     (single source of truth)
   │
   ├─→ Journey runner (Playwright)   →  E2E test in CI (deterministic, fake-claude)
   │       └─ screenshots at named points — captured ONLY on a green run
   │
   ├─→ Doc generator                 →  Markdown user guide + PPTX deck (pptxgenjs;
   │                                    narrative → slide notes, screenshot → slide image)
   │
   ├─→ Video                         →  Playwright video recording of the same run
   │                                    (slowMo lane; narration is a stretch goal)
   │
   └─→ Visual regression             →  before/after screenshots posted on UI PRs
```

The chicken-and-egg problem ("does the doc drive the test or the test the doc?")
dissolves because **the E2E test run *is* the screenshot generator for the
documentation**. Docs can only be regenerated from a passing run, so documentation and
product cannot silently diverge: a UI change first turns a journey red, then — once the
journey is updated and green — the doc/deck regenerate themselves. The same named
screenshot points double as the visual-regression surface for PR before/after evidence,
so one artifact set serves tests, docs, video and review.

**The one discipline that makes or breaks this:** journeys are *thin data* over a
hand-written **step library** (Playwright page objects / fixtures). All brittle work —
selectors, auto-waiting, SSE timing — lives in code, written once per UI area. The
journey YAML only names semantic actions (`wizard.selectProcessTemplate`,
`chat.send`, `flows.wireChannel`). We deliberately do **not** build a general-purpose
DSL that can express arbitrary clicks; that path ends in an interpreter harder to
maintain than the tests it replaces (the Cucumber trap).

## 1. The four ideas this concept sorts

1. **Derive more E2E tests from the demo deck.** The deck's chapters (Team Setup wizard,
   the IBAN story, Triggers, Flows, Agent Templates, Knowledge) are exactly the flow
   inventory the E2E suite should grow into. §5 maps every chapter to a journey and
   names the mocks each needs.
2. **A neutral flow description as the single source** for tests *and* docs *and* video.
   That is the journey spec itself (§2–§4).
3. **Chicken-and-egg between spec and doc** — resolved by "docs regenerate from the last
   green run" (§0, §4.2).
4. **Playwright ↔ GitHub: before/after screenshots on UI PRs** — the most independent
   piece; it needs only the named screenshot points and a CI workflow (§4.4). Aligns
   with #262.

Priority ruling: **do not pull doc generation ahead of the tests.** The step library the
tests need anyway is the foundation of everything else; journeys, docs, video and PR
diffs are consumers of it. Concretely: F1–F4 from `docs/e2e-testing-concept.md` are
built first, structured from day one as step-library + thin specs, so the journey layer
lands on top without rework.

## 2. The journey spec

### 2.1 Format

YAML files under `e2e/journeys/`, one per flow/chapter. Schema (v1):

```yaml
journeyVersion: 1
id: team-setup                  # slug; doubles as artifact directory name
title: Team Setup               # chapter title (deck section, doc heading)
order: 10                       # chapter ordering across the full walkthrough
lanes: [ci, live]               # which lanes may run it (see §4.1)
fixtures:                       # named preconditions, resolved by fixture code
  - env: iban-demo              #   e.g. a Working Environment seeded via API
steps:
  - id: process-step            # slug; names the screenshot artifact
    narrative: |                # verbatim prose → slide speaker notes / doc paragraph
      The first step is the Process step — and it comes first on purpose,
      because the process is the central decision. ...
    action:
      do: wizard.selectProcessTemplate     # a step-library function, dot-namespaced
      template: core-sdlc                  # its parameters, passed through verbatim
    assert:
      do: wizard.expectFlowPreview         # assertions are step-library calls too
      lints: none
    screenshot: process-step-core-sdlc     # named capture point (optional)

  - kind: narrative-only        # concept/section slides with no UI action
    narrative: |
      So what exactly is a team here? A team is a coordinated group of AI agents ...
    visual: diagrams/team-concept.png      # optional static asset for the doc/deck
```

Rules:

- **`action`/`assert` values are opaque to the schema** — they are `(name, params)`
  pairs resolved against the step library. The journey format never grows selector,
  wait, or retry vocabulary. If a step can't be expressed, the step library gains a
  function; the schema does not gain a feature.
- **`narrative-only` steps** carry the storyline parts that aren't test steps (chapter
  intros, concept slides like "what is a team"). The runner skips them; the doc
  generator renders them. This is what lets one file drive both a test and a deck with
  a real dramaturgy.
- **`narrative` is presentation prose, not test documentation.** The existing deck's
  speaker notes port into journeys nearly verbatim — they are already written in
  exactly this voice.
- Steps without `screenshot` produce no artifact; steps without `narrative` (pure
  plumbing, e.g. logging in) produce no doc output. Both are normal.
- A journey is also a Playwright test: each step becomes a `test.step(...)`, so trace
  viewer, retries and reporting keep working unchanged.

### 2.2 The step library

Lives in `e2e/steps/`, one module per UI area, plain Playwright code:

```
e2e/steps/
  wizard.js      # Team-Setup wizard: selectProcessTemplate, selectEnvironment, ...
  chat.js        # Agent chat: open, send, expectReply, expectSessionLogResult, ...
  flows.js       # Flow editor: createDraft, addAgentFromScratch, wireChannel, ...
  triggers.js    # Trigger panel: addCron, addOnce, addHttp, addGithubEvent, ...
  knowledge.js   # Knowledge page: setAutonomy, activateSkill, expectDigestBadge, ...
  agents.js      # Agents page, templates page, skills registry, ...
  gh.js          # fake-GitHub helpers: applyLabel, expectIssue, expectPr (§6.1)
```

Every function takes `(ctx, params)` where `ctx` bundles `page`, the API `request`
context, and the artifact recorder. F1–F4 are written against these modules directly
(as ordinary specs) *before* the journey runner exists — the runner is then only a thin
loop: parse YAML → resolve functions → `test.step` each → capture screenshots.

**More than one signed-in human (#2086).** Journeys ran as a single identity — the env
admin `global-setup.js` logs in once and snapshots into `storageState` — until the
decentralised-access journey needed two people who can see different things. The
extension is deliberately confined to the step library, per §9's anti-DSL rule:

- `steps/identity.js` is a **helper** module (absent from `STEP_MODULES`, the
  `team.js` arrangement) that mints real user records with local passwords, signs each
  into its **own browser context** through the same real `/api/auth/login`, and hangs
  them off `ctx`.
- `runner.js` builds `ctx` **once** and passes that same object to every fixture and
  step, so `access.actAs` can re-point `ctx.page`/`ctx.request` at one identity and the
  entire existing step library follows — including the recorder, which reads `ctx.page`
  fresh at each capture, so a screenshot is taken in whichever human's browser is
  active.
- The journey **schema is untouched**: identities are named in ordinary opaque step
  params, and a fixture owns their lifecycle (its teardown restores the primary
  fixtures before closing the extra contexts).

The rule this follows, and the one to keep: a capability that needs more than one
browser belongs in the step library and a fixture; it is never a new YAML key.

### 2.3 Screenshot capture contract

- Captured **only inside a passing run**; a failing journey publishes nothing.
- Written to `e2e/artifacts/<journey>/<step-id>.png` plus a `manifest.json`
  (journey id, step id, commit SHA, timestamp, viewport).
- Deterministic rendering (see §7): fixed viewport, animations disabled, dynamic
  regions (timestamps, generated ids) masked via step-library-provided locators.

## 3. Consumers

### 3.1 Journey runner (tests)

A Playwright project (`journeys`) beside the existing spec project. Same stack, same
`aee-e2e` compose lifecycle, same global setup/teardown as today. CI lanes:

| Lane | What runs | LLM / GitHub |
|---|---|---|
| **PR smoke** | F0 + the fast journeys (wizard, CRUD-ish chapters) | fake-claude, fake-GitHub |
| **Nightly full** | all `lanes: ci` journeys incl. the IBAN story | fake-claude, fake-GitHub |
| **Kind (k8s) lane** (#1319, `make e2e-kind`) | `lanes: ci` + `lanes: kind` journeys against the dedicated e2e **kind** cluster — agents spawn as k8s pods | fake-claude, in-cluster fake-GitHub |
| **Live demo lane** (manual/weekly) | `lanes: live` journeys against a real LLM + real GitHub sandbox repo | real — produces the "real content" screenshots/video for the public deck |

The live lane reuses the phase-4 "live-ish" option from the E2E concept. CI journeys
assert platform wiring (triggers, labels, hand-offs, SSE); they intentionally do *not*
assert agent intelligence — that is what the live lane's human-reviewed output is for.

Since #1319 the runner **enforces** `lanes:`: `journeys.spec.js` selects journeys whose
`lanes` intersect the comma-separated `E2E_LANE` env (default `ci`, so `make e2e` is
unchanged; `make e2e-kind` passes `ci,kind`). A journey with no `lanes` runs everywhere.
`lanes: [kind]` marks a journey whose fixture depends on the kind stack itself (e.g.
`context-mount`, which shells into the kind node container).

### 3.2 Doc generator

`e2e/docgen/` (Node, run via `make docs-journeys`):

1. **Markdown first** (cheap, immediately useful): one page per journey under
   `docs/user-guide/<order>-<id>.md` — narrative paragraphs interleaved with the
   captured screenshots. This *is* the detailed user documentation idea.
2. **PPTX second**: `pptxgenjs` renders one deck from all journeys ordered by `order` —
   section slide per journey (`title`), one slide per step that has `narrative` and/or
   `screenshot`; narrative goes into speaker notes (`slide.addNotes`), screenshot as the
   slide visual. Output: `artifacts/agent-studio-walkthrough.pptx`. This reproduces
   (and then supersedes) the hand-maintained demo deck.
3. **Coverage report**: docgen cross-checks journeys against the F0 nav-page list and
   flags nav pages without any journey step touching them, plus journeys whose deck
   chapter is still `TODO` — turning "which corners are documented/tested" into a
   printed list instead of tribal knowledge.

Generated docs carry a header line naming the source journey, commit SHA and run date —
they are build artifacts, reviewed like any other diff when regenerated and committed.

### 3.3 Video

Cheapest viable path, in order:

1. `video: on` + `launchOptions.slowMo` in a dedicated `journey-video` Playwright
   project → one `.webm` per journey from the *same* run that produced the screenshots.
2. Post-assembly (concat chapters, title cards from `title`/`narrative-only` steps) via
   a small ffmpeg script.
3. **Stretch, explicitly not a blocker:** TTS narration synthesized from `narrative`,
   mixed as an audio track. Park until 1–2 are boring.

### 3.4 PR before/after screenshots (the GitHub integration)

Mechanic, mostly independent of docgen:

1. Every green `main` run uploads the screenshot artifact set as the **baseline**
   (GitHub Actions artifact keyed by branch; alternatively a `journey-baselines`
   branch — decide in the ticket, artifact-based is simpler and has retention built in).
2. A PR workflow, triggered by path filter (`admin-console/src/**`) or a `ui` label,
   brings up the e2e stack, runs the journey screenshot pass on the PR branch, and
   compares against the baseline (`pixelmatch`, thresholded).
3. A sticky PR comment shows a before/after grid for changed captures (baseline |
   PR | diff), so the reviewer *sees* the visual delta instead of inferring it from
   JSX. Unchanged captures are listed collapsed.
4. This is evidence, not a gate: the job never fails the PR on pixel diffs alone
   (that is #262's future judgement call); it fails only if a journey itself fails.

## 4. Coverage map: deck chapters → journeys

Verified against the deck (54 slides) and the codebase. Effort: S (step library +
YAML only), M (needs a new fixture/mock), L (needs new product seam + playbooks).

| Deck chapter | Journey | Feasibility / prerequisites | Effort |
|---|---|---|---|
| Team Setup wizard (slides 1–6) | `team-setup` | ✅ = F1 (env pointing at the in-stack git remote — repo-less envs can't create teams per the #586 guardrail; see #667 / e2e concept v1.1) | S |
| Agent Chat tour (slide 8) | `agent-chat` | ✅ = F2; fake-claude exists | S |
| **Working with agents — IBAN story** (9–15) | `iban-story` | ⚠️ The crown jewel. Needs fake-GitHub (§6.1) + fake-claude playbooks (§6.2) + local git remote. CI variant proves the wiring; live lane produces the showable content | L |
| Triggers (16–21) | `triggers` | ✅ CRUD + `once` (near-future timestamp) + `http` (curl :4003) now; `github-event` step needs fake-GitHub | S→M |
| Flows editor (22–32) | `flows-draft` | ✅ Draft → add agent → generate prompt → wire issue channel + gate → stages → materialise. "Generate agent prompt" needs the mock `/v1/messages` (§6.3) | M |
| Agent Templates (33–35) | `agent-templates` | ✅ Pure UI/CRUD | S |
| Skills Registry (36–37, 40) | `skills-registry` | ✅ Pure UI/CRUD (deck slides still TODO — journey can lead here) | S |
| Knowledge (38–43) | `knowledge` | ⚠️ Autonomy dial, skill activation, feed = ✅ (≈ F4). Convergence + digest badges need KB state seeded via API/files, not organically learned | M |
| App Modernization, Model Provider, Git/GitHub, Token Usage, Maintenance (44–53) | one each, later | Deck chapters are empty; Maintenance Mode and Token Usage are easily testable — journeys can be authored *first* and generate these chapters | S |

## 5. Repository layout

```
e2e/
  journeys/            # *.yaml — the single source of truth
  steps/               # step library (page objects), plain Playwright code
  journey-runner/      # YAML → test.step loop + artifact recorder
  docgen/              # journeys + artifacts → markdown / pptx / coverage report
  fixtures/            # fake-claude reply fixtures + playbooks (§6.2)
  artifacts/           # captured screenshots + manifest (gitignored; CI artifact)
  tests/               # existing hand-written specs (F0; F1–F4 land here first)
docs/user-guide/       # generated markdown (committed, header marks it generated)
```

## 6. New mocks and seams

### 6.1 Fake GitHub (`fake-github` compose service, e2e overlay only)

A small HTTP server implementing the minimal GitHub REST surface the stack touches:

- **Events API** `GET /repos/:owner/:repo/events` (with ETag/304 semantics) — feeds
  `orchestrator/github-poller.js`.
- **Issues/PRs/labels**: create/read/label endpoints used by the agents (via `gh`) and
  by test steps acting as "the human" (applying `ready` — the control point).
  Label mutations emit corresponding `issues.labeled` / `pull_request.*` events into
  the events feed, closing the loop poller-side.
- State in memory, reset per run; an inspection endpoint for assertions.

**Required product change (small, flag-like, analogous to `AEE_FAKE_CLAUDE`):** the API
base is hardcoded today — `api.github.com` in `orchestrator/github-poller.js:915` and
three call sites in `admin-console/api/api.js`. Introduce `GITHUB_API_BASE`
(default `https://api.github.com`), read at those seams. Flag absent ⇒ byte-identical
production behaviour. Agent-side, `gh` already supports `GH_HOST`/`GH_ENTERPRISE_TOKEN`
env routing; git I/O does **not** go through fake-GitHub at all — it uses the local
**git remote container** (bare repo over HTTP), which lands with E2E phase 2 (#667,
option B: the wizard's #586 guardrail requires a repository, so the F1 fixture env
already needs the in-stack remote — see e2e concept §0 item 1, v1.1). Fake-GitHub
fakes the *API*, the git remote is *real* git.

### 6.2 Scriptable fake-claude (playbooks)

The F-phase shim replays canned stream-json text. The IBAN story needs role behaviour:
the Developer must actually create a branch, commit, push, open a PR. Extension: a
fixture entry may name a **playbook** — a shell script executed by the shim (inside the
agent container, as the agent user, against the real workspace clone and the fake
GitHub API) before emitting its canned reply:

```
e2e/fixtures/playbooks/
  ba-create-issue.sh          # gh issue create → fixture reply summarises it
  developer-implement.sh      # branch, scripted diff, commit, push, gh pr create, label
  reviewer-approve.sh         # gh pr review + ready-to-merge label
```

Matching stays prompt-marker-based as today. This keeps the CI IBAN journey honest: the
label wakes the real trigger machinery, the container runs, git and the API surface are
really exercised — only the "thinking" is a script.

### 6.3 Mock `/v1/messages` (LLM HTTP endpoint)

For UI features that call an LLM server-side (`POST /api/agent-prompt/generate`,
port suggestions), no product change is needed: `resolveGenerationTarget` already reads
registered Model Provider endpoints with a configurable `baseUrl`. The e2e stack
registers a provider pointing at a tiny mock that returns a canned, plausible agent
prompt. (The `.env` fallback `ANTHROPIC_BASE_URL` points at a dead address by design —
the mock provider is registered explicitly by the fixture.)

## 7. Screenshot determinism (what keeps §3.4 from flaking)

- Fixed viewport (1440×900), `deviceScaleFactor: 1`, `colorScheme: light` pinned.
- `reducedMotion: 'reduce'` + a stylesheet (`stylePath`) killing CSS animations/carets.
- Fonts ship in the runner image (CI and local render identically).
- Dynamic regions masked, not tolerated: timestamps, generated ids/slugs, live feeds.
  Each step-library module exports its `volatileLocators` so masks live next to the
  selectors they belong to.
- Seeded fixture data uses fixed names ("Agentic Demos", "IBAN Demo") so text content
  is stable across runs — matching the deck's storyline for free.
- Comparison threshold small but non-zero (`pixelmatch` ~0.1) to absorb AA jitter.

## 8. Phased roadmap → follow-up issues

| Phase | Issue (to be created) | Content | Depends on |
|---|---|---|---|
| **J0** | *Prereq: F1–F4 as step library* | Build the E2E-concept phases 2–3 flows structured as `e2e/steps/` modules + thin specs. No journey code yet — but no throwaway code either. | e2e #666 phase 1 (done) |
| **J1** | *Journey format + runner (pilot: team-setup)* | Schema v1, YAML loader, runner project, artifact recorder; port the deck's Team-Setup chapter (notes → narrative) as the pilot journey. | J0 |
| **J1b** | *Journey tooling & authoring skill* | JSON Schema + `journeys:lint`, generated step catalog, dry-run mode, `.claude/skills/journey-author` with the triage rules — the §11 package that makes journeys agent-maintainable. | J1 |
| **J2** | *Doc generator: markdown + coverage report* | `docgen` → `docs/user-guide/`, generated-header convention, nav-coverage report; `make docs-journeys`. | J1 |
| **J3** | *PPTX generator* | pptxgenjs deck from all journeys (notes = narrative, screenshots = visuals); replaces hand-maintained deck for covered chapters. | J2 |
| **J4** | *PR before/after screenshots* | Baseline publication on main, PR workflow (path filter/`ui` label), pixel diff, sticky comment with before/after grid. Evidence, not a gate. | J1 (can start parallel to J2/J3) |
| **J5** | *Fake GitHub + `GITHUB_API_BASE` seam* | The fake-GitHub compose service (§6.1) + the one product change; `triggers` journey gains the github-event step; `flows-draft` journey lands (with §6.3 mock). (The local git remote is **not** in this phase — it ships with E2E phase 2 / #667, which J0 depends on.) | J1 |
| **J6** | *IBAN story journey* | fake-claude playbooks (§6.2); the full BA→issue→`ready`→Developer→PR→review→`ready-to-merge` loop as a nightly CI journey; live-lane variant for showable content. | J5 |
| **J7** | *Video lane (stretch)* | slowMo project, ffmpeg assembly, title cards; TTS narration parked behind it. | J1, nice after J6 |

## 9. Risks

- **DSL creep** — the schema quietly grows waits/selectors/conditionals until it is a
  bad programming language. Countermeasure is structural: `action`/`assert` params are
  opaque pass-through; every new capability lands in the step library, never in the
  schema. Treat any schema PR adding control flow as a design smell. (§11 additionally
  removes the *motivation* for creep: humans rarely touch the YAML at all.)
- **Doc drift in the other direction** — someone edits generated markdown/PPTX by hand.
  Countermeasure: generated-header convention + CI check that regenerating from the
  last artifacts produces no diff on `docs/user-guide/`.
- **Screenshot flake** burning trust in the PR workflow (§7 is the answer; burn-in
  nightly before enabling the PR comment, same discipline as the E2E gating plan).
- **Playbook divergence from real agent behaviour** — the scripted Developer does
  something the real one wouldn't, and the CI journey certifies a fiction. Mitigation:
  playbooks only perform actions the live lane has demonstrated (keep them minimal:
  branch/commit/PR/label), and the live lane runs the same journey YAML.
- **Two decks during transition** — until J3 covers all chapters, the hand deck and the
  generated deck coexist. Accept it; the coverage report (§3.2) tracks the remainder.
- **Live-lane cost/permissions** — real LLM + a sandbox GitHub repo with a PAT; keep it
  manual/weekly, behind repo secrets, same posture as the E2E concept's live-smoke lane.

## 10. Decisions taken (and their alternatives)

1. **Journey = data over a code step library** — not Cucumber/Gherkin (glue-code
   indirection without the payoff), not pure code with doc comments (narrative would
   rot; non-engineers can't review dramaturgy in JS), not recording tools (unmaintainable
   output).
2. **Docs regenerate from the last green run** — not "docs as input to tests" (screenshots
   would go stale the day they're committed) and not screenshot-on-demand against a dev
   stack (no proof the flow still works).
3. **PPTX via pptxgenjs from scratch** — not template-XML surgery on the existing deck;
   the deck's value is its notes (ported into journeys) and its screenshots (recaptured),
   not its slide XML.
4. **PR visual workflow is evidence, not a gate** — a human (or later #262's agent)
   judges the diff; pixel equality is not a merge criterion.
5. **Fake-GitHub fakes only the REST API; git stays real** via the local bare-repo
   remote — keeps the agents' actual git discipline (branch, push, PR ref) under test.

## 11. Agent-maintained journeys (softening the DSL)

Nobody wants to hand-edit journey YAML — and the design does not require it. The
intended maintenance model is: **an agent (Claude Code, in-session) authors and repairs
journeys; humans review rendered artifacts, not YAML.**

### 11.1 Why this works here specifically

- **Executable ground truth.** Unlike prose or docs, a journey is verifiable: the agent
  runs it (`make e2e-up` + Playwright — the authoring loop already exists), reads the
  failure, iterates until green. A wrong journey is not subtly wrong; it is red. That
  is the strongest guard against LLM error available.
- **Thin data over a finite vocabulary.** Because journeys only compose named
  step-library calls, the agent never invents selectors or wait logic — the classic
  LLM failure mode in UI testing. Authoring a journey is a translation task
  (prose → step sequence), not a programming task.

### 11.2 Enablers to build (phase J1b)

Four small pieces turn "an agent could do this" into "an agent reliably does this":

1. **JSON Schema + linter** (`npm run journeys:lint`): schema validation, unknown step
   names, missing fixtures, orphaned screenshot references. Feedback in seconds
   instead of a full stack run.
2. **Generated step catalog** (`steps-catalog.json` from the step library's JSDoc:
   name, params, description, example). This is the vocabulary handed to the agent;
   with it, a hallucinated step is impossible to ship — the linter rejects any name
   not in the catalog.
3. **Dry-run mode** of the runner: resolve every step and validate params without a
   browser — the middle gear between lint (ms) and a real run (minutes).
4. **A `journey-author` skill** (`.claude/skills/journey-author`): encodes the
   workflow *read schema → read catalog → draft YAML → lint → dry-run → real run →
   iterate until green → check captured screenshots*. Authoring a journey then is a
   normal Claude Code session, no new infrastructure.

### 11.3 Authoring inputs, strongest first

- **Prose + the running app.** The best input is the flow described in speaker-note
  style ("the BA asks clarifying questions, then…"). The agent explores the running
  e2e stack itself, finds the click paths, and writes the journey (plus any missing
  step-library functions, which go through normal code review). Screenshots serve as
  *acceptance reference* ("does the capture point look as intended?"), not as the
  specification.
- **Playwright codegen as seed.** For brand-new UI areas, a human click-through via
  `npx playwright codegen` yields raw script with guaranteed-real selectors; the agent
  lifts it into step-library calls and distills the journey. The human demonstrates
  the flow once; the agent formalises it. No YAML, no selectors written by hand.
- Screenshots alone as input are workable (multimodal) but weakest — prefer the two
  above.

### 11.4 The drift case (most of the real maintenance)

Journey maintenance is dominated not by new flows but by UI changes breaking existing
ones. A failed run leaves a **Playwright trace** (DOM snapshots, network, console per
step) — ideal agent input. The `journey-author` skill must encode a hard **triage
rule** before any repair:

| Diagnosis | Action |
|---|---|
| Journey outdated (UI intentionally changed) | update the YAML |
| Step library broken (selector rot) | fix the step function |
| **App actually broken** | **report the bug; repair nothing** |

Without this rule an eager agent "heals away" real regressions — the single biggest
risk of the approach, so it lives in the skill text, not in tribal knowledge.

### 11.5 Where the human reviews

With an agent maintaining the YAML, the human review point moves up a level: the
generated markdown/PPTX diff and the screenshot diffs of the green run — "is the story
right, do the pictures look right" — rather than YAML lines. The YAML becomes an
intermediate format a human *can* read but rarely must.

**Outlook (deliberately later):** the same loop is a natural dogfooding candidate — a
"journey-curator" agent in the Agent Studio itself, triggered on UI-changing PRs,
proposing journey updates as PRs. Only worth starting once the Claude-Code-skill path
(J1b) is routine.
