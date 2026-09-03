# Concept: End-to-End Tests for Standard User Flows

**Status:** concept / plan of record — v1.1 (2026-07-17; v1 2026-07-16). Origin: #651.
v1.1: F1's repo-less-env premise corrected after the #667 blocker (teams require a
repository — deliberate #586 guardrail); the local git remote moves from phase 4 into
phase 2. See also `docs/journey-spec-concept.md`, which builds on phases 2–3.
**Relates to:** #262 (Playwright visual-regression agent — tooling alignment), #253 (SSE stream miss — exactly the bug class E2E must catch), #300/#301 (auth model — still open, design works with today's #276 session auth), `docs/admin-console.md`

## 0. Feasibility verdict (TL;DR)

**Yes — browser-driven E2E for the standard flows is feasible with modest infrastructure,
and the reference flow ("create a team") can run with *zero* external dependencies.**
Three verified findings carry the design:

1. **Team creation never touches the LLM.** `POST /api/teams(/stream)` provisions env →
   team agent → members (Matrix user + login, workspace seed, container spawn) → DM
   rooms. Claude is only invoked when a container later processes a message or trigger.
   Hard dependencies are Matrix (local conduwuit — fine) and `git clone`. *(v1.1
   correction, found in #667:)* v1 claimed a repo-less env removes GitHub entirely —
   but a team **cannot** be created from a repo-less env: the #586 guardrail rejects it
   in the API (`api.js:2069/8593/9087`) and the wizard UI marks repo-less env cards
   non-selectable. Zero-external-deps is preserved differently: the fixture env points
   at an **in-stack git remote** (a bare repo served by a small `git-remote` compose
   service in the e2e overlay). Verified: the orchestrator's clone path treats only SSH
   and `https://github.com/` URLs specially — a plain anonymous `http://git-remote/...`
   URL clones credential-less, and the GitHub poller skips repos without a
   `githubTokenId`, so no poller noise. No product change needed.
2. **The LLM seam is trivial.** The agent runtime invokes `claude` by **bare name via
   PATH** (`agent-entrypoint.py:1752`), and the runtime already parses `--output-format
   stream-json`. A fake `claude` shim earlier on PATH that replays canned stream-json
   makes chat flows fully deterministic and free — everything else (Matrix, session
   logs, SSE, the whole UI) stays real. `AEE_TEST_MODE` (`agent-entrypoint.py:2049`)
   exists as an even blunter in-container kill-switch.
3. **Isolation is already namespaced.** Every named volume is prefixed with
   `COMPOSE_PROJECT_NAME` and every spawned agent container carries `aee.instance`
   labels — a dedicated project name (`aee-e2e`) gives a parallel, disposable stack
   whose teardown is `compose -p aee-e2e down -v` plus label-scoped cleanup.

The honest caveats: the spawn path speaks the **libpod REST API** (podman-specific —
Docker is *not* a drop-in), the compose file has **no healthchecks** (the harness must
poll for readiness), and there is **no CI running any tests today** — E2E lands on a
green field, which also means the unit suites should get a CI job as a cheap sibling
follow-up.

## 1. Current-state inventory (AC 1)

Verified 2026-07-16:

| Layer | Coverage | How it runs |
|---|---|---|
| Orchestrator | 24 unit-test files (`orchestrator/*.test.js`) | `npm test` → `node --test`, pure logic |
| Admin-console API | 27 unit-test files (`admin-console/api/*.test.js`) | `node --test`, pure logic |
| Admin-console frontend | 14 `node:test` files under `src/**` — **pure logic modules only** (layout math, adapters); no React/JSX is ever rendered in a test | manual `node --test`, no npm script wired |
| Agent runtime | 2 Python suites (`agent-image/scripts/test_*.py`) | pytest/unittest |
| **Frontend rendering / UI** | **none** — no vitest/jest/testing-library, no jsdom, no browser tooling of any kind (repo-wide grep for playwright/cypress/puppeteer: zero hits) | — |
| **E2E / integration across services** | **none** | — |

**CI (`.github/workflows/`): none of the above runs anywhere.** The three existing
workflows are `claude.yml` (@claude mention handler), `coordinator.yml` (label
coordination cron), `mirror-to-gitlab.yml` (push mirror). **No workflow executes
`node --test`, pytest, a lint, or even a build.** The E2E gap is therefore part of a
wider gap: *nothing* is verified automatically today; the only safety net for any flow
— UI → API (`:4000`) → orchestrator (`:4002`) → Matrix/agents — is a human clicking
through.

## 2. Candidate flows (AC 2)

Prioritised shortlist. Each flow lists the services it actually traverses (verified
against the code paths, not assumed).

| # | Flow | Traverses | Why this one |
|---|---|---|---|
| **F0** | **Login + navigation smoke** — log in (`admin/admin` via the #276 session), visit every nav page, assert core widgets render | UI → API `:4000` | Cheapest possible canary: catches build breakage, routing regressions, auth-gate regressions. Runs in seconds. |
| **F1** | **Create a team** (reference flow) — Team-Setup wizard end-to-end: Process step (template), Working Environment step (env pointing at the **in-stack git remote**, see §0 item 1), Team step, Review, submit; assert per-step NDJSON progress in the UI, then team + members on the Agents page and DM rooms present | UI → API `:4000` → orchestrator `:4002` → conduwuit (user provisioning + login) → git-remote (fixture clone) → podman (real `as-agent` containers spawn and idle) | The ticket's reference example. With the in-stack remote it has zero **external** dependencies: no GitHub, no LLM. Members spawn as real containers that sit idle as Matrix clients. *(v1.1: was "repo-less env" — impossible per the #586 guardrail, see #667.)* |
| **F2** | **Agent DM chat round-trip** — open `/chats/:agentId`, send a message, deterministic fake-`claude` reply; assert the reply bubble arrives (SSE `/api/matrix/rooms/:roomId/stream`) and the session-log panel shows the `result` event (SSE session stream) | UI → API → conduwuit → agent container (runtime + fake `claude`) → back via Matrix + both SSE streams | Exercises the full message loop including the exact async surface of #253 (SSE stream miss). This is the flow that turns "agent didn't answer" from a user report into a red test. |
| **F3** | **Working Environment + credential CRUD** — create an SSH key (fingerprint-only response), create/edit/delete an env, assert list scoping | UI → API → orchestrator file state | Governs everything else (envs are the infra template); cheap; touches the secret-handling contract (key value never returned). |
| **F4** | **Team skill activation** — add/activate a global skill on the team from the Knowledge page, assert per-member activation badges | UI → API → orchestrator (`planSkillSync`, workspace copy, CLAUDE.md rebuild) | Representative of the knowledge/skill surface, fully local, exercises the orchestrator sync machinery. |

Deliberately **not** in the first set: BriefingPack/orchestrator-role flows (needs a git
remote + ACE data), the PR build-and-review loop (needs GitHub or a local git server —
phase 4 option), Flow-Designer draft→materialise (valuable, but F1 already covers the
materialise pipeline; add as F5 when F1 is stable).

## 3. Tooling recommendation (AC 3)

**Playwright (`@playwright/test`).** Rationale:

- **Alignment with #262**, which already proposes Playwright for the visual-regression
  agent — one browser-automation stack for both, shared selectors/fixtures later.
- **Auto-waiting assertions** fit an SSE/NDJSON-driven UI: `expect(locator).toHaveText()`
  polls until the DOM settles, which is precisely what chat bubbles and wizard progress
  steps need — no `sleep()`, the #1 flakiness source.
- **Trace viewer** records DOM snapshots + network + console per retry — the only
  realistic way to debug a flaky async failure that happened in CI at 3am.
- **API + browser in one runner**: Playwright's `request` context does the setup work
  (login → `storageState`, create fixtures via API, teardown via DELETE endpoints)
  without a second tool.
- **Node**, matching the repo's `node --test` convention — no new language, no new
  package manager. First-class GitHub Actions support, free parallelism.

Cypress was considered and rejected: weaker multi-tab/out-of-origin support, slower runs,
the useful dashboard is commercial, and it would split tooling from #262. Selenium-class
tools bring grid overhead with no benefit at this scale.

Layout: a new top-level **`e2e/`** package (own `package.json` — the repo has no root
one), `e2e/playwright.config.js`, specs under `e2e/tests/`, the fake-claude fixture
scripts under `e2e/fixtures/`.

## 4. System under test (AC 4)

### 4.1 Topology: one compose overlay, everything real except the LLM

```
docker-compose.yml  +  docker-compose.e2e.yml  (project: aee-e2e)
├── conduwuit        REAL   (local Matrix — fast, free, no reason to stub)
├── orchestrator     REAL   (the thing under test)
├── admin-console    REAL   (serves built SPA + API on :4000 — single origin)
└── agent containers REAL image (as-agent:latest) with a FAKE `claude` on PATH
GitHub               ABSENT (repo-less envs; the poller only polls repos with tokens)
LLM                  STUBBED (fake `claude` shim; ANTHROPIC_* point at a dead address)
```

This answers the ticket's core question directly: **the LLM/agent dependency is removed
at the `claude`-binary seam, not by stubbing the agent away.** The agent container, its
Matrix client, the trigger scheduler, session logging and SSE all run for real — only
the model call is canned. That keeps the test honest (it traverses the same code the
user's message traverses) while making it deterministic and free.

### 4.2 The fake `claude` shim (the one product change phase 1 needs)

- A small script shipped in the agent image (e.g. `/opt/ace/e2e/claude`), plus ~3 lines
  in the entrypoint: when `AEE_FAKE_CLAUDE=1` is in the container env, prepend that
  directory to `PATH`. The orchestrator already passes its own env through to agent
  containers, so the overlay sets the flag once, stack-wide. Flag absent ⇒ byte-identical
  production behaviour.
- The shim parses the args it's given (`-p <prompt>`, `--resume`, `--output-format
  stream-json`) and emits a **valid stream-json sequence** (`system:init` →
  `assistant` text → `result` with usage) — the same NDJSON contract the runtime's
  parser is already unit-tested against (`agent-entrypoint.py:766-895`). Replies are
  keyed on prompt content (a fixtures file), default reply otherwise; echo of a marker
  from the prompt makes assertions unambiguous.
- Deliberately **not** chosen as the primary seam: a mock Anthropic HTTP server behind
  `ANTHROPIC_BASE_URL`. It needs no code change, but couples the tests to the CLI's
  internal API usage (version-fragile) and is slower. It stays on the table for a later
  "live-ish" lane; noted in §8.
- `AEE_TEST_MODE` (existing) is *not* used for E2E — it suppresses Matrix posts and
  session-log writes, i.e. exactly the behaviour F2 must observe.

### 4.3 Runtime platform: podman, also in CI

`spawn-container.js` speaks the **libpod REST API** (`/v4.0.0/libpod/...`) with
podman-specific create options (`SubPath`, per-agent netns). **Docker is not a drop-in**
for the spawn path. Consequence: E2E runs on podman locally (as today) and on podman in
CI — GitHub's `ubuntu-24.04` hosted runners ship podman; the workflow starts the rootless
socket (`podman system service`) and points `PODMAN_HOST_SOCKET` at it. This must be
validated as the *first* task of the harness follow-up (it is the single biggest
infrastructure risk — see §9).

### 4.4 Readiness

The compose file defines **no healthchecks** (`depends_on: service_started` only). The
harness's global-setup therefore polls: `GET /api/setup/status` (admin-console up),
login round-trip (auth up), a `/api/agents` list (orchestrator `:4002` reachable via the
console proxy), and conduwuit's `/_matrix/client/versions`. Adding real compose
healthchecks is a small, separately-ticketed product improvement (per the ticket's
scope rule), not a prerequisite.

## 5. Test data, auth & isolation (AC 5)

- **Auth:** there is no `AUTH_ENABLED` flag today (#301 is open); the console is always
  gated by the #276 env-credential session (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, signed
  `aee_session` cookie). The tests **use the real gate**: global-setup logs in once via
  `POST /api/auth/login` and persists Playwright `storageState`; one dedicated spec
  asserts the unauthenticated redirect. No auth-disabling backdoor is added — the login
  is part of what we're testing. If/when #301 lands, only global-setup changes.
- **Matrix identities:** `orchestrator/setup.sh` already bootstraps the admin user
  non-interactively when `ADMIN_PASS` is set and writes `MATRIX_ACCESS_TOKEN` +
  `CONDUWUIT_ADMIN_ROOM` back to the env file. Global-setup runs it against the e2e
  project with a generated `.env.e2e`. Agent Matrix users are created *by the flows
  under test* — that's product behaviour, not fixture setup.
- **Isolation between runs:** dedicated `COMPOSE_PROJECT_NAME=aee-e2e` +
  `AEE_INSTANCE_ID=e2e`. A run starts from **fresh named volumes** and ends with
  `compose -p aee-e2e down -v` plus removal of dynamic `aee-e2e_agent-*` volumes and
  label-scoped container cleanup (`aee.agent.id` / instance labels). Nothing can leak
  into (or survive from) the developer's normal `agent-studio` stack, because every volume
  and container is project-prefixed.
- **Isolation within a run:** created resources use a per-run unique suffix
  (`e2e-<runid>-…`) so specs never collide on ids; mutating flows run **serially**
  (`workers: 1`) in phase 1 — correctness first, parallelism is a later optimisation.
  Specs still delete what they create via the existing DELETE endpoints (agents cascade
  through the orchestrator incl. per-agent network/volume teardown), so a single run
  stays clean even before the final volume wipe.
- **Seeding:** `make seed-pool` (skills/templates/process-templates) runs once in
  global-setup so the wizard's Process step has its curated templates.

## 6. Execution & CI (AC 6)

**Local:** `make e2e` → builds images, brings up the `aee-e2e` project, runs
`npx playwright test`, tears down. Also `make e2e-up` / `make e2e-down` for keeping the
stack alive while authoring tests (Playwright UI mode against it).

**CI:** new workflow `.github/workflows/e2e.yml` on `ubuntu-24.04`:

1. Start rootless podman socket; build `as-agent:latest` + compose images (layer cache
   via GHCR or `actions/cache` — the builds dominate runtime).
2. Generate `.env.e2e`, run setup bootstrap, `compose -p aee-e2e up -d`, readiness poll.
3. `npx playwright test` (retries: 1, trace: on-first-retry).
4. Upload traces/videos/report as artifacts on failure; always `down -v`.

**Budget estimate:** image builds ~5–8 min cold / ~2–3 min cached; stack up + bootstrap
~1–2 min; F0–F2 ~3–5 min. **Total ≈ 10–15 min per run. LLM cost: $0** (stubbed by
design). No GitHub PAT, no external quota.

**Gating recommendation:** start **nightly + manual dispatch, non-blocking**, for the
first 2–3 weeks of life (every new E2E suite has a burn-in period; a flaky blocking gate
destroys trust faster than no gate). Once the suite has a clean streak, promote the
**smoke lane (F0 + F1) to a required PR check** — it is deterministic and external-free,
so there is no cost argument against gating; the full suite (F2–F4) stays nightly.
Sibling quick win (own follow-up, independent of E2E): a plain CI job running the
existing unit suites (`node --test` × 2, pytest) on every PR — today literally nothing
runs them.

## 7. Flakiness & async discipline (edge cases)

- **No sleeps, ever.** All waits are Playwright auto-waiting assertions on user-visible
  state (wizard step chips, chat bubbles, badges) — the same signal a human uses.
- **SSE surfaces** (chat stream, session log) are asserted through the UI they feed. F2
  was written to catch the #253 stream-miss bug; #253 is now fixed, so F2 is expected
  green and a red reply-bubble step is a real regression, not an accepted red. F2's
  assertion gets a generous-but-bounded timeout (fake-claude replies in milliseconds;
  30 s ceiling flags a real delivery bug, not slowness).
- **Agent async:** DM message → runtime poll → fake claude → Matrix post is seconds, not
  minutes, once the model call is canned — "long-running agent flows" cease to exist in
  the stubbed lane. Trigger-driven flows (cron 60 s sync loops) are avoided in specs;
  where needed later, the pending-queue drain (5 s) is the wait bound, not cron.
- **Retries:** CI `retries: 1` with trace-on-retry. A spec that needs the retry twice in
  a week gets fixed or quarantined (`@quarantine` tag excluded from the gate) — the
  suite's credibility is the asset being managed.

## 8. Phased roadmap → follow-up issues (AC 7)

| Phase | Follow-up issue (to be created) | Content | Depends on |
|---|---|---|---|
| **0** | *CI for existing unit tests* | GitHub Actions job: `node --test` (orchestrator + admin-console/api), pytest (agent-image), on every PR. Independent quick win surfaced by the inventory. | — |
| **1** | *E2E harness & infra* | `e2e/` Playwright package; `docker-compose.e2e.yml` + `.env.e2e` generation; global setup/teardown (bootstrap, readiness poll, volume wipe); **fake-`claude` shim + `AEE_FAKE_CLAUDE` flag in agent-image** (the one product change); `make e2e*` targets; CI workflow running **F0** (login/nav smoke). **First task: validate rootless podman + libpod spawn on a GitHub hosted runner** — this is the go/no-go infrastructure risk. | — |
| **2** | *Reference flow: create a team* | **Local git remote** (`git-remote` compose service in the e2e overlay, seeded bare fixture repo — pulled forward from phase 4 per #667/option B; also shared foundation for the journey-spec roadmap). **F1** through the real wizard with an env pointing at that remote; asserts per-step progress, team/members on Agents page, DM rooms, containers running; API teardown. Built as step-library modules + thin spec (journey-spec concept J0). Promote F0+F1 to a blocking PR check after burn-in. | 1 |
| **3** | *Chat round-trip + remaining flows* | **F2** (DM → fake claude → SSE assertions), **F3** (env/SSH-key CRUD), **F4** (skill activation). Nightly full-suite schedule. | 1, 2 (F2 needs a team from F1's fixture path) |
| **4** | *Optional depth — largely absorbed by the journey-spec roadmap (`docs/journey-spec-concept.md` §8)* | ~~Local git remote~~ (moved into phase 2, v1.1); the PR build-and-review loop → journey J6 (IBAN story); the **live-LLM smoke** → the journey live lane (§3.1 there); Flow-Designer draft→materialise (F5) → journey `flows-draft` (J5); visual work with #262 → journey J4. Remaining here: compose healthchecks. Recut #669 accordingly when the J-tickets are created. | 3 |

## 9. Risks

- **Podman on CI runners** (the real feasibility risk): rootless socket + libpod REST +
  nested agent-container spawn on a hosted runner must be proven in phase 1 before
  anything else is built on it. Fallbacks if it fights back: a self-hosted runner, or a
  CI mode where team members are created as **non-materialised stubs** (`enabled: false`,
  no token ⇒ `startAllEnabledAgents` skips them — an existing seam, `orchestrator.js:396`)
  so F1 still verifies the whole control plane minus the actual spawn; F2 would then be
  local-only until a runner with podman exists.
- **Shim/CLI contract drift:** the fake `claude` must track the runtime's stream-json
  parsing contract. Mitigation: the shim's output is validated by the same Python parser
  tests (shared fixture, the knowledge-digest two-sided-contract discipline).
- **Burn-in flakiness:** addressed by §7's discipline + the nightly-first gating plan.
- **conduwuit `:latest`:** the compose file floats the Matrix server image; an upstream
  change can break E2E unrelated to our code. Pin the tag in the e2e overlay (and
  arguably in prod — separate note).

## 10. The ticket's open questions, answered

1. **Depth of v1:** UI+API+orchestrator+Matrix+real agent containers, **LLM stubbed at
   the `claude` binary** — i.e. more "real" than an agent-layer stub, but deterministic
   and free. A small live-LLM smoke lane is a phase-4 option, nightly, behind a secret.
2. **Priority flows:** F0 login smoke → **F1 create-team (reference)** → F2 chat
   round-trip → F3 env/credential CRUD → F4 skill activation (§2). PR loop and
   BP/orchestrator flows deferred until a local git remote exists (phase 4).
3. **Where it runs:** locally via `make e2e`; CI nightly + manual first, smoke lane
   (F0+F1) promoted to a blocking PR check after burn-in. LLM cost in CI: zero by
   design; the optional live lane is the only spender and stays nightly/weekly.
   Since #1319 the journey suite also runs against a dedicated e2e **kind** cluster
   (`make e2e-kind`, agents as real k8s pods, fakes deployed in-cluster) — the k8s
   runtime's lane; see `docs/journey-spec-concept.md` §3.1 and `deploy/k8s/README.md`.
4. **Tooling:** Playwright, aligning with #262 (§3).
5. **Test environment:** no dedicated infra needed — an **ephemeral compose project**
   (`aee-e2e`) beside the normal stack, fully isolated by project-prefixed volumes and
   instance labels, disposable per run (§5). CI uses the same mechanism on the runner.
