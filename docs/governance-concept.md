# Agent Studio Platform Governance — Concept

> Status: **concept & options only** — nothing here is implemented by this document.
> Scope: the whole platform, sized for a typical large delivery project — **~50 human
> users, dozens of autonomous agents, multiple Agent Teams sharing one installation.**
> Every gap named below was verified in the current code by a survey pass (file
> references included); every proposed control attaches to a mechanism that already
> exists. Companion concepts this document builds on:
> `docs/knowledge-governance.md` (autonomy dial + supervised review — the governance
> pattern this concept generalizes), `docs/multi-user-concept.md` (roles/SSO),
> `docs/cost-per-pr-concept.md` (token telemetry), `docs/skill-lifecycle-concept.md`
> (skill versioning/lineage).

---

## 1. Purpose & scope

Agent Studio has a working **permission** concept (Teams, System Admin / Team Admin /
Team Member, `scope.js` visibility filtering, an append-only audit trail) but no
**governance** concept: nothing systematically bounds what a well-meaning newcomer, a
misconfigured autonomous agent, or simple scale can break, leak, or overspend. The
sponsor's four worries, taken verbatim as requirements:

1. **Skills must not be silently degraded** by misconfigured agents (or day-one users).
2. **Token spend must be boundable** — today there are no budgets anywhere.
3. **Work must not bypass project regulations.**
4. **A newcomer must not be able to break the platform** on their first morning.

Equally binding is the counter-requirement: **not a locked-down system.** The platform's
value is Team-Admin self-service and autonomous agents; governance must scale that to 50
people, not strangle it.

This document defines the governance model (§3), then walks the platform domain by
domain (§4–§10), covers the surfaces the domain cut would otherwise miss (§11), the
organizational operating model (§12), a minimum-viable-governance shortlist (§13), and a
rollout roadmap (§14). Controls carry stable IDs (`GOV-<DOMAIN>-n`) for later tickets.

---

## 2. Governance stance — six principles

1. **Guardrails over gates.** The default answer to "should this need approval?" is
   *no — audit is enough*. Hard gates are reserved for the short list where one mistake
   propagates platform-wide or runs unattended.
2. **Observe → warn → enforce.** Every behavioral control ships in *observe* (record the
   would-be violation), steps to *warn* (notify a human, allow), and only then *enforce*
   (deny/hold — always with an audited override). Missing **locks** (routes that simply
   forgot authorization) skip the ladder: they are bugs, not guardrails.
3. **Progressive trust.** New users start read-only and are promoted by their Team Admin
   in the UI — a membership edit, not a ticket. New agents start at low blast radius;
   higher tiers are deliberate, audited acts. High autonomy (knowledge level 3) is a
   recorded acknowledgment, not a checkbox.
4. **Recoverability beats prevention.** Where rollback is cheap (skills, prompts,
   config), invest in snapshots + one-click revert and keep the write path light. Gate
   hard only what cannot be rolled back (spend, secret exposure, pushed code).
5. **Reuse the choke points.** Every control attaches to an existing seam — `scope.js`
   predicates, the audit funnel, prompt assembly, the maintenance-mode flag, the usage
   spool, the hill-climb loop, the lint set, the label registry. No parallel control
   plane, no new vocabulary where one exists.
6. **Nothing is silently lost.** Enforcement degrades gracefully: budget exhaustion
   defers durable queues (maintenance-mode semantics), throttles fold into lossless
   digests, quarantined triggers await approval instead of vanishing. Chat with a human
   at the keyboard is never blocked.

---

## 3. The governance model — cross-cutting primitives

Five primitives every domain chapter references. They are also where this concept makes
binding decisions where the domains would otherwise diverge.

### 3.1 Personas — the normative role matrix

One new role: **Team Viewer** (added to `MEMBERSHIP_ROLES` in
`orchestrator/teams-store.js`, learned by `admin-console/api/scope.js`). The matrix
below is the **single normative permission table** of the platform; the route policy of
GOV-ACCESS-1 encodes it. `R` read, `W` write, `–` none, `4E` four-eyes (§4), `†` own
team(s) only.

| Resource | Viewer | Member | Team Admin | System Admin |
|---|---|---|---|---|
| Agents / flows / metrics / knowledge (read) | R† | R† | R† | R |
| Chat: read transcripts & session logs | R† | R† | R† | R |
| Chat: send, stop, reset, ticket bind | – | W† | W† | W |
| Workspace / context browse | R† | R† | R† | R |
| Workspace write, git-action | – | W† | W† | W |
| Create/edit agents up to tier T1 (§3.3) + own triggers | – | W† | W† | W |
| Agents at tier T2 (repo+PAT) | – | confirm-warn† | W† | W |
| Agents at tier T3 (RW host mount) | – | – | W† (audited) | W |
| Team create (wizard) | – | – | W | W |
| Working Environments | R† | R† | W† | W |
| Credentials (all four families) | – | R meta† | W† create/bind | W + reassign |
| MCP server registry | R† | R† | W† (team-scoped) | W (system) |
| Skills: team tier | R† | R† | W† | W |
| Skills: global pool | R | R | propose (4E) | W / approve |
| Knowledge autonomy dial (levels 0–2 / level 3) | R† | R† | W† / W†+ack | W |
| Hill-climb run/apply/rollback; team disable/enable | R† | R† | W† | W |
| Usage & budget view | R† | R† | R† | R + export |
| Maintenance mode / platform envelopes / regulations store | – | – | – | W |
| Audit log | – | – | R† (team view) | R |
| Users & memberships | – | – | W† (own team) | W |

Deliberate calls: **Members keep building power** (T0/T1 agents, chat, workspace) — the
junior tier is Viewer, and promotion is the Team Admin's everyday act. Team creation,
team skills, autonomy dials, budgets-within-envelope and memberships stay **Team-Admin
self-service**; System Admins hold only the platform-wide levers (global pool,
maintenance, envelopes, regulations, credential reassignment).

### 3.2 The enforcement ladder

Vocabulary used by every control: **observe** = allow + audit-tag the would-be
violation; **warn** = allow + audit + notification (banner / DM to the actor and the
Team Admin); **enforce** = deny (4xx) or hold (quarantine/pending), always audited,
always with a defined override path. Teams step a control up (never below the platform
floor) by editing that control's config slot — an ordinary audited `/api` mutation.
Would-deny audit lines double as a usage census during observe phases.

### 3.3 Blast-radius tiers (GOV-AUTONOMY-1)

A pure, **derived** classification (`blastRadiusTier(cfg, env)`, sibling of
`agentIsAutonomous()` in `orchestrator/prompt-assembly.js`) — computed, never stored,
so it cannot be faked down:

- **T0 chat-only** — no triggers, no repo, no mounts.
- **T1 scheduled** — cron/once/loop/http triggers; no GitHub write capability.
- **T2 GitHub-writing** — env has repo + PAT and/or `github-event` triggers.
- **T3 host-writing** — any `contextMounts[].readWrite: true`.

The tier appears as a badge (Agents page), is stamped
into audit lines, and keys the defaults of trigger policy (§7), creation rules (§3.1)
and mount governance (§10). *P0, small build.*

### 3.4 Policy carriage, envelopes, floors

- **Per-team policy** rides the proven config-carriage pattern (`hillClimb` /
  `anomalyThresholds` on the team agent — round-tripped through
  export/materialise/Edit-as-draft, enforced server-side). New slots: `tokenBudget`
  (§6), `triggerPolicy` incl. backstop overrides (§7 — the *single* home of backstop
  config), `modelPolicy` (§6), `policy.lints` (§9).
- **Platform envelopes** cap what Team Admins may grant themselves:
  `/workspace/governance/budget-envelopes.json` (System-Admin-writable) carries max
  budgets, `maxAgentsPerTeam`, and minimum enforcement modes. Raising an envelope *is*
  the approval — recorded by the audit trail, no workflow engine.
- **Platform floors** are System-Admin-owned defaults a team can raise but never lower
  (e.g. the two error-severity lints of §9 stay `enforce` everywhere).

### 3.5 One internal-auth implementation (binding decision)

Six domains independently need the same thing, so it is defined **once** and referenced
everywhere: the orchestrator internal API on `:4002` is today **unauthenticated,
unaudited, and reachable from agent containers** — every console-side gate in this
document is bypassable until this lands, which makes it the highest-leverage control of
the whole concept.

