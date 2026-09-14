# Concept: Team-owned Skills & Activation from the Knowledge UI

**Status:** v2 — fully implemented (phases 1–4): ownership move, truth & repair (manifest, activation endpoints, Knowledge-page badges), flow integration (default-on activation in promote/share/lift, feed `activation` events), and autonomy-3 auto-activation
**Relates to:** Knowledge Flow page (`/knowledge`), two-tier skill pool (#306), promotion pipeline, Working Environments, Team-Setup wizard

## 1. Problem

Two entangled problems, one root cause: **skills are owned by the wrong entity.**

### 1.1 The dead end after promotion

The Knowledge pipeline today ends one step too early. After `POST /api/knowledge/promote`
the skill exists as a file in the team pool — but **no agent ever sees it**, because:

1. A skill is only seeded into an agent workspace when its name is listed in the Working
   Environment's `skills[]` array. Promotion does not touch any environment.
2. Even after editing the environment, running members do not pick the change up — skills
   are copied at workspace seed time only. The operator must deactivate/reactivate every
   member individually.

Neither step is discoverable from the Knowledge UI. The skill sits in the pool, unused,
and the operator reasonably assumes "promoted = active".

### 1.2 The ownership mismatch

The Knowledge feature is scoped to the **Agent Team (squad)**: a team learns, converges,
promotes into *its* pool. But the activation lever — `env.skills` — belongs to the Working
Environment, which is a *shared, reusable* infrastructure recipe (several teams may reuse
one env via the Team-Setup wizard). Activating a team's skill through a shared env would
leak the grant to unrelated teams. The team produces knowledge it cannot own end-to-end.

**Goal:** the full lifecycle — *Learn → Converge → Promote → **Activate*** — is drivable
end-to-end from the Knowledge surface, with truthful status, and the **team is the sole
owner of its skill set**.

## 2. Decisions (made)

| Question | Decision |
|---|---|
| Where do skills live? | **On the team, not the environment.** Skill management is removed from Working Environments entirely. The env becomes a pure infrastructure template (repo, SSH key, PAT, MCP servers, additional context). The team manages its own skill set. |
| When does activation happen? | **At promotion, opt-out.** The promotion dialog carries an "Activate for the team immediately" checkbox, checked by default. |
| Autonomy level 3 (Auto-curate)? | **Fully autonomous.** Auto-promoted skills are auto-activated. The live feed reports it transparently. |
| Members with `skillsOverride` (Custom skill list)? | **Excluded + surfaced.** They are skipped; the UI shows "active for 4/6 members — 2 excluded (own skill list)" with a per-member opt-in action. |
| Standalone agents (role `agent`, no team)? | Carry their own `skills[]` directly on the agent config — the same lever, one level down. |

## 3. Data-model change: skills move off the environment

### 3.1 New shape

| Entity | Before | After |
|---|---|---|
| Working Environment | `skills[]` drives seeding | **no skill field.** Repo, credentials, MCP, additionalContext only. |
| Team agent (`role: team`) | — | **`skills[]`** — the team's *active* skill set. Names resolve team-pool-first, then global (unchanged resolver). |
| Team member | `skillsOverride[]` replaces env list | `skillsOverride[]` replaces the **team** list (semantics otherwise unchanged; absent = inherit). |
| Standalone agent (`role: agent`) | inherits env `skills[]` | own **`skills[]`** on its config. |

Seeding changes accordingly: `seedAgentWorkspace` resolves the effective list as
`member.skillsOverride ?? teamAgent.skills ?? agent.skills ?? []` — the env parameter no
longer contributes skills. The two-tier **pool** (files: team pool `/workspace/teams/<id>/skills/`,
global pool) and the team-first resolution in `skill-source.js` stay exactly as they are;
what moves is only the **grant** (which names are active for whom).

"Team" throughout this concept means the **Agent Team (squad)** — the same scope the
Knowledge feature already uses (`agentKnowledgeTeamId`, i.e. `parentTeamId`), not the
human-tenant Team.

### 3.2 Active set vs. pool

The team pool contains files (what the team *owns*); `teamAgent.skills[]` says what is
*active*. They are deliberately not the same thing:

- A promoted skill can exist in the pool but be deactivated (name removed from the list)
  without deleting the file — reversible.
- Global-pool skills are adopted by listing their name — the team activates skills it does
  not own.

One list, one lever, no environment involved.

### 3.3 Migration

One-time, at orchestrator startup (same pattern as the legacy role rewrite):

1. For every team agent: if it has no `skills` field, copy `skills[]` from its env.
2. For every standalone agent: same, from its env.
3. Env `skills[]` is left in place but ignored from then on (dropped from the editor UI;
   the API accepts-and-discards it for old clients).

No workspace is touched by the migration — running agents already have their seeded
skills; the migrated lists exactly describe the status quo.

### 3.4 UI relocation

- **Working Environments editor:** the Skills picker section is removed. A short note
  explains that skills are managed per team (link to `/knowledge`).
- **Team-Setup wizard:** the existing **Knowledge (optional)** step becomes the place to
  pick the team's *initial* skill set (global-pool picker). The env card summaries drop
  their skill counts.
- **Agent edit form:** members keep the Inherit-from-team / Custom toggle (now inheriting
  from the team's list); standalone agents get a plain skills field.
- **Knowledge Flow page:** becomes the primary day-to-day management surface for a team's
  skills (see §5).

## 4. Core mechanism: additive skill sync (not respawn)

The existing heavy paths are wrong for this job: disable→enable wipes the member workspace
(uncommitted repo state, session context); `respawnAgentsForEnvironment` recreates
containers. Skills are **static files read by the Claude CLI at invocation time**, and the
orchestrator mounts the same pool volume the member workspaces live on — activation is a
pure file operation, no container restart:

```
POST /internal/teams/:teamId/activate-skill        (orchestrator, port 4002)
{ "skillName": "<name>", "includeMembers": ["<agentId>", …]? }
```

1. **Add the skill name to `teamAgent.skills[]`** (idempotent set-insert). The team config
   is the single source of truth: stubs and future members get the skill through the
   normal seeding path automatically.
2. For every **materialized** member **without** `skillsOverride` (plus any explicitly
   listed `includeMembers`): copy the skill directory into the member workspace, resolved
   **team-pool-first, then global** via `makeSkillSourceResolver` — identical to seed-time
   resolution, so activation can never resolve differently than a later re-seed.
3. Update the member's **seed manifest** (§4.1).
4. Return per-member results: `{ agentId, status: seeded | skipped-override | stub | error }`.

Effect timing: `per-invocation` members use the skill on their very next triggered run;
persistent members on their next Claude invocation. No restart, no session loss.

**Deactivation** (`deactivate-skill`) is the exact inverse: remove from the list, remove
the directory from member workspaces, update manifests. The pool file stays — deactivation
is reversible; deletion stays on the Skills Registry page.

For **standalone agents** the same pair exists as
`POST /internal/agents/:id/{activate,deactivate}-skill`, operating on the agent's own
`skills[]` and single workspace.

**A third entry point (#2286)** reuses this exact mechanism for the team's Settings →
**Skills** tab bulk "Save Changes" edit (`PUT /api/agents/:id` on a `role: "team"` agent),
which historically wrote `skills[]` to `config.json` only and left already-materialized
members to pick the change up at their next re-seed/enable. `POST
/internal/teams/:teamId/skills` (`{ "skills": string[] }`) now diffs the submitted list
against the team's current one and re-runs the activation/deactivation sync above for every
name that newly entered or left the set — same guarantees (CLAUDE.md rebuild, isolated-
volume mirroring, no respawn, `skillsOverride` members skipped), same manifest. A save whose
effective set is unchanged (including a pure reorder) does no work.

### 4.1 Seed manifest — the truth for "is it active?"

Today nobody records which skills actually landed in a workspace. `seedAgentWorkspace`
(and the activation sync) writes/updates:

```
/workspace/agents/<id>/.agent-studio/seeded-skills.json
{ "<skillName>": { "tier": "team" | "global", "seededAt": "<ISO>" } }
```

A skill is *active for member M* iff it appears in M's manifest. The list alone is not
enough — it doesn't tell whether a running member was seeded before or after the name was
added.

## 5. UI concept (Knowledge Flow page)

### 5.1 Skill cards get an activation state

Every card in the **Skills** column shows one of:

- 🟢 `active · 6/6 members`
- 🟡 `active · 4/6 members` — click opens a per-member popover: who is active / pending /
  excluded; excluded (override) members get an **"Add for this member"** action that
  appends the name to their `skillsOverride` *and* syncs their workspace.
- ⚪ `not active` + an **Activate** button — the repair path for previously promoted,
  never-activated skills (there will be a backlog of exactly these on day one).

Because the team now owns the whole set, the Skills column also lists **adopted global
skills** (tier badge distinguishes them) and offers a small **"Add global skill…"** picker
— the Knowledge page becomes the team's complete skill management surface, replacing what
the env editor used to do.

### 5.2 Promotion dialog: activation is the default last step

The PromotionDialog gains a final section:

> ☑ **Activate for the team immediately** — copies the skill to all 6 members' workspaces
> and adds it to the team's active skills.
> *2 members keep their own skill list and are excluded — you can add them afterwards from
> the skill card.*

Checked by default (opt-out). On success the closing toast is the activation result:
**"Skill promoted and active for 4/6 members."** On partial failure the card shows 🟡 and
the popover names the failing member — promotion never rolls back because activation
hiccuped.

The same checkbox appears in the sibling flows that also end at the pool today:

- **Share to another team** (ShareDialog): "Activate for *<target team>* immediately"
  (acts on the target team's list/members).
- **Lift to team** (private agent skill → team pool): same checkbox, same default.

### 5.3 Autonomy 3: the loop closes itself

At autonomy level 3 (Auto-curate), auto-promoted skills are **auto-activated** in the same
server-side step. The live feed (SSE `/api/knowledge/stream`) gains an `activation` event
type:

> ⚡ *auto-promoted → activated for team `payments` (4 members, 1 excluded)*

At levels 0–2, activation happens only through the dialog checkbox or the skill-card
button. No new promotion gate: activation inherits the trust decision made at the
promotion gate. `team>global` promotions activate for the **source team only**; other
teams adopt via Share or the global-skill picker.

### 5.4 Team section header

> Skills — proven & reusable · 3 of 5 active

## 6. API surface (admin console)

- `POST /api/knowledge/activate` / `POST /api/knowledge/deactivate` —
  `{ teamId, skillName, includeMembers? }`; proxy the orchestrator endpoints; protected by
  the auth gate; covered by the audit trail (#305).
- **Activation status rides on the existing graph call** (no extra round-trip):
  `GET /api/knowledge/graph?scope=team:<id>` skill nodes gain

  ```json
  "activation": {
    "active": true,
    "members": [ { "agentId": "…", "state": "active | pending | excluded-override | stub" } ]
  }
  ```

  `pending` = name is in the team list but not in that member's manifest (partial
  activation failure, or the list was edited elsewhere).

## 7. Edge cases

| Case | Behaviour |
|---|---|
| **Shared environment** | **Dissolved by design.** The env no longer carries skills, so reusing an env across teams cannot leak grants. Each team's list is its own. |
| Member is a **stub / disabled** | Skipped by the sync; state `stub`. Consistent by construction: the team list already carries the name, so the normal seed path delivers it at next enable. |
| Member has `skillsOverride` | Skipped (`excluded-override`), surfaced in the popover, opt-in per member (writes into the override + syncs). |
| **Name collision** team vs global | Team-pool-first resolution, identical to seed behaviour. |
| Repeated activation | Fully idempotent: set-insert, file copy overwrites, manifest updates. |
| Team list edited via the Skills tab (agent edit form) | Eager, since #2286 — the bulk save propagates immediately (see §4), same as the Knowledge page toggle. The graph's `pending`/**Activate** reconciliation now only matters for drift from a source that bypassed both write paths (e.g. a member added between two saves, or manual file tampering). |
| Activation failure mid-fanout | Per-member results; card shows 🟡; retry via the same idempotent call. |
| Pre-migration clients sending `env.skills` | Accepted and discarded by the API; the field is dead after migration. |

## 8. Rollout phases

1. **Ownership move:** data-model migration (env → team/agent `skills[]`), seeding reads
   the new source, env editor loses the picker, wizard Knowledge step picks initial
   skills. Behaviour-preserving for every existing agent.
2. **Truth & repair:** seed manifest + `activation` block on the graph + skill-card badge
   + **Activate** button + global-skill picker on the Knowledge page.
3. **Flow integration:** PromotionDialog / ShareDialog / Lift-to-team checkboxes, feed
   `activation` events, deactivation action.
4. **Autonomy 3 auto-activation.**

Each phase is independently shippable; phase 1 is the structural prerequisite, phase 2
alone already closes the discoverability gap because the UI finally *tells* the user a
promoted skill is not active.
