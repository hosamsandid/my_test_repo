# Windows Setup Guide: Podman Desktop + Claude Code

This guide walks through setting up the development environment on Windows from scratch.

> **Prerequisite:** This guide assumes you have completed the [Onboarding Guide](onboarding.md) through Step 3 (GitHub access, SSH key, repository cloned). If not, start there.

> **Goal:** Once setup is complete, your daily workflow is: `git pull` → `make down` → `make up` (or just `make update`).

---

## Prerequisites

Install these tools **in order** — later steps depend on earlier ones.

### 1. WSL2 + Ubuntu

Podman Desktop on Windows requires WSL2 (Windows Subsystem for Linux 2) as its backend. This must be installed **before** Podman Desktop.

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

This installs WSL2 and Ubuntu by default. **Reboot** when prompted.

After reboot, set WSL2 as the default version:

```powershell
wsl --set-default-version 2
```

Verify:

```powershell
wsl --status
```

You should see `Default Version: 2`.

> **Corporate IT:** On managed machines, WSL2 features may be restricted by IT policy. If `wsl --install` fails or WSL2 is auto-removed after reboot, escalate to IT — no container runtime (Podman or Docker) works on Windows without WSL2. The Podman machine creation error `exit status 0xffffffff` is a reliable indicator of missing WSL2.

### 2. Git for Windows (includes Git Bash)

```powershell
winget install Git.Git
```

> **Git Bash** is included with Git for Windows and is **required** for all `make` commands. The Makefile uses bash syntax that does not work in PowerShell or cmd.

### 3. Node.js 22 LTS

```powershell
winget install OpenJS.NodeJS.LTS
```

### 4. GitHub CLI

```powershell
winget install GitHub.cli
```

### 5. GNU Make

```powershell
winget install GnuWin32.Make
```

After installation, add the Make binary directory to your system PATH:

1. Open **System Settings** → **Environment Variables**
2. Edit the **Path** variable (system or user)
3. Add: `C:\Program Files (x86)\GnuWin32\bin`
4. Close and reopen your terminal

### 6. Podman Desktop

```powershell
winget install RedHat.Podman-Desktop
```

> **Important:** WSL2 must be installed and working (step 1) before opening Podman Desktop. If Podman Desktop prompts to create a machine and fails with `exit status 0xffffffff`, WSL2 is not installed or is disabled.

### 7. Claude Code CLI

```powershell
npm install -g @anthropic-ai/claude-code
```

### 8. jq

```powershell
winget install --id jqlang.jq
```

> **`jq` is not optional.** `orchestrator/setup.sh` aborts with `ERROR: jq is required` if
> it is missing. Restart your shell afterwards so it is on `PATH`.

### 9. A global git identity (no longer required by the stack)

This used to be a hard prerequisite: `bp-explorer` bind-mounted `~/.gitconfig` read-only
and refused to start without it. That service was removed in #1963 and no compose service
mounts the file any more. Still worth setting if you intend to commit from this checkout —
from Git Bash:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### Verify all prerequisites

Open **Git Bash** and run each command. All tools should be available:

```bash
wsl --status               # Default Version: 2
git --version              # git version 2.x
node -v                    # v22.x or higher
gh --version               # gh version 2.x
jq --version               # jq-1.x
make --version             # GNU Make 3.x or 4.x
podman --version           # podman version 5.x
claude --version           # @anthropic-ai/claude-code x.x.x
cat ~/.gitconfig           # must exist and be non-empty
```

> **PATH troubleshooting:** If any tool is not recognized after installation, close and reopen your terminal. If still not found, verify the install directory is in your system PATH via **System Settings** → **Environment Variables**. Use `where.exe <tool>` (e.g., `where.exe make`) to locate the install path.

---

## Step 1: Initialize the Podman Machine

Open **Podman Desktop** after installation. It will guide you through creating a WSL2-backed Podman machine.

After the machine is created, verify from Git Bash:

```bash
podman run hello-world
```

You should see: `Hello from Podman!`

> **VPN warning:** Corporate VPN may block access to container registries (Docker Hub, ghcr.io). If image pulls fail or hang, **disconnect from VPN** before pulling images. Reconnect after images are pulled.

> **DNS after Podman machine restart:** After restarting the Podman machine, DNS resolution inside containers may break (`resolv.conf` is lost). Fix with:
> ```bash
> podman machine ssh 'echo nameserver 8.8.8.8 | sudo tee /etc/resolv.conf'
> ```

