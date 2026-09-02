# Deployment & hosting

Where can you actually run Agent Studio? This page gives you three concrete options, what
each one costs you, and — just as important — **what is not supported yet**, so you do not
plan into a dead end.

The product is designed to be self-hosted: the whole stack, including the chat backbone,
runs inside your network. What varies is *whose* machine it runs on.

---

## Choose your option

| | **A. Local** | **B. Shared server** | **C. Enterprise multi-tenant** |
|---|---|---|---|
| Runs on | one developer's laptop | one Linux VM your team reaches over the network | central platform, many teams |
| Users | 1 | a small team, **trusted with each other's chats** | many, isolated |
| Status | ✅ **fully supported** | ⚠️ **works, with real caveats** | ❌ **not supported yet** |
| Effort | 45–60 min | half a day plus a reverse proxy | a development project |
| Best for | evaluating, developing, demos | a pilot team, a shared demo instance | the long-term target |

Most readers want **A** today and are planning for **B**. Read the caveats in B before you
promise it to anyone — one of them (shared chat identity) is a genuine surprise.

---

## A. Local hosting (supported today)

The default and best-tested path. Everything runs on your machine under Podman; nothing is
exposed beyond `localhost`.

**Follow the step-by-step guide for your OS:**
[macOS](guides/mac-setup.md) · [Windows](guides/windows-setup.md) ·
[new-joiner onboarding](guides/onboarding.md)

Linux is not written up as its own guide, but it is the *simplest* case: install rootless
Podman, ensure `/run/user/$(id -u)/podman/podman.sock` exists
(`systemctl --user enable --now podman.socket`), point `PODMAN_HOST_SOCKET` at it, and
follow the macOS guide from "Configure the .env file" onward — there is no Podman machine
VM to initialize.

**What you get:** every feature. **What you don't:** anybody else using it.

---

## B. Shared server hosting (works today — read the caveats)

One Linux VM, the same compose stack, reachable by your team over the network. This is the
realistic "central hosting" answer right now.

### Why this works without code changes

- **The web UI makes only origin-relative calls.** There is no baked-in `localhost` in the
  browser bundle, so serving the console from `https://agents.corp.example` needs no
  rebuild.
- **The browser never talks to Matrix or Podman directly.** All chat traffic is proxied
  through the console's own API, so only one port has to be reachable.
- **Ports and names are already environment-driven** — `ADMIN_PORT`, `CONDUWUIT_PORT`,
  `COMPOSE_PROJECT_NAME`, `AEE_INSTANCE_ID`.
- **Rootless Podman on Linux is an anticipated target.** The compose file already carries
  the `label=disable` workaround needed on SELinux-enforcing hosts.

### What you have to add yourself

#### 1. TLS — there is none in the repository

No reverse proxy, no certificate handling, no HTTPS listener ships with the stack. Put a
terminator (nginx, Caddy, Traefik) in front of port `4000` and then:

```bash
# in .env
AUTH_COOKIE_SECURE=true        # session cookie gets the Secure attribute
AUTH_SESSION_SECRET=<random>   # otherwise it is derived from the admin password
ADMIN_PASSWORD=<something real>
```

> **Do not skip `AUTH_COOKIE_SECURE`.** Without it the session cookie is sent over plain
> HTTP too.

Two rough edges to know about behind a proxy:

- The API does **not** set Express's `trust proxy`. The login rate limiter (20 attempts per
  15 minutes) therefore keys on the *proxy's* IP, so all users share one bucket. Rate-limit
  at the proxy instead.
- CORS is configured wide open (`cors()` with no origin restriction). Cookies are not sent
  cross-origin, so this is not an authentication bypass, but restrict it at the proxy if
  your security review asks.

#### 2. Only expose what you mean to expose

| Port | Service | Expose? |
|---|---|---|
| `4000` | Admin Console | **yes** — behind TLS + your identity provider's proxy if you have one |
| `4003` | Orchestrator webhook (`http` triggers) | only if external systems must fire triggers; it authenticates per-trigger via `X-Hook-Secret` |
| `8448` | Matrix homeserver | **no** — keep internal; nothing outside needs it |
| `4002` | Orchestrator internal API | already unpublished; leave it that way |

#### 3. Replace the developer bind-mounts

The compose file mounts two things from a *developer's* home directory. On a server, these
are wrong and must be provisioned deliberately:

- `~/.ssh/id_accenturecodefoundry` (+ `.pub`) — a **single SSH key shared by every agent**,
  referenced by name in `GIT_SSH_COMMAND`. If the file does not exist, Podman silently
  creates a *directory* there and every git-over-SSH operation fails.
- `~/.gitconfig` — `bp-explorer` will not start without it.

Create both for the service account that runs the stack, or edit the mounts in
`docker-compose.yml` to point at managed paths.

#### 4. Run it as a dedicated, unprivileged user

The orchestrator holds a **read-write** Podman socket — that is how it spawns agent
containers. Within that user's namespace this is effectively root-equivalent: anything that
compromises the orchestrator can create containers with arbitrary mounts. Give the stack
its own Linux user, and do not share that user with anything else.

### ⚠️ The caveats you must tell your users about

These are properties of the current implementation, not configuration mistakes.

