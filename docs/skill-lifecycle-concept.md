# Concept: Holistic Skill Lifecycle Management

**Status:** concept / plan of record — v1 (2026-07-16). Epic: #624 (child issues #625–#633)
**Relates to:** two-tier skill pool (#306), team-owned skill grants (`docs/knowledge-skill-activation-concept.md`), knowledge pipeline (`docs/knowledge-sharing-concept.md`, `docs/knowledge-curation.md`, `docs/knowledge-governance.md`), skills system (`docs/skills-system.md`)

## 1. Why

Skills are the **central knowledge-transport mechanism** of the Agent Studio: they carry
learned team knowledge across all agents of a team, between teams, and in and out of the
whole installation. The pipeline *below* skills (memory → team KB → convergence →
promotion → activation) is mature. The management *of the skills themselves* is not:
skills are plain directories that are copied around with no identity, no version, no
memory of where a copy came from — and the operator surface has grown into two
disconnected pages with mismatched permissions and numerous dead-ends.

### 1.1 Dead-ends today (inventory)

Lifecycle gaps:

- **No versioning anywhere.** `SKILL.md` is overwritten in place. No version counter, no
  content checksum, no history, no diff, no rollback. When the same skill exists on
  several tiers (global pool, team pool copy, seeded agent copies) nothing can tell which
  copy is current, which is stale, and which was edited locally.
- **Copies have no lineage.** Promote / share / adopt / seed all copy files and forget
  the source. Editing a global skill does not propagate to team copies or seeded agent
  workspaces (only the narrow `extend` path calls `resyncTeamSkill`); nothing even
  *detects* the staleness.
- **Global → team is not first-class.** The only way to turn a global skill into a team
  skill is the Share dialog's `from: "global"` branch on the Knowledge page — well hidden,
  and there is no *move* semantics (make it a team skill and retire the global one).
- **Deletion is inconsistent.** Global delete has an in-use guard; team delete is a blind
  `rmSync` (dangling grants, silent seed warnings); agent-tier delete is 403 — a Team
  Admin cannot delete their own team's skills at all (the Skills Registry is
  System-Admin-only), and nobody can clean up an agent-authored skill via the API.
- **No merge.** Two overlapping skills cannot be combined into one. (`mode: extend` folds
  KB *entries* into a skill, but skill+skill → skill does not exist.)
- **Import is global-only and unvalidated**; export works but drops all metadata context,
  so a skill moved between installations loses its identity.

Surface gaps:

- **Two disconnected pages, mismatched access.** Skills Registry (`/skills`,
  System-Admin-only) is file-centric; Knowledge (`/knowledge`, open) is activation-centric.
  No cross-links. A Team Admin can promote/share/activate but can never browse, edit,
  export, or delete the resulting files.
- **Pickers are wrong.** The agent edit form and the Team-Setup wizard offer *global pool
  skills only* — existing team/agent skills can never be granted from a form. The
  team-member override is a free-text comma list (typos become silent dead grants).
- **Redundant, semantically divergent endpoints.** `/api/skills/promote` (agent→global,
  no provenance), `/api/skills/promote-to-global` (team→global, no provenance) and
  `/api/knowledge/promote` (provenance-mandatory ladder) coexist; `/api/skills/install`
  copies files without touching the grant, so the next re-seed silently drops the skill.
- **Provenance is written but never shown.** `provenance.json` (entryIds, origin agents,
  promotion/share stamps) exists on disk and is rendered nowhere.

### 1.2 Goal

Every skill is an **identifiable, versioned, traceable object** that can move freely
across all three tiers and across installations, with one consistent set of operations
(create, edit, adopt, promote, lift, share, move, merge, extend, resync, export, import,
archive, delete) available from one role-scoped surface — and the learned-knowledge
pipeline keeps feeding it. No operation is a dead-end: every state a skill can reach has
a visible next step.

## 2. Object model: skill identity

### 2.1 The tiers stay

