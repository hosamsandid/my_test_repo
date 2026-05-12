# SSH Keys and GitHub Tokens

## SSH Keys

SSH keys are used by agents to clone and push to private Git repositories.

**Registering a key** (`/ssh-keys`): Paste a private key into the console. It is stored at mode 0600. The console returns only the SHA256 fingerprint — the private key is never returned by the API after creation.

**Deleting a key:** Keys can be deleted only when no Working Environment references them.

**Using a key:** Assign the key to a repository entry in a Working Environment. When an agent is created, the orchestrator clones the repository using that key and configures the workspace's SSH agent accordingly.

## GitHub Tokens

GitHub Personal Access Tokens (PATs) authorize the built-in GitHub poller to watch repository events.

**Registering a token** (`/github-tokens`): Paste a GitHub PAT into the console. It is stored securely and displayed only as a masked prefix plus the last four characters.

**Scope:** The token must have at minimum `repo` read access for the repositories you want to monitor. For writing commits and opening pull requests via `gh-as-agent`, it must also have `repo` write access and `workflow` access if Actions workflows are involved.

**Using a token:** Assign a token to a Working Environment. All agents in that environment share the token for polling — they do not each need their own.

**Loop protection:** The GitHub poller stamps agent-originated commits and PR bodies with agent identity markers. This prevents agents from triggering themselves in a feedback loop (see [docs/triggers.md](./triggers.md) for details).
