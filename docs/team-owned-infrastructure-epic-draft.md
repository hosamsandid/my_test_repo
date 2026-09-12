# Epic draft — Team-owned infrastructure & decentralised, person-bound credentials

> **Status: filed.** Epic #2166 with sub-issues #2167–#2179 (A1–A6, B1–B5, C1–C2). This document
> holds the epic and every ticket in the repo's issue style (Human Section / Agent Section).
> Design of record for the access model: `docs/decentralised-access-concept.md` (#2041); this epic
> *extends* it — the WE→Team collapse and person-bound credentials are new decisions taken in
> planning and are recorded here, not restated from #2041.

Decision labels referenced below (from the planning discussion): F1c, F2, F3c, F4a, F16a/F17a,
G1a, G2, G4a, G5, G7a, G8, G9(a+c), G10b, H1a, H2a, H3a, H4a, H5a, H6a, I1a, I2a, L1, L2, L3.

---

## Epic — Team-owned infrastructure & person-bound credentials

### Human Section

Today a normal user hits two walls that a System Admin must break. First, to build a team they
must first create a **Working Environment** and, worse, pick a *team* for it — a team that does
not exist yet, because you create the environment before the team. Second, when a team is shared
with several people, everyone's agent actions run under one baked-in credential, so "who did what"
and "whose access is used" are wrong.

This epic finishes the move to a **decentralised, creator-owned platform**: you create a **Team**
directly; everything an environment used to hold (repositories, model provider, toolchain, MCP
servers, extra context) is configured **on the team**; the phrase "Working Environment" disappears
from the UI. Visibility is derived — anyone who can see the team can see its infrastructure. And
every interactive action an agent takes runs under **the personal credentials of the human who
sent the message**; automatic runs use the team admin's. The only thing a System Admin still
provides is the **model provider** (and reviewing privileged plugin installs).

### Agent Section

**Design of record — do not restate:** the access model (Agent Team as boundary, `scope.all`
kept, ownership tiers, migration) is `docs/decentralised-access-concept.md` (#2041 D1–D13),
delivered by epic #2076 (P1–P6, closed). **New decisions this epic adds** (planning session,
recorded in the epic draft `docs/team-owned-infrastructure-epic-draft.md`): the WE→Team collapse
and person-bound credentials.

**Goal.** (1) Fold the Working Environment into the Agent Team as an internal, invisible unit
(F1c/F2). (2) Derive all infrastructure visibility from team membership (F3c/F4a); "share the
team" is the only sharing primitive (F16a/F17a). (3) Make interactive agent actions use the
acting human's personal credentials, resolved orchestrator-side (H2a/I1a); non-interactive work
uses the team admin baseline (G4a/H1a). (4) Keep the WE data model internally so this is staged,
not a big bang (~40 `cfg.environmentId` sites survive).

**Two independent blocks, A before B (L3).** Block A is IA/model and ships first. Block B is
identity & credentials; **B1 is its root** (B2/B3 depend on it, B4 on B3, B5 last).

**Delivery checklist**
- **A — Team-owned infrastructure (UI/model)**
  - [ ] A1 — Team edit form carries the environment fields (tabs)
  - [x] A2 — Reverse creation order: team-first, no standalone environment creation (#2168)
  - [x] A3 — Derive infrastructure visibility from the team; remove the ownership/team picker (#2195)
  - [x] A4 — Remove the Working Environments page; add a Sysadmin template catalog (redirects #2158) (#2207)
  - [x] A5 — Team clone copies structure only, prompts for credentials (#2171)
  - [ ] A6 — Terminology sweep: "Working Environment" out of the frontend, help, copilot
- **B — Identity & person-bound credentials**
  - [x] B1 — Humans post under their own Matrix identity into the shared per-agent room (#2173)
  - [x] B2 — Sharing a team invites the human into the team's agent rooms (#2174)
  - [x] B3 — Thread the acting sender into credential resolution (re-key off the sender, #2175)
  - [x] B4 — Team-admin baseline for non-interactive work; just-in-time refusal for writes (#2176)
  - [ ] B5 — Retire the shared team credential; personal is the norm
- **C — Cross-cutting (schedule anywhere)**
  - [ ] C1 — Move skill promote-to-global and plugin-apply to Team Admin
  - [x] C2 — Guide provider onboarding; block team-create without a provider (#2179)

**Out of scope / kept:** the full per-(human, agent) *room* model (multi-user-concept §4 / §10
item 6) stays deferred — B1 uses one shared room per agent, humans joining under their own
identity. Plugin *installation* stays System-Admin-only (C1). The credential axis
`resolveAgentTenant` and any remaining scope stamps are the concern of #2041 P5/#2160, not this
epic.

---

## Block A — Team-owned infrastructure (UI/model)

### A1 — Team edit form carries the environment fields (tabs)

**Human Section.** When you open a team's settings, you should be able to set its repositories,
model provider, toolchain, MCP servers and extra context right there — without ever meeting a
separate "Working Environment" object. This ticket surfaces those fields on the team, editing the
environment behind the scenes.

**Agent Section.**
- The team's settings surface (Agent-Chat **Settings** tab for a `role:'team'` agent) gains
  grouped tabs (G10b) for the fields an environment holds today: `repositories[]`,
  `llmEndpointId`/`defaultModelId`, `toolchainId`, `mcpServers[]`, `additionalContext`. These map
  onto the team agent's bound environment (`cfg.environmentId` → `loadEnvironment`), reusing the
  existing `POST/PUT /api/environments` under the hood. No data-model change.
- Reuse the existing field components (the `RepositoryCard`, the model-provider selector, the
  toolchain select, the MCP picker once #2051 lands, the context textarea) so there is one
  implementation, not a fork (the #1928/#1929 shared-form discipline).
- The **ownership/team picker is not shown here** — the environment already belongs to this team;
  editing content is not a re-tier.
- **AC:** editing any of these fields on a team persists to its environment and reaches agents by
  the existing propagation paths (repo changes via the #2066 save-time offer; provider/toolchain
  via respawn). The standalone Working Environments page is unchanged by this ticket (A4 removes
  it). Guard test: the team settings tabs render the same field components the WE form used.
- **Depends on:** none. **Ships green** alongside the still-present WE page.

### A2 — Reverse creation order: team-first, no standalone environment creation

**Human Section.** You should create a **Team** first; the environment is created for you behind
it. Creating a loose environment up front — and being asked which (non-existent) team it belongs
to — is the confusing order we are removing.

**Agent Section.**
- Remove the standalone "create environment" entry points from the user flow; team creation
  (wizard, quickstart, convert-to-team) remains the only way infrastructure comes into being. This
  already auto-creates a 1:1 environment (`POST /api/teams`, env id = team id) — that path becomes
  canonical.
- The create surfaces that still ask for an environment id / ownership drop those inputs for
  non-admins; the environment is minted from the team automatically (F1c/F2).
- **AC:** a plain member can create a team on an empty platform (given a provider, C2) without ever
  naming or picking an environment. No UI path lets a user create a free-floating environment.
- **Depends on:** A1. **Ships green.**

### A3 — Derive infrastructure visibility from the team; remove the ownership/team picker

**Human Section.** You should never choose "who can see this environment". It is simply visible to
everyone who can see its team. This removes the ownership control from infrastructure entirely.

**Agent Section.**
- Remove the `CredentialOwnership` control from the environment (and, per D12, MCP server) forms in
  the user-facing flow. The environment is auto-stamped to its owning team (`scope:'team'`,
  `teamId` = the team) at creation; visibility follows team membership via the existing
  `visibleEnvironment` predicate (F3c/F4a).
- Drop the `|| 'default'` and "pick a team" defaulting for infra created through team flows; an
  environment with no readable team is invisible to non-admins (§8.4 discipline already in place).
- **AC:** infrastructure carries no independent ACL; a two-user test shows user B sees a team's
  environment iff B is a member of that team. The ownership picker no longer appears in the
  user-facing environment/MCP forms (System-Admin template management is A4).
- **Depends on:** A2. **Ships green.**

### A4 — Remove the Working Environments page; add a Sysadmin template catalog (redirects #2158)

**Human Section.** The "Working Environments" navigation entry goes away. In its place, a System
Admin can curate **templates** — ready-made repo/provider/MCP/toolchain/context sets — that a new
team copies from at creation, so a newcomer gets a running start.

**Agent Section.**
- Remove the `/environments` nav entry and page from the user IA (G9a); `/environments` redirects
  (the `/agents`→`/chats` precedent). Fields live on the team now (A1).
- Add a System-Admin-only **template catalog**: an environment marked as a template is a *copy
  source*, never a live-shared binding. Team creation/clone copies its structure (A5).
- **This is where #2158 lands** (G1a): the "global" idea becomes copyable templates, not
  `global:true` live-shared visibility. Model providers keep #2136's live-global behaviour.
- **AC:** no user-facing environment list remains; a System Admin can create/edit/delete templates;
  creating a team can start from a template and copies its structure. Removal guard test (the
  `access-page-removed.test.js` shape). Help topic `environments.md` is re-homed onto the team
  settings topic.
- **Depends on:** A3 (and coordinate with the #2158 implementer per §0). **Ships green.**

### A5 — Team clone copies structure only, prompts for credentials

**Human Section.** Cloning a team should copy its repositories, MCP references, toolchain and
context — but never someone else's secrets. The clone should ask you for the credentials it needs.

**Agent Section.**
- Extend the existing clone/convert paths so the copied environment carries **non-secret structure
  only** (repo URLs/branches, `mcpServers` refs, `toolchainId`, `additionalContext`); credential
  references (`githubTokenId`, per-repo `sshKeyId`, MCP `credentialId`) are **not** copied (G2).
- The clone dialog prompts the creator to supply the credentials for the copied repos (H4a); until
  supplied, the affected repos are shown as needing a credential rather than failing silently.
- **AC:** cloning team X into team Y produces Y with X's structure and none of X's secrets; the
  dialog surfaces exactly which credentials Y still needs. Guard test asserts no credential id from
  X appears on Y's environment.
- **Depends on:** A3, A4. **Ships green.**

### A6 — Terminology sweep: "Working Environment" out of the frontend, help, copilot

**Human Section.** The words "Working Environment" should no longer appear anywhere a user looks —
menus, forms, help, the flow copilot.

**Agent Section.**
- Sweep the frontend strings, `help-topics/*`, breadcrumbs/route-titles, and `flow-copilot-prompt`
  vocabulary; fold the environment help material into the team settings topic (coordinate with the
  context-help grounding budget test — `corpus.test.js` worst case).
- The internal data model, API routes and `cfg.environmentId` are **unchanged** (kept internal).
- **AC:** a grep of user-facing strings/help finds no "Working Environment"; `help-coverage.test.js`
  and the corpus budget test stay green.
- **Depends on:** A1–A5. **Ships green (last in block A).**

---

## Block B — Identity & person-bound credentials

### B1 — Humans post under their own Matrix identity into the shared per-agent room

**Human Section.** All of a team's people should chat with an agent in **one shared room** and see
each other's messages and the agent's replies — but each person should be **distinguishable** in
that room. We achieve this by having each human post under their own Matrix identity (which we
already create per user) instead of a single shared admin identity.

**Agent Section.**
- Switch the human send path (`POST /api/matrix/rooms/:roomId/messages`) from the shared
  `MATRIX_ACCESS_TOKEN` admin to **the acting human's own Matrix identity** (provisioned since
  #1458; token in `human-matrix-store`). Keep one room per agent — this is *identity in a shared
  room*, not per-human rooms (the deferred §4 model stays out).
- **Replace the "act iff exactly 2 room members" gate** (`is_dm_from_human`, agent-entrypoint.py):
  the agent responds when the sender is a human member and not itself. This is mandatory once a
  second human can be in the room.
- The chat UI labels each message by its (now real) Matrix sender.
- **AC:** two humans in one agent room both get replies; each message shows its true author
  natively; `event.sender` in the runtime is the real human, not the shared admin. Guard test on
  the send path using the human identity; a runtime test that a 3-member room still responds.
- **Depends on:** none in block B (root). **Prereq check:** confirm the stored per-human Matrix
  token is usable for sending (#1458 built provisioning, not the send path). **Ships green.**

### B2 — Sharing a team invites the human into the team's agent rooms

**Human Section.** When you share a team with a colleague, their chat should just work — they
should already be in the team's agent rooms.

**Agent Section.**
- On team share (`POST /api/admin/memberships` via the Share dialog), invite the new human's Matrix
  identity into every team agent's room immediately (L1); backfill invites for existing rooms.
- On unshare/removal, remove them from those rooms.
- **AC:** a shared-in member opens any team agent and can chat without a lazy room step; a removed
  member is no longer in the rooms. Best-effort + idempotent (the #1458 provisioning discipline).
- **Depends on:** B1. **Ships green.**

### B3 — Thread the acting sender into credential resolution (re-key off the sender)

**Human Section.** When you tell a shared agent to commit, open a PR or push, it must act under
**your** credentials — not the team creator's.

**Agent Section.**
- Thread the real acting sender (from B1) through the agent run so orchestrator-mediated writes
  carry "who is acting". Re-key `resolveAttributedGithubToken` (and the SSH equivalent) from the
  static `resolveAgentOwnerId` to the **acting human** for interactive runs (I1a — resolved
  orchestrator-side; the secret never enters the container).
- The few in-container direct git/gh spots that would otherwise use the baked token are routed
  through the orchestrator-mediated path so attribution holds (or explicitly left on baseline where
  they are non-interactive, e.g. poller/claim-swap).
- **AC:** an interactive commit/PR/push by human A uses A's personal credential; by human B uses
  B's. Guard test over the resolution keyed on the passed sender. Autonomous runs (no sender) are
  unaffected (→ B4).
- **Depends on:** B1. **Ships green.**

### B4 — Team-admin baseline for non-interactive work; just-in-time refusal for writes

**Human Section.** Automatic runs (scheduled, GitHub-triggered) and the very first repo clone
should run under the **team admin's** credentials. If you try an action needing a personal
credential you have not set, you get a clear prompt to add one — not a silent failure.

**Agent Section.**
- Define the **baseline identity** = the team admin's personal credential (H1a/G4a), used for: the
  first clone at team creation (H3a), GitHub polling, and all auto-triggered runs.
- For interactive writes with no usable personal credential of the acting human, **refuse
  just-in-time** with the existing 424 `personal-credential-required` message pointing at My
  Credentials (G5/L2); reads/clone fall back to baseline.
- **AC:** an autonomous run uses the team-admin baseline; an interactive write without a personal
  credential is refused with guidance; a read still works via baseline. Tests for each branch.
- **Depends on:** B3. **Ships green.**

### B5 — Retire the shared team credential; personal is the norm

**Human Section.** A team should not hold a shared secret that everyone silently borrows.
Credentials are personal; the only team-level fallback is explicitly the team admin's.

**Agent Section.**
- Re-interpret `env.githubTokenId` (and per-repo `sshKeyId`) from "the shared team token" to a
  **baseline pointer at the team admin's personal credential** (H1a). Migrate existing team/system
  credential bindings to this model; personal credentials are the default path for interactive
  work.
- Coordinate with #2160 (GOV-CREDENTIALS-1): once credentials are person-bound, the "bind any
  credential by id" holes are closed by construction on the interactive path; the baseline binding
  is the remaining team-level surface to gate.
- **AC:** no interactive action uses a shared team secret; baseline resolves to the team admin's
  personal credential; a migration test over existing bindings. **The deepest migration — last.**
- **Depends on:** B4. **Ships green.**

---

## Block C — Cross-cutting

### C1 — Move skill promote-to-global and plugin-apply to Team Admin

**Human Section.** A Team Admin should be able to publish a skill to the shared catalog and grant
an installed plugin to their team without a System Admin. Only the raw **installation** of a plugin
(which grants real privilege) stays System-Admin-only.

**Agent Section.**
- `POST /api/skills/promote-to-global` (and the `skill-transfer` `to.tier==='global'` path) move
  from System-Admin to **Team-Admin** (G8/H5a). Per H5a, publishing goes into a **shared catalog
  that must still be team-granted** — not an automatic "all teams see it" global — so visibility
  stays "created by sharing".
- Plugin **apply/grant** is already Team-Admin (confirm and keep). Plugin **install/uninstall**
  stays System-Admin-only (broker privilege).
- **AC:** a Team Admin can promote a skill into the shared catalog and grant an installed plugin;
  a Team Admin still cannot install a plugin. Predicate tests for each route.
- **Depends on:** none. **Ships green.**

### C2 — Guide provider onboarding; block team-create without a provider

**Human Section.** The one thing a member cannot self-provide is a model provider. If none exists,
the member should be clearly told to ask an admin, and team creation should be blocked with that
message — not fail later at first run.

**Agent Section.**
- Team-create surfaces detect "no usable provider for me" and block with a clear "ask your admin
  for a model provider" state (G7a/H6a), rather than allowing a team whose first run 500s.
- **AC:** on a platform with no provider, team creation is blocked with the guidance message; once
  a (global) provider exists, creation proceeds. Client + server checks (server is the boundary).
- **Depends on:** none. **Ships green.**
