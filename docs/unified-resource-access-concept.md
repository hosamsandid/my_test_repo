# Unified Resource Access Model — Concept

Status: **Design** (not yet implemented). Supersedes the ad-hoc scoping split
across Model Providers, SSH keys and GitHub tokens. Relates to and refines
`personal-credentials-concept.md`, `decentralised-access-concept.md`,
`assist-model-selection-concept.md`, `credentials.md`, `model-providers.md`.

## 1. Why this exists

Today three secret-bearing resource classes — **Model Providers** (LLM
endpoints), **SSH keys** and **GitHub tokens** — each carry the same
`{scope, teamId, assignedTeamIds, userId}` tier triple, but the mental model is
hard to reason about and the surfaces disagree:

- **Three overlapping axes** (`personal` / `team` / `system` + `assignedTeamIds`)
  plus a fourth (`global`, Model-Provider-only) mean the same intent can be
  expressed several ways, and "System, assigned to team X" vs "Team owns" reads
  as two different things for what users think of as one idea.
- **Two blend of viewpoints.** The per-agent chat model picker filters by the
  *agent's team* (`usableEndpointsForTeam` → `credentialVisibleToTeam`), while the
  Team-Settings provider dropdown filters by the *caller's* admin rights
  (`GET /api/llm-endpoints` → `providerVisible` → `visibleCredential`). A provider
  the team's agents already run on can therefore be invisible in the very page
  that sets the team default. The SSH/GitHub pickers are caller-scoped with no
  team keying at all.
- **An inconsistent `oauth` rule.** Subscription (`oauth-token`) providers can be
  bound per-team and appear in the chat picker, but are hard-excluded from being
  `global` and from every server-side assist/helper path (five separate sites).

This document replaces those axes with **one principle** applied identically to
all three classes.

## 2. Core principle: classify by identity, not by tier

The load-bearing distinction is **what identity the secret acts as** — not which
tier box it sits in.

- **`human` (identity-bound).** The secret *acts as a specific person*. Every
  action it performs is attributed to, or billed to, that human. Examples: a
  personal GitHub **PAT** (authenticates as your account, attributes every
  commit/PR/review to you), a personal **user SSH key** (acts as your account
  across every repo it can reach), an Anthropic **subscription** (`oauth-token`)
  seat (single-user under Anthropic Consumer Terms).
  Binding a `human` secret to a team is a **lend of your identity**, never a
  transfer of ownership: it stays yours, and every write it makes is still *you*.

- **`service` (infrastructure / shared identity).** The secret acts as a
  *non-human* identity that belongs to no individual. Examples: a **machine-user**
  PAT (a dedicated bot account), a **deploy key** (registered to a repo, tied to
  no user account), an **api-key** Model Provider (a gateway key). These survive
  personnel changes precisely because they are not anyone's identity.

The user-facing insight that motivated this: *you cannot make a personal SSH key
or PAT "team-owned" — it is still personalised and still hangs off your user.* A
durable team credential is real and useful, but it only makes sense as an
explicitly declared **service** credential, not as a re-scoped personal one.

## 3. Two fields define every secret

Every resource carries two orthogonal fields:

- `identity ∈ { human, service }` — chosen at creation, immutable.
- `scope ∈ { personal, team, global }` — the ownership/reach tier.

`assignedTeamIds` and the "system, assigned to N teams" axis are **removed** as an
authored concept. Reach is fully described by `scope` + (for `team`) a single
`teamId` + (for `personal`) a single `userId`.

## 4. Allowed combinations

| `identity` \ `scope` | `personal` | `team` (durable) | `global` |
|---|---|---|---|
| **human** — user PAT / user SSH key | ✅ owner-only | ❌ | ❌ |
| **human** — subscription (oauth) | ✅ owner-only | ❌ | ⚠️ **only** with single-user `complianceAck` (System-Admin escape hatch); **runtime-only** — usable for agent runtime, never assist/helper (§9) |
| **service** — machine PAT / deploy key / api-key provider | ✅ private to owner | ✅ this team, survives membership changes | ✅ everyone, everywhere |

