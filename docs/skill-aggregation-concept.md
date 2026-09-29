# Skill aggregation — from converged lessons to domain playbooks

Status: concept (2026-07-22). Companion to `docs/knowledge-skill-ux-concept.md` (the UX of
governing skills; phases cut as #774/#775/#776) — this document redesigns **what a skill is and
how it comes into existence**. It changes the content pipeline, not the grant/pool/activation
model.

> **Update (#2592, shipped):** the per-lesson amendment cards of §3.2 are superseded by the
> domain → skill pipeline in §3.6 — every domain grows into exactly one living skill.

## 1. Problem (verified against the current pipeline)

The convergence mechanism ("≥2 distinct agents learned a similar lesson" → skill candidate) uses a
*generality signal* as the *unit of skill creation*. Four structural consequences:

1. **Wrong altitude, guaranteed flood.** In teams with same-typed agents (two developers, three
   reviewers) it is *normal* that two agents learn the same thing — convergence at threshold 2
   (`DEFAULT_CONVERGENCE_THRESHOLD`, `knowledge-store.js`) fires constantly, and every crossing
   cluster raises its own candidate (`planNewSuggestions`, `knowledge-convergence.js`). One skill
   ≈ one lesson.
2. **Skills are verbatim lesson dumps.** On *every automatic path* the SKILL.md is the
   deduplicated lesson texts concatenated as bullets in a fixed template: the level-3 curator's
   `curatorSkillDraft`/`curatorThemeSkillDraft` (`knowledge-curator.js`) and the operator's
   prefilled draft (`buildHeuristicSkillDraft`, `knowledge-suggestions.js`) contain **no
   synthesis**. Real LLM abstraction exists only behind the human-triggered "Draft with AI" /
   extend-draft / merge calls. A skill is therefore *not* abstracted knowledge — it is a list.
3. **The curator never grows a skill.** The extend mechanism (#553) exists but is operator-only;
   `autoPromoteStep` always *creates* new skills and refuses to touch an existing SKILL.md.
   Fragmentation is built in: related knowledge accretes as new sibling skills, never into one
   maturing document.
4. **Aggregation machinery is ephemeral and nameless.** Themes (`groupRelatedClusters`,
   overlap-coefficient 0.3 over long text tokens) are recomputed from scratch every collector
   pass — nothing persists a topic, there is no taxonomy, and skill *names* are the first six
   slug-words of a lesson text (`slugifySkillName`) rather than a meaningful domain name.
   Entry `tags[]` exist but are read by nothing.

Meanwhile the **knowledge digest** already guarantees that conventions, converged and recent
lessons are in every agent's context at session start. A micro-skill that wraps a single converged
lesson adds *no delivery value* over the digest — it only adds governance noise.

## 2. Target model — the knowledge pyramid

Three layers with distinct jobs; the top layer is what changes:

| Layer | Unit | Job | Stays/changes |
|---|---|---|---|
| **Lessons** | fact / convention / entity | Episodic evidence, full detail, provenance | unchanged |
| **Digest** | ~3k-token generated file | *Guaranteed* in-context delivery of the small stuff | unchanged |
| **Skills** | **domain playbook** | Few, stable, structured documents that teach a *practice*: the abstracted flow plus its rules, gotchas and examples | **redefined** |

**A skill is a domain playbook, not a promoted lesson.** Target shape of a SKILL.md:

```
# <Domain name, human-meaningful>        e.g. "Dev workflow: branching, commits, PRs"
## When to use                            scope + audience roles
## The flow                               the abstracted process — the actual skill
## Rules & conventions                    hard rules distilled from lessons
## Gotchas & edge cases                   where individual lessons land as details
## Examples & snippets                    concrete material, clearly marked as examples
(provenance.json: evidence links to every contributing lesson, with convergence counts)
```

**Litmus test:** if it fits in a digest bullet, it is not a skill. Skills exist for structure and
flow that exceed the digest's budget — role-level or cross-role knowledge ("how we do
development" spans developer, reworker, reviewer), not single observations.

Convergence stops being the creation trigger and becomes **confidence metadata**: evidence weight
on the contributing lessons inside a skill's provenance ("this rule was independently learned by
4 agents"), surfaced in the UI, feeding review priority.

## 3. Mechanism — route and grow instead of spawn

### 3.1 Persistent domains (new, small entity)

A team carries a short list of **skill domains** — `{id, name, scope, roles[]}` — each mapping to
at most one living skill. Sources, in order:

- **Seeded** from role templates (a dev team starts with e.g. Dev workflow / CI & build /
  Repo conventions / Review practice).
- **Bootstrapped** once per team by an LLM pass over the existing lesson corpus ("propose 5–8
  domains covering these lessons"), operator-confirmed.
- **Operator-editable** at any time (rename, merge, split, add).

Domains are what today's themes wanted to be, made durable: the ephemeral per-pass
`groupRelatedClusters` output becomes a *stable* routing target instead of a one-shot card.

### 3.2 Routing: every converged cluster gets classified, not carded

When a cluster crosses convergence, the collector **routes** it instead of raising a
new-skill candidate:

1. **Digest-only** (default for single conventions/facts): no skill action at all — the digest
   already delivers it. This alone removes most of today's flood.
2. **Fits an existing domain** → the suggestion becomes an **amendment**: "Add to skill
   *Dev workflow* → section *Gotchas*". Cheap first pass: extend the existing
   `matchExistingSkill` token/lineage heuristic with domain vocabulary + entry `tags`; better:
   one batched LLM classification call per collector pass (all unrouted clusters in one request,
   heuristic fallback on failure).
3. **Fits no domain** → parked in an unrouted pool. Only when *mass* accumulates (≥N lessons
   across ≥M distinct sub-topics and ≥2 agents — thresholds well above today's "2 agents, 1
   lesson") does the collector propose a **new domain + skill**, with an LLM-suggested name and
   scope. Never one skill per lesson.

At **autonomy level 3** the curator may **auto-extend** (new — today forbidden): apply amendments
to existing team skills through the existing extend path, gated exactly like auto-promotion
(`resolvePromotionGates`, per-pass cap, feed events, review fallback). Creating a **new domain**
always stays a review card, at every level — domains are the taxonomy, and taxonomy is a human
decision.

### 3.3 Synthesis is the default, not a button

Every promotion/extension that actually writes a SKILL.md runs the **existing** LLM draft
machinery (`buildSkillDraftRequest` / `buildSkillExtensionRequest`) — including the automatic
paths — with a sharpened contract:

- generalize beyond the incident: express the *process*, not the occurrence;
- file each lesson into the right section (rule vs. gotcha vs. example);
- keep concrete snippets, but marked as examples of the abstract rule;
- never drop evidence: every contributing lesson id lands in provenance;
- bounded size budget per skill.

The heuristic bullet-dump survives only as the *failure* fallback, visibly marked
"un-synthesised" and queued for re-synthesis — never as the normal result.

### 3.4 Distillation pass (periodic refactor)

Repeated extensions degrade any document. After X amendments since the last distillation (or on
operator demand: a "Distill" action in the skill inspector), the curator re-synthesises the whole
skill from its accumulated content + provenance: dedupe, restructure, re-abstract, enforce the
size budget. The result is a **reviewed diff** (per gates/autonomy), a feed event, and a version
bump — the existing version/lineage machinery already carries this.

### 3.5 Forcing functions

- **Skill budget**: a soft cap (~5–15 skills per team) surfaced in the UI. Above it, the routing
  bias hardens: new-domain proposals require merging or explicit operator override — the system
  pushes toward aggregation instead of accretion.
- **Naming**: skill name = domain name. The lesson-slug generator (`slugifySkillName` on lesson
  text) is retired for skill naming.
- **Role tags**: domains carry `roles[]`; surfaced on skill cards ("for: developer, reworker")
  and available to later role-scoped grants. Cross-role flow skills are explicitly first-class.

### 3.6 One living skill per domain (#2592 — shipped)

Once a team has domains (`orchestrator/knowledge-domain-skills.js`, driven by the collector's
`_runDomainSkillPipeline`), no lesson-named team skill is created at autonomy ≥2:

- **Routing.** Only *converged* clusters are routed (digest routing runs first, so a
  convention/fact below the digest-only bar never reaches here). All new clusters are classified
  in **one batched LLM call per pass**, with the §3.3 heuristic as fallback; the method (`llm` /
  `heuristic` / `vocab`) is recorded on the row. A routed lesson is parked as `domain-queued`;
  a lesson that fits no domain is `unrouted` — digest only, counted towards a new-domain proposal,
  never its own skill — and is re-classified only after the domain list changes.
- **Per domain, one unit of work.** Extend when the domain skill exists; create when it does not
  and the queue meets the **first-skill threshold** (default ≥3 lessons from ≥2 agents, per team
  `domainSkillThreshold`, set in *Configure knowledge*); otherwise wait.
- **Per autonomy level.** Level 3 with the *Knowledge → team skill* gate on `auto` applies the
  work directly (within the shared per-pass cap; the rest waits for the next pass). Level 2, or a
  gate on review, raises **one card per domain** ("Create / update skill *Domain*", id
  `ds-<domainId>`) listing every pending lesson; accepting it can only create/extend that
  domain's skill. `GET /api/knowledge/promotion-suggestions` returns `domainId`, `domainName`,
  `domainSkill`; the card reads "→ *Domain*".
- **Settlement (G6).** A lesson is marked promoted only when its entry ids are in the provenance
  of the skill it went into. Every "skill already exists" path folds the lesson in (unioning its
  ids into provenance) rather than claiming it on a name match.
- **Budget.** Adding a domain, splitting one, or confirming a proposal at or over the soft skill
  budget answers `409 over-budget` until the operator confirms; declining changes nothing.
- **Taxonomy edits.** *Rename* keeps the domain id, so the skill (and its card) stays the same.
  *Remove* leaves the skill as an ordinary unassigned team skill; the domain's queued lessons
  are re-classified. *Merge/split* yield one skill per resulting domain via Consolidate (§4).
- **Consolidate.** A domain with ≥2 member skills merges them into a playbook; a domain with a
  single other skill folds it into the domain skill (a one-source `fold` merge); accepting a
  domain also queues its pending lesson cards for the domain skill. Team skills matching no
  domain are only folded in through Consolidate.

## 4. Migration — consolidating an existing team

One-time, operator-driven consolidation for teams that already accumulated micro-skills
(e.g. agent-studio: 12 skills + ~47 open candidates):

1. Bootstrap domains from the full corpus (skills + candidates + lessons), operator confirms.
2. Per domain: LLM synthesis of one playbook from all member micro-skills/candidates
   (the existing merge machinery, fed with more than two inputs).
3. Operator reviews each playbook in the promotion dialog; on accept, member micro-skills are
   archived with lineage to the new skill (existing archive + provenance chains), their grants
   replaced by the domain skill's grant.
4. Remaining candidates are routed per §3.2 — most will resolve to digest-only or amendments.

## 5. Interplay with the UX concept (#774–#776)

This concept reshapes what flows through the Phase-2/3 surfaces, not the surfaces themselves:

- The **suggestion inbox** stops being 47 new-skill cards and becomes mostly **amendment cards**
  ("Add to *Dev workflow*"), grouped by target skill instead of by ephemeral theme — strictly
  fewer, strictly more decidable.
- **Review mode** triages amendments (accept into section / dismiss) — even faster than
  promote-decisions.
- The **inspector's Origin tab** shows the evidence tree: domain → sections → contributing
  lessons with convergence counts.
- **Dismiss with memory** (#775) applies unchanged to amendments and domain proposals.

## 6. Explicit non-goals

- No change to lesson recording, the digest, canonical projection, or supervised review.
- No change to grants/activation/pools — a domain skill activates exactly like any skill today.
- No embedding infrastructure required: the `similarity()` seam stays lexical; routing quality
  comes from the batched LLM classification with heuristic fallback (the same
  target-resolution pattern as "Draft with AI").
- No fully-autonomous taxonomy: domain creation/merge/rename is always human-confirmed.

## 7. Phasing sketch

1. **Digest-only routing + auto-extend.** Suppress single-lesson candidates whose content the
   digest already delivers; let the level-3 curator extend existing skills via the existing
   extend path (gated). Biggest flood reduction for the least new surface.
2. **Domains + routing + default synthesis.** Persistent domain entity, batched classification,
   amendment cards, LLM synthesis on all writing paths, domain-based naming, skill budget.
3. **Distillation + migration tooling.** Periodic refactor pass, "Distill" action, one-time
   consolidation flow for existing teams.
4. **One skill per domain (#2592, shipped).** Domain queue, first-skill threshold, one card per
   domain, provenance-based settlement, over-budget confirmation — §3.6.
