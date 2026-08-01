# Concept: Episodic Knowledge — decision of record

**Status:** Decision spike for #920 (Gap 6 of the KM future-proofing epic #914) — **decided, no implementation off this document**; the winning option's implementation ticket is filed separately and carries its own acceptance criteria.
**Relates to:** `docs/memory-knowledge-unification-concept.md` §2 (the deliberate semantic/episodic split this spike re-examines), `docs/knowledge-flow.md` §7 (session logs + `correlationId` drill-down — the raw material), the harvest pipeline (`orchestrator/harvest-block.js` ↔ `parse_harvest_block()`), `docs/knowledge-curation.md` (proposals-only forgetting doctrine, #919).

## 1. Problem, and why this is a spike rather than a ticket

The KB captures *what is true* (`fact | entity | convention` — `orchestrator/knowledge-store.js:26`, mirrored in the CLI and the harvest block) but not *what happened*: "last time we tried X it failed because Y". That narrative continuity exists today only as raw session logs (drill-downable via `correlationId`, but not searchable, not convergeable, not promotable) and each agent's private `memory/log.md`.

The obvious fix — a fourth KB kind — would reopen a boundary the architecture drew **on purpose**: semantic knowledge lives only in the team KB; episodic/private content (`context.md`, `log.md`, `users.md`) stays in `memory/`, and `users.md` is never shared, never migrated (unification concept §2, locked). At the same time, Anthropic's native Memory Tool is emerging as a *second writer* of exactly this class of content. Both facts make this a decide-first problem: build the wrong shape and we erode a privacy boundary *and* inherit a two-writers-one-truth conflict.

## 2. Options considered

| | Option 1 — new `episode` KB kind | Option 2 — promotion-only distillation | Option 3 — separate episodic store |
|---|---|---|---|
| Shape | 4th kind in `KINDS`; episodes are first-class shared entries | episodic stays private in `memory/log.md`; the **existing harvest path** is extended so recurring/hard-won episodes are explicitly distilled into `fact`/`convention` entries carrying an `episode` tag + `sessionId` provenance | new store sharing shard/git/provenance machinery but separate folds/UI |
| Cost | touches `KINDS` in **every** mirror: store JS+Py, harvest-block JS+Py (+ golden fixture), CLI, digest builders JS+Py (+ golden fixture), graph folds, UI lanes, manifest | near-zero code: harvest-hint prompt text + a tag convention + docs | highest; duplicates the entire lifecycle (folds, digest, convergence, review, decay) |
| Privacy | weakest — raw narrative is shared **by default**, and narratives are exactly where names, blame and personal context live | strongest — distillation is the filter: an episode only leaves the agent as an explicitly phrased, durable lesson | medium — same default-share risk as 1, plus more surface to audit |
| Convergence | needs new semantics ("same failure" ≠ token overlap; would gate on #918 embeddings) | inherits fact/convention convergence **unchanged** — a distilled lesson converges exactly like any other lesson | needs everything new |
| Single-writer compatibility (§4) | poor — a shared episode store is precisely what the native Memory Tool will also write | good — the KB stays the only durable/shared writer; the Memory Tool's territory (in-session narrative) is never a shared store here | poor — a *third* writer |

**Evaluation criteria, in the ticket's priority order:** privacy enforceability · operator surface simplicity · convergence semantics soundness · implementation/maintenance cost · compatibility with the single-writer rule.

## 3. Decision

**Option 2 — promotion-only distillation.** Episodic narrative stays agent-private; what crosses into the shared KB is a *distilled, durable lesson* (`fact` or `convention`) tagged `episode` and carrying `sessionId`/`correlationId` provenance, emitted through the existing end-of-run harvest block. Nothing new to fold, converge, digest, review, decay, or render — an `episode`-tagged lesson rides every existing pipeline unchanged, including #915 retrieval telemetry, #916 validity, #917 auto-load triggers and #919 decay.

Reasoning against the alternatives, per criterion:

1. **Privacy enforceability** (the hard constraint): Options 1/3 share narrative by default and then try to filter it; Option 2 inverts the default — nothing episodic leaves the agent unless it has been rephrased into a lesson. The filter is the act of distillation itself, backed by the same review queue supervised-mode teams already have. This is the only option where "personal content is structurally unable to leak" is true by *construction* rather than by instruction.
2. **Operator surface:** zero new lanes, browsers, or workflows. An operator who ignores episodes loses nothing (the ticket's explicit bar). The Knowledge page shows distilled lessons with full provenance drill-down (lesson → session → `correlationId`) exactly like today.
3. **Convergence soundness:** "same failure, different words" is an open research-grade matching problem (cause→remedy structure, #918 embeddings). Option 2 sidesteps it: two agents that hit the same failure and both distill it produce two *lessons*, which converge with the machinery we already trust.
4. **Cost:** a prompt-text change plus a tag convention versus touching two byte-identity golden fixtures, two mirrored enums, and every fold in four places.
5. **Single-writer rule:** see §4 — Option 2 is the only shape under which the rule stays one sentence.

**What would change this call:** if, after ≥ one quarter of real use, (a) `episode`-tagged lessons demonstrably converge poorly because the *narrative* was the value (not the distilled rule), or (b) the #915 telemetry shows operators repeatedly reaching into raw session logs for the same past incidents, then Option 1 gets a re-spike — gated on #918 embeddings for narrative convergence and on the §5 privacy line being enforceable at write time. Auto-summarisation of sessions into episodes stays out regardless (deferred in the ticket, reaffirmed here).

## 4. The single-writer rule (decision B — gates the epic's parallel-writers red flag)

> **Rule (testable): For any durable, shared, or curated piece of knowledge there is exactly one system of record — the Agent Studio KB — and exactly one write path into it — the harvest→push choke-point (`parse_harvest_block` → `knowledge add` → `POST /internal/agents/:id/knowledge/push`). The native Claude Memory Tool owns only in-session/short-term working memory inside one agent's container; nothing it writes is shared, synced, or read by another agent, and anything worth keeping crosses into the KB via the harvest path — never by both systems writing the same fact.**

- **Enforcement point:** the workspace-isolation boundary plus the push endpoint. Agent containers mount only `agents/<id>` (`spawn-container.js`), so a Memory Tool writing files can *physically* reach only agent-private storage; the sole route into shared state is the orchestrator's push endpoint, which accepts only schema-validated `fact|entity|convention` entries with mandatory provenance. The rule is therefore already structurally enforced today; this document fixes it as policy so a future Memory-Tool integration must route through harvest rather than being granted a second path.
- **What happens to `memory/log.md`:** it remains the agent's episodic notebook and the Memory Tool's natural home. Its curation stays per-agent (self-curation crons). It is now also, explicitly, the *staging area* for distillation: the harvest hint (see the follow-up ticket) instructs the agent to review the episode it just lived and its log for lessons that generalise, then emit them as tagged harvest lines. `users.md` is untouched by all of this: never shared, never migrated, never harvestable (unification concept §2 stays locked).

## 5. The privacy line (decision C)

**Framing: allowlist, enforced at two points.** Blocklists ("nothing mentioning persons") fail open on novel content; an allowlist fails closed.

> **Eligible to leave the agent is only: a technical outcome narrative distilled to a durable lesson — what was attempted on which system, what failed or succeeded, and the technical cause or remedy — phrased without reference to any person, user, chat content, or `users.md` material.**

A reviewer checks any concrete candidate against three questions: (1) is it phrased as a reusable lesson rather than a story? (2) does it name only systems/repos/tools, never people or their behaviour? (3) would it still be true and useful for an agent that wasn't in the original session? Three yeses ⇒ inside the line.

- **Enforcement point 1 — harvest time (always on):** the harvest hint states the allowlist; the runtime's harvest parser only accepts schema-shaped lessons (free narrative doesn't parse), and `users.md` content has no harvest path at all.
- **Enforcement point 2 — review queue (supervised mode):** teams running `knowledgeReview` get every distilled lesson as a `pending` entry; the reviewer applies the three questions above. Teams that want a hard human gate on episodic distillation simply enable review mode — no new mechanism.

## 6. Convergence semantics for narratives (decision D)

Not applicable under Option 2 — distilled lessons converge as ordinary facts/conventions. Recorded for a future Option-1 re-spike: raw episode convergence would need cause→remedy structuring and semantic (not lexical) matching, i.e. it gates on #918; do not attempt it with Jaccard similarity.

## 7. Follow-up

One implementation ticket (filed with this spike, linked from #920) covers the whole of Option 2:

- Extend the harvest hint (both runtimes' hint text, one commit) with the distillation instruction + the §5 allowlist phrasing.
- Establish the `episode` tag convention (documentation + the hint; no schema change — `tags` already exists) and `sessionId` provenance on distilled lessons (already carried by `knowledge add`).
- Document the flow in `docs/memory-knowledge-unification-concept.md` (§2 table row for `log.md` gains "staging area for distillation") and `knowledge-cli.md`.
- Explicitly out of scope there too: auto-summarisation, new kinds, any Memory-Tool integration beyond the §4 rule.