The three-tier pool (agent → team → global, most-specific-first resolution via
`skill-source.js`) and the grant model (team `skills[]` / agent `skills[]` / member
`skillsOverride`, `skill-grants.js`) are unchanged. This concept adds identity and
lifecycle on top; it does not move ownership again.

### 2.2 `skill.json` — the per-skill manifest

Every skill directory gains a sidecar `skill.json` (peer of the existing
`provenance.json`, which keeps its role as *knowledge* lineage — entryIds, origin
agents). `skill.json` is *content* lineage:

```jsonc
{
  "v": 1,
  "name": "cobol-copybook-mapping",
  "version": 4,                      // monotonic per skill instance (this dir)
  "contentHash": "a1b2c3d4e5f6",     // 12-hex SHA-256 over normalized content
  "updatedAt": "2026-07-16T09:00:00Z",
  "updatedBy": "operator:thorsten | agent:<id> | curator | import",
  "origin": {                        // where THIS copy came from (absent = authored here)
    "tier": "global | team | agent | external",
    "teamId": "payments",            // when tier=team
    "agentId": "payments-developer", // when tier=agent
    "sourceVersion": 3,
    "sourceHash": "0f9e8d7c6b5a"
  },
  "history": [                       // bounded (last 20), newest first
    { "version": 4, "hash": "a1b2…", "at": "…", "by": "curator",
      "action": "extended", "note": "folded 3 converged lessons" },
    { "version": 3, "hash": "0f9e…", "at": "…", "by": "operator:thorsten",
      "action": "edited" }
  ]
}
```

**Content hash.** SHA-256 (12-hex prefix) over the normalized directory content: sorted
relative paths + raw bytes of every file, **excluding** `skill.json`, `provenance.json`
and `_archive/`. Two copies with equal hashes are the same knowledge regardless of their
version counters — the hash is the cross-tier, cross-installation identity of a state;
the version counter is the human-readable "v4" of one instance.

**Actions** (closed set): `created`, `edited`, `imported`, `adopted` (global→team copy),
`promoted` (team→global / KB→skill), `lifted` (agent→team), `shared` (team→team),
`moved`, `merged`, `extended` (KB entries folded in), `resynced` (pulled source update).

**One pure module, two call sites.** `skill-manifest.js` (hashing, stamping, history
append, drift classification — pure, unit-tested) lives in the admin-console API (the
pool writer) and is mirrored in the orchestrator (curator writes, seed reads) — same
two-sided golden-fixture discipline as `knowledge-digest.js`.

**Backfill.** A one-time startup pass stamps every existing skill dir (all tiers)
`version: 1, action: "created"` with the computed hash — idempotent, skip when present.
Agent-tier dirs are stamped lazily on first read (agents own those dirs).

### 2.3 Seeded copies join the model

`.agent-studio/seeded-skills.json` entries grow from `{tier, seededAt}` to:

```jsonc
"<name>": { "tier": "team", "seededAt": "…", "contentHash": "0f9e8d7c6b5a", "sourceVersion": 3 }
```

written by every path that lands skill files in a workspace (seed, activate, install,
resync). A seeded copy is thereby a *tracked replica* like any other.

### 2.4 Drift states (computed, never stored)

For any copy that records an `origin` (team copy of a global skill, seeded agent copy of
a pool skill), comparing three hashes — copy's current, copy's recorded `sourceHash`,
source's current — yields:

| State | Meaning | Offered action |
|---|---|---|
| `in-sync` | copy == source | — |
| `outdated` | source moved on, copy unchanged | **Update** (resync) |
| `diverged` | copy edited locally, source unchanged | **Push up** (promote/lift) or keep |
| `conflict` | both changed | **Merge review** (side-by-side, manual) |
| `orphaned` | source deleted | **Detach** (clear origin) or delete |

Computed on read (graph/API), pure function of manifests — no background reconciler, no
stored state that can rot.

## 3. Lifecycle operations: one transfer engine

### 3.1 The transition matrix, complete

