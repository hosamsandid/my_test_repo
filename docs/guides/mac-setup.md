# macOS Setup Guide: Podman + Claude Code

This guide walks through setting up the development environment on macOS from scratch.

> **Prerequisite:** This guide assumes you have completed the [Onboarding Guide](onboarding.md) through Step 3 (GitHub access, SSH key, repository cloned). If not, start there.

> **Goal:** Once setup is complete, your daily workflow is: `git pull` → `make down` → `make up` (or just `make update`).

---

## Prerequisites

Install these tools **in order** — later steps depend on earlier ones.

### 1. Xcode Command Line Tools (includes `make`)

```bash
xcode-select --install
```

> This installs `make`, `git`, and other build tools. If already installed, the command will tell you.

### 2. Homebrew

If not already installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 3. Git + GitHub CLI + jq

```bash
brew install git gh jq
```

> **`jq` is not optional.** `orchestrator/setup.sh` aborts with
> `ERROR: jq is required` if it is missing.

### 4. Node.js 22

```bash
brew install node@22
```

Alternatively use `nvm`:

```bash
nvm install 22
```

### 5. Podman

```bash
brew install podman
sudo podman-mac-helper install   # maps /var/run/docker.sock → Podman
```

> **Alternative:** [OrbStack](https://orbstack.dev) or Docker Desktop also work as drop-in replacements for Podman.

### 6. Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### Verify all prerequisites

```bash
git --version && node -v && gh --version && jq --version && make --version && podman --version && claude --version
```

### A global git identity (no longer required by the stack)

This used to be a hard prerequisite: `bp-explorer` bind-mounted `~/.gitconfig` read-only
and refused to start without it. That service was removed in #1963 and no compose service
mounts the file any more, so `make up` no longer cares. Still worth setting if you intend
to commit from this checkout:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

---

## Step 1: Initialize the Podman Machine

```bash
podman machine init --cpus 4 --memory 4096 --disk-size 60 --rootful
podman machine start
```

Verify:

```bash
podman run hello-world
```

You should see: `Hello from Podman!`

---

## Step 2: Configure the .env File

```bash
cp .env.example .env
```

Open `.env` and fill in the required values:

| Variable | Description |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Your LiteLLM auth token — ask a project admin |
| `ANTHROPIC_BASE_URL` | LiteLLM proxy URL — ask a project admin |
| `ADMIN_USER` | Your desired Matrix admin username (e.g. `admin`) |
| `ADMIN_PASS` | Password for that Matrix admin user. Not in `.env.example` — **add the line yourself.** If you leave it out, `setup.sh` prompts interactively |
| `PODMAN_HOST_SOCKET` | Path to your Podman socket |

> **Discover your Podman socket path:**
> ```bash
> podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'
> ```
> The default for macOS Podman Desktop is `/run/user/501/podman/podman.sock`. Set it in `.env`:
> ```
> PODMAN_HOST_SOCKET=/run/user/501/podman/podman.sock
> ```

The model name variables (`ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`) and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` are already pre-filled in `.env.example` and do not need to be changed.

---

## Step 3: First-Time Bootstrap

> **Skip on subsequent clones:** This step is only needed for a completely fresh stack (new volume). If you are joining an existing team environment, skip to Step 4.

Start Conduwuit first, then run the bootstrap script:

```bash
podman compose up -d conduwuit
./orchestrator/setup.sh
```

The script prints a `MATRIX_ACCESS_TOKEN` and a `CONDUWUIT_ADMIN_ROOM` — and **writes both
into your `.env` for you**. You do not need to copy them by hand; it confirms with
`.env updated: …`.

---

## Step 4: Seed the Pool (first time only)

Seed the shared pool **before** the first start, so the Team-Setup wizard has role
templates to offer:

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

## Step 5: Build and Start the Stack

```bash
make up
```

This builds the per-agent container image (`as-agent:latest`), builds the orchestrator and admin-console images, and starts all services. After `make up` you will see a container status table.

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

## Configure LiteLLM Proxy (for your local Claude Code CLI)

Claude Code CLI connects through a LiteLLM proxy. Add the following to your `~/.zshrc` to configure it for local use:

```bash
export ANTHROPIC_BASE_URL=https://litellm.sandbox.starplatform.cloud
export ANTHROPIC_AUTH_TOKEN=<your-auth-token>
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
```

Reload your shell:

```bash
source ~/.zshrc
```

> **Auth token:** Ask a project admin for your LiteLLM auth token.

> **Protect the token at rest:** `~/.zshrc` now contains your LiteLLM credential in plain text. Restrict the file to your user only:
>
> ```bash
> chmod 600 ~/.zshrc
> ```
>
> Don't screen-share, paste, or commit `~/.zshrc` while the token is in it. If the token leaks, ask a project admin to rotate it.

> **Note:** These variables configure your local `claude` CLI (for working on the AEE codebase). The AEE stack itself reads `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from `.env`.

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

## Reopening the Environment (Next Time)

You do not need to repeat the full setup. Next time:

```bash
podman machine start   # if not already running
make update            # git pull + down + up
# or manually:
git pull
make down
make up
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `podman: command not found` | Run `brew install podman` and restart your terminal. |
| Podman machine not running | Run `podman machine start`. |
| `Cannot connect to Podman` / socket error | Run `podman machine start`. If persists, try `podman machine rm` then re-init. |
| `make` not found | Xcode Command Line Tools missing. Run `xcode-select --install`. |
| Admin Console not loading at :4000 | Check `podman ps` — ensure `admin-console` container is running. Rebuild with `make build` if needed. |
| Orchestrator cannot spawn agent containers | Verify `PODMAN_HOST_SOCKET` in `.env` points to the correct socket path. Run `podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` to find it. Note that on a `--rootful` machine the in-VM socket is `/run/podman/podman.sock`, not the rootless `/run/user/<uid>/…` path. |
| Team-Setup wizard shows no processes or roles | You skipped `make seed-pool`, or it seeded a different volume — see Step 4. |
| Agent creation fails with an image-not-found error | The `as-agent:latest` image was never built. Run `make agent-image` (`make up` does this for you; a plain `podman compose up` does **not**). |
| Git operations from agents fail with an SSH error | The orchestrator bind-mounts a fixed key path, `~/.ssh/id_accenturecodefoundry` (see `docker-compose.yml`). If your key has a different name, either create that file or adjust the mount and `GIT_SSH_COMMAND` in `docker-compose.yml`. If the path does not exist, Podman creates a *directory* there and every git-over-SSH call fails. |
| OrbStack instead of Podman | Works as a drop-in replacement. Install from [orbstack.dev](https://orbstack.dev). No `podman machine init` needed. |
