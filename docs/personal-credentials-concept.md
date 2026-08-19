# Personal (per-human) GitHub tokens & SSH keys — Concept

Status: **concept / decision document**. No implementation code is delivered here. This document specifies the `personal` credential ownership tier completely enough that implementation issues can be derived from it (see §12).

Tracking issue: [#1558](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1558).

---

## Table of Contents

1. [Starting point and goal](#1--starting-point-and-goal)
2. [The `personal` ownership tier (data model)](#2--the-personal-ownership-tier-data-model)
3. [RBAC — who may create, manage and see what](#3--rbac--who-may-create-manage-and-see-what)
4. [Storage, isolation and audit](#4--storage-isolation-and-audit)
5. [Runtime resolution order](#5--runtime-resolution-order)
6. [Autonomous runs and owner identity](#6--autonomous-runs-and-owner-identity)
7. [Rotation and respawn propagation](#7--rotation-and-respawn-propagation)
8. [Offboarding and lifecycle](#8--offboarding-and-lifecycle)
9. [Event polling stays shared](#9--event-polling-stays-shared)
10. [SSH keys are account-wide](#10--ssh-keys-are-account-wide)
11. [The UI surface](#11--the-ui-surface)
12. [Confirmed decisions, edge cases, dependencies, follow-ups](#12--confirmed-decisions-edge-cases-dependencies-follow-ups)

Acceptance-criteria map (issue #1558): AC1 → §2 · AC2 → §3 · AC3 → §5 · AC4 → §2/§3/§9 (unchanged tiers) · AC5 → §4 · AC6 → §7 · AC7 → §6 · AC8 → §8 · AC9 → §9 · AC10 → §10 · AC11 → §2/§3 + §12 (dependencies).

---

## 1 — Starting point and goal

### Where we are today (verified)

Credentials — SSH keys and GitHub Personal Access Tokens (PATs) — currently support **two** ownership tiers, both defined in `admin-console/api/scope.js`:

- **`team`** — owned by exactly one human Team (`teamId`). Visible to that team's Team Admins and to full-visibility admins.
- **`system`** — created by a System Admin, assigned to 0..n teams (`assignedTeamIds[]`). Visible to full-visibility admins always and to the Team Admins of every assigned team.

Key facts about the current model:

- **No owner reference.** A credential entry carries `scope: 'team' | 'system'`, `teamId` and `assignedTeamIds[]` — there is **no `userId`/owner field** (`normalizeCredential`, `resolveCredentialOwnership` in `admin-console/api/api.js`).
- **Creation gating** (`canCreateCredential`): system-scoped → full-visibility admin only; team-scoped → Team Admin of that team. **A plain Team Member cannot create any credential at all.**
- **Management gating** (`canManageCredential`): a Team Admin may edit/delete team-scoped credentials of a team they administer, never system-scoped ones; full-visibility admins may manage all. Reassigning a credential's scope/team is System-Admin-only (`canReassignCredential`).
- **Runtime resolution is agent → environment → credential.** An agent's credential is resolved purely from its Working Environment: `env.githubTokenId` and `env.repositories[].sshKeyId` (`orchestrator/orchestrator.js`). The token/key is injected into the container **at spawn** and is immutable for the container's lifetime; repointing an environment's token triggers a respawn of the affected agents.
- **The GitHub poller picks one token per repo** (first environment wins) for event polling.

Two existing hooks make a personal tier a natural extension rather than a greenfield build:

- Agents already carry `config.ownerId` (and `visibility: 'private'`); `visibleAgent` in `scope.js` already keys private-agent visibility on `ownerId === scope.userId`.
- User records already carry an optional `githubHandle`, surfaced on the session by `describeAuthz`.

### The goal

The platform's intent is that **every team member can run their own agent team, and that team acts on GitHub under *that person's* name and identity.** Today that is impossible: no credential can belong to an individual, and a plain Team Member cannot register one. This concept adds a **personal** credential tier so any authenticated human can store their own GitHub token and SSH key, kept strictly private to them, and have their agents work under their personal identity — while shared/global credentials keep working for infrastructure that isn't tied to one person.

### Why personal identity attaches to the PAT more than the SSH key

An SSH key authorizes *transport* (which principal may push over SSH); the **GitHub PAT and the git commit author** drive *attribution* (whose name appears on commits, PRs, reviews). Personal identity therefore matters most for the **PAT on attributed write operations**. Read-only clones and event polling can keep using a shared credential without misattributing anyone. This asymmetry shapes the resolution rules in §5.

---

## 2 — The `personal` ownership tier (data model)

*(satisfies AC1, AC11; decision D1)*

Add a third ownership tier, **`personal`**, for **both** SSH keys and GitHub tokens, owned by a human. The minimal data-model change is a single new owner field on a credential entry:

```
scope:  'personal' | 'team' | 'system'
userId: <the owning human's id>          // present iff scope === 'personal'
teamId, assignedTeamIds[]                // as today; null/[] for personal
```

- `userId` references the human's stable id — the same `id`/`subject` that `computeScope` resolves onto `scope.userId` and that agents already carry as `config.ownerId`. This is the join key for every personal-tier decision.
- `personal` is **additive** (D1): `team` and `system` entries are untouched, keep all their fields, and behave exactly as today. `normalizeCredential` continues to normalize legacy entries (no `scope`) to `team`/`default`; a `personal` entry is only ever produced by the new personal-creation path, so legacy data is unaffected.
- A `personal` credential carries **no** `teamId`/`assignedTeamIds` — it is bound to a person, not a tenant. It is never "assigned" to a team (that is what `system` is for).

This is the whole storage change: one field. Everything else is RBAC (§3) and resolution (§5).

---

## 3 — RBAC — who may create, manage and see what

*(satisfies AC2, AC5, AC11; decisions D1, D2)*

The personal tier extends the three existing predicates in `scope.js`; the `team`/`system` branches of each stay **byte-for-byte as today** (AC4).

- **Create** (`canCreateCredential`) — **any authenticated human** (Team Member, Team Admin or System Admin) may create a `personal` credential, and only for **themselves**: the requested `userId` must equal `scope.userId`. The `team`/`system` branches are unchanged (team-scoped → Team Admin of that team; system-scoped → full-visibility admin only). This is the one place a plain Team Member gains a create capability, and it is strictly self-scoped.
- **Manage** (`canManageCredential`) — a human may rename, rotate and delete **their own** personal credentials: `cred.scope === 'personal' && cred.userId === scope.userId`. No one else may manage them.
- **See** (`visibleCredential`) — a personal credential is visible **only** to its owner: `cred.scope === 'personal' && cred.userId === scope.userId`. It never appears in any other human's list — see §4 for why this must not honour the `scope.all` override.
- **Reassign** (`canReassignCredential`) — a personal credential **cannot** be reassigned to another human or converted to a shared tier, and a shared credential cannot be "adopted" as personal. Ownership of a personal credential is fixed at creation; changing owner is not a supported operation (offboarding deletes, it does not transfer — §8).

Everything a human may do to their own personal credential mirrors what a Team Admin may already do to a team credential (create / list-metadata / rotate / delete), just keyed on `userId` instead of `teamId`.

---

## 4 — Storage, isolation and audit

*(satisfies AC5; decision D2)*

**Strictly private (D2).** Personal-tier credentials are neither visible to nor manageable by any other human — **including System Admins**. Concretely, the personal tier has **no `scope.all` override**: unlike every other predicate in `scope.js`, `visibleCredential`/`canManageCredential` must **not** early-return `true` for `scope.all` when the credential is `personal`. A System Admin (or the env single-admin) sees their *own* personal credentials and no one else's. This is a deliberate, load-bearing exception to the "operator never loses visibility" rule that governs the rest of `scope.js`, and it must be called out in code so a future refactor does not "restore consistency" and reopen the hole (cf. the visibility-leak class of bug in #1501).

**Secret handling is unchanged.** As today, the private key / PAT secret is write-only: the API returns only a fingerprint (SSH) or a masked prefix + last four (PAT), never the secret after creation. Personal entries store the secret the same way and in the same on-disk stores, distinguished only by `scope: 'personal'` + `userId`. (Where the secret bytes live — `SSH_KEYS_DIR` / `GH_TOKENS_DIR` today vs. a K8s Secret / vault later — is the multi-user concept's data-isolation question, out of scope here.)

**Audit consequence.** Creating, rotating and deleting a personal credential is an attributed `/api` mutation under `req.user`, audited like every other credential mutation. What is deliberately **not** possible is any admin *read* or *use* of another human's personal secret — there is **no break-glass** (D6, §8). The audit trail can therefore record *that* a person managed their own credential, but the platform provides no mechanism for anyone else to see or act under it. If a person is unavailable, their agents pause (§8); the secret is never recoverable by an operator.

---

## 5 — Runtime resolution order

*(satisfies AC3; decisions D1, D5, D7)*

The credential an agent uses is resolved in the order:

> **personal (of the agent's owner) → team → system**

"The agent's owner" is `config.ownerId` (for a team-member, resolved via its parent team-agent's owner, mirroring `resolveAgentTenant`). Resolution is per **operation class**, because attribution and transport differ:

| Operation | Prefers | Rationale |
|---|---|---|
| Attributed **writes** — commits, PRs, reviews, HTTPS/SSH push (`gh-as-agent`, `git push`) | **personal PAT** of the owner; personal SSH key for SSH transport | These carry the human's name; they must run under the owner's identity. |
| Read-only clones (deploy-key / HTTPS read), the repo-check probe | shared `team`/`system` credential is fine | No attribution; a shared read credential misattributes no one. |
| Event polling of a repo | shared `team`/`system` token **only** (§9) | Poller is per-repo infrastructure, not per-human (D7). |

The order is a **preference among tiers**, not a fallback for a *missing* personal credential. When an operation prefers the personal tier and the owner **has no usable personal credential**, the run **refuses** — it does **not** silently drop to `team`/`system` (D5, §6). "No usable" includes both *absent* and *present-but-underscoped* (e.g. a PAT missing `repo`/`workflow`); both surface the same refusal. The fallback chain only applies where a shared credential is legitimately acceptable (reads, polling).

The `team` and `system` tiers remain fully available for infrastructure roles — global SSH keys, shared service/bootstrap tokens, read-only deploy keys — and their behaviour is unchanged (D1, §2/§3). A team with no personal credentials in play behaves exactly as it does today.

---

## 6 — Autonomous runs and owner identity

*(satisfies AC7; decisions D4, D5)*

For a **chat** turn the acting human is obvious. The design question is autonomous runs (cron / GitHub-event), where no human is in the loop.

- **Owner identity by default (D4).** An autonomous run acts under its **owner's** (`config.ownerId`) personal credential — **not** the identity of whoever initiated the trigger, and never a foreign human. This keeps attribution stable and predictable regardless of what event woke the agent.
- **Teams with multiple operators (D4, edge case).** A team-agent's autonomous run uses the **team-agent's own `ownerId`** identity. Several humans may operate the team, but the team-agent has exactly one owner, so its autonomous commits/PRs are attributed to that one person — not to whichever member happened to trigger the run.
- **No credential ⇒ refuse (D5).** When a required personal credential is absent — or present but missing a required scope (`repo`/`workflow`) — the agent **refuses the run with a clear message** rather than falling back to a team/system credential. An agent never acts under a foreign identity by surprise. The refusal names the owner and what is missing (absent vs. underscoped) so the human can fix it and re-run.

---

## 7 — Rotation and respawn propagation

*(satisfies AC6; decision D3)*

Setting or rotating a person's personal credential **propagates by respawn**, reusing the existing env-credential-change → respawn path (`orchestrator/orchestrator.js`), **scoped to the owner's affected agents** — i.e. only the agents whose resolved credential (§5) is that person's personal one. Because the credential is baked into the container at spawn and is immutable for its lifetime, a running agent only picks up the new secret on its next spawn.

- **In-flight-work caveat (D3).** Respawn interrupts any in-flight work (a mid-run loop or trigger is cut). Rotation should therefore be done at a quiet moment — the same caveat the shared-token rotation flow already documents in `docs/credentials.md`.
- Disabled/idle agents pick up the fresh credential on their next enable/spawn, as today.
- Scoping the respawn to the owner's agents means one person rotating their token never disturbs another person's — or the team's shared — agents.

*Implemented (#1570, Phase 4):* the admin-console `notifyOwnerCredentialChange(userId)` (fired on personal SSH-key/GitHub-token **set** and **rotate**) calls `POST /internal/owners/:ownerId/respawn-agents` → `orchestrator.respawnAgentsForOwner`, the owner-scoped sibling of `respawnAgentsForEnvironment`. Owner matching is the pure `credential-resolution.selectAgentIdsForOwner` (over `resolveAgentOwnerId`, so a team-member resolves via its parent team's owner); disabled/not-running/tokenless agents are skipped exactly like the env path. This also closes the prior gap where a personal **SSH-key** change triggered no respawn at all.

---

## 8 — Offboarding and lifecycle

*(satisfies AC8; decisions D2, D6)*

**Offboarding = auto-delete + pause (D6).** When a human is deactivated or leaves:

1. **Their personal credentials are automatically deleted** (all personal SSH keys and PATs owned by that `userId`).
2. **Their affected agents are paused** — the agents whose resolved identity was that person's personal credential. Consistent with D5, a paused agent does not fall back to a shared identity; it stops rather than act under someone else's name.

**No break-glass (D6, consistent with D2).** There is deliberately **no** admin path into a departed person's secrets — not to read them, not to transfer them, not to keep their agents running under the old identity. If the work must continue, an operator re-owns the affected agents to a present human, who supplies their **own** personal credential. This is the lifecycle consequence of the strictly-private guarantee in §4: a secret no one but the owner can ever see is also a secret no one can inherit.

*Implemented (#1571, Phase 5):* `DELETE /internal/admin/users/:id` now calls `orchestrator.offboardOwner(userId)` **before** `teamsStore.deleteUser`, so a partial failure leaves the user recoverable rather than deleted-with-lingering-secrets (AC5). `offboardOwner` (1) **pauses** the person's agents — `credential-resolution.selectAgentIdsForOwner` (over `resolveAgentOwnerId`, so a team-member is matched via its parent team's owner) selects them, each drained in place via `disableAgent(id, { mode: 'drain' })` (disabled, never wiped — AC2); then (2) **deletes** the person's personal credentials — `credential-resolution.selectPersonalCredentialIds` picks only `scope: 'personal'` entries owned by that `userId` (a team/system entry is never matched even if its `userId` coincides — AC3), and `_deletePersonalCredentials` unlinks each 0600 secret file and rewrites the `_keys`/`_tokens` index without them (AC1/AC4). Pausing first means any in-flight attributed write that outlives the pause **refuses** (Phase 3 refuse-on-missing) rather than acting under a now-deleted identity, and a drained agent does not auto-resume — re-enabling it is an explicit human decision (edge case). Best-effort per item; a summary is returned on the delete response and logged.

---

## 9 — Event polling stays shared

*(satisfies AC9; decision D7)*

Event polling of a repository continues to use a shared `system`/`team` token, exactly as today — the poller picks **one token per repo** (first environment wins). **The personal tier never gates or replaces the poller's per-repo token.** Polling is per-repo infrastructure that must keep working regardless of which humans own agents on that repo, and it performs no attributed writes, so a shared read token is correct. A shared repo's polling therefore always uses a shared token, never a personal one (edge case). This keeps the poller decoupled from per-human lifecycle events (a person leaving — §8 — must never stop a repo being watched).

---

## 10 — SSH keys are account-wide

*(satisfies AC10; decision D8)*

Personal SSH keys are **account-wide**: one personal key authorizes the owner's SSH transport across all repositories they touch, mirroring how a developer's single SSH key works on GitHub. **Per-repo personal deploy keys are explicitly out of scope for now** and may be added later. (Shared per-repo deploy keys remain available on the `team`/`system` tiers for read-only infrastructure clones — unchanged.)

---

## 11 — The UI surface

*(supports the "UI for a human to manage their own credentials" scope item)*

Any authenticated human gets a self-service surface to manage their **own** personal credentials, alongside the existing admin credential pages (`/ssh-keys`, `/github-tokens`):

- **Create** a personal SSH key / GitHub token (choose ownership = *Personal (me)*). The create form is available to every authenticated human — a Team Member sees it even though they cannot create team/system credentials.
- **List (metadata only)** their own personal credentials: fingerprint / masked prefix, created date, and *what it's used by* (which of their agents resolve to it). No secret is ever shown.
- **Rotate** (create-new + repoint, with the respawn caveat of §7 surfaced inline) and **delete** their own.
- A human **never sees another human's personal credentials** in any list (§4). Team/system credential management stays exactly where it is, gated as today.

Copy should make the tier and its identity consequence explicit (a personal credential means *your agents act as you on GitHub*), addressing the adjacent "invisible `${credential}` magic" UX concern (#1507) for this tier.

---

## 12 — Confirmed decisions, edge cases, dependencies, follow-ups

### Confirmed decisions (binding requirements)

| # | Decision | Where specified |
|---|---|---|
| **D1** | Additive — `personal` alongside `system`/`team`; nothing removed; shared credentials keep working. | §2, §3, §5 |
| **D2** | Strictly private — no other human, incl. System Admins, may see or manage a personal credential; no `scope.all` override. | §3, §4 |
| **D3** | Respawn propagation — setting/rotating a personal credential respawns the owner's affected agents; in-flight work interrupted. | §7 |
| **D4** | Owner identity by default — autonomous runs use `config.ownerId`'s personal credential (team-agent uses the team-agent's owner). | §6 |
| **D5** | No credential ⇒ refuse — absent or underscoped personal credential refuses the run; no team/system fallback. | §5, §6 |
| **D6** | Offboarding = auto-delete + pause; no admin break-glass. | §8 |
| **D7** | Polling uses a shared token — personal tier never gates/replaces the poller's per-repo token. | §9 |
| **D8** | Account-wide SSH keys; per-repo personal deploy keys deferred. | §10 |

### Edge cases

- A shared repo's event polling always uses a shared `system`/`team` token, never a personal one (§9, D7).
- A team operated by more than one human runs its team-agent under the team-agent's `ownerId` identity (§6, D4/D5).
- Rotation while a loop/trigger is mid-run — respawn interrupts it (§7, D3 caveat).
- A personal token lacks required scopes (`repo`/`workflow`) — the run refuses with a clear error, on the same path as a missing credential (§5/§6, D5).
- Legacy credentials (normalized to `team`/`default`) are unaffected — `personal` is only ever produced by the new self-creation path (§2).
- Multi-forge repositories are out of scope, but the `userId`-owner model does not preclude them: the owner field is forge-agnostic.

### Dependencies

- **[#1456](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1456)** — API authentication middleware. Personal ownership requires a **trustworthy `req.user`** to attribute creation and gate `canCreateCredential`/`canManageCredential`/`visibleCredential` on the acting human. Without a dependable acting identity the strictly-private guarantee (D2) cannot hold.
- **[#1458](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1458)** — Per-human Matrix identity. This concept is the **git-credential sibling** of the same per-human-identity work: #1458 gives a human their own chat identity, this gives their agents their own GitHub identity.

### Related work

- [#178](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/178) — multi-user architecture with enterprise SSO (parent context; `docs/multi-user-concept.md`).
- [#288](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/288) — per-user token *usage*/cost accounting (distinct from per-user *credentials*).
- [#1501](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1501) — bound/respawn agent credential-visibility leak (the "who can see whose credential" boundary this concept hardens).
- [#1507](https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/issues/1507) — `${credential}` UX (§11).

### Out of scope

- Implementation itself (this is a concept ticket).
- SSO/OIDC identity provisioning (#178, #1458).
- Token usage/cost accounting (#288).
- Non-GitHub forges — Bitbucket (#1523), GitLab (#1493/#1494).

### Follow-up implementation issues (derivable from this concept)

1. **Data model** — add `scope: 'personal'` + `userId` to credential entries; extend `normalizeCredential` (personal passthrough; legacy untouched) and `resolveCredentialOwnership`. *(shipped — #1576)*
2. **RBAC** — extend `canCreateCredential` (self-scoped personal create for any human), `canManageCredential` and `visibleCredential` (owner-only, **no `scope.all`** for personal), and reject reassignment of personal credentials. *(shipped — #1576)*
3. **Runtime resolution** — implement the personal → team → system order per operation class in the orchestrator, with the refuse-on-missing/underscoped behaviour (D5). *(pure decision core + attributed-write wiring shipped — #1569; the live end-to-end path activates once `config.ownerId` population lands, and the present-but-underscoped scope probe is the completion step)*
4. **Respawn propagation** — scope the existing credential-change → respawn path to an owner's agents on personal-credential set/rotate (D3). *(shipped — #1570)*
5. **Offboarding hook** — on user deactivation, auto-delete the person's personal credentials and pause their affected agents (D6). *(shipped — #1571)*
6. **UI** — the self-service personal-credential surface on `/ssh-keys` and `/github-tokens` (§11).

Depends on #1456 (trustworthy `req.user`) landing first.
