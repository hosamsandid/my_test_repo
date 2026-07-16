# `knowledge` CLI + harvest — Phase 1 design

Reference design for **Phase 1** of the Shared Agent Learning & Knowledge Flow
(`docs/knowledge-sharing-concept.md` → "Phase 1"). Builds on the Phase 0 data
model, config and resolver (`docs/knowledge-store.md`). Phase 1 reaches
**autonomy level 1**: agents harvest durable facts into a shared, git-backed,
team-scoped Knowledge Base (KB) and can query it in real time, offline. Not yet
visible in the UI. Level 0 reproduces today's behaviour exactly.

Status: **design of record for #460** (approved decisions recorded in §0).

## 0. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | **Write/share path** | **Orchestrator-mediated.** The CLI builds the entry, appends to the agent's own shard and `git commit`s locally (attribution preserved); the credentialed push to the shared `agent-knowledge` branch runs through a new orchestrator internal endpoint (fetch-rebase-retry). Query stays 100% local/offline. Rationale: credentials, network isolation and the protected-branch guard already live in the orchestrator (as for `gh-as-agent push`). Accepts ~2 small additions to `orchestrator.js` beyond the concept's file list. |
| 2 | **Harvest scope** | **DM sessions *and* per-invocation runs** (level ≥ 1). Both weave the harvest guidance into their system-prompt hint. |
| 3 | **Concurrency** | **Per-agent shards** — each agent writes only `<kind>/shards/<agentId>.jsonl`; textual conflicts are impossible. Canonical `<kind>.jsonl` becomes the Phase-3 curated read view. |
| 4 | **Record** | Committed as this doc on `integration/knowledge-flow` + posted to issue #460. |

---

## 1. `knowledge` CLI contract

New file `agent-image/scripts/knowledge` (Python 3, on the agent PATH, installed
like `aee-artifact`). Mirrors `aee-artifact`'s conventions: `--help`/`help`
prints the module docstring; JSON-lines machine output under `--json`; tolerant
JSONL reads (a mangled line is skipped, never crashes a harvest).

**Exit codes** (aligned with `aee-artifact`): `0` success · `1` nothing found
(search/path with no hit) · `2` usage/validation error · `3` recognized but not
yet enabled (the `promote` stub only).

### `knowledge add <kind> "<text>" [flags]`

Records one durable statement with mandatory provenance.

```
knowledge add fact "This repo unit-tests pure helper cores only; IO is verified manually"
knowledge add entity "github-poller.js polls the Events API every 30s" --tag polling
knowledge add convention "Branch from origin/main" --source pr:459 --json
```

- `kind` ∈ `fact|entity|convention` (`knowledge-store.js` `KINDS`); else exit 2.
- Flags: `--tag <t>` (repeatable), `--source <kind:ref>` (repeatable; kind ∈
  `pr|issue|commit|branch|url`), `--json` (print the full entry), `--no-push`
  (append + commit locally, skip the orchestrator push — for tests/offline).
- **Provenance is stamped from the environment, never from user args:**
  `originAgent=$AGENT_ID`, `teamId=$KNOWLEDGE_TEAM_ID`,
  `correlationId=$KNOWLEDGE_CORRELATION_ID`, `sessionId=$KNOWLEDGE_SESSION_ID`
  (best-effort), `createdAt=now`, `convergence=[originAgent]`. The runtime always
  sets `KNOWLEDGE_CORRELATION_ID` at harvest time, so the mandatory
  provenance-link rule is always satisfiable; if none of
  correlationId/sessionId/sourceRefs is present the CLI refuses (exit 2) — same
  rule as `makeKnowledgeEntry`.
- Writes: append the serialized line to the agent's **own shard**
  `<store>/<dir>/shards/<agentId>.jsonl` → `git commit --author="<agentId>
  <…@agents.local>"` (via `gh-as-agent commit`) → push via the orchestrator (§3).
  Prints the new id.

### `knowledge search "<query>" [flags]`

Real-time, offline query over the synced working copy.

```
knowledge search "poller pagination"
knowledge search "npm install" --kind fact --json --limit 5
```

- Best-effort refresh first (§3 pull-on-demand) unless `--no-sync`; a refresh
  failure is silent and search proceeds over the last-synced copy (offline-safe).
- Matching: ripgrep (`rg`) over all `shards/*.jsonl` + any curated canonical
  `<kind>.jsonl`, then parse matched lines. Case-insensitive substring/regex on
  `text` (and `tags`). `--kind` filters; `--limit N` caps; `--tier`/`--source`
  reserved (labels shown now, filtering later).