**GOV-PLATFORM-2 (canonical): one auth middleware at the internal server mount, three
token classes** — (a) a **control-plane token** (`INTERNAL_API_TOKEN`, injected into the
admin-console container, sent as a bearer header by the proxy layer; grants the full
`/internal/*` surface), (b) **per-agent tokens** minted at `startAgentProcess` and baked
into the container env exactly like the PAT (valid only for the agent-facing allowlist —
`/internal/agents/:id/claim`, `ticket*`, knowledge, usage ingest,
maintenance-mode read — and **only for the agent's own `:id`**), (c) a
**signaler token** for external event sources (`POST /internal/bp-events` — the ACE
`bp-transition.py` caller; without this class, enforcement would break BP routing).
Rollout via `INTERNAL_AUTH_MODE=observe|warn|enforce`: one observe week inventories
every real caller (including forgotten integrations), then enforce. **The unset default
is deployment-dependent (#2459):** a local Podman Compose stack keeps `observe` for
developer convenience, while the shared/production-style **GKE/Kubernetes** deploy path
(`AEE_CONTAINER_RUNTIME=kubernetes`) defaults to `enforce` **once the gate is armed** — so
a shared cluster does not linger in silent log-only mode. An explicitly set mode always
wins (a deliberate migration-window `observe` is never overridden), and a non-local
deployment that is not enforcing logs a startup warning. Agent tokens rotate
via the existing respawn-on-credential-change path. Companion **GOV-PLATFORM-3**: an
`auditMutations` sibling on the internal app writes every `/internal/*` mutation to
`/workspace/audit/audit-internal-<date>.jsonl` with
`callerKind: console-proxy | agent:<id> | signaler | anonymous` — closing the audit
blind spot and restoring attribution (an agent can no longer push, claim, emit, or
reconfigure *as any other agent*). *P0, small build; prerequisite for the enforce rungs
of §5, §6, §7, §8, §9.*

### 3.6 One audit spine

The console audit trail is extended once, serving every domain that needs "what
changed": (a) reliable `teamId` stamping resolved from route params, (b) a **compact
field-level diff** for mutations of governed resources (agent config, triggers, skills,
labels/gates, autonomy, budgets — old/new for scalar fields, credential-shaped values
redacted), (c) optional `reason` fields captured from confirmation dialogs, (d) a
team-filtered `GET /api/audit` view for Team Admins (self-service governance: Team
Admins police their own team). Attaches at `admin-console/api/audit.js`
(`buildEvent`/`record`) + `scope.js`. *P1, small build (GOV-ACCESS-10; also serves
GOV-SKILLS-6 and GOV-DELIVERY-3).*

---

## 4. Identity, roles & access control

### Verified risk picture

- **Authorization is opt-in per route, and whole families never opted in**: any
  logged-in user can create teams and spawn container fleets (`POST /api/teams`),
  register stdio MCP servers whose `command` executes inside agent containers, toggle
  **platform-wide maintenance mode**, edit any team's skills, and publish to the global
  skill pool (worries #1 and #4 in one sentence).
- ~~**Tenant isolation stops at the config plane**: the chat/session/workspace route
  family (`api.js` ~13343–15811) has effectively one visibility check — any user can
  read/write any agent's workspace, run git commit/push in it, and post into any Matrix
  room as the admin token (worry #3: pushing work through another team's agents,
  outside their gates).~~ **Closed for cross-tenant access by #1459** (2026-09-08) —
  *any user* is now *any member of the agent's own team*: GOV-ACCESS-3 below is
  delivered at that boundary, and with it the gate half of GOV-PLATFORM-4. Still open
  **inside** a team: #2041 D9 rules workspace writes and `git-action` Team-Admin-only,
  which `docs/decentralised-access-concept.md` §11.2 assigns to P2. The finding is left
  visible rather than deleted because it is what the two controls were written against;
  the route range it cites has since moved, and the family is now addressed by parameter
  name (`:agentId`) rather than by line number. See `admin-console/api/work-plane-access.js`.
- **Sessions are irrevocable 7-day cookies** — deleting a user or changing a password
  leaves their sessions alive; the initial administrator ships as `admin`/`admin`.
  (Since #2059 that administrator is at least a real, attributable **record** rather
  than a shared recordless credential — but the shipped default is unchanged, and a
  password change no longer even invalidates sessions as a side effect, the cookie key
  having been decoupled from it.) Offboarding is fictional today.

### Controls

**GOV-ACCESS-1 — Central deny-by-default route policy.** `P0 · small build · observe → enforce`
A declarative table (`method + path pattern → required permission`) evaluated where
`getScope(req)` already runs, resolving through the existing `scope.js` predicates;
unmatched mutating routes are flagged. Eliminates the "route forgot to opt in" failure
class permanently. Encodes the §3.1 matrix. Observe first (would-deny census), enforce
per route family after two weeks. Option B (server refuses to start unless every route
is covered, census in CI) is the end state.

**GOV-ACCESS-2 — Close the verified holes now.** `P0 · small build · enforce day one`
The specific ungated mutations are missing locks, not guardrails — no ladder: team
create → Team Admin; MCP registry → owning-team admin / System Admin; **maintenance
mode → System Admin**; skills CRUD → tier-appropriate admin (§5); knowledge autonomy →
Team Admin; team disable/enable + hill-climb actions → Team Admin; drafts/templates →
Team Admin (drafts owner-editable); `/api/audit` → System Admin + team view.

**GOV-ACCESS-3 — One middleware for the work plane.** `P0 · small build · reads observe 1 week, writes enforce day one` — **DELIVERED as worded (#1459, 2026-09-08); tightened further by #2041 D9 at P2**
A single `:agentId`-keyed middleware in front of the whole chat/session/workspace
family: reads require `visibleAgent` (404 on miss — don't leak existence), writes
(post message, session ops, workspace write, git-action, queue cancel) require
membership in the agent's team. Same treatment for `/api/matrix/*` (resolve room →
agent before posting with the admin token).
*As built* (`admin-console/api/work-plane-access.js`): one middleware over a prefix
list mounted directly after `auth.gate`, and the room routes resolve room → agent
through `findAgentByDmRoom`. Two deviations, both deliberate. **The read/write split
is one predicate, not two branches** — with the two roles that exist today
`visibleAgent` already resolves through the caller's membership set, so "writes
require membership" is the same test; a second branch would be unreachable code, so
the equivalence is pinned by a cross-product test instead and GOV-ACCESS-4's
`team-viewer` tier is what will make the halves diverge. **There is no separate
observe rung for reads** — `AUTH_ENABLED` (#1457) already is one: it ships **off**,
which makes every caller `all: true` and the gate a no-op, so the enforcement cannot
bite until an operator turns multi-user authorization on. Both refusals are 404.
**Note the ceiling this control has as worded**: "membership in the agent's team" is
the *tenant* boundary, so a Team **Member** may still delete workspace files and run
`git-action` in their own team's agents. `docs/decentralised-access-concept.md` §6 (D9)
rules that Team-Admin-only and §11.2 schedules it for P2 — a separate, narrower change
that cannot be method-based (posting a message, opening a DM room, attaching a file and
stopping your own run are writes D9 deliberately allows a member).

**GOV-ACCESS-4 — Viewer role; Member as standard builder tier.** `P0 · small build · structural`
Adds `team-viewer` (§3.1). **New joiners default to Viewer**; promotion is a Team-Admin
membership edit. Nobody existing is downgraded at rollout.

**GOV-ACCESS-5 — Session revocation & hygiene.** `P0 · small build · enforce`
A per-user `sessionEpoch` on the user record, embedded in tokens, validated in
`requireAuth` (≤60 s cache): password change, user deletion, or "sign out everywhere"
bumps it and kills all sessions. TTL 7 d → 24 h **sliding** (renewal invisible to daily
users — epoch revocation, not TTL, is the real control); `AUTH_COOKIE_SECURE` mandatory
off-localhost.

**GOV-ACCESS-6 — Four-eyes for the short list only.** `P1 (interim rule at P0) · small build · warn → enforce`
Exactly three cases: (1) **skill promote-to-global** — proposer (Team Admin) ≠ approver
(**decided: a System Admin *or* a Team Admin of a different team** — keeps platform
operators out of the daily path; proposer ≠ approver enforced server-side), via a
hill-climb-card-style pending-proposal record; interim P0 rule: promote-to-global is
System-Admin-only (one predicate line). (2) **Knowledge autonomy → level 3** — a
recorded acknowledgment in the `complianceAck` pattern (typed confirmation naming the
consequence, persisted, audited, System Admins notified) — *not* a central approval;
see §5. (3) **Credential reassignment** — already System-Admin-only; add the recorded
ack. Maintenance mode gets **no** four-eyes — an emergency brake must pull one-handed
(typed reason + auto-expiry instead, §7). Everything else: audit is enough.

**GOV-ACCESS-7 — Break-glass governance.** `P0 · process · enforce`
*Restated by #2059 (concept #2041 D13): there is no env-admin login left to refuse.*
The configured initial user is consumed once at first boot to create a real
System-Admin **record** and is never read again, so the console has exactly one login
path and every session resolves to a named person. That removes this control's
original subject and moves the break-glass **off the console**: recovering a lost
administrator is a **host-level** action on the orchestrator volume
(`/workspace/users/index.json`), which is where comparable systems put it
(`gitlab-rails console`, `occ user:resetpassword`, `grafana-cli
admin reset-admin-password`) — and it is deliberately not reachable through the UI,
since an in-console way back in would be the shared recordless credential wearing a
different name. What remains governable is therefore process, not config: **host
access is the break-glass** and must be held by the people the runbook names; the
shipped `admin`/`admin` seed must be replaced on the Users page (afterwards the
password lives on the record, so rotating `.env` no longer revokes it); and **≥2
named System Admin records** stays the rule — now partly enforced rather than merely
advised, since the store refuses to delete or demote the last one, which means a
single-administrator stack cannot lock itself out by accident but equally has nobody
to recover it from inside. The `break-glass-login` audit marker retires with the
login it marked; the seeding itself writes one audit entry (`method: BOOTSTRAP`), so
how an instance's first administrator got there is answerable in an access review —
which it previously was not.

**GOV-ACCESS-8 — Joiner / Mover / Leaver.** `P0 · process-only (given -5) · process`
Joiner = user record + Viewer membership; mover = membership swap within a week;
leaver = user deletion cascades memberships **and bumps sessionEpoch**, plus a
last-30-days audit review. Quarterly: each Team Admin re-confirms their member list
(**Share…** on the team in the Agent Chat shows it — the central Access page was
dissolved by #2085, and a Team Admin no longer needs a System Admin to run this). Includes the **agent leaver path**: deleting an
agent deactivates its Matrix user and archives its DM room (today orphaned — see §11).

**GOV-ACCESS-11 — Account hygiene floor.** `P1 · small build · enforce for new passwords`
Minimum password length (12), per-username lockout with backoff, self-service password
change (`/api/me/password`, triggers epoch bump). Where IAP runs, IAP is primary and
local passwords are fallback-only.

*(GOV-ACCESS-9 — internal-API auth — is absorbed by the canonical §3.5.
GOV-ACCESS-10 — audit diffs/team view — is the §3.6 spine.)*

---

## 5. Skill & knowledge lifecycle governance

The sponsor's #1 worry lands here, and the survey confirms it verbatim: today a global
skill can be edited by **any authenticated user** (`PUT /api/skills/:name` checks
session only; the caps model exists only on the newer `/api/skills/transfer`), skill
history stores **hashes, never content** (detectable, not revertible),
`promote-to-global {overwrite:true}` `rmSync`s the previous version with no snapshot,
and any team-visible user can flip the team to **autonomy level 3**, after which the
curator LLM-writes skills and **auto-activates them into every member's context with no
human ever seeing the text**. KB entries reach every teammate's guaranteed
session-start digest once two agents converge — review defaults off.

What's already right: content identity/provenance per skill (`skill.json` version,
hash, who/when incl. `by: "curator"`), drift detection with review-gated resync, the
autonomy dial + per-pass caps + supervised-review machinery
(`docs/knowledge-governance.md`), archive/restore for delete paths, git history for the
KB. `docs/skill-lifecycle-concept.md` describes the full versioning/lineage target;
GOV-SKILLS-2 below is its governance-critical P0 slice.

### Controls

**GOV-SKILLS-1 — One caps model for every skill write path.** `P0 · small build · enforce (global) / warn→enforce (team)`
Extract `requiredCaps` from `skill-transfer.js` into a shared helper and apply it to all
legacy routes (create/edit/file-write/promote/activate): global tier → System Admin,
team tier → that team's Team Admin. Retire the deprecated `promote` route.

**GOV-SKILLS-2 — Content snapshots + one-click rollback.** `P0 · small build · always-on`
Hook `stampManifest` — the single funnel all skill writes already pass — to snapshot
prior content into `.history/<version>/` (bounded, last 10); `GET .../history` +
`POST .../rollback`; snapshot **before** the promote-overwrite `rmSync`. **The
highest-leverage control of this chapter: with rollback in place, the write gates can
stay light** (principle 4). Option B (git-backed pools, retiring the bespoke history)
is the `skill-lifecycle-concept.md` end state — worth a spike, not on the P0 path.

**GOV-SKILLS-3 — Govern the autonomy dial.** `P0 · small build · enforce`
Levels 0–2 → Team Admin; **level 3 → Team-Admin self-grant with a recorded
acknowledgment** (`complianceAck` pattern: typed confirmation naming "skills will be
synthesized and promoted without human review", persisted, audited, System Admins
notified) — deliberately *not* System-Admin-only, honoring self-service; the ack plus
the §3.6 audit alert is the oversight. Platform default stays level 1. Same caps on
gates/decay config.

**GOV-SKILLS-4 — Quality bar before auto-activation.** `P0 · small build · enforce for new teams, warn for existing`
Split the level-3 chain: `autoPromoteStep` keeps writing curator skills into the team
pool (rollback covers the pool), but **auto-activation into agents' context** is gated
by a new `autoActivate` promotion gate — **default off for newly created teams**; teams
already at level 3 keep today's behavior in warn mode (DM per auto-activation) until
they opt. Pending skills surface as a one-click **Review & activate** card (activation
endpoint + `planSkillSync` fan-out exist; the card shows the diff via GOV-SKILLS-6).
No human in the daily loop — one human glance at the exact point where blast radius
jumps.

**GOV-SKILLS-5 — Review-on-convergence for the digest.** `P1 · small build · enforce (rank-hold) / observe (lint)`
Not review-everything (that would be the locked-down system): only the **convergence
transition** — the moment an entry would be boosted into everyone's guaranteed digest —
enters `pending-convergence` and keeps its lower single-source rank until a Team Admin
approves. Plus a deterministic observe-only ingress lint at `knowledge push` (oversized
entries, instruction-shaped text — a cheap prompt-injection tripwire), never blocking
an agent mid-run.

**GOV-SKILLS-6 — Provenance surfacing + diff view.** `P1 · small build · observe`
Origin badges (`by: curator` vs user subject) and "last changed by/when" in the Skills
registry; content diffs between history snapshots; before/after hashes in audit lines.
Degradation gets *noticed* in minutes instead of discovered in an incident review.

**GOV-SKILLS-8 — Curation spend ledger.** `P1 · small build · observe → warn → enforce`
Per-team JSONL ledger around the two unattended LLM call sites (`autoPromoteStep`,
`autoExtendStep`) + a `curationBudget.monthlyTokens` knob; on breach, warn DMs the Team
Admin; enforce falls back to the deterministic curation path (which already exists).
Feeds the §6 budget model.

**GOV-SKILLS-9 / -10 — Canary skill rollout; sprawl hygiene.** `P2 · larger/small build`
`skillResyncMode: 'canary'` (one member first, promote on Team-Admin click or
hill-climb-verified success); dead grants folded into the hill-climb dead-config metric
and raised as improvement cards, retired via the existing decay/archive path.

*(GOV-SKILLS-7 — internal-route auth — is absorbed by §3.5; the
`AEE_WORKSPACE_ISOLATION=0` startup warning it carried rides along as a one-liner.)*

---

## 6. Cost, tokens & capacity governance

The sponsor's #2 worry. The survey's good news: **the accounting substrate already
exists and is excellent** — every invocation writes a usage record with four token
classes, per-model split, agent/team/role/trigger attribution, delivered via a durable
spool and re-stamped server-side (`build_usage_record` → `usage-log.js`;
`docs/cost-per-pr-concept.md` builds work-item attribution on the same substrate). The
bad news, all verified: **no code path anywhere compares usage to any limit**; usage
views are System-Admin-only (the people creating agents get no cost feedback); any Team
Admin can pin the most expensive model on every agent with no tier concept or record;
loops require `maxIterations` but `maxTokens` is optional and un-defaulted; there is
**no cap on agents/team/containers and no CPU limit** on Podman agents (memory + pids
only) — a few wizard-materialised teams can saturate the host and present as a platform
outage for all 50 users.

This chapter is the **single** budget design (the autonomy chapter's enforcement points
plug into it rather than defining their own).

### Controls

**GOV-COST-1 — Per-team token budgets on the existing usage rail.** `P0 (observe/warn) · larger build · observe → warn → enforce`
A `tokenBudget` slot on the team agent (§3.4): daily/monthly limits in **weighted
tokens** (cache-read discounted; weights System-Admin-owned in one place — tokens, not
currency, preserving the platform's deliberate tokens-only stance; **decided:** a
read-only €-showback view may follow once FinOps supplies a price table, but
enforcement stays token-denominated), optional
per-agent/per-trigger refinements, `warnPct`, `mode`. A pure `token-budget.js`
(`flow-anomaly-detector.js` discipline) computes state from an **incremental counter
maintained at the existing ingest choke point** (O(1) checks, seeded at startup).
Enforcement consults a budget-state endpoint at the **existing triggered-work spawn
gate** (`_execute` + `TriggerBackstop`, exactly beside the maintenance-mode check) and
between loop iterations. **Chat/DM turns are never blocked.**

**GOV-COST-2 — Budget authority: envelope model.** `P0 · small build · enforce day one`
`budget-envelopes.json` (§3.4): Team Admins set/tune their own budgets freely **within**
a System-Admin envelope; exceeding it → honest 400 ("ask a System Admin"). Raising an
envelope is the approval, recorded by audit. A newcomer cannot raise their own ceiling.

**GOV-COST-3 — Team-Admin spend showback.** `P0 · small build · always-on`
Relax the System-Admin-only usage gate via the existing `scope.js` team filtering:
teams see their own usage; a budget bar + usage tiles join the hill-climb waste tiles
in the Improvements panel ("what you spent" next to "what you wasted"). Export stays
System-Admin (FinOps). **The cheapest behavior-changer in this document — visibility
first, then warn means something.**

**GOV-COST-4 — Defined exhaustion behavior: degrade → defer → pause, never lose.** `P0 · bundled with -1 · enforce rung`
Maintenance-mode semantics reused verbatim: (1) **degrade model** — agents resolve to
the team's work model via a final clamp in `resolveLlmBinding`; chat lives here
permanently (never blocked, at worst degraded); (2) **defer** cron/once with exactly
one catch-up run; `http`/`github-event` keep queuing durably; (3) **pause loops** with
the existing `paused` outcome + restartable loop card; (4) one DM per episode saying
what deferred and when the window resets.

**GOV-COST-5 — Model-tier policy: premium by exception.** `P1 · small build · observe → warn (→ enforce per team)`
`tier: standard|premium` on registry models; `modelPolicy { defaultWorkModelId,
allowPremium, premiumAgents[], premiumRationale }` on the team agent; enforced at the
three existing resolution choke points (`resolveLlmBinding`, `buildAssistModelOptions`,
`pickAssistEndpoint`). Premium exceptions become enumerable config, not silent pins.

**GOV-COST-6 — Close the uncapped-autonomy defaults.** `P1 · small build · warn → enforce`
Platform-default loop `maxTokens` when the author omits it (warn one release, then
binding); backstop limits move from per-container env to `triggerPolicy.backstop`
(§3.4) — `0`-disables becomes a System-Admin-visible decision, not a silent env var; a
`hot-cron` info lint (< 15 min cadence) joins the advisory lint set.

**GOV-COST-7 — Capacity caps.** `P0 · small build · enforce (CPU) / warn→enforce (counts)`
(1) `maxAgentsPerTeam` (envelope-carried), validated in the atomic team-materialisation
pipeline + piecewise member adds; (2) max running containers platform-wide, checked at
the spawn/enable path (warn at 80 %, refuse *enable* at 100 % — never kill running
agents); (3) a **CPU quota** added to the existing Podman/K8s `resourceLimits` beside
the 2 g memory limit. The only control here protecting *availability* rather than spend.

**GOV-COST-8 — Usage-store rollups + ingest plausibility.** `P1/P2 · small build · observe`
Daily rollups fold old day files into monthly aggregates (raw files archived, never
deleted — the billing-adjacent invariant holds); implausible records flagged
`suspect: true` (observe-first). Keeps the meter fast and trustworthy at 50-user scale.

**GOV-COST-9 — Cost cards in the hill-climb loop.** `P2 · small build · proposals only`
A `cost-hygiene` card class fed by waste metrics, budget-warn recurrence, and premium
outliers — riding the existing proposal/apply/verdict machinery unchanged.

---

## 7. Agent autonomy & operations governance

Verified risks: agents are **explicitly authorized to edit their own `triggers.json`**
(the prompt says so) with only an advisory DM as the guard — a self-authored
`* * * * *` cron runs ~144 invocations/hour indefinitely; the poller deliberately does
no source filtering, and the 5/h conversation throttle keys on `pr:N`/`issue:N` — **an
agent that opens a new issue each run rotates the key and evades it** (ping-pong loops
between two flow agents); **maintenance mode is toggleable by any logged-in user, never
auto-expires, and doesn't stop chat** — no true global stop exists; a loop authored
without `maxIterations` via the console is saved and silently never runs.

Worth building on: the loop stop contract (the best-designed bound in the platform),
the #611 backstop, WorkspaceGate, the poller's lossless digest, and — as the governance
pattern to generalize — the hill-climb autonomy dial with its server-enforced levels,
class allowlist, staleness check, undo and cooldown.

### Controls

**GOV-AUTONOMY-1 — Blast-radius tiers.** *(defined in §3.3 — foundation for the rest.)*

**GOV-AUTONOMY-2 — Kill-switch hierarchy.** `P0 · small build · enforce (missing locks)`
Per-agent `enabled:false` (exists, `canManageAgent`) → per-team disable/enable (**fix:**
gate on `canManageTeam`, today visibility suffices) → **global maintenance (System
Admin only**, + typed `reason` and `actor` surfaced in the banner, + default 24 h
`expiresAt` with auto-release and an audit line — a forgotten freeze cannot silently
persist) → **global hard stop**: `stopChat: true` on the same `state.json` every reader
already polls; chat turns get a polite canned refusal instead of a Claude invocation.
One flag file, four rungs, no new distribution mechanism. No four-eyes anywhere here —
brakes pull one-handed.

**GOV-AUTONOMY-4 — Self-managed trigger policy: one rulebook.** `P0 (warn) / P1 (quarantine) · small build · warn → enforce`
The scheduler's 60 s sync tick validates self-edited triggers against the **same**
rulebook as console edits (shared spec, golden-fixture-tested both sides, like
`buildMemoryHint`), plus tier-keyed bounds in `triggerPolicy` (§3.4): minimum
self-authored cron interval (15 min T1 / 5 min T2 — console-authored crons unaffected),
mandatory `labelFilter` on self-authored GitHub listeners, capped `maxIterations`.
Ladder: warn (DM + audit line `actor: agent:<id>` via §3.5 + Team-Admin notify; trigger
still runs) → enforce (T3 default / per-team opt-up): nonconformant trigger is
**quarantined** (`disabled + pendingReview`, Approve action in the TriggersPanel) —
never silently rewritten or dropped. Cheapest guardrail included: the prompt's
Trigger-management block *tells* agents the bounds, so conformant triggers get written
in the first place.

**GOV-AUTONOMY-6 — Feedback-loop protection beyond frequency.** `P0 · small build · enforce (lossless) / observe (detector)`
(1) A **new-conversation rate cap** in the poller (default 10 distinct new
conversation keys per agent per hour); beyond it, new-key events fold into the existing
**lossless** digest — neutralizes rotation evasion while leaving a busy reviewer on
known PRs untouched. (2) Backstop-as-policy (see GOV-COST-6). (3) A `ping-pong`
anomaly class (same agent pair alternating artifact creations above threshold) —
detection, not blocking: legitimate rework cycles are normal in the wiring vocabulary.

**GOV-AUTONOMY-7 — Anomaly escalation: observe → notify.** `P1 · small build · warn`
The hourly anomaly-history timer gains a recurrence rule: an anomaly present in three
consecutive sweeps notifies the flow's bound human role (else the Team Admin), once per
episode. Same rung for sustained throttle/backstop drop streaks and `noMatchingTrigger`
streaks from the event-transparency log — "the platform knew and told no one" ends.
Repair stays the flow-reconciliation Phase-4 responder's job, not governance's.

**GOV-AUTONOMY-8 — Safe-by-default creation.** `P0 · small build · enforce (validation, T3) / warn (T2)`
(1) Author-time validation: console trigger routes reject a loop without a valid stop
contract with a 400 + readable message (today: saved and silently never runs); (2) tier
rules per §3.1 — Members create T0/T1 freely; **T2 creation by a Member = typed
confirmation + audit** (the env/PAT binding behind T2 is already Team-Admin-gated, so a
hard second gate would be double); **T3 (RW mount) = Team Admin + distinct audit
action**; (3) wizard pre-fills budgets and `triggerPolicy.level: warn` on every new
team.

**GOV-AUTONOMY-9 — Config freeze (change windows).** `P2 · small build · opt-in enforce`
A `configFreeze` variant on the maintenance flag: mutating `/api` requests 423 during
release windows/cutover — except brakes (stop/disable/maintenance) and System Admin.
Freezes *configuration*, not *operation*; chat and running triggers continue.

**BP/ACE activation semantics** (ownership note): orchestrator-role and bp-instance
agents ride the same tier model (BP activation ≈ T1; their git writes ≈ T2);
`bp-trigger-policy.respect-manual-disable` should default **true** in governed
deployments — an operator's manual disable is a brake and must not be overridden by BP
routing (today's default overrides it).

*(GOV-AUTONOMY-3 → §3.5; GOV-AUTONOMY-5 → §6.)*

---

## 8. Credentials & secrets governance

Four credential families (SSH keys, GitHub PATs, MCP credentials, model-provider keys)
with solid at-rest hygiene (0600, fingerprint-only APIs, in-use deletion protection, a
real scope model in `scope.js` for SSH/PAT/LLM). Verified gaps: **binding a credential
to an environment checks only that it exists, not that the team may use it** (the one
step that injects it into containers — the entire role model bypassed exactly where it
matters); **MCP secrets are materialized in plaintext into agent
`.claude/settings.json`, and the workspace browser serves that file to any
authenticated user** (the largest single exposure surface today); **no expiry, no
last-used, no scope inspection** anywhere (the immortal pilot-era org-admin PAT);
nothing redacts a secret that leaks into a session log; rotation is best-effort with
failures only logged.

### Controls

**GOV-CREDENTIALS-1 — Team-scoped binding check.** `P0 · small build · enforce day one`
Reuse the existing `credentialVisibleToTeam` predicate on **every** binding write path
(env PAT/SSH, MCP credential refs, knowledge repoRef). Existing violations are
grandfathered as findings (they block on next write), so day-one enforcement slows
nobody legitimate.

**GOV-CREDENTIALS-2 — Workspace secret masking + visibility gate.** `P0 · small build · enforce`
One shared masking module at the workspace-browser read/download handlers (this is
also GOV-PLATFORM-5 — one implementation): `.claude/settings.json` served with
credential values replaced by `«masked: <credentialId>»`; `_keys/`-pattern paths 403;
plus the §4 `visibleAgent` gate (404). The agent itself reads the real file in its
container — only the console view is masked. The real fix (env-var indirection at
seeding so plaintext never lands in the workspace) is the P1 follow-up, pending a spike
on the CLI settings schema.

**GOV-CREDENTIALS-3 — Lifecycle metadata: expiry, rotation SLA, last-used.** `P0 (observe) / P1 (enforce) · small build`
`expiresAt` / `rotateBy` (per-family SLA defaults: PAT 90 d, SSH/MCP 180 d) /
`lastUsedAt` (one token-accessor over the known read points, day granularity);
fresh/aging/**overdue**/unused-90d badges; hourly sweep findings in the anomaly
surface. Step-up: block *new bindings* of overdue credentials (never touch running
agents).

**GOV-CREDENTIALS-4 — Secret redaction in session logs & chat.** `P0 (render) / P1 (at-rest) · small build`
The stores know the exact secret values — no entropy heuristics: render-time redaction
in the session-log/chat serving path (generalizing the hill-climb `redactSecrets`);
P1: an at-rest sweep scrubs recent JSONLs/workspaces and raises a `secret-leaked`
finding naming agent + credential — the rotation trigger.

**GOV-CREDENTIALS-5 — PAT least-privilege intake.** `P1 · small build · warn`
Record `tokenKind` (fine-grained vs classic) + `X-OAuth-Scopes` at the existing probe;
broad classic tokens get an amber `broadScopes` badge and intake guidance (fine-grained
PAT with contents + pull-requests + issues; deploy keys for read-only clones — already
the documented recommendation). Never blocks: some enterprise setups genuinely need
classic tokens.

**GOV-CREDENTIALS-6 — MCP credentials join the common scope model.** `P1 · small build · enforce`
`scope: system|team` + `assignedTeamIds` via the existing `normalizeCredential`; CRUD
through the standard predicates; `serverId` binding enforced at seed time (a wiki token
can no longer silently back a graph-DB server). Startup backfill preserves current
access.

**GOV-CREDENTIALS-7 — Verified one-button rotation.** `P1 · small build · capability`
Rotate = new secret under the same id → existing respawn fan-out, but with a **per-agent
outcome report** (respawned/failed/deferred-disabled) returned to the UI and appended
to audit — replacing best-effort log lines. Disabled agents get a `staleCredential`
marker cleared on next enable. Old-secret revocation stays a runbook step.

**GOV-CREDENTIALS-9 — OAuth single-user ack as standing policy.** `P1 · config + badge`
`oauth-token` providers: team-scope only (system-scope refused by one predicate line),
owner = the attesting user, re-attest badge after 180 d; the existing exclusions from
server-side assist calls documented as policy, not accident.

**GOV-CREDENTIALS-10 — Quarterly credential inventory.** `P2 · small build + process`
A read-only report (family, scope, owner, age, last-used, broad-scopes, bound envs/
agents — data the in-use checks already walk); System Admin reviews globally, Team
Admins their slice; actions run through the normal audited CRUD.

*(GOV-CREDENTIALS-8 → §3.5. Webhook `http`-trigger secrets join the -3 lifecycle sweep
— age badge + one-click regenerate; see §11.)*

---

## 9. Delivery, code & regulatory-compliance governance

The sponsor's #3 worry. Verified reality: everything between an agent and GitHub is
**cooperative** — the full PAT sits in every agent container, so every `gh-as-agent`
guard (no merge, no protected-branch push) is bypassable by plain `git push origin
main`/`gh pr merge`; only GitHub-side branch protection is a real wall, and the
platform neither requires nor verifies it. A Team Admin can remove `humanGate: true`
from a live team silently, and the legacy flat-`emits` write path **skips the
human-gate validation entirely** — a mandated approval can evaporate from a running
flow without a trace. Regulations have no home (free-text `additionalContext` at best);
neither shipped SDLC template includes a compliance role; one shared PAT + the
unauthenticated internal API meant (until §3.5) that attribution was forgeable exactly
when a compliance review needs it.

What's right already: gate-ness is configuration (`labels[].humanGate` registry), a
real write-time validator guards materialisation, a rich advisory lint set exists (an
embryonic policy engine), all mediated pushes/PRs land in an append-only ledger
(`pr-events-log.js`), no merger role exists among the 24 templates, and prompt assembly
already injects "never set gate labels yourself".

### Controls

**GOV-DELIVERY-1 — Minimum oversight per flow ("no unreviewed path to done").** `P0 · small build · enforce at materialisation (regulated), warn live`
A `regulated: true` flag on the env repository entry (System-Admin floor per repo
pattern; Team Admins may raise, never lower); a new `no-human-gate` lint;
`validateProcessTemplate` hard-rejects materialising a gate-less flow for a regulated
repo (same pattern as the existing humanGate-as-outcome rejection); the wizard offers
one-click "add human gate / add compliance-reviewer". Live teams: warn banner; blocking
live port-writes that would remove the last gate is the per-team step-up.

**GOV-DELIVERY-2 — Policy engine: lint severities with server-side teeth.** `P0 (bypass fix) / P1 (engine) · small build`
**Unconditional day-one fix:** the legacy flat-`emits` write path runs the same
human-gate/registry validation as the authored-outcomes path — closing a bypass of an
already-enforced rule. Then: `policy.lints { <lint-id>: observe|warn|enforce }` per
team (§3.4), applied by re-running the pure graph builders at the write choke points
(enforce → 4xx with lint payload; warn → `confirmPolicy: true` + reason). Platform
floor: `gate-violation` + `human-label-as-outcome` stay enforce everywhere. The
advisory lint set *is* the policy engine — grown, not replaced.

**GOV-DELIVERY-3 — Guarded gate mutations on live teams.** `P0 · small build · warn (enforce for regulated)`
Removing/demoting a `humanGate` label with bound listeners → 409 unless the request
carries `confirmGateRemoval: true` + a free-text reason, written to the audit line
(§3.6). Regulated envs step up to System-Admin-only removal.

**GOV-DELIVERY-4 — Branch protection as the verified outer belt.** `P0 · process + small build · observe/warn`
Accept that in-platform git guards are cooperative; make GitHub the wall: (a) written
standard — regulated repos have default-branch protection (PRs required, ≥1 review,
no force-push; the agent PAT is never an approver and never repo admin; fine-grained,
contents + pull-requests only); (b) a daily probe of
`/branches/:default/protection` per discovered repo → compliance badge on the env page
+ a `branch-unprotected` anomaly (warn for regulated). The platform *verifies*, it does
not write org repo settings — responsibility stays with repo owners, non-compliance
becomes impossible to miss. **The only control that stops `git push origin main` from
a container today.**

**GOV-DELIVERY-6 — Attribution standard + ledger reconciliation.** `P1 · small build · observe → warn`
`gh-as-agent` is the required agent write path (attribution chain: author email +
correlationId ledger record — now enforceable thanks to §3.5 per-agent tokens); a
periodic pass cross-checks recent default-branch commits/merged PRs on regulated repos
against the ledger: unledgered merges or unknown author emails raise
`unattributed-change`. Non-attribution becomes visible within a day.

**GOV-DELIVERY-7 — Governed "Project Regulations" prompt block.** `P0 · small build · enforce-by-construction`
A System-Admin-managed, versioned regulations store (`/workspace/regulations/`: id,
version, scope = global | team | env pattern); prompt assembly composes a
**Project Regulations** section for every matching agent — version-stamped,
byte-identical in the Prompt-tab preview, size-bounded like the knowledge digest,
fan-out via the existing prompt-rebuild endpoint (no respawn). Team Admins read, only
System Admins write. Regulations reach every agent, guaranteed, outside Team-Admin
editing reach — closing "the agent never saw the rule". (Also: retire or wire up the
dead `additionalContextSnippet` template field — a field that looks governed but has no
consumer is itself a compliance hazard.)

**GOV-DELIVERY-8 — Traceability chain for regulated deliverables.** `P1 · small build · observe → warn (→ enforce)`
Auto-append the bound parent ticket (#1383) to PR bodies and ledger entries at the PR
choke point (mechanical, zero agent cooperation); an `untracked-delivery` anomaly for
regulated-repo PRs without a ticket reference; per-team step-up: the PR route 409s
without a bound ticket. Requirement → conversation → run → PR → approval becomes
walkable by an auditor.

**GOV-DELIVERY-9 — Named-approver gates.** `P2 · small build · observe/warn`
Optional `githubLogin` per `humans[]` role; the anomaly sweep checks who actually
applied a gate label → `unauthorized-gate-approval` (warn). Hard enforcement is
delegated to the outer belt (CODEOWNERS/required reviewers) — the platform never
auto-reverts labels against humans.

**GOV-DELIVERY-10 — Compliance in the paved road.** `P2 · config + small build · observe`
The wizard suggests `compliance-reviewer` for regulated envs (the role template
exists); an advisory `no-compliance-role` info lint; the #1375 missing-roles machinery
offers one-click add. A nudge, never a mandate — the human gate of -1 is the hard
requirement.

*(GOV-DELIVERY-5 → §3.5. Flow-Copilot/LLM-generated bundles need no extra control:
they pass the same validator + lint pipeline at materialisation as every other bundle —
stated here so it is a checked property, not an assumption.)*

---

## 10. Data, audit & platform-hardening governance

Verified risks: workspace/context **read** routes have no team-scope check and no read
is logged anywhere (any user reads any team's seeded secrets, repo clones, and
`memory/users.md` personal notes — invisibly, forever); all audit/telemetry files are
plain JSONL on a volume mounted RW in **three** containers (console, orchestrator,
bp-explorer — the last unauthenticated and also holding the LLM token), so history can
be rewritten untraceably; retention ranges from 7 days to forever with no policy;
compose ships `admin`/`admin` + an empty session-signing secret + Conduwuit published
to the host (one shared Matrix token = every user reads every chat); personal data
lives in ≥6 stores with no erasure path; **there is no backup/restore tooling at all**
for five interdependent stateful volumes holding all secrets, audit, and agent state.

### Controls

**GOV-PLATFORM-1 — Data classification register.** `P0 · process-only · keystone`
A versioned `docs/data-classification.md` defining six classes with handling rules —
C1 config · C2 secrets (incl. seeded copies in agent workspaces) · C3 transcripts &
session logs · C4 personal data (`users.md`, transcription texts, usage rows) ·
C5 audit & telemetry (append-only, no interactive write path) · C6 knowledge & skills.
Every other control cites it (the masking denylist, mount tags, retention, erasure);
it is the onboarding read that makes handling rules teachable. The delivery domain's
`regulated` repo flag is registered here so the two vocabularies cannot drift.

**GOV-PLATFORM-2 / -3 — Internal-API auth + internal audit.** *(§3.5 — canonical.)*

**GOV-PLATFORM-4 — Scope the read routes; targeted read-audit.** `P0 · small build · enforce (gate) / observe (audit)` — **gate DELIVERED (#1459, 2026-09-08); read-audit OUTSTANDING**
`visibleAgent` at the four workspace handlers + context proxies (404 on miss); a
**short** sensitive-path read-audit (C2/C4 paths only: `.claude/settings.json`,
`users.md`, `_keys/`, session-log streams) through the existing audit funnel — a
tripwire, deliberately not a SIEM-shaped full read log.
*As built*: the gate half is the GOV-ACCESS-3 middleware above — it covers the
workspace handlers and the context proxies, so this control needs no second gate.
The **read-audit tripwire is not built**: it is observability rather than
authorization, `audit.auditMutations` records mutations only, and #1459's scope stops
at the gate. It needs its own ticket; nothing in the delivered gate blocks it (denied
*writes* are already audited, because `auditMutations` is mounted ahead of the auth
gate and therefore ahead of this one).

**GOV-PLATFORM-5 — C2 out of every browse surface.** *(one implementation with
GOV-CREDENTIALS-2, §8.)*

**GOV-PLATFORM-6 — Retention matrix, one sweep.** `P1 · small build · warn → enforce`
Generalize the three existing retention engines into one nightly timer driven by one
table: console + internal audit **400 d** (decided; export-before-delete hook ships
with the Phase-2 rotation sweep — revisit only if the programme's records policy
mandates longer), GitHub event
log 7 d (as-is), anomaly history 90 d (as-is), usage raw 90 d + monthly aggregates
400 d (archived, never deleted), hill-climb 180 d, session JSONL rotation becomes
stated policy, client-side localStorage TTL 7 d. `0 = unbounded` stays the escape
hatch. One warn release (log what *would* be pruned) before enforcing.

**GOV-PLATFORM-7 — Tamper evidence for audit.** `P0 (config slice) / P1 (chain) · small build · observe`
Config-only now: **mount `/workspace` read-only into bp-explorer** (one compose line —
removes one of three containers able to rewrite history). P1: a daily hash-chain
manifest over closed audit day files (`{date, file, sha256, prevManifestSha256}`) + a
verify command; off-box shipping is the hosted-deployment step-up.

**GOV-PLATFORM-8 — Refuse unsafe defaults.** `P0 · config · warn → enforce`
*Partly delivered and partly re-scoped by #2059.* The `verifyCredentials` seam this
control was attached to no longer exists, and its second clause is moot: an empty
`AUTH_SESSION_SECRET` no longer derives the cookie key from the admin password — it
falls back to a random key persisted on the workspace volume, so a shipped-default
password can no longer make session cookies forgeable. What is left is the first
clause, re-pointed at the **record** rather than the environment: a System-Admin
record still carrying the shipped-default password on a non-localhost deployment →
prominent warning, and with `GOVERNANCE_MODE=enforce`, refused. Note the check must
move with the password: it is no longer answerable from configuration at startup (the
value in `.env` is only ever the seed), so it becomes a check against the store —
which is also why #2059 deliberately added no password policy. Never blocks local dev.

**GOV-PLATFORM-9 — Host-mount governance.** `P1 (observe slice with P0) · small build · observe → warn → enforce`
`contextMounts` gain `dataClass` (default C1) + `approvedBy`; RW-mount changes get a
distinct grep-able audit action (observe, nearly free — ship with P0); the mount editor
warns on RW/C3+; the prompt's Context-Folders block tells the *agent* the folder's
class and handling rule (the platform already talks to agents this way). Enforce rung:
RW mount = Team Admin + audit; **System Admin only for `dataClass ≥ C4`** — not for
every RW mount (a podman/local dev feature must not centralize on platform operators).

**GOV-PLATFORM-10 — Personal data & erasure.** `P1 (register at P0) · process + small build`
The C4 register enumerates every personal-data location with its deletion procedure
(including the honest "Matrix history needs admin-room tooling" caveat); offboarding
runs the checklist from the **Administration → Users** trigger point (the Access
page it used to name was dissolved into that surface by #2085). P2: an `offboard` endpoint
automating the sweep (redact from `users.md` files, drop session pointers, prune usage
rows, audit line). Answers GDPR-style erasure with a checklist first, a script second.

**GOV-PLATFORM-11 — Backup/DR minimum.** `P0 · small build · enforce`
`make backup` / `make restore`: enable maintenance mode (the quiesce point the design
already provides) → export **all** stateful volumes in one pass (incl. dynamic
`agent-<id>` volumes via the `aee.agent.id` label — half-restores break agents, so
all-or-nothing) → encrypt (key off-host — the pragmatic encryption-at-rest answer) →
release. Nightly, keep 7 daily + 4 weekly; **quarterly restore drill** (an untested
backup is a hope, not a control). The one existential risk in this document with no
compensating control today.

**GOV-PLATFORM-12 — Network exposure trims.** `P1 (checklist items with P0) · config + small build`
Loopback-bind published ports by default (`127.0.0.1:4000/:8448/:4003`, env override
for LAN; IAP fronts the hosted stack); webhook `:4003` gets a per-`(ip, agentId)` token
bucket + lockout after repeated bad secrets; Conduwuit sits behind the same proxy/VPN
as the console at 50 users (per-user Matrix identity is the real fix — §11); the Podman
socket in the console container is documented as accepted risk with a target state of
orchestrator-only socket use.

---

## 11. Surfaces beyond the seven domains

The domain cut misses real surfaces; each gets an owner and a minimum control.

- **Matrix identity & homeserver** *(owner: §4)*. Today one shared admin token reads
  every agent chat of every user. Interim: Conduwuit behind proxy/VPN (§10), admin-room
  access = System Admins only. Real fix: **per-user Matrix identity** as designed in
  `docs/multi-user-concept.md` §4 — pulled into the roadmap as the Phase-2 identity
  milestone. **Agent Matrix lifecycle**: agent deletion deactivates `@<agent>:local`
  and archives the DM room (today both are orphaned).
- **Model-provider registration as an egress channel** *(owner: §8)*. A registered
  `baseUrl` receives the full prompts, code, and knowledge of every bound agent — the
  quietest exfiltration path in the platform. Control: provider create/edit =
  System Admin, or Team Admin within a System-Admin-owned **host allowlist**
  (`ALLOWED_PROVIDER_HOSTS`); every new provider host is an audited event. P0-adjacent.
- **MCP server content** *(owner: §8)*. Registry CRUD is role-gated by GOV-ACCESS-2,
  but nothing vets the stdio `command` itself (arbitrary execution inside agent
  containers). Control: warn → enforce that stdio commands resolve inside the seeded
  `/workspace/mcp-servers/` tree (custom paths = System Admin + audit); http/sse `url`
  hosts join the provider allowlist review.
- **BP/ACE surfaces** *(owner: §7)*. Signaler token class for `bp-events` (§3.5);
  `respect-manual-disable` default true in governed deployments; hand-off overrides
  already require a typed reason — keep, and surface them in the governance digest
  (§12).
- **bp-explorer** *(owner: §10)*. RO mount at P0 (§10); additionally loopback-bind or
  put behind the proxy, and drop the LLM token from its environment unless a feature
  verifiably needs it.
- **Meeting transcription** *(owner: §10)*. Consent is a human duty the UI should
  carry: one standing notice in the meeting-mode start control ("all parties must be
  informed"); the external STT backend joins the vendor/data-flow inventory (§12) —
  audio leaves the platform, class C3/C4.
- **Supply chain** *(owner: §10)*. `as-agent:latest` + service images: a monthly
  rebuild cadence against patched base images, pinned versions, and a documented image
  provenance note; CVE scanning is a P2 option, not a gate.
- **Webhook (`http`-trigger) secrets** *(owner: §8)*. Join the GOV-CREDENTIALS-3
  lifecycle sweep: age badge + one-click regenerate; the §10 rate-limit closes the
  brute-force window. Flows should prefer `github-event` (already documented).
- **E2E journeys** *(owner: §10)*. Nightly runs use a dedicated test user + test team
  (never the stack's seeded administrator, which they currently do use), and journeys
  must not mutate non-test teams — a naming-scoped guard in the journey runner plus the
  normal audit trail make violations visible.

---

## 12. Governance operating model

Controls without owners decay. The organizational half, deliberately lightweight:

- **Ownership.** A **Platform Governance Circle** = the 2–4 System Admins + one sponsor
  delegate. Owns: platform floors and envelopes, the regulations store, the severity
  map, the data-classification register, and this document. Meets monthly (see
  reporting); decides envelope raises and waiver renewals asynchronously via the
  existing audited actions.
- **Policy lifecycle.** Governance policies (floors, envelopes, severity maps,
  regulations entries) are versioned artifacts: changes go through a PR on this repo
  (for documents) or an audited System-Admin mutation (for stores), each with a stated
  reason. A quarterly re-read of this concept against reality replaces "big review"
  theater.
- **Exception & waiver register.** Every grandfathered violation (GOV-CREDENTIALS-1
  findings, unprotected regulated repos, `confirmPolicy`/`confirmGateRemoval`
  overrides, premium-model exceptions, level-3 grants, standing risk acceptances such
  as the shared-PAT decision of §16 #7) is one line in
  `/workspace/governance/waivers.jsonl` — what, who, why, **expiry**. The monthly
  review walks expiring waivers. An exception without an expiry is a policy change and
  belongs in the policy, not the register.
- **Incident response.** One page, not a framework: severity classes (S1 platform /
  S2 team / S3 agent); who may pull which kill switch (§7's hierarchy *is* the decision
  table); the leak playbook (a `secret-leaked` finding → rotate within 24 h via the
  GOV-CREDENTIALS-7 report, then review the §3.6 audit slice); every S1/S2 gets a
  post-incident note whose actions land as waiver-register or backlog entries.
- **Onboarding & awareness.** Joiners start as Viewer (§4) and receive exactly two
  reads: the data-classification register (§10) and a one-page acceptable-use note
  (what agents may be pointed at, what belongs in chat, what never does). Promotion to
  Member after the first supervised week is the Team Admin's call — onboarding *is*
  the progressive-trust ladder, not a separate program.
- **External compliance mapping.** GDPR → GOV-PLATFORM-10 (register + erasure) and
  GOV-PLATFORM-6 (retention). **EU AI Act** (relevant for autonomous agents producing
  regulated deliverables in an insurance-adjacent programme): the human-oversight duty
  is discharged by §9's human gates + the `humans[]` registry + this document as the
  documented oversight design — keep them citable. ISO 27001-style ISMS mapping: this
  concept's control IDs map onto A.5/A.8 controls; produce the mapping table when the
  programme's ISMS asks, not before. **Vendor inventory**: LLM proxy/provider, GitHub,
  STT backend — each with a data-flow line (what leaves, where to) and the applicable
  terms (incl. the consumer-OAuth single-user constraint of §8).
- **Governance reporting.** A monthly one-page digest, assembled from data the platform
  already writes: the first-boot System-Admin seeding, would-deny counts by route family, budget state
  per team, gate-removal and policy overrides (with reasons), anomaly recurrence,
  waiver expiries, backup/restore-drill status. Send to the Circle + sponsor. When the
  digest is boring, governance is working.

---

## 13. Minimum viable governance — the P0 shortlist

If only ten things ship before the platform reaches 50 users, ship these, in this
order:

| # | Control | Why first |
|---|---|---|
| 1 | §3.5 internal-API auth + internal audit (GOV-PLATFORM-2/3) | Every other server-side control is bypassable via :4002 until this lands; six domains depend on it |
| 2 | Work-plane tenant isolation (GOV-ACCESS-3 + GOV-PLATFORM-4) | Closes cross-team read/write/git-push — the widest live hole. **Gate delivered #1459**; GOV-PLATFORM-4's read-audit tripwire still owed |
| 3 | Workspace secret masking + gate (GOV-CREDENTIALS-2 ≡ GOV-PLATFORM-5) | Plaintext MCP secrets are three clicks from any user today |
| 4 | Close the verified route holes (GOV-ACCESS-2, incl. the maintenance + team-disable role fixes of GOV-AUTONOMY-2) | Missing locks, enforce day one |
| 5 | Branch-protection standard + probe (GOV-DELIVERY-4) | The only thing that stops `git push origin main` from a container |
| 6 | Skill snapshots + rollback (GOV-SKILLS-2) + caps on legacy skill routes (GOV-SKILLS-1) | Makes worry #1 recoverable; with rollback, the other skill gates stay light |
| 7 | Session revocation + JML (GOV-ACCESS-5/8) | Offboarding is fictional without it, with contractors rotating monthly |
| 8 | Backup/DR (GOV-PLATFORM-11) + bp-explorer RO mount | The one existential risk with no compensating control |
| 9 | Budgets observe/warn + showback + envelopes (GOV-COST-1/2/3) + capacity caps (GOV-COST-7) | Worry #2: visibility first, ceilings second, availability protected |
| 10 | Refuse default credentials (GOV-PLATFORM-8 / GOV-ACCESS-7) + the emits-lift validation fix (GOV-DELIVERY-2) | The cheapest kills of the worst defaults — same-day changes |

---

## 14. Rollout roadmap

**Phase 0 — days, config & process only.** Data-classification register + C4/personal
register; JML process + quarterly access review; host-level break-glass runbook
(GOV-ACCESS-7, restated by #2059) + refuse-default check (warn); bp-explorer RO mount; loopback-bind checklist; branch-protection policy
text; backup script + first restore drill; close the GOV-ACCESS-2 route holes;
emits-lift validation fix; maintenance role gate + reason + auto-expiry;
`AEE_WORKSPACE_ISOLATION=0` startup warning; RW-mount audit tag; waiver register file.

**Phase 1 — the first month, small builds.** Internal-API auth ladder
(observe → enforce) + internal audit; work-plane middleware (**delivered #1459**) +
workspace masking/gate;
skill caps + snapshots/rollback + autonomy-dial ack + `autoActivate` gate for new
teams; budgets (observe/warn) + showback + envelopes + CPU/count caps; session epoch +
24 h sliding TTL + Viewer role; credential binding checks + lifecycle metadata
(observe) + render-time redaction; regulations store + prompt block; gate-removal
guard; self-trigger rulebook (warn rung) + author-time loop validation + T3 gating;
new-conversation cap; anomaly notify rung; tier badges; provider-host allowlist.

**Phase 2 — the quarter, deliberate builds & step-ups.** Four-eyes promote-to-global
proposal flow; policy engine (per-team lint severities); enforce rungs teams opt into
(budget enforce, trigger quarantine + approve UI, overdue-credential binding block,
regulated-repo ticket enforcement); retention sweep + hash-chain manifest; rotation
reports; MCP scope model; offboard endpoint; convergence review; canary skill rollout;
named approvers; config freeze; per-user Matrix identity (from
`docs/multi-user-concept.md`); direction decisions: git-backed skill pools, secrets
env-var indirection. (GitHub App / credential broker: deliberately declined — §16 #7.)

Sequencing principles: observe phases are **data collection**, not delay — would-deny
censuses and caller inventories de-risk every enforce flip; budgets get a two-week
observe baseline before defaults are set from actual p95 spend; no existing user or
team is downgraded at any rollout step — floors apply to *new* creations first,
grandfathered violations land in the waiver register with expiries.

---

## 15. Relationship to existing concepts

| Concept | Relationship |
|---|---|
| `docs/knowledge-governance.md` | The implemented autonomy-dial + supervised-review layer; §5 extends it (dial authorization, activation gate, convergence review) rather than replacing it. Its "additive and default-off" discipline is this concept's model. |
| `docs/multi-user-concept.md` | The roles/SSO architecture; partially implemented (teams, scoping, audit, IAP). §4 hardens the implemented state; per-user Matrix identity and credential ownership scopes are pulled into Phase 2. |
| `docs/cost-per-pr-concept.md` | The telemetry/attribution substrate §6 builds budgets on; its usage records and honest-numbers rules are assumed, not duplicated. |
| `docs/skill-lifecycle-concept.md` | The full skill identity/versioning target; GOV-SKILLS-2 ships its governance-critical slice first, and Option B (git-backed pools) is its end state. |
| `docs/hill-climbing-agent-concept.md` | Supplies the proven autonomy-gate + card/apply/verdict machinery this concept generalizes (§3.4, GOV-COST-9, GOV-SKILLS-10) and the metrics rail showback rides on. |
| `docs/flow-reconciliation-concept.md` | Owns *repair*; governance stops at notify (GOV-AUTONOMY-7) by design. |

---

## 16. Decision log (sponsor decisions, 2026-08-08)

The open questions of the first draft were decided by the sponsor as follows. Each
entry is binding for implementation; revisit triggers are stated where agreed.

1. **Promote-to-global approver** (§4, GOV-ACCESS-6): **a System Admin *or* a Team
   Admin of a different team** may approve; proposer ≠ approver enforced server-side.
   Keeps platform operators out of the daily path.
2. **Budget denomination** (§6, GOV-COST-1): **weighted tokens now, € later as
   display only.** Enforcement stays token-denominated; a read-only €-showback view
   follows once FinOps supplies a price table. The weighted-token formula is settled
   in one FinOps conversation before warn mode defaults are set.
3. **`regulated` classification & regulations store** (§9): **System-Admin floor per
   repo pattern, Team Admins may raise but never lower** (as designed in
   GOV-DELIVERY-1). The regulations store needs **no two-person rule** — versioned
   entries + System-Admin write + the §3.6 audit diff suffice.
4. **Audit retention** (§10, GOV-PLATFORM-6): **400 days**, export-before-delete hook
   ships with the Phase-2 rotation sweep. Revisit only if the programme's records
   policy mandates longer.
5. **Matrix history & GDPR** (§10/§11, GOV-PLATFORM-10): **checklist, no tooling** —
   erasure requests are handled via the documented manual procedure (admin-room
   commands); retention is honestly documented in the C4 register. Revisit at the
   first real erasure request.
6. **Reference deployment** (§10): **the hosted GKE/IAP stack is the reference at 50
   users**; compose remains fully supported for pilots, demos, and local development.
   Enforce-mode defaults (`GOVERNANCE_MODE`) target the reference stack.
7. **Per-agent GitHub identity** (§8/§9): **deliberately declined.** The shared PAT
   per environment remains the architecture; attribution stays cooperative
   (`gh-as-agent` standard) plus reconciliation-monitored (GOV-DELIVERY-6), with
   branch protection (GOV-DELIVERY-4) and internal-API auth (§3.5) as the compensating
   controls. Recorded as a **standing risk acceptance in the waiver register** (§12)
   so audits cite a decision, not a gap.
8. **Viewer transcript access** (§4, GOV-ACCESS-4): **full read access** to the own
   team's transcripts and session logs — onboarding by watching is the point. No
   per-team metadata-only toggle.
9. **Skill-librarian tier** (§5, GOV-SKILLS-1): **not needed** — the two-level caps
   model (Team Admin / System Admin) stands; the Q1 cross-team approver already
   distributes the load. Retrofittable if global-pool stewardship becomes a
   bottleneck.
10. **Governance config and the hill-climb loop** (§9): **exempt until Phase 3** —
    governance settings (lint severities, budgets, trigger policies) are not a target
    for improvement cards; governance changes remain human decisions. Revisit once
    Phase-3 verdict/rollback data proves the loop's measurement reliability.

---

## Amendment 1 — GOV-PLATFORM-2 as built (#1456, 2026-09-08)

§3.5 is a binding decision, and this section does not rewrite it: it records where
the implementation diverged and why, so the doc stays readable as a design and
correct as a spec. Everything §3.5 asks for is in place except the one item whose
subject no longer exists.

### What shipped

| §3.5 asks for | Built as |
|---|---|
| One auth middleware at the internal server mount | The first statement of the `internalApi` request handler (`orchestrator/orchestrator.js`). That server is a ~4 400-line `if`-ladder with no middleware chain, so "at the mount" can only mean the top of the dispatcher — every route, including the `/internal/admin/*` delegation and the inverted-guard tail route that serves as the 404, is behind it by construction. |
| Control-plane token `INTERNAL_API_TOKEN`, bearer header from the proxy layer | The console has no proxy layer — it reaches `:4002` from **126 raw `fetch` call sites**. `admin-console/api/internal-auth-client.js` installs one wrapper over the global `fetch`, scoped to the orchestrator's own origin **and** the `/internal/` prefix. Editing 126 sites would have made completeness a review claim; here a call site cannot opt out and a new one is covered the day it is written. |
| Per-agent tokens, minted at `startAgentProcess`, baked into the container env like the PAT | Exactly that, as `AEE_INTERNAL_TOKEN`. Deterministic (an HMAC over the agent id), so no state is kept and a respawn re-mints the identical value. |
| Valid only for the agent-facing allowlist, and only for the agent's own `:id` | `AGENT_ROUTES` in `orchestrator/internal-auth.js`. Derived by reading every caller that runs inside an agent container, not from the prose list — see the two corrections below. |
| `INTERNAL_AUTH_MODE=observe\|warn\|enforce`, one observe week | Implemented; the **unset default is deployment-dependent** (#2459) — `observe` on a local Podman Compose stack, `enforce` on an armed non-local (Kubernetes) deploy, an explicit mode always winning — and all three rungs run the same predicate — the observe-mode census is therefore a truthful preview of what `enforce` will reject rather than a second, drifting implementation. `enforce` without a token is refused at boot. |
| Agent tokens rotate via the respawn-on-credential-change path | Free, by construction: all three respawn paths funnel through `startAgentProcess`, and changing the secret invalidates every outstanding token at once. |

### Three corrections §3.5 could not have known

1. **The signaler class has no subject.** §3.5 justifies it with `POST /internal/bp-events` and the ACE `bp-transition.py` caller. That route was **deleted** by the BriefingPack removal (#1961/#2005) and `orchestrator/bp-removal-guard.test.js` asserts it stays gone; nothing in the repo posts BP events, and the webhook server on `:4003` — the only remaining external entry point — has authenticated per-trigger with `X-Hook-Secret` all along. The class was therefore **not implemented** at the time: a token class nothing can present is not a control, it is a hole with a name. Re-adding an external signaler means re-adding the class alongside it; `internal-auth.js` says so at the point where it would go. **Update (Jira event-source plugin):** the class now has a subject and is implemented as **`plugin-scope`** — a plugin broker presents its HMAC scope token (`plugin-scope-token.js`, signed with the registry's `/workspace/plugins/_secret`) and is allowlisted to exactly one route, `POST /internal/plugin-event` (`PLUGIN_SCOPE_ROUTES`). **Update (#2562):** a second route, `POST /internal/plugin-credential-grant`, is allowlisted only for the broker's reserved `_grant-<scopeId>` token (403 `grant-token-required` for a plain scope token, which every granted agent also holds). The secret is a file created on first use, so the adapter hands it to the config as a lazy getter rather than reading it at module load. Audit `callerKind` for this class is `plugin-scope(<pluginId>/<scopeId>)`.

2. **`/internal/agents/:id/claim`, one of the four concrete paths in §3.5's allowlist, is also gone** — same removal. The allowlist was rebuilt from the live callers instead.

3. **"Only for the agent's own `:id`" has exactly one legitimate exception.** The loop verifier (#933) posts its verify request into a **sibling's** queue via `POST /internal/agents/:id/enqueue-pending`. Narrowing that to own-id would break every loop carrying a `verify.agentId` gate. It is marked `scope: 'peer'` rather than silently widened, and a unit test pins that it is the *only* such route in both directions. Giving that route its own same-team check — the `wake-agent.js` precedent — is the named follow-up.

### The failure mode this nearly shipped with

`startAgentProcess` builds the agent container's environment from `...process.env`,
so the orchestrator's **own** `INTERNAL_API_TOKEN` — the credential granting the
full `/internal/*` surface — would have been inherited by every agent container.
Minting a narrow per-agent token while shipping the wide one alongside it is not a
control at all, and nothing about it looks wrong at runtime: every call simply
succeeds. Both the token and the agent-token signing secret are explicitly deleted
from the child environment (which covers the kubernetes spawn path too, since it
receives the same object), and `orchestrator/internal-auth-wiring.test.js`
mutation-proves that the deletes are present *and* ordered after the spread.

The general rule for successors: when a container's environment is built by
spreading the parent's, adding a secret to the parent is adding it to the child.

### What did NOT change

- `:4002` is still never published to the host, on either runtime — the gate is
  defence in depth, not a replacement for the network boundary
  (`docs/deployment.md` §2/§2a).
- Console-side authorization (`admin-console/api/scope.js`) is untouched. The
  control-plane token grants the full surface precisely *because* the console has
  already decided who may do what before it proxies.
- **GOV-PLATFORM-3 (internal audit) is not in this change.** §3.5 names it a
  companion and the ticket's acceptance list does not carry it. The gate emits one
  `[internal-auth]` log line per would-be violation, carrying the same
  `callerKind` vocabulary GOV-PLATFORM-3 will persist — enough for the observe-week
  census, not a substitute for the audit trail.
