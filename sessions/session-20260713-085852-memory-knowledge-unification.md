# Session Summary — i-sase-aee (e-vgh-claw)

**Session ID**: 20260713-085852-memory-knowledge-unification
**Date**: 2026-07-13T08:58:52Z
**Current Branch**: feat/knowledge-skill-aggregation
**Focus Area**: Team-owned skills (shipped) → Memory/Knowledge unification (concept ready, implementation next)
**Working Directory**: /Users/thorsten.a.maier/Projects/i-sase-aee

---

## 🎯 Session Objectives

1. Make promoted knowledge skills actually *active* for team members (they used to land in the pool and die there) — **done, shipped in 3 commits**.
2. Assess the Full-Learn button + the memory/knowledge redundancy — **assessed, concept written, implementation NOT started**.

---

## ✅ Work Completed (all committed)

### Commit `52f5ccd` — feat(skills): team-owned skill grants (concept phase 1)
Ownership move: the skill GRANT lives on the agent construct, never the Working Environment (env = pure infrastructure template). New pure module `orchestrator/skill-grants.js` (`effectiveSkills` / `hasSkillGrant` / `migrateSkillGrant` / `planSkillSync`, unit-tested). One-time startup migration `migrateSkillGrantsToAgents()` copies legacy `env.skills` → configs. Seeding/CLAUDE.md-gate/prompt-preview resolve via `effectiveSkills`; `saveAgentPrompt` self-resolves from config (no caller can forget). APIs: `PUT /api/agents` accepts `skills[]`; env endpoints accept-and-discard; `POST /api/teams(/stream)` takes initial team skills. UI: env editor lost the picker; shared `SkillPicker` component in agent create/edit forms + wizard Knowledge step.

### Commit `54cac36` — feat(skills): one-click activation (phase 2)
Seed manifest `/workspace/agents/<id>/.aee/seeded-skills.json` (`{name:{tier,seededAt}}`) = per-member activation truth. Orchestrator `POST /internal/teams/:id/skills/{activate,deactivate}` + `/internal/agents/:id/skills/{...}` — **additive file sync, no respawn** (idempotent grant edit + workspace copy/remove + manifest + CLAUDE.md rebuild + volume mirror; override members skipped unless `includeMembers` opts them in). Admin proxies `POST /api/knowledge/{activate,deactivate}`; graph `?scope=team:` gets `activation` block per skill node. Knowledge page: badges (🟢 n/n, 🟡 k/n, ⚪ not active + Activate), member popover, Deactivate, "Add global skill…" picker.

### Commit `0c1e76e` — feat(knowledge): activation closes the loop (phases 3+4)
Promotion/Share dialogs: ☑ "Activate … immediately" (default on, never rolls back the promote/share); Lift-to-team always activates. Feed events `type:"activation"` (⚡ in KnowledgeFeed). Autonomy 3: curator auto-promotions auto-activate (`autoPromoteStep` → `setTeamSkillActive({auto:true})` via `orchestratorSingleton`).

**Concept doc:** `docs/knowledge-skill-activation-concept.md` — status: fully implemented (phases 1–4).
**Verification:** 261 orchestrator + 257 admin-console API tests green; vite build green. NOT yet deployed to the live stack (`~/Projects/e-vgh-claw`).

### Uncommitted at handover (committed as part of this handover)
- `docs/memory-knowledge-unification-concept.md` — the NEXT work package (see below)
- `sessions/*` — this handover

---

## 🚀 Next Session: Memory/Knowledge unification

**Concept (READ FIRST):** `docs/memory-knowledge-unification-concept.md`

**Problem:** `memory/facts.md`+`entities.md` fully duplicate the KB kinds fact/entity(/convention); two competing curation paths; Full-Learn button routes everything into private memory (never mentions the `knowledge` CLI).