- Output: default human line per hit —
  `[team] <text>  (id=<id> by=<originAgent> conv=<n>)`; `--json` emits full entry
  objects, one per line.
- Exit `0` if ≥ 1 hit, `1` if none.

### `knowledge list [flags]`

Inspection dump. `--kind <k>`, `--mine` (only `originAgent==$AGENT_ID`),
`--json`. Prints entries (human table or JSON lines). Exit 0.

### `knowledge path "<id>"`

Mirrors `aee-artifact path`: prints the store-relative file that holds the entry
(`facts/shards/<agent>.jsonl`) so a human/agent can open it. Exit `0` found · `1`
not found · `2` usage.

### `knowledge promote <id|cluster>` — stub

Prints `knowledge: promotion lands in Phase 3 (not yet enabled)` to stderr and
exits `3`. Present so agents/tests can discover the verb; intentionally a no-op.

### Pure core inside the CLI (testable, mirrors the JS core)

The CLI's construction logic is factored into importable pure functions, a
**Python mirror** of `orchestrator/knowledge-store.js`:
`build_entry(kind, text, *, origin_agent, team_id, correlation_id, session_id,
source_refs, tags, now, id_gen)`, `serialize_entry(entry)` (identical
`KEY_ORDER` to JS), `parse_entry(line)`, `validate_entry(entry)`,
`match_entries(entries, query, kind)`. No fs/network — those live in thin
`cmd_*` wrappers, exactly as `aee-artifact` separates `read_entries` from
`cmd_*`.

---

## 2. Harvest hook (DM + per-invocation)

**Mechanism = LLM-in-the-loop, not a post-hoc parser.** Like today's
memory/log.md guidance, the hint instructs Claude to call the CLI itself for each
durable lesson. No stdout scraping.

One pure function, mirrored in both runtimes:

```
build_harvest_hint(autonomy_level: int) -> str
```

- `autonomy_level < 1` → returns `""` → hints are exactly today's text. **This is
  level 0 == today.**
- `autonomy_level >= 1` → returns an appended block, roughly:

  > In addition to memory files, for each durable lesson that would help *any*
  > teammate on this repo (project conventions, environment facts, key entities),
  > record it in the shared team knowledge base:
  > `knowledge add fact|entity|convention "<one-line statement>"`
  > Provenance is attached automatically — no PR/issue-specific detail, only
  > lessons that hold beyond this run. First run `knowledge search "<topic>"` to
  > avoid restating something already recorded. Nothing to add → skip.

Wired into **both** run kinds at level ≥ 1:

| Run kind | Where the hint is appended | correlationId source |
|---|---|---|
| **DM** (persistent) | alongside the memory hint (`_build_memory_hint`) | the Matrix `event_id` of the message |
| **Per-invocation** (cron/github/http) | the existing `learn_hint` block | the run's computed `correlation_id` |

At invocation the runtime exports into the claude subprocess env:
`KNOWLEDGE_CORRELATION_ID` (per message/run), `KNOWLEDGE_TEAM_ID`,
`KNOWLEDGE_SESSION_ID` (if a resume id is known). These are what the CLI reads to
stamp provenance. The `search`-before-`add` nudge is the cheap Phase-1 stand-in
for real dedup (Phase 3).

DM continuity is untouched: harvesting is a prompt-level instruction, not a
session-pointer change.

---

## 3. KB working-copy sync

**Location.** `/workspace/agents/<id>/knowledge/` — a dedicated checkout,
separate from the agent's repo clone (which sits on a feature branch). In
`in-repo` mode it's a clone of the resolved KB repo checked out on the shared
**`agent-knowledge`** branch, KB rooted at `knowledgeStore.path` (default
`docs/agent-knowledge/`). In `own-repo` mode, the KB repo, same branch. The
branch name is a documented constant; never a protected branch.

**Seed-time** (orchestrator, in `seedAgentWorkspace`, gated on
`knowledgeAutonomyLevel(env) >= 1`). After the existing clone step: provision the
KB checkout — clone the KB repo, `git checkout -B agent-knowledge
origin/agent-knowledge`, creating the branch from the shipped template
`orchestrator/knowledge-template/` + `buildDefaultManifest()` when it doesn't
exist yet (first-agent bootstrap). Reuses the per-env clone cache. Best-effort:
failure logs a warning and the agent still runs (KB unavailable → that agent
degrades to level-0 behaviour).