---

## Step 2: Navigate to the Project

Open **Git Bash** and navigate to the project folder:

```bash
cd /c/Users/<your-username>/<your-project-folder>
```

> **Important:** Use **Git Bash** for all remaining steps. PowerShell works for standalone `podman compose` commands, but `make` targets require bash.

---

## Step 3: Configure the .env File

Copy the example and fill in your values:

```bash
cp .env.example .env
```

Open `.env` in a text editor and fill in:

| Variable | Description |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Your LiteLLM auth token — ask a project admin |
| `ANTHROPIC_BASE_URL` | LiteLLM proxy URL — ask a project admin |
| `ADMIN_USER` | Your desired Matrix admin username (e.g. `admin`) |
| `ADMIN_PASS` | Password for that Matrix admin user. Not in `.env.example` — **add the line yourself.** On Windows this is effectively required: without it `setup.sh` falls back to an interactive prompt that is unreliable in Git Bash |
| `PODMAN_HOST_SOCKET` | Path to your Podman socket inside WSL2 |

> **Discover your Podman socket path (Windows Podman Desktop default):**
> ```bash
> podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'
> ```
> The path is typically `/run/user/1000/podman/podman.sock` on Windows Podman Desktop. Set it in `.env`:
> ```
> PODMAN_HOST_SOCKET=/run/user/1000/podman/podman.sock
> ```

The model name variables (`ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`) and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` are already pre-filled in `.env.example` and do not need to be changed.

---

## Step 4: First-Time Bootstrap

> **Skip on subsequent clones:** This step is only needed for a completely fresh stack (new volume). If you are joining an existing team environment, skip to Step 5.

Start Conduwuit first, then run the bootstrap script:

```bash
podman compose up -d conduwuit
./orchestrator/setup.sh
```

The script prints a `MATRIX_ACCESS_TOKEN` and a `CONDUWUIT_ADMIN_ROOM` — and **writes both
into your `.env` for you**. You do not need to copy them by hand; it confirms with
`.env updated: …`.

---

## Step 5: Build and Start the Stack

From Git Bash:

```bash
make up
```

This builds the per-agent container image (`as-agent:latest`), builds the orchestrator and admin-console images, and starts all services.

### `podman compose` vs `podman-compose`

The project uses **`podman compose`** (Compose v2 subcommand built into Podman). This is **not** the same as `podman-compose` (a standalone Python package). Do not install `podman-compose` via pip — it has known issues with `dockerfile:` keys and `pull_policy`.

### If you don't have `make`

Use `podman compose` directly from Git Bash or PowerShell — but **you must build the
per-agent image yourself first**. It is not a compose service, so `podman compose build`
never builds it, and without it every agent you create fails to start with an
image-not-found error:

```bash
podman build -t as-agent:latest -f agent-image/Dockerfile agent-image/
podman compose -f docker-compose.yml build
podman compose -f docker-compose.yml up -d
```

Installing GNU Make is strongly preferred — `make up` does all three steps in the right
order.

### Troubleshooting the build

- **VPN blocks image pulls:** Disconnect from corporate VPN before running `make up`. The VPN may block access to Docker Hub and other registries. Reconnect after images are pulled.
- **CRLF line endings in .sh files:** If a shell script fails with `/bin/bash^M: bad interpreter`, the file has Windows-style line endings. The repository's `.gitattributes` pins shell and Python scripts to LF, so a fresh clone is protected. If you have an **older clone** made before that file existed, a plain `git checkout --` will restore the same CRLF content — renormalize instead:
  ```bash
  git rm --cached -r . && git reset --hard
  ```

---

## Step 6: Seed the Pool (first time only)

Seed the shared pool so the Team-Setup wizard has role templates to offer:

```bash
make seed-pool
```

This copies five things into the pool volume: skills, baseline memory, agent role
templates, process templates, and the reference MCP servers.

> **`make up` does not seed for you.** Skip this and the Team-Setup wizard will present an
> empty process/role catalog — the most common "why is it empty?" first-run experience.

> **A `WARNING` about the engineering skill is expected** if you have not installed the
> ACE plugin. Everything else seeds normally — see
> [ACE plugin installation](ace-plugin-installation.md) if you actually need it.

> **If you changed `COMPOSE_PROJECT_NAME` in `.env`, seeding silently targets the wrong
> volume.** `make` does not read `.env`, so it falls back to the `agent-studio_claude-workspace`
> volume while compose creates `<yourname>_claude-workspace`. Pass it explicitly:
> ```bash
> COMPOSE_PROJECT_NAME=<yourname> make seed-pool
> ```

---

## Access the Admin Console

After `make up`, the Admin Console is available at:

| Service | URL |
|---------|-----|
| Admin Console | <http://localhost:4000> |
| Conduwuit Matrix API | <http://localhost:8448> |
| Orchestrator Webhook | <http://localhost:4003> |

Log in at <http://localhost:4000> with the credentials from your `.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`, default `admin` / `admin`).

---

## Useful Commands

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

---

## Configure LiteLLM Proxy (for your local Claude Code CLI)

Claude Code CLI connects through a LiteLLM proxy. Use `setx` to create permanent environment variables for your local Claude Code CLI:

```powershell
setx ANTHROPIC_BASE_URL https://litellm.sandbox.starplatform.cloud
setx ANTHROPIC_AUTH_TOKEN <your-auth-token>
setx ANTHROPIC_DEFAULT_SONNET_MODEL claude-sonnet-4-6
setx ANTHROPIC_DEFAULT_HAIKU_MODEL claude-haiku-4-5
setx CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 1
```

**Restart your PowerShell terminal** for the new variables to take effect, then verify:

```powershell
echo $env:ANTHROPIC_BASE_URL
echo $env:ANTHROPIC_AUTH_TOKEN
```

> **Note:** These variables configure your local `claude` CLI (for working on the AEE codebase). The AEE stack itself reads `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from `.env`.

