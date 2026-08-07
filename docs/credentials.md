# SSH Keys, GitHub Tokens, and Jira Credentials

## SSH Keys

SSH keys are used by agents to clone and push to private Git repositories.

**Registering a key** (`/ssh-keys`): Paste a private key into the console. It is stored at mode 0600. The console returns only the SHA256 fingerprint — the private key is never returned by the API after creation.

**Deleting a key:** Keys can be deleted only when no Working Environment references them.

**Using a key:** Assign the key to a repository entry in a Working Environment. When an agent is created, the orchestrator clones the repository using that key and configures the workspace's SSH agent accordingly.

## GitHub Tokens

GitHub Personal Access Tokens (PATs) authorize the built-in GitHub poller to watch repository events.

**Registering a token** (`/github-tokens`): Paste a GitHub PAT into the console. It is stored securely and displayed only as a masked prefix plus the last four characters.

**Scope:** The token must have at minimum `repo` read access for the repositories you want to monitor. For writing commits and opening pull requests via `gh-as-agent`, it must also have `repo` write access and `workflow` access if Actions workflows are involved.

**Using a token:** Assign a token to a Working Environment. All agents in that environment share the token for polling and for HTTPS GitHub repository access (cloning and the real-time repo-check probe) — they do not each need their own.

**Loop protection:** The GitHub poller stamps agent-originated commits and PR bodies with agent identity markers. This prevents agents from triggering themselves in a feedback loop (see [docs/triggers.md](./triggers.md) for details).

### Granting an agent GitHub access

To let an agent push commits, open PRs, or run the `gh` CLI:

1. **Admin Console → GitHub Tokens** → paste a PAT with `repo` scope on the repos the agent should touch. Give it any id (e.g. `gh-as-agent`).
2. **Edit the agent's Working Environment** → set "GitHub Token" to that id and save.
3. **Toggle the agent's Enabled switch off, then on.** The orchestrator re-spawns the agent and injects the token as `GH_TOKEN` and `GITHUB_TOKEN` into its container. Confirm in `make logs`: look for `[Orchestrator] Agent <id> → GH_TOKEN injected (env=<env>, token=<token-id>)`.

## Jira Credentials

Jira credentials authorize the built-in Jira poller to watch a project's issues for status changes ([docs/triggers.md](./triggers.md)).

**Registering a credential** (`/jira-tokens`): enter the Jira site (a bare Atlassian subdomain or a full origin for a custom domain), the account email, and an API token generated at `id.atlassian.com/manage-profile/security/api-tokens`. The token is stored securely and displayed only as a masked preview plus fingerprint — never returned by the API after creation.

**Why site + email live on the credential, not the environment:** a single deployment can span multiple Jira sites, so "which site" has to travel with "which secret" — the same split reasoning as SSH keys vs. GitHub tokens above, just for a different axis (site, not scope).

**Using a credential:** on a Working Environment, bind a project key (e.g. `ENG`) to a Jira credential under **Jira Projects**. Agents in that environment can then add a `jira-event` trigger referencing that project key.

### Agent workspace and repos

The agent has no host bind-mount — only the `/workspace` named volume is mounted into its container. To work on a repository, DM the agent and ask it to `git clone <url>` into `/workspace/`. The clone persists across orchestrator restarts via the named volume.