| Caveat | What it means in practice |
|---|---|
| **All console users share one chat identity** | The console authenticates to Matrix with a single access token. Every logged-in person acts as the *same* Matrix user and sees the *same* DM rooms — so **everyone can read everyone's agent conversations.** Acceptable inside one trusted team; not acceptable across teams. |
| **The single env-admin credential always works** | Per-user passwords exist (set on the Users page), but login falls back to `ADMIN_USERNAME`/`ADMIN_PASSWORD` by design, so nobody can be locked out. That fallback also cannot be disabled. |
| **No SSO** | There is a clean, documented swap-point for OIDC/SAML, but no implementation. |
| **Authorization is coarse** | The API gate is binary: authenticated or not. Team roles scope *lists*, not every mutation. |
| **No backup tooling** | Five stateful volumes and no dump/restore script — see below. |

If your deployment needs per-user chat privacy, treat B as a **pilot**, not a rollout.

### Backup: what is actually stateful

There is no backup tooling in the repository. You must handle these five named volumes
(all prefixed with your `COMPOSE_PROJECT_NAME`) yourself:

| Volume | Holds | If you lose it |
|---|---|---|
| `conduwuit-db` | all users, rooms and **chat history**, access tokens | catastrophic: tokens invalid, admin room ID changes, all conversations gone |
| `agent-pool-workspace` | agent workspaces, the **secret stores** (SSH keys, GitHub tokens, MCP credentials), the audit log | catastrophic and secret-bearing |
| `claude-home` | Claude session snapshots used by `--resume` | agents lose conversation continuity |
| `agent-control-plane` | live status and session logs | monitoring history lost |
| `skills-pool` | the curated skill pool | recoverable via `make seed-pool`, minus local edits |

Plus per-agent volumes named `<project>_agent-<id>` when `AEE_PER_AGENT_VOLUME=1` — those
are created dynamically, so enumerate Podman volumes rather than reading the compose file.

Snapshot the whole volume set together: `conduwuit-db` and `agent-pool-workspace` reference
each other, and a half-restored pair leaves agents pointing at rooms that no longer exist.

> **Upgrading past the `vgh-claw` → `agent-studio` rename.** The default `COMPOSE_PROJECT_NAME`
> changed, which changes the prefix on every named volume above. On an existing stack this
> orphans your volumes unless you either pin the old prefix (`COMPOSE_PROJECT_NAME=vgh-claw`
> in `.env`) or copy the data across to the new prefix. Step-by-step migration commands are in
> `RELEASE_NOTES` under **Unreleased → Breaking Changes**.

### Sizing

Agent containers are started **eagerly** — every enabled agent has a container running,
whether or not anyone is talking to it. There is no spawn-on-first-message path.

Steady state = **4 service containers + one container per enabled agent**, and:

- each agent container is capped at **2 GiB** (`AEE_AGENT_MEM_LIMIT`, default `2g`) and 512
  PIDs (`AEE_AGENT_PIDS_LIMIT`) — neither is in `.env.example`, both are settable;
- there is **no CPU limit** on agents, and **no limits at all** on the four service
  containers;
- each agent also gets **its own Podman network**, with the orchestrator and homeserver
  attached to it. At high agent counts the number of network attachments is the first
  thing likely to strain.

A practical starting point for a pilot of ~10 agents: 8 vCPU, 32 GiB RAM, 100 GiB disk —
then measure, because real usage depends entirely on how busy the agents are.

---

## C. Enterprise multi-tenant hosting (not supported yet)

The long-term target: one central platform, many teams, each isolated from the others.
**Nothing in the repository implements this today.** Being explicit about the gap:

| Needed | Status today |
|---|---|
| Per-user identity in chat | ❌ one shared Matrix token for all console users — the core blocker |
| SSO / OIDC | ❌ not implemented; a documented swap-point exists |
| Per-request authorization by team role | ⚠️ partial — list endpoints are scoped, mutations are not |
| TLS as part of the deployment | ❌ external concern today |
| Kubernetes | ❌ **not possible without new code.** Agent spawning talks the Podman-specific libpod API over a Unix socket, with no abstraction seam and no alternative backend. A Docker socket would not work either |
| A real Matrix `server_name` | ⚠️ currently the literal `local`. Fine while Matrix stays internal — but changing it is a destructive migration: it means wiping the homeserver database, re-bootstrapping, and touching every hardcoded `:local` reference |
| Backup / restore | ❌ no tooling |
| Deployment automation | ❌ CI builds and tests only; no image publishing, no deploy job |

**The honest summary:** the architecture does not prevent central hosting — the UI is
origin-relative, the services are already network-separated, and rootless Podman on Linux
is an anticipated target. What is missing is the *multi-tenancy layer*: real per-user
identity, authorization on every mutation, and an orchestration backend that is not tied to
a local Podman socket.

Design intent for the identity part is written up in
[multi-user-concept.md](multi-user-concept.md) — read it as a plan, not as a description of
what exists.

---

## Which model provider, and where

Independent of where the stack runs, the LLM endpoint is yours to choose: the public
Anthropic API, a LiteLLM proxy, Azure AI Foundry, or an internal corporate gateway —
anything speaking the Anthropic Messages API. Configure it in `.env`, or register it in the
console under **Model Providers**.

For a hosted deployment, prefer an **API-key** provider. Claude *subscription* (OAuth)
tokens are licensed for the subscription owner's own single-user use, which does not fit a
shared server — the console requires you to confirm this explicitly before creating such a
provider.

See [model-providers.md](model-providers.md).

---

## Related

- [macOS setup](guides/mac-setup.md) · [Windows setup](guides/windows-setup.md) — local install
- [credentials.md](credentials.md) — SSH keys and GitHub tokens
- [triggers.md](triggers.md) — the webhook endpoint on port 4003
- [admin-console.md](admin-console.md) — authentication and the audit trail

← Back to the [documentation index](README.md).
- [agent-chat-troubleshooting.md](agent-chat-troubleshooting.md) — when an agent stays silent