**Pull-on-demand.** `knowledge search`/`list` run a timeout-bounded
`git fetch && git checkout` of `agent-knowledge` before reading. Failure is
silent → reads the last-synced copy. This is what makes queries real-time
without a service.

**Conflict-avoidance (two layers).**
1. **Per-agent shards** — each agent only appends to
   `<dir>/shards/<agentId>.jsonl`; two agents never write the same file, so
   textual/JSONL conflicts are impossible. Phase 1 `search` globs shards (+ the
   canonical `<kind>.jsonl` if a curator has produced one).
2. **Push ref-race** — concurrent pushes to `agent-knowledge` can be
   non-fast-forward. The orchestrator push endpoint does `fetch → rebase → push`,
   retrying ≤ 3× (clean, since different files).

**New orchestrator endpoint** `POST /internal/agents/:id/knowledge/push` —
mirrors `agentGitPush` but targets the `knowledge/` checkout, allows the
`agent-knowledge` branch only (bypasses `PROTECTED_BRANCHES` for that one
validated constant), and wraps the push in fetch-rebase-retry. Credentials via
the existing `buildRepoGitEnv`. The `knowledge` CLI calls it directly (curl), the
way `gh-as-agent` calls `/git/push`.

---

## 4. Autonomy dial wiring (levels 0/1)

- `knowledgeAutonomyLevel(env)` (exists, default 1, clamped) is the single source
  of truth. The orchestrator resolves it at spawn/seed and **injects env vars**
  into the agent container: `KNOWLEDGE_AUTONOMY`, `KNOWLEDGE_TEAM_ID`,
  `KNOWLEDGE_STORE_PATH`, `KNOWLEDGE_BRANCH=agent-knowledge`. No Python
  re-implementation of the dial — the level is computed once in JS and passed
  down.
- **Level 0**: seed skips KB provisioning; `build_harvest_hint` returns `""`; CLI
  installed but unused. Byte-for-byte today's behaviour.
- **Level 1** (default): seed provisions the KB checkout; DM and per-invocation
  runs get the harvest hint; agents share + query. Levels 2/3 read as ≥ 1 for
  Phase 1 (harvest on); their extra automation lands in Phases 3/4.

---

## 5. Test plan (pure cores only, per repo convention)

**Python — new `agent-image/scripts/test_knowledge.py`** (stdlib-unittest +
importlib, like `test_agent_entrypoint.py`):
- `build_entry`: fills defaults; seeds `convergence=[originAgent]`; **throws**
  without a provenance link; `correlationId` alone satisfies the link; rejects
  bad `kind`; id is 12-hex.
- `serialize_entry`: key order **byte-matches** the JS `KEY_ORDER` (a shared
  golden string asserted in both Python and JS tests — the cross-runtime guard).
- `parse_entry`: tolerant (mangled line → None).
- `match_entries`: substring/kind filtering.

**Python — additions to `test_agent_entrypoint.py`**:
- `build_harvest_hint`: `""` at level 0; contains `knowledge add` at level ≥ 1.

**JS — `orchestrator/agent-runner.js` reference**: mirror `buildHarvestHint`; add
a `node --test` asserting `""`/`knowledge add` cases + the shared golden
serialization string. `knowledge-store.js` is already covered (Phase 0).

**Pure git-plumbing helpers** (orchestrator): a tiny pure module for
shard-filename building + the retry-decision predicate, unit-tested; the actual
clone/push IO is **not** unit-tested (convention).

**Manual (documented in the PR):** run a multi-agent team, watch
`agent-knowledge` fill from multiple agents, confirm shards don't conflict and
`knowledge search` returns cross-agent hits mid-run (inspect via `git log`).

---

## 6. Files touched

- **New:** `agent-image/scripts/knowledge` (CLI + pure core),
  `agent-image/scripts/test_knowledge.py`, this doc.
- **Edit:** `agent-image/scripts/agent-entrypoint.py` (harvest hint in DM +
  per-invocation paths, env export), `orchestrator/agent-runner.js` (mirror +
  `node --test`), `agent-image/CLAUDE.md` (a `knowledge` section next to
  `aee-artifact`), `orchestrator/orchestrator.js` (seed-time KB provisioning +
  `/internal/agents/:id/knowledge/push` + env-var injection),
  `agent-image/Dockerfile` (put `knowledge` on PATH).
