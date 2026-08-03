# SSH Keys and GitHub Tokens

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