**Decisions already made by the user (do NOT re-ask):**
1. Unify along **semantic/episodic**: facts/entities/conventions → KB only; `context.md`/`log.md`/`users.md` stay in `memory/` (users.md is personal data — never shared/migrated).
2. **"Knowledge must be THERE at session start"** (user was explicit/worried): guaranteed injection via generated `knowledge-digest.md`, `@`-imported by CLAUDE.md (same mechanism as `@AGENT-PROMPT.md`, #510). Deterministic digest: all conventions → converged entries → recent, ~2–4k token budget. Search = long tail only.
3. **Transparency is a HARD requirement** (user emphasized): digest is a real, browsable, always-current file in the workspace root; regenerated pre-invocation (runtime) **and** event-driven on KB change (orchestrator, hook `emitKnowledgeHarvest`); self-explanatory header banner; the `@`-import visible in CLAUDE.md; no hidden context channels. (Saved as durable memory: workspace-transparency-principle.)
4. Autonomy 0 / no KB checkout → legacy 5-file model as fallback (gate exists: `build_harvest_hint()` knows the level).

**Phases (each shippable alone):**
- **Phase 0 — Full-Learn fix** (~30 min, frontend-only): `LEARN_PROMPT` in `admin-console/src/pages/agent-chat/ChatPanel.jsx:17-26` gets a knowledge-add paragraph (wording aligned with `build_harvest_hint()` in `agent-image/scripts/agent-entrypoint.py:1081-1101`; "skip if the team knowledge base is not available"); tooltip update (button "Full Learn", ChatPanel.jsx:776-786); refresh Knowledge tab after learn reply.
- **Phase 1 — Digest, additive** (no removals): pure builder `orchestrator/knowledge-digest.js` + byte-equivalent Python port in `agent-entrypoint.py` (drift-guard test, same pattern as the memory-hint contract `buildMemoryHint()` ↔ `_build_memory_hint()`); pre-invocation regen + post-KB-change fan-out; `@knowledge-digest.md` import added by `prompt-assembly.js` only when a KB checkout is provisioned; seeding writes an initial digest so the import never dangles.
- **Phase 2 — Semantic rerouting**: unified vs legacy memory-hint + CLAUDE.md Memory-section variants, autonomy-gated. ⚠️ The hint is a **byte-identical two-sided contract** — change `prompt-assembly.js` and `agent-entrypoint.py` in one commit.
- **Phase 3 — Migration**: one-shot import facts/entities → KB (provenance `migrated:<agentId>`), archive to `memory/_archive/` (visible, not deleted); digest indicator in the agent-chat Knowledge tab.
- **Phase 4 (optional)** — curator-refined digest at autonomy 3.

---

## 💡 Key Technical Context (hard-won this session)

- **Knowledge "team" = the SQUAD** (`parentTeamId` / team agent id, `agentKnowledgeTeamId`), NEVER `cfg.teamId` (human tenant, 'default' everywhere).
- **`saveAgentPrompt` self-resolves skills from the saved config** — config is on disk before every call site; keep that invariant when adding call sites.
- Blueprint/ephemeral paths (no operator UI) copy `env.skills` **once at creation** as initial grant — the only intentional remaining `env.skills` readers (plus migration).
- Skill (de)activation = file ops only; deactivation never deletes agent-tier (agent-authored) skills; volume-isolated removal can't be mirrored (stale copy dies at next respawn; rebuilt CLAUDE.md IS mirrored).
- `planSkillSync` actions: sync / sync-override (opt-in persists name on `skillsOverride`) / skip-override / stub (stubs consistent by construction).
- Feed events append via `appendKnowledgeEvents()` (orchestrator writes JSONL, admin console tails it via SSE; scope filter matches on `teamId`).
- Working Environments: `respawnAgentsForEnvironment` exists but is credential-rotation only — activation deliberately avoids respawn.

## ⚠️ Watch Out For
- ❗ The memory-hint byte-identity test (`prompt-assembly.test.js`, drift guard against the Python source) — any Phase-2 wording change must touch both files together.
- ❗ `users.md` never migrates to the KB (personal data).
- ❗ User principle: **ask only fachliche/product questions, decide technical details yourself; user writes German** (answer German, repo docs/code English).
- ❗ Deploy to live stack is separate: push → pull in `~/Projects/e-vgh-claw` → `compose build` + `up --force-recreate` (skill-grant migration runs automatically at orchestrator start).

---

## 📂 Files to Review First (next session)
- `docs/memory-knowledge-unification-concept.md` — the work package
- `docs/knowledge-skill-activation-concept.md` — what already shipped (context)
- `admin-console/src/pages/agent-chat/ChatPanel.jsx:17-26,528-550,776-799` — LEARN_PROMPT + Full-Learn/Reset buttons (Phase 0)
- `agent-image/scripts/agent-entrypoint.py:1081-1135` — `build_harvest_hint` + `_build_memory_hint` (contract)
- `orchestrator/prompt-assembly.js` — `buildMemoryHint`, section gating (Phase 1/2 target)
- `orchestrator/orchestrator.js` — `emitKnowledgeHarvest` (~line 2123), `provisionKnowledgeCheckout`, `seedAgentWorkspace`
- `orchestrator/skill-grants.js` — pattern template for new pure modules

---

**Generated**: 2026-07-13T08:58:52Z · Session ID: 20260713-085852-memory-knowledge-unification
