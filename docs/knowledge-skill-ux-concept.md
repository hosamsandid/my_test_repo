# Skill management on the Knowledge page — UX redesign concept

Status: concept (2026-07-22). Companion to `docs/knowledge-skill-activation-concept.md` (the
technical activation model, which this concept does **not** change) — this document redesigns the
*end-user experience* of governing skills inside the team-scoped Knowledge Flow page
(`admin-console/src/pages/KnowledgeFlow.jsx`, right column).

## 1. Problem (verified against the current code)

1. **Blind activation.** The skill card never shows content. Its external-link goes to the
   *unfiltered* Skills Registry (`SkillsRegistry.jsx` ignores the `?team=` param; there is no
   per-skill deep link) — even though the content APIs already exist
   (`GET /api/skills/:name/content`, `/files`, `/file`).
2. **Hidden, per-agent rollout control.** That the `active · N/M` badge is clickable (opening the
   per-member list with "Sync now") is undiscoverable; there is no holistic rollout view and no
   bulk action of any kind for skills.
3. **Deactivation wears three costumes.** A bare `×` icon, the "Remove this skill" banner button
   (sourceMissing case) and the trash icon look like three different things; two of them are the
   same `/api/knowledge/deactivate` call, the third really deletes. Nothing explains the
   consequence (file stays in pool, removed from workspaces).
4. **Status jargon.** "promoted · not activated" = file in team pool, name not in the team's
   `skills[]`. "active · N/M" counts seed manifests against *all* member configs incl. stubs and
   override members — and the post-activate flash computes a *different* denominator than the
   badge (fan-out members vs. all members: "4/4" flash vs. "4/6" badge).
5. **Suggestion flood.** `GET /api/knowledge/promotion-suggestions` returns all open candidates
   with no limit, no sort, no grouping; the page stacks one card each under the real skills. There
   is no dismiss, no merge-of-suggestions, no ranking — the column grows unbounded.
6. **One card type for four life phases.** Active, promoted-inactive, suggested and private agent
   skills share one column in one visual language; the lifecycle (and thus the pending decision)
   is unreadable.

## 2. Core idea — skills are a pipeline, not a list

The user has exactly **one** question per life phase. Make the phases the ordering principle of the
skills column: three stations, each with its own question and tools.

| Station | User question | Tools |
|---|---|---|
| **Suggested** | Is this worth it? | Ranked + themed inbox; review mode; promote / merge / dismiss |
| **Ready** (today: "promoted · not activated") | Should the team use it? | Content preview, one-click Activate — or leave it in the library |
| **In use** | Is it reaching everyone? | Rollout health as a sentence; explicit exceptions; a named, explained Deactivate |

Private agent skills stay a clearly separated fourth source feeding the pipeline via *Lift to team*.

Design principles:

- **Row, not card; details in an inspector.** The column shows one compact row per skill;
  everything else opens in a slide-over drawer. No registry round-trip to see content.
- **One team switch; exceptions are explicit.** Activation is a team decision. Individual agents
  are *exceptions* managed in the Rollout tab — not the default path clicked one by one.
- **Every action named, every consequence explained.** No icon-only actions.
- **Counters tell a sentence.** "Installed on all 10 agents" instead of `active · 10/10`; one
  counting basis everywhere (denominator = members that *should* receive the skill; overrides and
  stubs are annotated, not silently counted as failures).
- **Suggestions are an inbox** — capped, ranked, themed, and *completable* (promote/merge/dismiss).

## 3. The redesigned skills column (Wireframe A)

- Segmented lifecycle tabs **In use (n) · Ready (n) · Suggested (n)** with a "new evidence" dot on
  Suggested; default tab is In use, so suggestions no longer flood the column.
- Search/filter across tabs.
- One row per skill: name, tier metatext (`global` / `team · auto-promoted`), health sentence
  (`✓ Installed on all 10 agents` / `⟳ Installing — 8 of 10, 2 syncing…` /
  `9 of 10 · 1 agent keeps its own skill list` / `⚠ Source file missing`).
- Whole row is clickable → inspector. No icon strip on the row.
- Checkbox multi-select with a bulk bar per tab: Deactivate/Share (In use), Activate (Ready),
  Merge/Dismiss/Promote (Suggested).

## 4. Skill inspector drawer (Wireframe B)

One slide-over for every skill-shaped thing (active, ready, suggested, private):

- **Header**: name, one status pill (`Suggested` / `Ready` / `In use`), provenance as metatext
  (auto-promoted by curator · v3 · updated …).
- **Content tab**: rendered SKILL.md + file list — pure frontend on the existing
  `/content`/`/files`/`/file` endpoints. For suggestions: the draft content.
