# Onboarding Guide

This guide walks new team members through setup and first steps for the Agent Execution Environment (AEE) project.

## 1. Prerequisites / Access Requests

Request **"Microsoft Visual Studio Code with Github Copilot"** via <https://support.accenture.com/>.

Once GitHub Enterprise access is granted, ask a project admin for access to this repository:

- <https://github.com/AccentureCodeFoundry/314092_agent-execution-environment>

### Platform-Specific Prerequisites

Follow your platform guide to install all required tools before proceeding:

- **macOS:** See the [macOS Setup Guide](mac-setup.md) — Xcode CLT, Homebrew, Podman, etc.
- **Windows:** See the [Windows Setup Guide](windows-setup.md) — WSL2, Podman Desktop, GNU Make, etc.

### Windows Prerequisites (summary)

Windows requires several additional tools installed **in order** before proceeding. If you are on macOS/Linux, skip to Section 2.

| # | Tool | Install Command | Notes |
|---|------|-----------------|-------|
| 1 | WSL2 + Ubuntu | `wsl --install` (admin, reboot) | Required by Podman Desktop. See [Windows Setup Guide](windows-setup.md). |
| 2 | Git for Windows | `winget install Git.Git` | Includes **Git Bash**, required for all `make` commands. |
| 3 | Node.js 22 LTS | `winget install OpenJS.NodeJS.LTS` | |
| 4 | GitHub CLI | `winget install GitHub.cli` | |
| 5 | GNU Make | `winget install GnuWin32.Make` | Add `C:\Program Files (x86)\GnuWin32\bin` to PATH. |
| 6 | Podman Desktop | `winget install RedHat.Podman-Desktop` | Requires WSL2 (step 1). |
| 7 | Claude Code CLI | `npm install -g @anthropic-ai/claude-code` | Requires Node.js (step 3). |

Verify all tools from **Git Bash**:

```bash
wsl --status && git --version && node -v && gh --version && make --version && podman --version && claude --version
```

> **Corporate IT:** If `wsl --install` fails or WSL2 is auto-removed, escalate to IT. No container runtime works on Windows without WSL2. See the [Windows Setup Guide](windows-setup.md) for the full walkthrough and troubleshooting.

## 2. Configure SSH for GitHub Enterprise (optional)

> **Note:** This section is only needed if you have multiple SSH keys (e.g., a personal GitHub key and a corporate GitHub Enterprise key). If you use a single SSH key for everything, skip to Step 3.

### Generate a dedicated SSH key

```bash
ssh-keygen -t ed25519 -C "your.email@accenture.com" -f ~/.ssh/id_ed25519_acf
```

> **Windows path:** The key will be stored at `C:\Users\<username>\.ssh\id_ed25519_acf`.

### Copy the public key to your clipboard

**macOS:**
```bash
pbcopy < ~/.ssh/id_ed25519_acf.pub
```

**Linux:**
```bash
cat ~/.ssh/id_ed25519_acf.pub
# Select and copy the output manually
```

**Windows (PowerShell):**
```powershell
Get-Content ~\.ssh\id_ed25519_acf.pub | Set-Clipboard
```

### Add the key to GitHub

Go to <https://github.com/settings/keys>, click **New SSH key**, paste the public key, and save.

### Configure the SSH host alias

Add the following to `~/.ssh/config` (on Windows: `C:\Users\<username>\.ssh\config`). Create the file if it does not exist.

> **Windows note:** Heredoc (`<< 'EOF'`) in Git Bash requires the closing `EOF` to be at column 0 with no leading spaces. If you have trouble, use the `echo` commands below instead.

**macOS / Linux / Git Bash (heredoc):**
```bash
cat > ~/.ssh/config << 'EOF'
Host github-acf
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519_acf
    IdentitiesOnly yes
EOF
```

**Windows (Git Bash — echo fallback):**
```bash
echo "Host github-acf" > ~/.ssh/config
echo "    HostName ssh.github.com" >> ~/.ssh/config
echo "    Port 443" >> ~/.ssh/config
echo "    User git" >> ~/.ssh/config
echo "    IdentityFile ~/.ssh/id_ed25519_acf" >> ~/.ssh/config
echo "    IdentitiesOnly yes" >> ~/.ssh/config
```

**Windows (PowerShell):**
```powershell
@"
Host github-acf
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519_acf
    IdentitiesOnly yes
"@ | Set-Content "$env:USERPROFILE\.ssh\config"
```

> **Why `ssh.github.com` on port 443?** Corporate firewalls commonly block outbound port 22. GitHub supports SSH over HTTPS port 443 via `ssh.github.com` as a reliable alternative.

### Add GitHub's host key

After creating the config, trust GitHub's host key (only needed once):

```bash
ssh-keyscan -p 443 ssh.github.com >> ~/.ssh/known_hosts
```

### Test the connection

```bash
ssh -T git@github-acf
```

You should see: *"Hi &lt;username&gt;! You've successfully authenticated…"* (exit code 1 is normal for GitHub SSH.)

### Switch an existing repo to SSH

If you cloned the repo via HTTPS, update the remote to use the SSH alias:

```bash
git remote set-url origin git@github-acf:AccentureCodeFoundry/314092_agent-execution-environment.git
```

## 3. Clone the Repository

Use the `github-acf` SSH host alias:

```bash
git clone git@github-acf:AccentureCodeFoundry/314092_agent-execution-environment.git
```

## 4. Install Claude Code CLI

Follow the official setup guide: <https://code.claude.com/docs/en/setup>

After installation, verify it works:

```bash
claude --version
```

### macOS / Linux

> **macOS prerequisites:** If you have not yet installed the full macOS toolchain (Xcode CLT, Homebrew, Node.js, Podman, etc.), see the [macOS Setup Guide](mac-setup.md) for detailed instructions.

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### Windows (native)

> **Windows prerequisites:** If you have not yet installed the full Windows toolchain (WSL2, Git for Windows, Node.js, GNU Make, Podman Desktop, etc.), see the [Windows Prerequisites](#windows-prerequisites-summary) table in Section 1 and the [Windows Setup Guide](windows-setup.md) for detailed instructions.

```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

#### Configure LiteLLM proxy environment variables

Claude Code connects through a LiteLLM proxy. Use `setx` to create permanent environment variables:

```powershell
setx ANTHROPIC_BASE_URL https://litellm.sandbox.starplatform.cloud
setx ANTHROPIC_AUTH_TOKEN <your-auth-token>
setx ANTHROPIC_DEFAULT_SONNET_MODEL claude-sonnet-4-6
setx ANTHROPIC_DEFAULT_HAIKU_MODEL claude-haiku-4-5
setx CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 1
```

**Restart your PowerShell terminal** for the new variables to take effect.

### API key

Ask a project admin for your LiteLLM auth token.

### VS Code extension (optional)

If you prefer using Claude Code as a VS Code extension (or alongside the CLI), see [claude-code-vscode-setup.md](claude-code-vscode-setup.md) for extension installation, JSON settings, and troubleshooting.

## 5. Bootstrap the Stack

### Configure the .env file

```bash
cp .env.example .env
```

Open `.env` and fill in the required values:

| Variable | Description |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Your LiteLLM auth token — ask a project admin |
| `ANTHROPIC_BASE_URL` | LiteLLM proxy URL — ask a project admin |
| `ADMIN_USER` | Your desired Matrix admin username (e.g. `admin`) |
| `ADMIN_PASS` | Password for that Matrix admin user. Not in `.env.example` — **add the line yourself**, otherwise `setup.sh` prompts interactively (unreliable in Git Bash on Windows) |
| `PODMAN_HOST_SOCKET` | Path to your Podman socket — see below |

> **One host-side prerequisite that is easy to miss:** `jq` must be installed —
> `setup.sh` aborts without it. (A global `~/.gitconfig` used to be a second one,
> because `bp-explorer` bind-mounted it and refused to start otherwise; that service
> was removed in #1963 and no compose service mounts the file any more.)

> **Discover your Podman socket path:**
> ```bash
> podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'
> ```
> Common defaults: macOS Podman Desktop → `/run/user/501/podman/podman.sock`, Windows Podman Desktop → `/run/user/1000/podman/podman.sock`

### First-time bootstrap (fresh install only)

Start Conduwuit first, then run the setup script to create the admin Matrix user:

```bash
podman compose up -d conduwuit
./orchestrator/setup.sh
```

The script prints a `MATRIX_ACCESS_TOKEN` and a `CONDUWUIT_ADMIN_ROOM` — and **writes both
into your `.env` for you**. You do not need to copy them by hand; it confirms with
`.env updated: …`.

### Seed the shared pool (first time only — required)

```bash
make seed-pool
```

This copies skills, baseline memory, agent role templates, process templates and the
reference MCP servers into the pool volume.

> **`make up` does not seed for you.** Skip this step and the Team-Setup wizard opens with
> an empty process and role catalog. A `WARNING` about the engineering skill is expected
> unless you installed the ACE plugin — everything else seeds normally.

### Start the full stack

```bash
make up
```

This builds the per-agent container image (`as-agent:latest`) and starts all services (Conduwuit, Orchestrator, Admin Console, STT). After a successful start you will see a container status table.

## 6. First Steps — Get Oriented

### Access the Admin Console

Open <http://localhost:4000> in your browser. Log in with the credentials from your `.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`, default `admin` / `admin` for local use).

From here you can:
- Create **Working Environments** — shared workspace recipes that define skills, repos, SSH keys, and MCP servers for a group of agents
- Create **Agents** and **Teams** — the orchestrator spawns one Podman container per agent, lifecycle-managed via the Admin Console
- Chat with agents via the embedded chat UI at `/chats/:agentId`
- Browse agent workspaces, session logs, and triggers in the right rail

### Daily workflow

```bash
git pull
make down
make up
```

Or in one command:

```bash
make update   # git pull --ff-only + down + up
```

### Useful commands

| Command | Description |
|---|---|
| `make up` | Build images + start all services |
| `make down` | Stop the stack |
| `make restart` | down + up |
| `make build` | Rebuild orchestrator + admin-console images only |
| `make agent-image` | Rebuild the per-agent container image (`as-agent:latest`) |
| `make update` | `git pull --ff-only` + down + up in one step. Fails (rather than merging) if you have local commits or a dirty tree |
| `make ps` | Show container status for `conduwuit`, `orchestrator`, `admin-console` |
| `make logs` | Follow logs of those three |
| `make seed-pool` | Seed skills, memory, agent role templates, process templates and reference MCP servers into the shared pool volume |

### VS Code extension (optional)

See [claude-code-vscode-setup.md](claude-code-vscode-setup.md) for the Claude Code VS Code extension setup with the LiteLLM proxy.

### ACE / BriefingPack integration (optional)

If your project uses ACE BriefingPacks and `bp-instance` / `bp-orchestrator` agents, the orchestrator can pull skills from a local ACE plugin install. See [ace-plugin-installation.md](ace-plugin-installation.md).
