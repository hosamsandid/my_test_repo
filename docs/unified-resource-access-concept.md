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
| **human** — subscription (oauth) | ✅ owner-only | ❌ | ⚠️ **only** with single-user `complianceAck` (System-Admin, deliberate "single-user instance" escape hatch) |
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
  Global only via the single-user escape hatch. **Never** durable-team (that would
  silently share one person's seat with the team).
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

New rule: the exclusion changes from *"authType === oauth-token"* to *"oauth AND
not a single-user global provider."* A subscription published **global with the
single-user `complianceAck`** becomes usable everywhere, including assist/helper —
exactly the local single-user scenario (the operator is System Admin, registers
their subscription globally, uses it for everything). Keep all five sites in step.

> **⚠️ Open technical/ToS risk (must be verified before enabling).** Assist/helper
> issue **raw `/v1/messages`** from the admin-console container. A subscription
> `CLAUDE_CODE_OAUTH_TOKEN` is a CLI-seat token; whether it authenticates raw
> Messages API calls (and whether the Anthropic terms permit server-side use)
> is **unconfirmed** — this is the original reason for the exclusion. Build the
> policy hook, but gate activation on a spike: test the token against
> `/v1/messages` (likely needs an `anthropic-beta: oauth-*` header), or route
> assist through a CLI-style invocation instead of raw HTTP. Do not promise this
> path works until proven.

## 10. Lifecycle & edge cases

- **E1 — Owner leaves a team (stays an instance user).** The lend ends: sweep all
  team bindings (env default provider, env GitHub token, per-repo SSH key, member
  overrides) that reference a **personal** resource whose owner is no longer a
  member → invalidate the binding (reset to inherit / null) → respawn affected
  agents → record in the GitHub Event Log. The **resource is kept** (still the
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

## 12. Open decisions / to confirm

1. **Assist + subscription feasibility (§9).** Spike the raw `/v1/messages` +
   OAuth-token question before enabling; may force a CLI-style assist path.
2. **`identity` inference on migration.** How aggressively to auto-classify vs
   force per-record admin review.
3. **UI naming.** Surface `human` vs `service` as, e.g., "Personal identity —
   acts as you" vs "Service credential — a shared machine/deploy identity", and
   replace the "System / Assigned to teams / Team owns" controls with the
   `identity` + `scope` pair.

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
