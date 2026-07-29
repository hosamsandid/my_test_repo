# Concept: Token Telemetry & Work-Item Attribution

**Status:** concept / plan of record — v4 (2026-07-16). Origin: #643
**Relates to:** session log pipeline (`docs/agent-chat-plan.md` §4.1), GitHub event-transparency log (#469), Model Providers (`docs/model-providers.md`), `gh-as-agent`, ACE cost skill (`ace:cost`, BP world — separate scope)

> **Scope decisions (v2/v3, product owner 2026-07-16):**
> 1. The deliverable is **token counts, not dollars** — every token class the API meters
>    (input, output, cache-write, cache-read), per model. Deriving money happens
>    downstream (FinOps / customer contract prices) from our data; no price table, no
>    estimated dollars anywhere in the product.
> 2. **No backfill / offline analysis of historical sessions** — forward-looking feature;
>    records exist from the day the capture ships.
> 3. The attribution unit is the **work item — the connected issue↔PR chain** (BA opens
>    the issue, Dev/Reviewer/Reworker resolve it via a PR). Issue-side work is part of
>    the default figure, not an opt-in extra.
> 4. **First shippable step is a general token statistic** (per agent / team / model /
>    provider endpoint / day), independent of any PR — attribution builds on top.
> 5. One console page first; exports later. Raw records are retained **indefinitely**
>    (operator-managed cleanup).
> 6. The design must stay **compatible with per-invocation flow instances** (the
>    not-yet-built evolution of `sessionPolicy: per-invocation`: each new issue
>    instantiates a fresh Dev→Reviewer→Reworker chain that learns only from team
>    knowledge). See §3.3 — work item and flow instance are the same identity.

## 0. Feasibility verdict (TL;DR)

**Yes — token usage per work item is honestly trackable with the data the stack already
produces.** Three findings carry the whole concept:

1. **Token ground truth already exists.** Every Claude invocation's `result` event is
   persisted in the per-agent session JSONL with turn-aggregate token counts
   (input / output / cache-write / cache-read)
   (`agent-image/scripts/agent-entrypoint.py:876-895`). Token counts come from the
   Anthropic Messages API responses themselves — measured, not estimated.
   Verified live against the CLI: the `result` event additionally carries **`modelUsage`**
   (per-model breakdown of all four token classes), which the runtime currently drops —
   a one-line capture away.
2. **Inbound issue/PR attribution already exists.** A `github-event`-triggered run
   persists a `trigger.fired` session-log row carrying the full event payload — including
   `pull_request.number` / `issue.number` — under the **same `correlationId`** as its
   token-bearing `result` rows (`agent-entrypoint.py:3106-3114`). BA, reviewer, reworker
   and companion runs are therefore exactly attributable to "their" GitHub artifact
   today, with zero changes.
3. **Outbound PR attribution has exactly one gap.** `agentCreatePr`
   (`orchestrator/orchestrator.js:3517-3604`) knows agent id, repo, branch, base and the
   created PR URL at the moment of creation — and **persists nothing**. Closing this one
   seam (a `pr-created` record + passing the invocation's correlation id through
   `gh-as-agent`) makes "which run created this PR" a fact, not a heuristic.

The honest-numbers risk is therefore concentrated in one place: **attribution coverage**
(§2). Tokens themselves are facts.

## 1. What exists today (verified inventory)

| Building block | Where | State |
|---|---|---|
| Per-invocation token usage | `result` event in `/workspace/agents/<id>/sessions/<roomId>.jsonl` (`agent-entrypoint.py:876-895`) | ✅ captured since #494 |
| Per-model usage incl. cache tiers (`modelUsage`) | CLI stream-json `result` event (verified live, CLI 2.1.x) | ⚠️ emitted by CLI, **dropped** by runtime |
| Inbound PR/issue number per run | `trigger.fired` row, `github.payload.pull_request.number` / `issue.number`, same `correlationId` as `result` rows | ✅ persisted |
| Conversation key (`pr:42`, `issue:99`, `push:<ref>`) | poller `_conversationKey` (`github-poller.js:141-146`) | ✅ computed, used for throttling only |
| Outbound PR identity (agent → PR URL/branch) | `agentCreatePr` (`orchestrator.js:3517-3604`) via `gh-as-agent pr` | ❌ known at runtime, **not persisted** |
| Commit → agent identity | author email `<agentId>@agents.local`, PR body marker `<!-- agent: <id> -->` | ✅ stamped |
| Token aggregation | `SessionLogPanel.jsx:219-236` — in-browser, one session at a time | ⚠️ client-side only, no server rollup |
| Day-bucketed JSONL writer/reader split | github-event-log (#469): writer in orchestrator, reader in admin-console | ✅ pattern to reuse |

Conclusion: this is an **aggregation + one-seam-closing** project, not a new telemetry
pipeline. The runtime already measures everything; nothing needs to intercept API traffic.

## 2. Honest numbers: two rules

**Rule 1 — all four token classes, never irreversibly collapsed.** With agents' heavy
prompt caching, cache-read tokens typically dominate the raw total by an order of
magnitude, and any downstream cost derivation *must* treat the classes differently.
Every surface shows the split (or has it one click away), per model:

> Work item #99 → PR #42 — **2.4M tokens**
> (1.9M cache-read · 0.3M cache-write · 0.15M input · 0.05M output)
> · 7 runs, 4 agents (BA 1, Dev 3, Reviewer 2, Reworker 1) · attribution: 6 exact, 1 via branch
> · team-wide unattributed this week: 12%

**Rule 2 — attribute only on explicit signals, count every token exactly once, always
show the unattributed remainder.** No proration, no averaging, no silent spreading. An
operator (or a sales audience) can always see how much of the total is *not* assigned to
any work item — that is what makes the per-work-item number credible instead of
decorative.

## 3. Attribution model

### 3.1 The unit: work item = the connected issue↔PR chain

Flows are dynamic (Flow Designer), so attribution must **not** be configured per flow or
per role. It doesn't need to be: every role's runs are triggered by events on some GitHub
artifact (issue opened/labeled, PR opened/labeled, push), and the artifacts themselves
are linked by GitHub-native references. The **artifact graph is the generalization**:

```
issue #99 ──(closes #99 / branch naming)── PR #42 ── PR #43 (follow-up)
   ▲                                          ▲
   │ tier B: BA run (issues.labeled req:refine)│ tier B: reviewer run (pull_request.opened)
   │ tier B: triage run (issues.opened)        │ tier B: reworker run (pull_request.labeled)
                                               │ tier A: dev run that created the PR
                                               │ tier C: dev runs on the head branch
```

- Each **run** attaches to exactly one artifact node via its strongest signal (§3.2).
- Artifact **edges** come from GitHub itself: `closes/fixes #N` in the PR body, issue
  numbers referenced in the head branch name, and PR cross-references. All of these are
  readable from data we already have (PR payloads are enriched by the poller; the PR body
  passes through `agentCreatePr`).
- A **work item** is the connected component of that graph. Its token figure is the sum
  of its runs' records — BA → Dev → Reviewer → Reworker falls out automatically, and so
  does any future flow shape, with **zero per-flow configuration**. New roles, extra
  review stages, follow-up PRs: as long as they are wired through GitHub artifacts (which
  is how the Flow Designer wires everything), they join the chain by construction.
- The drill-down shows the **per-agent / per-stage breakdown** inside the work item, so
  the demo can tell the story "analysis cost X, implementation Y, review Z".

### 3.2 Run → artifact signals (tiers)

Each **invocation** (one Claude run = one `result` row = one usage record) is attributed
via the strongest available signal; a higher-tier match is never re-counted by a lower
one:

| Tier | Signal | Strength | Mechanism |
|---|---|---|---|
| **A — created the PR** | `gh-as-agent pr` ran inside this invocation | exact | new `pr-created` record: orchestrator persists `{repo, prNumber, url, branch, base, agentId, correlationId, ts}` at `agentCreatePr` time. The invocation's correlation id travels via env (`AEE_CORRELATION_ID`, exported by the runtime per invocation, sent by `gh-as-agent` in the POST body). |
| **B — ran *on* an issue/PR event** | `github-event` trigger payload carries `pull_request.number` / `issue.number` | exact | already persisted (`trigger.fired` row); stamped directly onto the usage record at run start. Covers BA, triage, reviewer, reworker, label-gate follow-ups — most runs in a flow are tier B. |
| **C — worked on a PR's branch** | invocation committed to branch `X`; a PR exists with head `X` | strong heuristic, verifiable | runtime records git context per invocation (repo, branch, HEAD before/after). Join via the PR's head branch + commit SHAs; verifiable because commits carry `<agentId>@agents.local` authorship and fall inside the invocation window. Labeled **"via branch"**. |
| **∅ — unattributed** | none of the above | — | DM chats, curation crons, digest rebuilds, exploratory runs. Stays in the general statistics (§5 view 1) and is *shown* as the remainder (§2). |

*(The former opt-in tier D disappeared as a tier: issue-side work is tier B on the issue
node and reaches the work-item total through the artifact graph — it is part of the
default figure by product decision.)*

### 3.3 Forward-compatibility: per-invocation flow instances

Agent templates already carry `sessionPolicy: per-invocation` (fresh Claude session per
triggered run). The planned — not yet built — evolution of that idea is **chain
instantiation**: the BA stays a persistent single instance, but every issue it produces
spawns a *fresh instance* of the downstream chain (Developer → Code Reviewer → Reworker)
that carries no episodic memory and learns only from team knowledge. That feature needs
end-to-end traceability through the chain ("which instance is this run part of?") —
exactly what this concept measures.

The key observation: **a flow instance and a work item are the same identity.** The
instantiated chain exists precisely to resolve one issue into one merged PR — i.e. one
connected artifact component (§3.1). Token telemetry per work item therefore *is* token
telemetry per flow instance, and this concept doubles as the observability layer the
instance feature will need. Three design consequences are baked in now so the two
features meet instead of colliding:

1. **Reserved `flowInstanceId` on the usage record** (nullable, unused today). When
   instantiation ships, the orchestrator mints the id at chain-spawn time (the issue
   trigger that creates the instance) and injects it into every member container's
   environment; the runtime stamps it onto each record. Attribution then gains a
   **tier-0 exact signal** — stronger than the artifact graph, and covering hand-offs
   that never pass through an issue/PR event (e.g. data-flow push triggers, which today
   attribute only via branch/tier C). Day-bucketed JSONL is additive, so the schema
   extension is free.
2. **No assumption of long-lived agent ids.** Instance members are ephemeral by design.
   Records therefore carry the stable identities alongside the concrete `agentId`:
   `teamId` and a best-effort `roleId` (from the member's template/role), so per-role
   breakdowns ("implementation vs. review") survive across instances and the summary
   view can aggregate a thousand short-lived `developer` instances into one line.
3. **The artifact graph stays the configuration-free fallback.** Runs without an
   instance stamp (legacy agents, manual shells, cross-instance follow-ups) still attach
   via tiers A–C. Where both signals exist they should agree; a mismatch is surfaced as
   a data-quality flag, never silently resolved in either direction.

Net effect: nothing in the storage, attribution, or API design blocks chain
instantiation — and when it lands, the work-items view becomes its instance monitor
(the endpoint gains `?instance=` addressing, nothing more).

Edge rules:

- **One run, several artifacts** (rare — a run that opens two PRs, or a `push` event
  fanning into several): the run is linked to each, flagged `shared`; if the artifacts
  belong to the *same* work item the question dissolves (counted once in the component);
  across different work items the shared portion is shown separately, never
  double-counted into totals.
- **Aborted runs** (crash/timeout → no `result` event): tokens were consumed but not
  recorded. Accepted as a stated limitation initially (the per-call `usage_sink`
  mechanism from #509 offers an upgrade path: accumulate per-assistant-message usage so a
  partial record survives). A *coverage* gap, not a wrong number — normal runs always
  emit `result`.
- **Sub-agent usage:** `modelUsage` aggregates the whole invocation including sub-agents
  (to be re-verified against the pinned agent-image CLI, currently 2.1.121 —
  `agent-image/Dockerfile:48` — as part of Phase 1 acceptance).

## 4. Data model & ingestion

### 4.1 Usage records (new, the workhorse)

One compact JSONL line **per invocation**, written at `result` time:

```json
{
  "ts": "2026-07-16T14:03:22Z",
  "agentId": "agent-studio-developer",
  "teamId": "agent-studio",
  "roleId": "developer",
  "flowInstanceId": null,
  "provider": "litellm-main",
  "correlationId": "trigger:dev-on-issue:gh:41234567890",
  "sessionId": "816d7386-…",
  "trigger": { "type": "github-event", "id": "dev-on-issue", "conversationKey": "issue:99" },
  "github": { "repo": "org/repo", "prNumber": null, "issueNumber": 99 },
  "git": { "repo": "repo", "branch": "agent/agent-studio-developer/issue-99", "headBefore": "ab12…", "headAfter": "cd34…" },
  "tokens": { "input": 10, "output": 42, "cacheCreationInput": 8141, "cacheReadInput": 17718 },
  "modelUsage": { "claude-sonnet-5": { "inputTokens": 532, "outputTokens": 54, "cacheReadInputTokens": 17718, "cacheCreationInputTokens": 8141 } },
  "durationMs": 191200
}
```

- `provider` is the Model-Provider endpoint that served the run (resolved from the
  agent's config/env at spawn time) — so the general statistic can group **per endpoint**
  as well as per model. Note the two differ: one gateway endpoint serves many models,
  and the same model id may appear behind two endpoints.
- `roleId` (best-effort, from the member's template/role) and `flowInstanceId`
  (reserved, `null` until chain instantiation ships) exist for §3.3: aggregation must
  survive ephemeral agent ids and be ready to key on flow instances.
- The CLI's `total_cost_usd` arrives in the same `result` event for free; it may be
  stored as an opaque extra field but is **not part of the contract and never surfaced**
  (scope decision 1).

**Ingestion path — central store via the orchestrator:** the agent runtime POSTs each
record to an internal orchestrator endpoint (the `_StatePushClient` channel that already
mirrors session state across the volume-isolation boundary is the template), and the
orchestrator appends to day-bucketed `/workspace/usage/usage-<date>.jsonl` — **single
writer**, exactly the proven github-event-log pattern (#469: writer in orchestrator,
reader in admin-console, day files). Fallback on unreachable orchestrator: append to a
local per-agent spool, retried by the existing push-retry loop. This sidesteps both the
multi-writer-one-file race and the control-plane-read / volume-isolation problem in one
move.

*(Alternative considered: per-agent `usage.jsonl` + reader-side merge — works, but needs
`controlOrAgentPath` allowlisting and a state-push mirror per agent file; the central
store is strictly simpler for a read path that is inherently cross-agent.)*

### 4.2 PR-link records (new, closes the one gap)

Appended by the orchestrator (already the single writer) from `agentCreatePr` /
`agentGitPush` success paths to `/workspace/usage/pr-events-<date>.jsonl`:

```json
{ "ts": "…", "kind": "pr-created", "agentId": "…", "teamId": "…",
  "repo": "org/repo", "prNumber": 731, "url": "…", "branch": "agent/…", "base": "main",
  "closes": [99], "correlationId": "trigger:…" }
```

- `prNumber` is parsed from the URL the handler already regex-extracts
  (`orchestrator.js:3591`).
- `closes` (issue links for the artifact graph, §3.1) is parsed from the PR body — which
  passes through `agentCreatePr` for stamping anyway — plus the head branch name.
- `correlationId` arrives via the new `AEE_CORRELATION_ID` passthrough (§3.2 tier A);
  absent (old agent image, manual shell) the record still lands with
  `correlationId: null` — tier C then covers attribution.

### 4.3 Retention

**Indefinite by default** (product decision): usage records are tiny — one line per
invocation, i.e. hundreds per day, not thousands per minute — so unbounded day-bucketed
JSONL growth stays trivially manageable for years. No automatic deletion; operators can
archive/prune day files manually. (If volume ever becomes a concern, monthly compaction
into per-work-item aggregates is the designed escape hatch — raw and compacted formats
are both pure-function outputs of the same records.)

## 5. Aggregation, API, UI

**Reader** (admin-console, pure + unit-tested aggregation module, mirroring
`github-event-log.js`'s reader). Two views, shipped in this order:

**View 1 — general token statistics (the intermediate step, valuable on its own):**

- `GET /api/usage/summary?since&until&groupBy=agent|team|model|provider|day[|trigger]`
  — token totals in all four classes, grouped; the **unattributed remainder** is simply
  "all of it" here — this view needs no attribution at all, only usage records.
- Answers "what does agent X / team Y / endpoint Z consume per day" from day one of
  capture, independent of any GitHub wiring.

**View 2 — work-item attribution (on top):**

- `GET /api/usage/work-items?since&until[&team=]` — one row per work item (connected
  issue↔PR chain): all four token classes per model, run count, agents involved,
  per-artifact and attribution-tier breakdown, shared flags, coverage.
- `GET /api/usage/work-items/:repo/:number` — drill-down (addressed by any artifact in
  the chain): every attributed invocation with tier, tokens, per-agent/stage split, and
  a deep-link into the existing session-log viewer (`correlationId` is already the join
  key the chat UI uses).

**UI — one new "Token Usage" page** (nav next to *GitHub Event Log*), two tabs matching
the views:

1. **Statistics** — summary cards + time series per team / agent / model / provider
   endpoint / day; the four-class split always visible.
2. **Work items** — the sales-show view: issue→PR chain, total tokens with class split,
   runs, agents, coverage indicator; drill-down per run.

Scoped by team membership like every other list endpoint (`computeScope`, #302).

**Deliberately later (not in the first cut):** flat export (CSV/JSON, one row per
work-item × model × token class) for downstream cost derivation; a PR comment posting
the token summary on merge; MCP/CLI exposure so budget-aware agents can query their own
consumption (#643 Q7). All three are read-side add-ons over the same records — nothing
in the storage design needs to anticipate them beyond what §4 already fixes.

## 6. Phasing

| Phase | Content | Runtime changes? | Yields |
|---|---|---|---|
| **1 — Capture + general statistics** | Runtime: persist `modelUsage` + git context, emit usage records via push channel; orchestrator: central day-bucketed store; admin-console: summary endpoint + Statistics tab | agent-image + orchestrator + admin-console | the product-owner's "Zwischenschritt": token consumption per agent/team/model/endpoint/day, live from day one — no attribution needed yet |
| **2 — Work-item attribution** | orchestrator: `pr-created` records + `AEE_CORRELATION_ID` passthrough in `gh-as-agent`; admin-console: artifact-graph builder + work-items endpoint + Work-items tab | orchestrator (small) + admin-console | tokens per issue↔PR chain with per-role breakdown |
| **3 — Read-side add-ons** | flat export, PR token comment on merge, MCP/CLI for budget-aware agents, soft budget alerts (token-denominated) | opt-in | governance depth, demo garnish |

Capture ships first and alone on purpose: records accrue while the attribution read side
is still being built, so by the time the work-item view lands there is real data behind
it. (A backfill over historical session logs was considered and **rejected** — scope
decision 2.)

## 7. The ticket's open questions, answered

1. **Attribution boundary** → the unit is the **work item** (connected issue↔PR chain,
   §3.1), derived from GitHub-native artifact links — no per-flow configuration, so
   dynamic Flow-Designer flows are covered by construction. Runs attach via explicit
   signals only (§3.2); multi-artifact runs flagged `shared`, never double-counted;
   runs without a signal stay visible as the unattributated remainder and in the general
   statistics.
2. **Token source of truth** → the Claude Code session stream (`result.usage` /
   `modelUsage`), i.e. the API's own response usage — available identically in direct,
   gateway, and subscription topologies, no gateway integration required. The gateway
   stays billing-authoritative for *invoices*; we are authoritative for *usage*.
3. **Pricing** → **out of scope by design.** We ship token counts per class, model and
   provider endpoint; whoever owns the contract prices derives money downstream (export
   in Phase 3). No price table, no estimated dollars in the product.
4. **Cache accounting** → resolved by reporting, not pricing: all four token classes
   (input / output / cache-write / cache-read) are first-class, per model, never
   collapsed irreversibly (§2 Rule 1).
5. **Storage & retention** → new day-bucketed JSONL stores under `/workspace/usage/`
   (usage records + pr-link records), orchestrator as single writer, admin-console
   reader; **indefinite retention**, operator-managed (§4.3). Audit log and
   github-event-log stay untouched.
6. **Privacy / scope** → subjects are *agents* (software roles), not humans, so the
   per-person-performance concern is structurally mild here; still, the landing view
   aggregates per team/work-item, per-agent detail sits one level deeper, and the
   endpoints honour team scoping (#302).
7. **MCP / agent exposure** → Phase 3: a read-only usage MCP (or `knowledge`-style CLI)
   so a budget-aware agent can ask "what have I consumed this week" — deliberately after
   the human-facing surface has stabilised.

## 8. Risks & verification duties

- **`modelUsage` on the pinned CLI (2.1.121):** verified on 2.1.204 locally; must be
  re-verified against the agent-image's pinned version before Phase 1 freezes the record
  schema (field has been stable across 2.x, low risk).
- **Sub-agent usage inclusion** in `modelUsage`: verify empirically (Phase 1 acceptance
  test), otherwise per-work-item figures undercount agentic runs.
- **Artifact-graph edges depend on discipline:** `closes #N` in PR bodies / issue numbers
  in branch names are conventions, not guarantees. The role templates and `gh-as-agent pr`
  guidance already push toward them; a missing link degrades gracefully (PR and issue
  appear as two separate work items — visibly, not silently merged into wrong ones).
- **Tier C false positives** (human pushes to an agent branch): mitigated by requiring
  agent authorship (`@agents.local`) on the joined commits; residual risk labeled by the
  tier badge.
- **Two-sided contracts:** the usage-record emitter lives in the Python runtime, the
  aggregator in JS — same discipline as the knowledge digest: shared golden fixture,
  asserted from both test suites, changed in one commit.
- Repo convention holds: aggregation/attribution logic as **pure, unit-tested modules**;
  IO shells thin.