---

## Reopening the Environment (Next Time)

You do not need to repeat the full setup. Next time:

1. Open **Podman Desktop** (ensure the machine is running)
2. Open **Git Bash** and navigate to the project folder
3. Run:
   ```bash
   make update    # git pull + down + up
   # or manually:
   git pull
   make down
   make up
   ```

> **DNS after Podman machine restart:** If containers cannot resolve hostnames after restarting the Podman machine, recreate `resolv.conf`:
> ```bash
> podman machine ssh 'echo nameserver 8.8.8.8 | sudo tee /etc/resolv.conf'
> ```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `wsl --install` fails or WSL2 is auto-removed | Corporate IT policy may block WSL2. Escalate to IT — Podman Desktop requires WSL2. |
| Podman machine creation fails with `exit status 0xffffffff` | WSL2 is not installed. Run `wsl --install` (admin), reboot, then retry. |
| `make` not found | Install via `winget install GnuWin32.Make` and add `C:\Program Files (x86)\GnuWin32\bin` to PATH. |
| `'{' is not recognized` when running `make` | You are using PowerShell or cmd.exe — switch to **Git Bash**. |
| `podman` not found in bash | Ensure Podman Desktop is installed and its bin directory is in your PATH. |
| VPN blocks image pulls (build hangs or fails) | Disconnect from corporate VPN, run `make up`, reconnect after images are pulled. |
| DNS broken after Podman machine restart | Run: `podman machine ssh 'echo nameserver 8.8.8.8 \| sudo tee /etc/resolv.conf'` |
| Admin Console not loading at :4000 | Check `podman ps` — ensure `admin-console` container is running. Rebuild with `make build` if needed. |
| `podman-compose` errors (dockerfile key ignored, pull_policy issues) | Use `podman compose` (Compose v2 subcommand), not `podman-compose` (Python package). Do not `pip install podman-compose`. |
| Orchestrator cannot spawn agent containers | Verify `PODMAN_HOST_SOCKET` in `.env` points to the correct socket path. Run `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` to find it. |
| `setup.sh` hangs at the password prompt | Set `ADMIN_PASS=<yourpassword>` in `.env` before running it — the interactive prompt is unreliable in Git Bash. Run it as `bash orchestrator/setup.sh`. |
| `ERROR: jq is required` | Install it: `winget install --id jqlang.jq`, then restart your shell. |
| Team-Setup wizard shows no processes or roles | You skipped `make seed-pool`, or it seeded a different volume — see Step 6. |
| Agent creation fails with an image-not-found error | The `as-agent:latest` image was never built. Run `make agent-image`, or `podman build -t as-agent:latest -f agent-image/Dockerfile agent-image/`. |
