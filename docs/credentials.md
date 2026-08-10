# SSH Keys and GitHub Tokens

## Credential ownership tiers

Every SSH key and GitHub token carries an **ownership tier** on its index entry (`normalizeCredential` in `admin-console/api/scope.js` is the authoritative contract):

| Tier | Stored as | Who may create it | Who can see / manage it |
|---|---|---|---|
| `team` | `scope: "team"`, one `teamId` | Team Admin of that team (or a System Admin) | Team Admins of that team; System Admins |
| `system` | `scope: "system"`, `assignedTeamIds[]` | System Admin only | System Admins; Team Admins of any assigned team |
| `personal` | `scope: "personal"`, `userId` (the owner) | **Any** authenticated human, owned by themselves | **Only the owner** — no other human, *including a System Admin* |

**Personal tier (epic #1558).** A `personal` credential belongs to exactly one human, identified by the `userId` owner field on its index entry, and is **strictly private** to that person. There is deliberately **no `scope.all` override**: neither a System Admin nor the env single-admin can list, read metadata for, or manage anyone else's personal credential. The owner is always the authenticated caller — a create body may not name a different owner, and a personal credential's ownership is immutable (it cannot be reassigned into or out of a `team`/`system` tier; create a fresh credential instead). Legacy entries without a `scope` field continue to normalize to a `team`/`default` credential, unchanged.

> Phase 1 landed the data-model & RBAC foundation; Phase 2 (below) adds the self-service UI. The runtime resolution order (`personal → team → system`), rotation→respawn propagation and offboarding land in later phases of epic #1558.

## My Credentials (self-service)

Every authenticated human manages their **own** personal SSH key and GitHub token from the **My Credentials** page (`/my-credentials`) — a top-level nav entry with **no `credAdmin` gate**, so a plain Team Member reaches it just like a Team Admin or System Admin (epic #1558 Phase 2). The page consumes the same `/api/ssh-keys` and `/api/github-tokens` endpoints, which already return the caller only their own personal entries plus any team/system credentials they may manage; the page filters to `scope: "personal"` owned by the caller (`personalCredentials` in `admin-console/src/pages/my-credentials-view.js`).

From this surface a human can, for their own personal credentials only:

- **Create** an SSH key — paste an existing private key or have the server generate a fresh ed25519 keypair (the public key is shown exactly once, matching the admin generate flow) — and register a GitHub token. The owner is always forced to the caller server-side (`resolveCredentialOwnership`); the create form never sends a `userId`.
- **List** metadata only — name, fingerprint / masked preview, createdAt. Raw secrets are never returned after creation.
- **Rename** (a name-only `PATCH`, allowed on the personal tier) and **rotate** the secret in place via `POST /api/{ssh-keys,github-tokens}/:id/rotate` (personal-tier only, owner-gated — a team/system credential is still rotated the create-new-and-repoint way described below). Rotation replaces the stored secret while keeping the same credential id/name/owner; propagating a rotation to *already-running* agents by respawn is Phase 4 (#1570), so the rotate panel tells the owner to rotate at a quiet moment.
- **Delete** their own credential.

Personal SSH keys are **account-wide** (one key covers all the owner's repositories); per-repo personal deploy keys are deferred (D8). The page shows a clear empty state when a human has none, and — because the personal tier is keyed on a real `userId` — an explanatory note to the **environment single-admin** (which has no user record, so cannot own personal credentials).

The admin **SSH Keys** / **GitHub Tokens** pages (below) filter personal credentials out of their tables (`adminManagedCredentials`), so the two tiers stay visually and navigationally distinct: shared team/system credentials there, personal ones on My Credentials.

## SSH Keys

SSH keys are used by agents to clone and push to private Git repositories.

**Registering a key** (`/ssh-keys`): Paste a private key into the console. It is stored at mode 0600. The console returns only the SHA256 fingerprint — the private key is never returned by the API after creation.

**Deleting a key:** Keys can be deleted only when no Working Environment references them. The **Used by** column on the SSH Keys page shows which environments reference each key (count + hover tooltip); the delete dialog names any blocking environments as a bulleted list.

**Using a key:** Assign the key to a repository entry in a Working Environment. When an agent is created, the orchestrator clones the repository using that key and configures the workspace's SSH agent accordingly.

## GitHub Tokens

GitHub Personal Access Tokens (PATs) authorize the built-in GitHub poller to watch repository events.

**Registering a token** (`/github-tokens`): Paste a GitHub PAT into the console. It is stored securely and displayed only as a masked prefix plus the last four characters.

**Deleting a token:** Tokens can be deleted only when no Working Environment references them. The **Used by** column on the GitHub Tokens page shows which environments reference each token (count + hover tooltip); the delete dialog names any blocking environments as a bulleted list.

**Editing / rotating a token:** The Edit panel can only rename a token and change its team ownership — the secret is create-only. To rotate an expiring or leaked token: create a new GitHub token, then repoint the Working Environment's "GitHub Token" field to the new one. Any agents running in that environment are restarted to pick up the new token — in-flight work is interrupted, so rotate at a quiet moment. Disabled agents pick up the fresh credential on their next enable.

**Scope:** The token must have at minimum `repo` read access for the repositories you want to monitor. For writing commits and opening pull requests via `gh-as-agent`, it must also have `repo` write access and `workflow` access if Actions workflows are involved.

**Using a token:** Assign a token to a Working Environment. All agents in that environment share the token for polling and for HTTPS GitHub repository access (cloning and the real-time repo-check probe) — they do not each need their own.

**Loop protection:** The GitHub poller stamps agent-originated commits and PR bodies with agent identity markers. This prevents agents from triggering themselves in a feedback loop (see [docs/triggers.md](./triggers.md) for details).

### Granting an agent GitHub access

To let an agent push commits, open PRs, or run the `gh` CLI:

1. **Admin Console → GitHub Tokens** → paste a PAT with `repo` scope on the repos the agent should touch. Give it any id (e.g. `gh-as-agent`).
2. **Edit the agent's Working Environment** → set "GitHub Token" to that id and save.
3. **Toggle the agent's Enabled switch off, then on.** The orchestrator re-spawns the agent and injects the token as `GH_TOKEN` and `GITHUB_TOKEN` into its container. Confirm in `make logs`: look for `[Orchestrator] Agent <id> → GH_TOKEN injected (env=<env>, token=<token-id>)`.

### Agent workspace and repos

The agent has no host bind-mount — only the `/workspace` named volume is mounted into its container. To work on a repository, DM the agent and ask it to `git clone <url>` into `/workspace/`. The clone persists across orchestrator restarts via the named volume.
