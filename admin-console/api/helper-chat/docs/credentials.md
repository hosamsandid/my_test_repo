# SSH Keys and GitHub Tokens

## Credential ownership tiers

Every SSH key and GitHub token carries an **ownership tier** on its index entry (`normalizeCredential` in `admin-console/api/scope.js` is the authoritative contract):

| Tier | Stored as | Who may create it | Who can see / manage it |
|---|---|---|---|
| `team` | `scope: "team"`, one `teamId` | Team Admin of that team (or a System Admin) | Team Admins of that team; System Admins |
| `system` | `scope: "system"`, `assignedTeamIds[]` | System Admin only | System Admins; Team Admins of any assigned team |
| `personal` | `scope: "personal"`, `userId` (the owner) | **Any** authenticated human, owned by themselves | **Only the owner** — no other human, *including a System Admin* |

**Personal tier (epic #1558).** A `personal` credential belongs to exactly one human, identified by the `userId` owner field on its index entry, and is **strictly private** to that person. There is deliberately **no `scope.all` override**: neither a System Admin nor the env single-admin can list, read metadata for, or manage anyone else's personal credential. The owner is always the authenticated caller — a create body may not name a different owner, and a personal credential's ownership is immutable (it cannot be reassigned into or out of a `team`/`system` tier; create a fresh credential instead). Legacy entries without a `scope` field continue to normalize to a `team`/`default` credential, unchanged.

> Phase 1 landed the data-model & RBAC foundation; Phase 2 (below) adds the self-service UI; Phase 3 (below) adds the runtime resolution order; Phase 4 adds rotation→respawn propagation; Phase 5 (below) adds offboarding auto-delete + pause.

### Offboarding (auto-delete + pause)

*(epic #1558 Phase 5, #1571; concept `personal-credentials-concept.md` §8, decision D6)*

When a human is deactivated or removed (`DELETE /internal/admin/users/:id`, proxied from the Users page), their personal credentials must not linger and their agents must not keep acting under a departed identity. The orchestrator runs `offboardOwner(userId)` **before** removing the user record, so a partial failure leaves the user recoverable:

1. **Pause** — every agent whose resolved identity was that person's personal credential (matched by `credential-resolution.selectAgentIdsForOwner`, so a team-member is matched via its parent team's owner) is **drained** — disabled in place, **not wiped**. In-flight work stops; the agent does not auto-resume, and re-enabling it is an explicit human decision.
2. **Auto-delete** — all of that person's **personal** SSH keys and GitHub tokens are removed: the `_keys`/`_tokens` index entries **and** the 0600 secret files, leaving no residual copy. The person's **team/system** credentials are shared infrastructure and are **never** touched (even one whose `userId` happens to coincide).

Pausing happens first, so any in-flight attributed write that outlives the pause **refuses** (refuse-on-missing, above) rather than acting under a now-deleted identity — it never silently drops to a shared credential. Consistent with the strict-privacy guarantee, there is **no administrator break-glass** into a departed person's secrets before deletion: they are simply removed, not read or transferred. To continue the work, an operator re-owns the affected agents to a present human who supplies their **own** personal credential.

### Runtime credential resolution (`personal → team → system`)

*(epic #1558 Phase 3, #1569; concept `personal-credentials-concept.md` §5/§6)*

The credential an agent uses is resolved **per operation class**, because attribution and transport differ:

| Operation | Credential used | Why |
|---|---|---|
| **Attributed writes** — commits, pull requests, reviews, HTTPS **and SSH** pushes | the **owner's personal** token/key (personal → team → system order) | These carry the human's name; they must run under the owner's identity. |
| Read-only clones, the repo-check probe | a shared `team`/`system` credential is fine | No attribution — a shared read credential misattributes no one. |
| Event polling of a repo | a shared `team`/`system` token **only** | The poller is per-repo infrastructure, not per-human (#1569 AC6 — the personal tier never gates or replaces the poller's token). |

The order is a **preference among tiers, not a fallback for an unusable personal credential.** When an attributed write prefers the personal tier and the owner **has** a personal credential that cannot be used (a PAT missing the `repo`/`workflow` scope), the run is **refused** with a clear, actionable message — it does **not** silently drop to a `team`/`system` credential and act under a shared identity (**refuse-on-missing**, D5). The fallback chain applies only where a shared credential is legitimately acceptable (reads, polling) — and, since #2077, where the owner has no personal credential of that kind at all (see the switch below).

**"The agent's owner"** is `config.ownerId` — for a `team-member` this is its parent Agent Team's owner (one hop, mirroring `resolveAgentTenant`), so a team operated by several humans still writes under exactly one deterministic identity regardless of which event woke the run (AC3/AC4). A **cron / GitHub-event** run resolves the owner from persisted config, never from whoever initiated the trigger — this stays true only for these **autonomous** triggers. **For an interactive chat turn (#2175, epic #2166 B3), the owner named above is superseded by the human actually chatting**: the acting sender's Matrix identity (provisioned since #1458) travels orchestrator-side from the agent run into `resolveEffectiveOwnerId`, which prefers it over the static `config.ownerId` — so a shared agent's commit/PR/push is attributed to whoever sent the message, not whoever created the team. A run with no acting sender (every autonomous trigger, or a human with no provisioned Matrix identity) resolves exactly as before. **The claim is bounded before it is trusted (#2187 review hardening):** the sender arrives as an ordinary env var the agent's own Bash calls can overwrite for the rest of the run, so `isActingSenderTrusted` refuses any resolved sender who is not plausibly the real one for *this* agent — a team-bound agent's own team members, or a standalone agent's own owner — before `resolveEffectiveOwnerId` ever sees it; an untrusted or out-of-boundary sender is treated exactly like no sender at all.

**Participation in the personal tier is the switch (reconciling AC5 with AC8).** #1569 originally gated the personal tier on the agent carrying an `ownerId`, which was safe only because nothing populated that field. **#2077 populates it on every Agent Team and standalone agent**, including a backfill over pre-existing ones, so owner *presence* can no longer be the switch: every owner starts with no personal credential (they are self-service and opt-in), and the old rule would have refused every `commit`/`pr`/`review`/`push-https` in the installation at once. The switch is now whether the owner actually participates:

| The agent's owner | An attributed write gets |
|---|---|
| none | the shared `team`/`system` credential, never refused (AC8) |
| set, but the owner has **no** personal credential of that kind, run is **autonomous** (no acting sender) | the shared credential, never refused — today's behaviour for every unattended run |
| set, but the owner has **no** personal credential of that kind, run is **interactive** (a chatting human) | **refused** (#2176, epic #2166 B4 — widened from the row below) |
| set, with a **usable** personal credential | that personal credential (AC1) |
| set, with a personal credential that is **present but unusable** | **refused** (AC2/AC5, D5) — regardless of interactive/autonomous |

Refuse-on-missing keeps its whole purpose: a human who *has* a personal credential never has an attributed write re-attributed to a shared identity. What it no longer does is refuse on behalf of someone who never had one, which protects nobody and only takes their agents offline — **unless that someone is a human chatting right now** (see below), who should be told to add one rather than have their write silently re-attributed. Note the honest consequence: the *unusable-scope* refusal branch stays unreachable until a scope probe lands (see below). **#2138 adds a second refusal that does not wait on that probe:** an owner who is **no longer a user on this platform** — their account was deleted, leaving their personal token on disk and still working — is refused on any attributed write, with a distinct `owner-not-a-live-user` message telling the operator to finish the offboarding and **revoke the token at GitHub** (nobody can add a personal token for an account that no longer exists). Reads and polling still use a shared credential, so a stale index entry never takes a flow offline.

**The team-admin baseline + interactive just-in-time refusal (#2176, epic #2166 B4, depends on B3).** B3 re-keyed *who* the owner is for an interactive run but left the "owner has no personal credential" row above unconditional; B4 splits it by a new `interactive` flag (`actingSenderUserId != null` — a resolved, *trusted* sender, never the raw untrusted Matrix id) threaded into `resolveCredential`. A human chatting right now whose owner has no personal credential is now refused with the same 424 `personal-credential-required` message pointing at **My Credentials** — silently attributing their write to the team's shared identity is exactly the "silent failure" this closes. An autonomous run is unaffected: it must always have a working path, so it never refuses on this row. Its *owner* resolution changed too — `resolveEffectiveOwnerId`'s no-sender fallback is no longer the static, immutable `config.ownerId` chain but `resolveBaselineOwnerId`, the **baseline identity**: for a team-bounded agent this is the team's **current** `team-admin` (via `resolveScopeOwner`, honouring a D4 succession without redeploying the agent), and for a standalone agent it is unchanged (its own static owner, since there is no team admin to defer to). This baseline is what the very first repository clone at team creation and the GitHub poller conceptually run under too, though this ticket wires it live only into the two attributed-write resolvers below — see the `CLAUDE.md` note on the scope left for the field-semantics migration (epic B5).

The decision core is the pure, unit-tested `orchestrator/credential-resolution.js` (`resolveAgentOwnerId` / `resolveEffectiveOwnerId` — the acting-sender-aware wrapper, #2175 — / `resolveBaselineOwnerId` — the team-admin baseline, #2176 — / `findPersonalCredential` / `findPersonalCredentialState` — the lookup that keeps "the owner has none" apart from "the owner's is unusable" — / `resolveCredential`); the orchestrator threads its result into the attributed-write git env (`_buildAgentGitEnv`) via `resolveAttributedGithubToken` and its SSH-transport sibling `resolveAttributedSshKey`, and surfaces the refusal as a distinct `personal-credential-required` error (HTTP 424) on the `gh-as-agent push`/`pr` path.

## My Credentials (self-service)

Every authenticated human manages their **own** personal SSH key and GitHub token from the **My Credentials** page (`/my-credentials`) — a top-level nav entry with **no `credAdmin` gate**, so a plain Team Member reaches it just like a Team Admin or System Admin (epic #1558 Phase 2). The page consumes the same `/api/ssh-keys` and `/api/github-tokens` endpoints, which already return the caller only their own personal entries plus any team/system credentials they may manage; the page filters to `scope: "personal"` owned by the caller (`personalCredentials` in `admin-console/src/pages/my-credentials-view.js`).

From this surface a human can, for their own personal credentials only:

- **Create** an SSH key — paste an existing private key or have the server generate a fresh ed25519 keypair (the public key is shown exactly once, matching the admin generate flow) — and register a GitHub token. The owner is always forced to the caller server-side (`resolveCredentialOwnership`); the create form never sends a `userId`.
- **List** metadata only — name, fingerprint / masked preview, createdAt. Raw secrets are never returned after creation.
- **Rename** (a name-only `PATCH`, allowed on the personal tier) and **rotate** the secret in place via `POST /api/{ssh-keys,github-tokens}/:id/rotate` (personal-tier only, owner-gated — a team/system credential is still rotated the create-new-and-repoint way described below). Rotation replaces the stored secret while keeping the same credential id/name/owner. **Setting or rotating a personal credential now respawns the owner's affected running agents** (Phase 4 #1570) so they pick up the new secret immediately — scoped to that human's agents only (matched by resolved `ownerId`, reusing the environment-respawn machinery via `notifyOwnerCredentialChange` → `POST /internal/owners/:ownerId/respawn-agents` → `respawnAgentsForOwner`; disabled / not-running / tokenless agents are skipped, exactly like the env path). Because that restart interrupts any in-flight work, the rotate panel warns the owner to rotate at a quiet moment.
- **Delete** their own credential.

Personal SSH keys are **account-wide** (one key covers all the owner's repositories); per-repo personal deploy keys are deferred (D8). The page shows a clear empty state when a human has none, and — because the personal tier is keyed on a real `userId` — an explanatory note to the **environment single-admin** (which has no user record, so cannot own personal credentials).

The admin **SSH Keys** / **GitHub Tokens** pages (below) filter personal credentials out of their tables (`adminManagedCredentials`), so the two tiers stay visually and navigationally distinct: shared team/system credentials there, personal ones on My Credentials.

## SSH Keys

SSH keys are used by agents to clone and push to private Git repositories.

**Registering a key** (`/ssh-keys`): Paste a private key into the console. It is stored at mode 0600. The console returns only the SHA256 fingerprint — the private key is never returned by the API after creation.

**Deleting a key:** Keys can be deleted only when no environment references them. The **Used by** column on the SSH Keys page shows which environments reference each key (count + hover tooltip); the delete dialog names any blocking environments as a bulleted list.

**Using a key:** Assign the key to a repository entry in an environment. When an agent is created, the orchestrator clones the repository using that key and configures the workspace's SSH agent accordingly.

## GitHub Tokens

GitHub Personal Access Tokens (PATs) authorize the built-in GitHub poller to watch repository events.

**Registering a token** (`/github-tokens`): Paste a GitHub PAT into the console. It is stored securely and displayed only as a masked prefix plus the last four characters.

**Deleting a token:** Tokens can be deleted only when no environment references them. The **Used by** column on the GitHub Tokens page shows which environments reference each token (count + hover tooltip); the delete dialog names any blocking environments as a bulleted list.

**Editing / rotating a token:** The Edit panel can only rename a token and change its team ownership — the secret is create-only. To rotate an expiring or leaked token: create a new GitHub token, then repoint the environment's "GitHub Token" field to the new one. Any agents running in that environment are restarted to pick up the new token — in-flight work is interrupted, so rotate at a quiet moment. Disabled agents pick up the fresh credential on their next enable.

**Scope:** The token must have at minimum `repo` read access for the repositories you want to monitor. For writing commits and opening pull requests via `gh-as-agent`, it must also have `repo` write access and `workflow` access if Actions workflows are involved.

**Using a token:** Assign a token to an environment. All agents in that environment share the token for polling and for HTTPS GitHub repository access (cloning and the real-time repo-check probe) — they do not each need their own.

**Loop protection:** Because every agent shares the environment's one token, an event caused by an agent is indistinguishable from one caused by a human, and a trigger fires on either. `gh-as-agent` stamps commits and PR bodies with agent identity markers for human readers, but nothing suppresses self-caused events — feedback loops are bounded by the poller's rate throttle and burst digest instead (see [docs/triggers.md](./triggers.md) for details).

### Granting an agent GitHub access

To let an agent push commits, open PRs, or run the `gh` CLI:

1. **Admin Console → GitHub Tokens** → paste a PAT with `repo` scope on the repos the agent should touch. Give it any id (e.g. `gh-as-agent`).
2. **Edit the agent's environment** → set "GitHub Token" to that id and save.
3. **Toggle the agent's Enabled switch off, then on.** The orchestrator re-spawns the agent and injects the token as `GH_TOKEN` and `GITHUB_TOKEN` into its container. Confirm in `make logs`: look for `[Orchestrator] Agent <id> → GH_TOKEN injected (env=<env>, token=<token-id>)`.

### Agent workspace and repos

The agent has no host bind-mount — only the `/workspace` named volume is mounted into its container. To work on a repository, DM the agent and ask it to `git clone <url>` into `/workspace/`. The clone persists across orchestrator restarts via the named volume.