Rules that fall out of the table:

- A `human` credential is **strictly Personal**. It can never be `team` or
  `global` — a "acts-as-me for everyone" secret is nonsensical and dangerous. The
  **only** exception is the subscription-provider escape hatch (§9), justified by
  the single-user compliance acknowledgement and confined to Model Providers.
- A `service` credential may live at any tier. `team` and `global` are the
  durable, personnel-independent tiers.
- **Who may create what:** `personal` — any user, for themselves. `team` (service)
  — a **Team Admin** of that team (or a System Admin). `global` — **System Admin
  only**. The single-user oauth-global escape hatch is System-Admin only and
  requires the explicit `complianceAck`.

## 5. Per-class mapping

- **Model Provider — api-key:** `service`. Personal (I pay for my own gateway
  key), durable Team, or Global. No identity attribution concerns.
- **Model Provider — subscription (oauth):** `human`. Personal by default;
  Global only via the single-user escape hatch, and then **runtime-only** (agent
  runtime, never assist/helper — §9). **Never** durable-team (that would silently
  share one person's seat with the team).
- **GitHub PAT — personal:** `human`, Personal only. Team use = lend.
- **GitHub PAT — machine-user:** `service`. Personal / Team / Global.
- **SSH — user key:** `human`, Personal only. Team use = lend.
- **SSH — deploy key:** `service`. Team / Global (a deploy key is repo-scoped and
  belongs to no user).

This mirrors how GitHub actually works: deploy keys and machine users are
first-class non-human identities, distinct from a person's key/token.

## 6. Access verbs & predicates

| Verb | `global` | `team` (service) | `personal` (own) | `personal` (someone else's) |
|---|---|---|---|---|
| Create | System Admin | Team Admin of that team / System Admin | any user (self) | — |
| See secret / preview | System Admin (manage) | Team Admin of that team | owner | **nobody** |
| Select when authoring a team binding | yes | yes (that team) | yes (own) | **no** |
| Consume at runtime (bound) | yes | yes | yes | yes — **while owner ∈ team** |
| Edit / rotate | System Admin | Team Admin of that team | owner | nobody |
| **Delete** | System Admin | Team Admin of that team | owner | **System Admin (break-glass, delete-only)** |
| Appear in Administration → Resources | yes | yes | — | **delete-only entry, secret masked** |

New/changed predicates (all three classes share them):

- `ownsPersonalTier(scope, r)` stays owner-only, checked **before** any
  `scope.all` shortcut (no admin break-glass to *see* or *use*). Unchanged
  foundation.
- **New `canDeleteCredential(scope, r) = owner || scope.all`** — the only
  admin break-glass, and it is delete-only. Distinct from `canManageCredential`
  (edit/rotate/use — owner-only for personal) and `visibleCredential` (secret —
  owner-only for personal). A System Admin's governance view lists personal
  resources as identity-only entries (name, owner, fingerprint / masked preview)
  — enough to delete, never to read or select.

## 7. Binding & selection (one unified rule)

For any team binding — provider default, env GitHub token, per-repo SSH key, or a
member override — with caller `C` in team `T`:

- **Selectable set = { global } ∪ { C's own personal } ∪ { T's own team-service
  credentials }.** Never another member's personal secret.
- The **currently bound value** may be a secret C cannot select (e.g. a
  teammate's lent personal PAT). It is shown **read-only** ("set — not selectable
  by you"), replaceable only with something from the selectable set, and never
  blind-cleared.

This is already implemented for SSH/GitHub as the `credential-ref-legibility`
pattern (`describeCredentialRef` + `guardCredentialRefChange`, replace-only). The
redesign extends the identical pattern to the **provider** dropdowns and keys the
selectable set to the **team the page is for** (not the caller). That alone
removes the "usable in chat but not selectable as team default" inconsistency by
construction, because the chat picker and the team-settings dropdown then compute
the same set.

## 8. Runtime resolution

Runtime consumption (`credential-resolution.js`, `usableEndpointsForTeam`) is
redefined in identity terms:

- **Consumable by team T** iff the resource is `global`, OR a `team`-service
  credential of T, OR a `human`/`service` **personal** credential whose owner is
  a **current member of T** (the live lend).
- **Attributed writes** (`ATTRIBUTED_OPERATIONS` = commit / pr / review /
  push-*): prefer the acting human's **personal** credential → else the team's
  **service** credential (the bot) → else a **global** service credential → else
  the existing **HTTP 424** refusal for an interactive attributed write whose
  owner has no personal credential. This just *names* the previous "personal vs
  shared" split: "shared" = a service credential.
- **Reads / clones / polling** are shared-eligible against any service (team or
  global) credential or the baseline owner, unchanged.
- Baseline owner for an autonomous run stays the team's current Team Admin
  (`resolveBaselineOwnerId`, honouring D4 succession); their personal credential,
  else the team/global service credential.

## 9. Assist / Helper / synthesis & the subscription escape hatch

Server-side one-shot LLM calls — Helper Chat, knowledge synthesis, Flow Copilot,
prompt generation, hill-climb — all route through
`resolveAssistTarget → resolveAssistSelection → assistSelectableEndpoint`, and
today exclude `oauth-token` at five sites (`scope.js:assistSelectableEndpoint`,
`assist-model-options.js`, the `assistLlmEndpointId` setter,
`orchestrator/assist-binding.js` ×2).

**Spike result (2026-09-17): the assist/helper subscription path is NOT viable —
keep the five exclusions.** The proposed relaxation was to allow a global
single-user subscription in assist. A spike (Claude API reference + current
Anthropic sources) settled it against us on two independent grounds:

- **Technical.** The Messages API **rejects** a subscription seat token
  (`sk-ant-oat01-…` from `claude setup-token`) — "OAuth authentication is
  currently not supported" / "only works with Claude Code". Anthropic
  server-side-validates the genuine Claude Code identity; a differing system
  prompt (which every assist/helper call sends) returns a 400. The provider
  record also carries no `baseUrl`, so `buildMessagesUrl('')` has no endpoint.
- **Policy.** Anthropic (Feb 2026) **explicitly bans** using subscription OAuth
  auth outside Claude Code / Claude.ai for third-party tools. The single-user
  `complianceAck` does not cure a ToS-prohibited server-side use.

Therefore the `oauth-token` exclusion **stays** at all five sites. A subscription
provider is a **runtime-only** provider: the agent runs the real `claude` CLI
with `CLAUDE_CODE_OAUTH_TOKEN` (that IS Claude Code — the sanctioned path), so a
global single-user subscription is usable for **agent runtime everywhere**, but
**not** for assist / helper / synthesis.

> **The only way to ever feed a subscription into assist/helper** is to route
> those calls through a genuine Claude Code invocation (the CLI or the Claude
> Agent SDK) instead of raw `/v1/messages` — a larger change, defensible only in
> a truly single-user instance. Out of scope here; recorded as a future option.

## 10. Lifecycle & edge cases

- **E1 — Owner leaves a team (stays an instance user).** The lend ends: sweep all
  team bindings (env default provider, env GitHub token, per-repo SSH key, member
  overrides) that reference a **personal** resource whose owner is no longer a
  member → reset the binding to **inherit-from-`.env` / the global default** (else
  empty with a warning badge, never "set but dead") → respawn affected agents →
  record in the GitHub Event Log. The **resource is kept** (still the
  owner's; usable in their other teams). "Throw it out" means the *binding*, not
  the resource.
- **E2 — Owner is deleted (offboarding).** Extend `offboardOwner` to also delete
  the owner's personal **Model Providers** (today it deletes only personal SSH
  keys and GitHub tokens), then run the E1 binding sweep. Extend the boot-time
  `reconcileOrphanedOffboardings` sweep the same way.
- **E3 — A non-owner member changes a team binding.** Only global / own-personal /
  this-team's-service credentials are selectable; a teammate's lent personal
  secret shows read-only, replace-only. Satisfied by the §7 legibility pattern.
- **E4 — System Admin vs a foreign personal resource.** No see, no use; delete
  allowed (break-glass, §6).
- **E5 — Owner demoted to plain member but stays in the team.** The lend survives
  (tied to membership, not role). They simply can no longer re-point the binding
  themselves; other admins may change it only to selectable options.
- **E6 — A global or team-service credential is deleted while bound.** Keep the
  existing 409 "detach first" guard for all classes.
- **E7 — Two members each lend their own personal provider.** The env default is a
  single field → last writer wins; per-agent overrides let individual members run
  on their own. Existing behaviour, unchanged.
- **E8 — Single-user local instance (`AUTH_ENABLED=off`).** The sole operator is
  an implicit System Admin → registers the subscription as global + single-user →
  usable everywhere including assist/helper. Degrades cleanly.
- **E9 — Personal subscription bound to a team.** Forbidden: a `human` oauth
  credential is Personal only and cannot be lent to a team (it would silently
  share the single-user seat). Sharing a subscription is possible **only** via the
  global escape hatch.

## 11. Migration

Existing records must move off the removed axes:

- `global: true` providers → stay global (service).
- `system` + `assignedTeamIds` and `team` records → need a home. Run a **one-time
  migration with System-Admin review**: per resource, choose **Global (service)**,
  **Team (service, pick the team)**, **Personal (assign owner)**, or **delete**.
  Sensible defaults: bound to exactly one team → Team-service of that team;
  assigned to many teams → Global candidate (flagged); a clearly personal token →
  Personal owned by its creator where known.
- Keep read-compatibility for legacy `team` / `system+assignedTeamIds` records
  until migrated (existing `credentialVisibleToTeam` fallback).
- Each record gains an explicit `identity` field; infer on migration (api-key
  provider / deploy key / machine token → `service`; oauth / obviously-personal
  PAT / user key → `human`) and let the review step correct it.

## 12. Resolved decisions

These are settled for the build. Only item 1 carries a residual technical
unknown (a spike gates activation, not the decision).

1. **Assist + subscription — spike done, path rejected.** The spike (2026-09-17,
   see §9) settled this: a subscription seat token is both **rejected by the
   Messages API** and **banned by Anthropic ToS** for non-Claude-Code use. The
   five `oauth-token` exclusions **stay**. A subscription is runtime-only (usable
   for agent runtime everywhere via the real CLI, never for assist/helper). No
   policy hook is built. Routing assist through a genuine Claude Code invocation
   is the only future option, out of scope here.
2. **`service` may be `personal`.** A `service` credential can sit at any tier
   (personal / team / global); it is not restricted to admin tiers. A privately
   owned bot token is valid.
3. **Global secrets — audit only.** A global SSH key / GitHub token is allowed
   like any other resource; the mitigation is the mutation **audit log**, no
   extra create-time confirmation and no forced read-only scope.
4. **Single-user oauth-global — `complianceAck` only.** Publishing a subscription
   as global requires just the existing single-user `complianceAck`, even in a
   multi-user instance (deliberate, logged, "owner's responsibility"). No extra
   multi-user gate.
5. **`identity` is immutable.** Chosen once when the field is first set;
   correcting it means delete + recreate. (During migration the field is set for
   the first time — that is not a re-classify.)
6. **Invalidated-binding fallback (E1).** A binding whose lend has ended resets
   to **inherit-from-`.env` / the global default**; if none applies it goes
   empty with a warning badge until re-selected. It is never left "set but dead".
7. **Delete break-glass view.** The System-Admin governance view shows a foreign
   personal resource as name / owner / created / fingerprint (secret masked) and
   allows deletion **without** a required reason (the mutation is audited anyway).
8. **Migration classification.** Auto-suggest an `identity` + tier per legacy
   record, but require **per-record System-Admin review** before it is applied.
9. **`system` + many `assignedTeamIds`.** Migrate as a **Global candidate**,
   flagged for the admin to confirm — not auto-split into per-team duplicates.
10. **UI naming.** Surface `human` vs `service` as "Personal identity — acts as
    you" vs "Service credential — a shared machine / deploy identity", and
    replace the "System / Assigned to teams / Team owns" controls with the
    `identity` + `scope` pair.
11. **Build sequence.** Spike (item 1) → tier core + predicates → provider routes
    → credential routes → migration → UI. See §13 for the file-level touchpoints.

## 13. Implementation touchpoints (for the build)

- **Tier core:** `orchestrator/resource-tier.js` (+ byte-identical
  `admin-console/api/resource-tier.js`) — add `identity`; drop `assignedTeamIds`
  as authored reach; keep `ownsPersonalTier` foundation.
- **Predicates:** `admin-console/api/scope.js` — `visibleCredential`,
  `canManageCredential`, `credentialVisibleToTeam`, new `canDeleteCredential`;
  `assistSelectableEndpoint` (oauth escape hatch).
- **Global rule:** `admin-console/api/llm-endpoint-global.js` — relax
  `isGlobalProvider`/`resolveGlobalFlag` for single-user oauth; add an
  `isGlobalCredential` analog for service SSH/GitHub.
- **Provider routes:** `admin-console/api/api.js` — pass `scope.userId` into the
  provider create path (enable personal providers); team-key the model-options /
  team-settings selectable set; extend delete break-glass.
- **Credential routes:** SSH/GitHub create/update/rotate/delete + the
  `credential-ref-legibility` pickers.
- **Runtime:** `orchestrator/credential-resolution.js` (personal → team-service →
  global-service preference), `orchestrator/orchestrator.js` (offboarding +
  membership-removal binding sweep), assist binding.
- **Consumers to keep in step:** every `resolveAssistTarget` call site (Helper
  Chat, knowledge synthesis, Flow Copilot, prompt generation, hill-climb).

## 14. Amendment (2026-09-22): the team-of-one → multi-user transition (#2360)

Context this amendment builds on (all shipped behind `AEE_RESOURCE_ACCESS_V2`):
the **#2360 re-key** made a provider's `team` scope mean a **set of Agent Teams**
(`scope:'team'`, `teamId` = primary, `teamIds[]` = the co-owned set — usable by
any agent in any team in the set, manageable by any set-team admin, a clone
auto-appends). Provider **identity** is fixed by auth type (api-key → `service`;
oauth/subscription → `human`), so the identity axis is not a separate control for
providers. Since #2229 every ordinary agent is a **team of one**.

**The taxonomy is decided by identity + reach, not headcount:**

- **Personal** is the natural home of a **team-of-one** — legal for both api-key
  and subscription. A team consuming a member's personal provider never *owns* it;
  it **lends** it (`personalLendToTeam`, keyed on the owner's membership of the
  **squad** id) for the duration of that membership.
- **Team** is the durable home for a **multi-person** team: an explicitly declared
  **service** (api-key) provider owned by the squad(s), surviving membership
  changes.
- **Global** is System-Admin-curated shared infrastructure (or the single-user
  subscription escape hatch, runtime-only — §9).

**E10 — a squad goes multi-*human* while its default is a member's PERSONAL
provider.** This is the transition the earlier edge cases did not cover (E1 is the
owner *leaving*; E10 is the squad *gaining a second human* while the owner stays).
The trigger is **human membership**, not the count of worker agents: a subscription
is single-*user* (single human), so one human running many of their own agents on
their own seat is fine — the violation is a *second human* benefiting from it. The
env default is a single field, and the runtime lend keys on the **owner's** squad
membership (which still passes), so once a second human joins, **their agents (and
the shared team agents operated on their behalf) silently run on the first
member's personal seat/key.** Resolution splits by identity (decided 2026-09-22,
implemented behind `AEE_RESOURCE_ACCESS_V2`):

- **subscription / oauth (`human`) — HARD (E9 enforcement).** Sharing a single-user
  seat with other members is forbidden by ToS (§ E9). Two guards, single-sourced
  through the pure classifier `provider-lend-policy.js`
  `personalDefaultTransitionRisk({ provider, humanMemberCount })`:
  - **Growth direction** — the membership-add endpoint (`teamsStore.setMembership`
    via `POST /internal/.../memberships`) **refuses** (409, `oauth_personal_lend_blocked`)
    when the add would take the squad to ≥2 humans **and** the squad's env default
    is a **personal oauth** provider. Fail-open on any read error / non-squad team.
  - **Binding direction** — `providerUsableByTeam` **withdraws** a personal oauth
    provider from a squad's usable/selectable set once the squad has ≥2 humans, so
    it can't be picked as the team default (dropdown) and PR7 backend enforcement
    refuses binding it.
  Together these hold the invariant "a multi-human squad never has a personal-oauth
  env default", so no runtime lend-gate in the orchestrator is needed. Mirrors the
  create-time "a subscription provider must be personal or global, never team-shared"
  guard.
- **api-key (`service`) — SOFT (advisory).** Legal but fragile: billing/identity
  concentrate on one member, and the E1 leave-sweep will reset the binding to
  inherit when they go. The api-key lend is **not** withdrawn; instead
  `personalDefaultTransitionRisk` returns `{ level: 'warn' }`, surfaced as a
  non-blocking `personalProviderNotice` on `GET /api/agents/:id/model-options`
  ("This team runs on a member's personal provider — a lend that resets if they
  leave; register a Team provider for durability"). The member can also self-bind
  their own provider via a per-agent override.

**No auto-convert (decided 2026-09-22).** We do **not** build a one-click
"promote my personal api-key provider → Team provider" action. The owner registers
a durable Team (service) provider manually when they want one. (A promote path is
only ever legal for api-key — a subscription can never become `team` — and it would
silently change billing/ownership semantics, so it is left as an explicit,
deliberate manual act.)

**Implemented touchpoints (all flag-gated):**
- `orchestrator/provider-lend-policy.js` ↔ `admin-console/api/provider-lend-policy.js`
  — the pure classifier (byte-identical, `provider-lend-policy.test.js` parity guard).
- `orchestrator/orchestrator.js` `personalOauthLendBlockOnMembershipAdd` + the
  memberships-`POST` branch — the hard growth-direction guard.
- `admin-console/api/api.js` `providerUsableByTeam` (binding-direction withdrawal)
  + `teamHumanMemberCount` + the `model-options` `personalProviderNotice`.
- `admin-console/api/api.js` `pickDefaultLlmBinding(pref)` +
  `providerUsableAtCreation` — a fresh team/agent's env default now prefers, in
  registry order, the first provider USABLE by the creator (global / own-personal /
  new-squad team), falling back to `endpoints[0]` only when none is usable; so a
  blind pick can no longer bind a foreign personal provider whose token the team
  would silently run on (the orchestrator has no runtime lend-gate). Checked by
  ownership — the creator's membership is written a phase later. Passed at all
  three creation sites (standalone quick-create + both `POST /api/teams` handlers).
- **UI:** `provider-health-view.js` `personalProviderNoticeText(notice)` (pure,
  `{ text, tone }`) renders the `personalProviderNotice` as a non-blocking badge in
  the Agent-Chat composer (`ChatPanel.jsx`, beside the health warning) and under the
  team-settings Provider dropdown (`TeamEnvironmentPanel.jsx`) — 'warn' (fragile
  api-key lend) vs 'error' (a subscription seat backing a multi-member team).