| From \ To | Agent | Team | Global |
|---|---|---|---|
| **Agent** | *(agent authors)* | **lift** ✅ exists | **publish** ✅ direct (#2180 — offered alongside the staged lift-then-promote path) |
| **Team** | activate/seed ✅ | **share** (cross-team) ✅ | **promote** ✅ |
| **Global** | activate/seed ✅ | **adopt** 🆕 first-class (copy) / **move** 🆕 (copy + retire global) | *(edit in place)* |
| **External** | — | **import** 🆕 | **import** ✅ |

Every cell is a copy that stamps `origin` + a history entry; **move** = copy + guarded
delete of the source (see §3.3). "Make a global skill a team skill" and "make a team
skill a global skill" are thereby both one-click, in both copy and move flavors.

### 3.2 `POST /api/skills/transfer` — single engine

```jsonc
{
  "name": "cobol-copybook-mapping",
  "from": { "tier": "global" },                          // or {tier:"team",teamId} / {tier:"agent",agentId}
  "to":   { "tier": "team", "teamId": "payments" },
  "mode": "copy" | "move",
  "onCollision": "reject" | "overwrite" | "rename",       // rename → "<name>-2"
  "activate": true                                        // default true when target is a team
}
```

One pure validator + planner (`skill-transfer.js`): containment-guarded paths, permission
check per tier (Team Admin for team targets; for a global target, System Admin **or**
Team Admin of the content's own team — #2180 — the agent's real owning team resolved
server-side, never client-supplied; any `move` OUT of global or an agent's own workspace
stays System-Admin-only, since retiring someone else's content is a separate,
still-governance-level act), provenance carried forward (share/lift semantics preserved),
`skill.json` stamped on the target, history entry on both ends. Activation reuses
`setTeamSkillActive` — transfers end active by default, never in the historic
"promoted-but-invisible" dead-end.

The legacy endpoints become thin delegating wrappers and are removed from the UI:
`/api/skills/promote` (agent→global bypassing the team tier and provenance — now
superseded by the engine's own first-class agent→global cell, #2180),
`/api/skills/promote-to-global`, and the Share/adopt special cases all route through the
engine. `/api/knowledge/promote` keeps its KB-specific work (draft synthesis, entryIds,
candidate lifecycle) and calls the engine for the file write.

### 3.3 Deletion — uniform, guarded, reversible

One rule on all tiers, replacing today's mix (guarded global / blind team / 403 agent):

1. **Guard:** refuse (409 + grantee list) while any agent construct lists the name in
   `skills[]`/`skillsOverride` *and resolves it to this tier*. Optional
   `cascade: true` deactivates everywhere first (reusing the idempotent
   `setTeamSkillActive`/`setAgentSkillActive` sync), then deletes.
2. **Safety snapshot:** before removal, an export ZIP (content + `skill.json` +
   `provenance.json`) is written to `/workspace/skill-archive/<tier>/<name>-<hash>.zip`.
   Deletion becomes reversible via re-import; the archive is listed in the UI ("Recently
   deleted", restorable, pruned after a retention window).
3. **Agent tier:** delete becomes possible for operators (with the same guard against the
   agent's own grant) — agent-authored skills stop being unreachable via API.
4. Deleting a source flips derived copies to `orphaned` (visible, actionable) instead of
   silently breaking them.

### 3.4 Merge (N skills → 1)

`POST /api/skills/merge`:

```jsonc
{
  "sources": [ { "tier": "team", "teamId": "payments", "name": "jcl-tips" },
               { "tier": "team", "teamId": "payments", "name": "jcl-conversion" } ],
  "target":  { "tier": "team", "teamId": "payments", "name": "jcl-conversion" },
  "draft": "<operator-reviewed SKILL.md>",   // produced by the draft step below
  "retireSources": true
}
```

Two-step like promotion: a **draft step** (`POST /api/skills/merge-draft`) synthesizes a
combined `SKILL.md` via the existing LLM draft machinery (`resolveGenerationTarget`,
heuristic concat fallback), the operator edits it in the dialog, then the merge commits:

- target written with `action: "merged"`, `mergedFrom: [{name, tier, hash}]` in history;
- `provenance.json` entryIds **unioned** across sources (knowledge lineage survives);
- extra files of all sources copied (collisions namespaced `files/<source-name>/…`);
- **grant migration:** every grant naming a retired source is rewritten to the target and
  the workspace sync runs (remove old dir, copy new) — no member silently loses knowledge;
- retired sources go through the §3.3 archive path.

Merge is operator-only (never the curator) and works cross-tier (two team skills, a team
+ an adopted global copy, …) with target-tier permissions: Team Admin of the target team
for a team target; for a **global** target, System Admin **or** Team Admin of *any* team
(#2307 — a merge has no single "content's own team" to name the way a transfer does, so
the floor is any team the caller administers, not System-Admin-only).

### 3.5 Export / import — round-trip with identity

- **Export** (exists) now includes `skill.json` + `provenance.json` in the ZIP.
- **Import** gains a target selector (`global` | `team`+teamId), validates `SKILL.md`
  (parseable frontmatter with `name` + `description`, size caps), and honors an embedded
  `skill.json`: version chain continues, `origin: {tier: "external"}` + `action:
  "imported"` appended. Skills can thus travel between installations without losing
  their history — the enterprise "skills from outside / to the outside" path.
  **Permission** (#2307): Team Admin for a team target; for a **global** target, System
  Admin **or** Team Admin of *any* team — an external archive has no resolvable owning
  team the way a transfer's source does, so the floor is any team the caller
  administers. `+ New Skill` (`POST /api/skills`) and editing an existing skill's
  content (`PUT /api/skills/:name`, `PUT /api/skills/:name/file`) apply the identical
  per-tier rule — before #2307 those two routes had no permission check at all.

### 3.6 Edit propagation & resync

- Any edit (file save in the UI, `PUT /api/skills/:name`, extend, merge) bumps
  `version` + hash. All derived copies and seeded replicas become `outdated` — visibly.
- **Resync action** generalizes `resyncTeamSkill`: per-copy ("Update this team's copy to
  global v5") and per-team bulk ("Sync 3 outdated skills to 6 members"), always through
  the same workspace-sync path as activation (manifest updated, CLAUDE.md rebuilt,
  isolated volumes mirrored).
- **Auto-resync gate** per team, default `review` (a per-team policy beside
  `knowledgePromotionGates`): `auto` = a pool edit fans out to member workspaces
  immediately; `review` = the Skills surface shows "update available" until confirmed.
  Conservative default keeps teams in control of what enters their agents' context.
  A **transfer** (Publish / Promote / Lift / Share / Adopt via `POST /api/skills/transfer`)
  changes a pool skill's effective content through the same write path as a plain
  edit, so it fans out identically for its `team`/`global` destination tier — a
  `move`'s source retirement is unrelated to the destination-side resync (#2316).
- Consistency fixes folded in: `install` also writes the grant (so a re-seed keeps the
  skill); `extend` offers the same "Activate immediately" default as promotion.

## 4. Surface: one Skills studio

### 4.1 One page, role-scoped

The Skills Registry (System-Admin-only, file-centric) and the Knowledge page's skill
column (team-scoped, activation-centric) merge into **one Skills surface** reachable by
every authenticated user; *actions* are role-gated, not the page:

- **Scope switcher:** Global pool | per-team (membership-filtered) — mirroring the
  Knowledge page's team selector, deep-linked (`?team=`).
- **Skill card/table row:** name, description, tier badge, `v4 · a1b2c3` version chip,
  activation state (`active · 4/6`), drift badge (`outdated` / `diverged` / `conflict` /
  `orphaned`), provenance chips (`auto` for curator, `shared from payments`, `imported`).
  A pool or team row additionally gets a **Downstream** badge ("2 outdated, 1 diverged")
  whenever any of ITS OWN downstream copies aren't `in-sync` — a pool row's downstream is
  every team + agent copy of the name, a team row's is only that team's own agent copies
  (agent rows are leaves, no badge); it reuses the same per-copy drift already computed
  for the row's own Drift badge, so it can never disagree with the Lineage/Usage tabs,
  and clicking it opens the Usage tab directly (#2317).
- **Detail panel tabs:** *Content* (file browser/editor — today's Registry viewer),
  *Versions* (history timeline with per-version diff of `SKILL.md`, from the bounded
  history + archive snapshots), *Lineage* (rendered `provenance.json` + `origin` chain +
  all known copies with their drift states — "this skill lives in 3 places"), *Usage*
  (which teams/agents grant it, seeded state per member — the §2.4/graph data).
- **Action bar** (permission-gated): Activate/Deactivate, Adopt to team, Promote to
  global, Share to team, Move, Merge (multi-select), Extend from knowledge, Resync,
  Export, Archive/Delete.
- The Knowledge page keeps its skill column as the *pipeline* view (learn → promote →
  activate) and deep-links every skill node to the Skills surface; the agent chat's
  Knowledge tab links likewise.

### 4.2 Pickers become grant-aware

`SkillPicker` lists **global + the construct's team tier** with tier badges (and marks
name shadowing); it replaces the pool-only checkbox lists in the agent form and the
Team-Setup Knowledge step, and replaces the free-text `skillsOverride` field on
team-member forms (typo-proof, validated against existing names).

### 4.3 Activity

Skill lifecycle events (created/edited/promoted/shared/adopted/moved/merged/deleted/
resynced — alongside the existing `activation` events) all flow through the knowledge
feed; the Skills surface shows a compact activity log so "the skills changed" is as
observable as "the team learned" (same transparency doctrine as the workspace-file rule).

## 5. What deliberately does NOT change

- **Tier semantics & grant model** — ownership stays exactly as decided in
  `knowledge-skill-activation-concept.md` (never re-add env skills).
- **Additive file sync, no respawn** — every new operation (transfer, merge, resync,
  cascade-delete) reuses the activation sync path.
- **Curator behavior** — auto-promotion/extension simply gains manifest stamping
  (`updatedBy: "curator"`); gates and autonomy dial are untouched. Merge and move stay
  human-only.
- **KB/provenance pipeline** — `provenance.json` keeps its schema; `entryIds` keep
  driving the T1→T2 graph edge.
- **Skills stay plain directories** — no git repo for pools in v1. The manifest + hash +
  bounded history + delete-snapshots give versioning, diff, and rollback at file level;
  a git-backed pool remains a possible later hardening, not a prerequisite.

## 6. Rollout phases (each independently shippable)

| Phase | Content | Payoff when shipped alone |
|---|---|---|
| **1 — Identity** | `skill-manifest.js` (two-sided) + `skill.json` stamping on every write path + backfill + hash in seeded manifests | every skill answers "which version is this, where did it come from" |
| **2 — Lifecycle** | transfer engine (adopt/move + consolidation of promote/lift/share), uniform guarded delete + archive snapshots, import targets + validation, export round-trip | no more dead-ends: every tier reachable from every tier, deletion safe everywhere |
| **3 — Truth & sync** | drift states on graph + skills API, resync actions, auto-resync gate, install/extend consistency fixes | stale copies become visible and one-click fixable |
| **4 — Merge** | merge-draft + merge endpoint + grant migration + dialog | overlapping skills consolidate instead of accumulating |
| **5 — Studio** | unified Skills surface (role-scoped), version/lineage/usage panels, grant-aware pickers, activity log | one place to manage everything; Team Admins get their skills |

Phase 1 is the structural prerequisite for 3–5; phase 2 only needs the stamping calls
from 1. Order within 2–4 is flexible.

## 7. Open questions

1. Retention defaults for delete-snapshots and history length (proposal: 20 history
   entries, 90-day archive retention).
2. Should `conflict` resolution get LLM assist (three-way merge draft) in v1, or is
   side-by-side manual editing enough? (Proposal: manual in v1; the merge-draft machinery
   makes assist cheap later.)
3. Whether the unified Skills surface replaces `/skills` under the same route or lands as
   a new page with `/skills` redirecting (proposal: same route, `AdminRoute` gate removed,
   actions role-gated).
