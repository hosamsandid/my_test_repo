# Concept: Memory ↔ Knowledge Unification (semantic vs. episodic)

**Status:** Phases 0–3 implemented (Full-Learn fix `4749720`, knowledge digest `95b9028`, semantic rerouting `7c8893d`, migration + digest indicator — see git log); phase 4 (curator-refined digest) optional/open
**Relates to:** Knowledge pipeline (harvest → convergence → promotion → activation, see `docs/knowledge-skill-activation-concept.md`), agent memory system (`memory/*.md`), Full-Learn button, Workspace Browser

## 1. Problem

Agents currently maintain **two disconnected stores for the same class of knowledge**:

| `memory/` file (per agent, private) | Knowledge KB (team, shared) | Redundant? |
|---|---|---|
| `facts.md` — atomic facts | kind `fact` | ✅ fully |
| `entities.md` — projects, systems, frameworks | kind `entity` | ✅ fully |
| (conventions scattered into facts/entities) | kind `convention` | ✅ KB is even more precise |
| `context.md` — current session state | — | ❌ genuinely private & ephemeral |
| `log.md` — conversation journal | — | ❌ episodic, agent-scoped |
| `users.md` — per-person interaction profiles | — | ❌ **must never be shared** (personal data) |

Consequences: the same insight lands in one store, the other, or both, depending on
prompt mood; **two competing curation paths** (per-agent self-curation crons prune
`memory/`, while the KB has convergence → review → promotion → activation) with no
bridge; the Full-Learn button routes everything into private memory, invisible to the
team and to the Knowledge page; and the "agents read facts.md at session start"
guarantee is an illusion — the memory hint merely *asks* the agent to read files.

## 2. Decisions (made)

| Question | Decision |
|---|---|
| Unify? | **Yes — along the semantic/episodic boundary.** Semantic knowledge (facts, entities, conventions) lives **only** in the team KB; episodic/private content (`context.md`, `log.md`, `users.md`) stays in `memory/`. |
| "Knowledge must be *there* at session start, not searched for" | **Guaranteed context injection via a generated digest** (`knowledge-digest.md`, `@`-imported by CLAUDE.md — see §3). Search is the long-tail complement, never the only access path. |
| **Transparency for the user** | **The workspace is the truth.** The digest and the KB checkout are real, browsable files in the agent workspace, kept current **event-driven** (not just pre-invocation), so a user navigating the Workspace Browser always sees the agent's actual current knowledge — nothing lives "only in the background". |
| Autonomy 0 (no KB checkout) | Legacy five-file memory model stays as fallback, selected by the same autonomy gate that already drives `build_harvest_hint()`. |
| `users.md` | Never shared, never migrated — personal data stays agent-private. |

## 3. Target model: the knowledge pyramid