- **Origin tab**: for suggestions the underlying lessons (which agents, when); for skills lineage
  + version history (APIs exist, Registry-only today).
- **Rollout tab**: per-member matrix — `✓ installed`, `⟳ syncing… [Retry]`,
  `excluded — own skill list [Include]`, `not materialized yet`; plus drift surfacing
  (`outdated → Update available`; diverged/conflict get an explanatory note). Footer: "Sync all
  pending".
- **Action footer**: `Deactivate…` (confirm sheet: "The skill stays in the team library. It will
  be removed from all 10 agent workspaces on the next sync. You can activate it again at any
  time."), `Open in Skill Editor ↗` (a **working** deep link: `SkillsRegistry` learns to read
  `?skill=&tier=&team=`), overflow `⋯` menu with `Share…` and destructive `Delete…`
  (snapshot-restorable). The card-level `×` icon, the "Remove this skill" banner and the trash
  icon are removed.

## 5. Suggestion inbox (Wireframe C)

- **Ranking by evidence** (agents × lessons × recency) as default sort — fields already exist on
  candidates (`lessonCount`, agents, timestamps).
- **Theme groups**: the curator's `source: 'related'` bundles (#604) become visible group headers;
  within a group, *Merge* is the obvious bulk path.
- **Cap + full view**: column shows top 10; "View all n →" opens a full-screen triage table with
  search and source filters (convergence / related / agent-nominated / manual). Suggestions with
  no new evidence for N weeks move to a "Stale" filter / auto-archive (logged in the feed).
- **Dismiss with memory** *(new)*: sets candidate `status: 'dismissed'` (optional reason:
  not relevant / already covered / too specific); the curator must not re-propose the same
  cluster; the underlying lessons remain untouched in team knowledge.
- **Review mode**: guided one-at-a-time triage with keyboard (`P` promote, `M` add-to-merge,
  `D` dismiss, `→` skip) and progress ("12 of 47"). Every decision emits a knowledge-feed event
  (transparency principle unchanged).

## 6. Rollout model (narrative, not mechanics)

The technical model (grant on the team agent, additive file sync, seed manifest as truth) is
unchanged. The *story* changes:

- **Activate** = "the team uses this skill." One click, applies to all members without their own
  list. First-use explainer: files are copied into agent workspaces and CLAUDE.md is rebuilt — no
  restart, effective next session.
- **Distribution is system work, not user work.** A `pending` member is not a human to-do but a
  "syncing…" state that an orchestrator reconcile loop resolves itself (building blocks —
  idempotent `planSkillSync`, manifest diff — exist). Humans intervene only on errors (*Retry*)
  or exceptions (*Include* for override members).
- **Deactivate** = "the team stops using it — it stays in the library." The skill visibly moves to
  the *Ready* tab instead of disappearing, which makes the difference to *Delete* tangible.

## 7. Wording map

| Today | New |
|---|---|
| `promoted · not activated` | pill **Ready** + "In the team library — not in use yet" |
| `active · 0/10` (amber) | pill **In use** + "Installing — 0 of 10, syncing…" |
| `×` icon / "Remove this skill" / trash | `Deactivate…` (with consequence sentence); `Delete…` only in the `⋯` menu |
| `excluded-override` | "keeps its own skill list" + action **Include** |
| `↗` to unfiltered registry | "Open in Skill Editor" deep link (skill + tier + team preselected) |
| flat suggestion cards | inbox: top-10 by evidence, theme groups, review mode, dismiss |

## 8. Phasing

**Phase 1 — visibility (frontend-only, existing APIs).** Inspector drawer (Content/Origin/Rollout),
row layout, named actions + deactivate confirm, consistent status wording and one counting basis
for badge + flash, registry deep-link support in `SkillsRegistry`.

**Phase 2 — structure (small API additions).** Lifecycle tabs + search; evidence sort + theme
groups (client-side from existing candidate fields); **dismiss** (new candidate status +
endpoint + curator respect); bulk select over existing single endpoints.

**Phase 3 — flow (backend work).** Review mode incl. merge basket → promotion dialog accepting
multiple candidates; server-side candidate merge (today only skill-merge exists in the registry);
orchestrator auto-reconcile for pending members ("Sync now" becomes *Retry* on error only);
suggestion auto-hygiene (stale filter / auto-archive, feed-logged).

## 9. Explicit non-goals

- No change to the grant/pool model (`skill-grants.js`, two-tier pool) or the activation
  endpoints' semantics.
- No skill *editing* on the Knowledge page — editing stays in the Skills Registry.
- No weakening of the transparency principle: every activation, dismissal and merge remains a
  visible knowledge-feed event.