**Level 1 — Digest, guaranteed in context.**
A generated `knowledge-digest.md` in the agent workspace root, referenced from the
seeded CLAUDE.md via a native **`@`-import** — the same mechanism as
`@AGENT-PROMPT.md` (#510). Claude Code inlines `@`-imports unconditionally at
session start: no tool call, no instruction the agent must obey. This is *stronger*
than anything the memory files ever provided.

Digest content (deterministic, no LLM required), under a hard token budget (~2–4k),
prioritized:

1. **All `conventions`** — few, highest value ("this is how we do things here"); when the budget truncates, ordered by confirmation count desc then newest first (so the most-confirmed and freshest survive, not simply the oldest)
2. **Converged entries** (independently learned ≥2× = validated), by convergence count
3. **Recent entries** (last N days)
4. Whatever exceeds the budget stays reachable via Level 2.

**Regeneration — two triggers, one writer contract:**

- **Pre-invocation (guarantee for the LLM):** the agent runtime
  (`agent-entrypoint.py`) rebuilds the digest from the local KB checkout before every
  Claude invocation (a grep + sort, milliseconds). Per-invocation agents — which
  today inherit *nothing* between runs — see the current team state on every run.
- **Post-KB-change (guarantee for the human):** the orchestrator regenerates the
  digest of every materialized agent of a team whenever that team's KB changes
  (hook into the existing post-push `refreshKnowledgeClone` / `emitKnowledgeHarvest`
  path). A user browsing the workspace between invocations therefore sees the
  *current* digest, not a stale artifact of the last run.

The digest builder is **one pure module** used by both sides (a small JS module for
the orchestrator + a byte-equivalent Python port in the runtime, drift-guarded by a
test — same pattern as the memory-hint contract).

**Digest file header (transparency):** the file starts with a generated banner —
source (team id), generation timestamp, entry counts per kind, budget usage, and
"generated — do not edit; contribute via `knowledge add`" — so a human reading it in
the Workspace Browser understands exactly what they are looking at and where it came
from.

**Level 1.5 — task-scoped auto-load (#917).** The middle layer between the
evergreen digest and the model's own judgement to search: entries carrying
operator-set `loadTriggers` (`keyword` = whole-word match on the invocation
prompt; `path` = glob against the prompt's path-shaped tokens) are injected
per invocation into a **separate** file, `knowledge-scoped.md`, `@`-imported by
CLAUDE.md next to the digest. Deliberately **single-writer** (the Python
runtime — the only place the prompt and the KB meet; the orchestrator seeds an
empty-state stub so the import never dangles) and therefore **no byte-identity
mirror**: the digest's promptless pure cores and golden fixture stay untouched.
Own 1k-token budget, converged-first, with an omitted-footer naming what didn't
fit; entries fold through `visible_entries` first, so hidden/expired knowledge
never trigger-loads. Each build reports its injected ids as the `scoped`
retrieval signal (#915). Transparency: the file is browsable in the Workspace
Browser and each block names which trigger matched.

**Level 2 — `knowledge search` for the long tail.** Everything beyond the digest
budget. The memory hint instructs topic-driven search; the CLI already exists.

**Level 3 — Skills.** Proven, procedural knowledge — the promotion + activation
chain (previous concept).

## 4. Transparency principle (hard requirement)

*What the agent knows must be visible where the user already looks.*

- **Workspace Browser:** `knowledge-digest.md` sits in the workspace root (top-level,
  not buried); the KB checkout directory is browsable as today. Both are always
  current per the event-driven regeneration above.
- **CLAUDE.md:** carries the visible `@knowledge-digest.md` import line — a user
  inspecting CLAUDE.md sees that (and how) knowledge enters the context.
- **Agent-chat Knowledge tab:** already lists the concrete learned entries; gains a
  small "digest" indicator (when the entry is currently inside the digest budget) so
  the user can tell guaranteed-in-context knowledge from search-only long tail.
- **No hidden channels:** the digest is the *only* injection path; there is no
  invisible server-side prompt stuffing. Context injection ≡ file content ≡ what the
  browser shows.

## 5. Full-Learn button rework (independent quick fix, ships first)

The chat toolbar's **Full Learn** predates the pipeline: its prompt routes
everything into `memory/*.md` and never mentions the KB. Rework (frontend-only):

- Prompt routes **episodic → memory** (`context.md`, `log.md`, `users.md`) and
  **semantic → `knowledge add fact|entity|convention`** (search first; "skip if the
  team knowledge base is not available" covers autonomy 0), wording aligned with
  `build_harvest_hint()` so the two can't drift.
- Tooltip: "…saves session state to its memory files and shares durable lessons
  with the team knowledge base."
- The right-rail Knowledge tab refreshes after the learn reply, so the user *sees*
  the button feeding the pipeline.

After unification this simplifies further (facts/entities routing disappears).

## 6. Migration

One-shot, per agent, at the flip to the unified model (autonomy ≥ 1 squads only):

1. Parse existing `memory/facts.md` / `memory/entities.md` lines into KB entries
   (`kind: fact` / `entity`), provenance `origin: migrated:<agentId>` — convergence
   then naturally deduplicates identical lessons across members.
2. Archive the two files as `memory/_archive/facts.md` (visible, not deleted).
3. The memory hint / CLAUDE.md Memory section for that agent switches to the
   three-file episodic model + pyramid instructions.

Autonomy-0 agents and standalone agents without a KB checkout are untouched
(legacy model), automatically upgraded if their team's dial is later raised.

## 7. Contracts touched (implementation map)

| Contract | Change |
|---|---|
| `_build_memory_hint()` ↔ `buildMemoryHint()` (byte-identical, test-guarded) | New pyramid wording (digest is auto-injected; episodic files; search for long tail), changed **on both sides in one commit**; autonomy-gated variant selection. |
| CLAUDE.md template — Memory System section | Two variants: unified (3 episodic files + digest note) vs legacy (5 files), gated in `prompt-assembly.js` like the Skills/Git sections. |
| Seeded CLAUDE.md | Adds the `@knowledge-digest.md` import (only when a KB checkout is provisioned); seeding writes an initial digest so the import never dangles. |
| `agent-entrypoint.py` | Pre-invocation digest rebuild; digest builder port. |
| Orchestrator | Post-KB-change digest fan-out (hook in `emitKnowledgeHarvest` / KB sync); pure `knowledge-digest.js` builder + unit tests. |
| Self-curation cron templates (role catalog) | Prune scope shrinks to episodic files; KB curation already belongs to the curator. |
| `LEARN_PROMPT` (ChatPanel) | §5, then simplified post-unification. Superseded: the button *and* the prompt were removed entirely in #1922 — the automatic per-invocation memory hint is the single source of the consolidation instruction. |
| Docs | CLAUDE.md (this repo), `agent-image/CLAUDE.md` memory/knowledge sections. |

## 8. Phases

1. **Phase 0 — Full-Learn fix** (§5). Independent, frontend-only, immediate value.
2. **Phase 1 — Digest, additive.** Pure builder (JS + Python port, drift-guarded),
   pre-invocation + post-change regeneration, `@`-import in CLAUDE.md, initial
   digest at seeding, header banner. Old memory model stays untouched — this phase
   only *adds* guaranteed visibility. Ships alone; already de-risks the user's
   "knowledge must be there" concern before anything is removed.
3. **Phase 2 — Semantic rerouting.** Unified memory-hint + CLAUDE.md variants
   (autonomy-gated): stop instructing writes to `facts.md`/`entities.md`, route
   semantic learning to `knowledge add`. Files still exist (read-compatible).
4. **Phase 3 — Migration + retirement.** One-shot import (§6), archive the two
   files, digest indicator in the Knowledge tab.
5. **Phase 4 (optional) — Curator-maintained digest.** At autonomy 3 the curator may
   compress/refine digest entries (LLM summarization) within the same budget —
   still written to the same visible file.

Each phase is independently shippable; phase 1 is pure gain with zero removal risk.
