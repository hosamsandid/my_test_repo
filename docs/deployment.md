# Deployment & hosting

Where can you actually run Agent Studio? This page gives you the concrete options, what
each one costs you, and — just as honestly — **what is still missing**, so you do not plan
into a dead end.

The product is self-hosted: the whole stack, including the chat backbone, runs inside your
network. What varies is *whose* machine it runs on, and on which runtime.

> **This page was rewritten.** Several limitations the earlier revision called out as
> blockers have since shipped and no longer apply:
>
> - **Per-user chat identity** — each human now chats under their own Matrix account, not one
>   shared console token (#1458, #2173).
> - **Authorization on every mutation** — writes are gated per team role, and the whole
>   `:agentId` work plane (chat, workspace, git, session log) is behind a tenant gate that
>   returns a uniform 404 for agents you can't see (#1459).
> - **Google SSO** — the hosted stack signs you in from your Google identity via Cloud IAP;
>   no second login form (#276, #1415).
> - **A Kubernetes backend** — agent spawning is no longer tied to a local Podman socket; a
>   runtime seam selects Podman *or* Kubernetes, and a GKE deployment is running (#1348 and
>   the `deploy/k8s/` tree).
>
> Central, multi-team hosting is therefore no longer "not possible" — it is a **running
> pilot** with a shrinking list of documented gaps (see option C).

Two container runtimes are supported behind one seam (`orchestrator/container-runtime.js`,
selected by `AEE_CONTAINER_RUNTIME`, default `podman`):

- **Podman + compose** — the default local dev path (`make up`) and the single-VM server.
- **Kubernetes** — locally on **kind**, hosted on **GKE**.

---

## Choose your option

| | **A. Local** | **B. Single shared VM** | **C. Hosted Kubernetes (GKE)** |
|---|---|---|---|
| Runs on | one developer's laptop (compose or kind) | one Linux VM your team reaches over the network (Podman compose) | a GKE cluster, kustomize overlays |
| Users | 1 (or a few, single-user mode) | a team — **now with per-user chat identity** | many, isolated per team |
| Status | ✅ **fully supported** | ✅ **supported** — read the hardening steps | ✅ **pilot** (test + preprod live), with documented gaps |
| Identity | local password | local password (per-user once `AUTH_ENABLED=true`) | Google SSO via Cloud IAP |
| Effort | 45–60 min | half a day plus a reverse proxy | a `terraform apply` + a bootstrap script, then a CI deploy |
| Best for | evaluating, developing, demos | a pilot team, a shared demo instance | the multi-team target |

Most readers still want **A** today. **B** is a solid single-team server. **C** is real now,
not a plan — but read its gap table before you promise enterprise multi-tenancy.

Operational runbooks (canonical, step-by-step, symptom-keyed troubleshooting):

- [`deploy/k8s/README.md`](../deploy/k8s/README.md) — kind + GKE, overlay model, release policy, port map.
- [`docs/hosting/gcp/gke-runbook.md`](hosting/gcp/gke-runbook.md) — GKE deploy & incident runbook.
- [`docs/hosting/gcp/vm-podman-runbook.md`](hosting/gcp/vm-podman-runbook.md) — the single-VM Podman pilot on GCP.

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

**Want the Kubernetes runtime locally?** `./deploy/k8s/kind-up.sh` builds the images, spins
up a kind cluster, deploys the kustomize `kind` overlay, and seeds it — agents then spawn as
real k8s pods. It is idempotent (re-run after any failure). See
[`deploy/k8s/README.md`](../deploy/k8s/README.md). The compose stack is unaffected and
remains the default.

**What you get:** every feature. **What you don't:** anybody else using it (unless you turn
on the multi-user model below).

---

## B. Single shared VM (Podman compose)

One Linux VM, the same compose stack, reachable by your team over the network. This is the
realistic single-team "central hosting" answer, and there is a hardened GCP recipe for it:
[`docs/hosting/gcp/vm-podman-runbook.md`](hosting/gcp/vm-podman-runbook.md) plus the
provisioning scripts under `deploy/gcp/` (`provision.sh`, `deploy.sh`, `vm-*.sh`).

### Why this works without code changes

- **The web UI makes only origin-relative calls.** There is no baked-in `localhost` in the
  browser bundle, so serving the console from `https://agents.corp.example` needs no
  rebuild.
- **The browser never talks to Matrix or Podman directly.** All chat traffic is proxied
  through the console's own API, so only one port has to be reachable.
- **Ports and names are already environment-driven** — `ADMIN_PORT`, `CONDUWUIT_PORT`,
  `COMPOSE_PROJECT_NAME`, `AEE_INSTANCE_ID`.
- **Rootless Podman on Linux is a first-class target.** The compose file already carries the
  `label=disable` workaround needed on SELinux-enforcing hosts.

### Turn on the multi-user model

Two independent switches move you from "single operator" to "a team, each with their own
identity":

1. **Create real user records** (Administration → Users). Creating a user provisions that
   human their own reserved Matrix account `@u-<16 hex of sha256(subject)>:local`
   (`orchestrator/human-matrix-identity.js`); interactive chat then sends under *their* token,
   not the shared console token. This happens at user-record creation — there is no flag to
   toggle it on — and users still without one (older records, the seeded first administrator,
   a failed attempt) are backfilled at startup and retried every two minutes (#2721).
2. **Set `AUTH_ENABLED=true`.** The default is single-user compatibility mode, in which
   whoever signs in is the implicit System Admin and every scoping/authorization check is a
   no-op. With it on, list endpoints are filtered by team membership, per-mutation
   management gates apply, and the work-plane gate isolates each agent's chat/workspace/git.

> **These two go together.** With `AUTH_ENABLED` off, the single operator has no user record;
> it still gets its own `@u-…` chat identity keyed by its login subject, and chat never falls
> back to the shared `MATRIX_ACCESS_TOKEN` (#2721). Turn it on **before** you invite a second person, or they inherit
> the operator's view. Flipping it back off on a stack that already has named users grants
> every one of them full visibility — the console logs a boot warning when that is the case.

### What you have to add yourself

#### 1. TLS — there is none in the repository

No reverse proxy, no certificate handling, no HTTPS listener ships with the stack. Put a
terminator (nginx, Caddy, Traefik) in front of port `4000` and then:

```bash
# in .env
AUTH_ENABLED=true              # per-membership scoping + the work-plane gate (see above)
AUTH_COOKIE_SECURE=true        # session cookie gets the Secure attribute
AUTH_SESSION_SECRET=<random>   # otherwise a random key is persisted on the workspace volume
ADMIN_PASSWORD=<something real> # seeds the first System-Admin record at FIRST boot only
```

> **Do not skip `AUTH_COOKIE_SECURE`.** Without it the session cookie is sent over plain
> HTTP too.

> **`ADMIN_USERNAME`/`ADMIN_PASSWORD` are a one-time seed, not the login.** They create the
> first System-Admin *record* on a zero-users store and are never read again; they are no
> longer even passed to the admin-console container. On a stack that already has a user,
> change the password on the Users page instead. (`BOOTSTRAP_SYSTEM_ADMIN_SUBJECT/_EMAIL/_NAME`
> is the SSO-flavoured alternative seed: a passwordless System Admin.)

One rough edge behind a proxy:

- The API now sets Express's `trust proxy` to **1** (one hop), so with **exactly one** reverse
  proxy in front the login rate limiter (20 attempts / 15 min) keys on the real client IP
  from `X-Forwarded-For`. If you chain **two or more** proxies, `req.ip` becomes the nearest
  proxy's address again and all clients share one bucket — rate-limit at the edge in that case.
- CORS is configured wide open (`cors()` with no origin restriction). Cookies are not sent
  cross-origin, so this is not an authentication bypass, but restrict it at the proxy if
  your security review asks.

#### 2. Only expose what you mean to expose

| Port | Service | Expose? |
|---|---|---|
| `4000` | Admin Console | **yes** — behind TLS + your identity provider's proxy if you have one |
| `4003` | Orchestrator webhook (`http` triggers) | only if external systems must fire triggers; it authenticates per-trigger via `X-Hook-Secret` or a GitHub `X-Hub-Signature-256` |
| `8448` | Matrix homeserver | **no** — keep internal; nothing outside needs it |
| `4002` | Orchestrator internal API | already unpublished; **leave it that way** — and arm the internal-auth gate below, because unpublished is not the same as unreachable |

The compose stack now runs **four services**: `conduwuit`, `orchestrator` (which *is* the
webhook/hook server on `HOOK_PORT` — there is no separate webhook container), `admin-console`,
and `stt` (speech-to-text for the meeting Note-Taker; internal-only, no host port).

##### 2a. Arm the internal-API gate (`:4002`)

Not publishing `4002` keeps it off the host. It does **not** keep it off the
container network — every agent container can reach `http://orchestrator:4002`,
and until the gate is armed that surface is unauthenticated, so an agent can
call any control-plane route directly and every authorization check the admin
console performs is bypassable. This is GOV-PLATFORM-2 in
`docs/governance-concept.md` §3.5.

Arming it is one shared secret in `.env`:

```bash
INTERNAL_API_TOKEN=$(openssl rand -hex 32)
```

Both containers read it from the same `.env` (compose) or the same
`agent-studio-env` Secret (k8s — `--from-env-file` picks the new keys up with no
manifest change), and from there:

- the **admin console** sends it as a bearer header on every `/internal/*` call
  and gets the full surface;
- each **agent container** is given a *derived* per-agent token
  (`AEE_INTERNAL_TOKEN`) instead, valid only for the agent-facing routes and only
  for that agent's own id. The control-plane token itself is stripped from the
  agent environment, on both the podman and the kubernetes spawn path;
- nothing else can present a token at all.

**Roll it out in stages** (`INTERNAL_AUTH_MODE`, the §3.2 ladder):

| Mode | Behaviour | When |
|---|---|---|
| `observe` | allow everything, log every call that *would* be rejected | first — for at least a week |
| `warn` | same, logged louder | optional middle rung |
| `enforce` | reject with 401/403 | once the observe log is quiet |

**Default depends on the deployment target** (#2459). The safe default is not the
same everywhere, so the mode you get when `INTERNAL_AUTH_MODE` is *unset* differs:

| Deployment | Unset default | Rationale |
|---|---|---|
| Local Podman Compose (`AEE_CONTAINER_RUNTIME` unset / `podman`) | `observe` | developer convenience — the container network is a single laptop |
| Shared / production-style **GKE / Kubernetes** (`AEE_CONTAINER_RUNTIME=kubernetes`) | `enforce` **once armed** (a token is set); `observe` while unarmed | a shared cluster must not sit in silent log-only mode — but `enforce` needs a token, so it only kicks in after you arm the gate |

This is a **decision baked into the orchestrator**, not the manifests, so it
honours one important exception: **an explicitly set mode always wins.** If you
are mid-migration on the GKE path and deliberately set `INTERNAL_AUTH_MODE=observe`,
that choice stands — the safer default applies only when the variable is *unset*,
never overriding a deliberate one. To stage the rollout on GKE, either arm the
gate and let it default straight to `enforce`, or set `INTERNAL_AUTH_MODE=observe`
explicitly for the census week and drop it (or set `enforce`) afterwards.

A non-local deployment that is **not** enforcing — unarmed, or on an explicit/
defaulted `observe`/`warn` — logs a startup warning so it does not go unnoticed:

```
[Orchestrator] internal-auth: non-local deployment is … not enforce — :4002 violations are logged but NOT blocked …
```

During the observe week, inventory the real callers:

```bash
podman logs orchestrator 2>&1 | grep '\[internal-auth\]' | grep would-deny
# on GKE: kubectl logs deploy/orchestrator -n <namespace> | grep '\[internal-auth\]'
```

An empty result means nothing outside the console and the agents is talking to
`:4002`, and `enforce` is safe. A non-empty one names the caller and the route
before it breaks, which is the entire point of the rung. Setting `enforce`
without a token is refused at boot rather than silently locking everyone out.

> **Open question (flagged for Product Owner):** whether a *non*-GKE but
> network-exposed Podman deployment (e.g. bound to a non-localhost interface)
> should also default to `enforce`. It currently does not — the code keys the
> safer default off the Kubernetes runtime only. Such a deployment can still opt
> in by setting `INTERNAL_AUTH_MODE=enforce` explicitly.

Rotation is a value change plus a respawn: agent tokens are derived, so changing
`INTERNAL_API_TOKEN` (or `INTERNAL_AGENT_TOKEN_SECRET`) invalidates every
outstanding one, and each agent is re-minted the next time it spawns. Change the
value in both containers together — a console holding the old token is refused
exactly like an outsider.

#### 3. Replace the developer bind-mounts

The compose file mounts a key from a *developer's* home directory. On a server, this
is wrong and must be provisioned deliberately:

- `~/.ssh/id_accenturecodefoundry` (+ `.pub`) — a **single SSH key shared by every agent**,
  referenced by name in `GIT_SSH_COMMAND`. If the file does not exist, Podman silently
  creates a *directory* there and every git-over-SSH operation fails.

Create it for the service account that runs the stack, or edit the mount in
`docker-compose.yml` to point at a managed path.

#### 4. Run it as a dedicated, unprivileged user

The orchestrator holds a **read-write** Podman socket — that is how it spawns agent
containers. Within that user's namespace this is effectively root-equivalent: anything that
compromises the orchestrator can create containers with arbitrary mounts. Give the stack
its own Linux user, and do not share that user with anything else. (The GCP VM runbook does
exactly this — a dedicated `aee` service user with linger enabled.)

### ⚠️ The caveats you must still tell your users about

These are properties of the current implementation, not configuration mistakes.

| Caveat | What it means in practice |
|---|---|
| **One shared room per agent** | Per-user *identity* shipped, but the room model is still one room per agent. Everyone **explicitly authorized on the same agent** posts into that agent's room and sees each other's messages there (senders are distinguishable — this is by design, not per-human privacy from co-owners). Cross-agent / cross-team snooping *is* blocked by the work-plane gate. Per-human private rooms are not implemented. |
| **Signing in requires the orchestrator** | A password is checked against the user store and nothing else — there is no env-credential fallback (#2059). While the orchestrator is unreachable, login answers `503` and **nobody can sign in**. Recovering a lost identity is a host-level action on `/workspace/users/index.json`, not a console login. |
| **No generic OIDC/SAML** | Google Cloud IAP SSO is implemented, but it is GKE-only (option C) and needs `IAP_AUDIENCE`. On a VM there is password login. A clean, documented swap-point for OIDC/SAML exists, but no implementation. |
| **Single-user mode is all-or-nothing** | With `AUTH_ENABLED` unset (the default), everyone who can sign in is the implicit System Admin — team roles scope nothing. Turn it on for a real team (see above, and [teams-data-model.md](./teams-data-model.md#single-user-compatibility-mode-auth_enabled-1457)). |
| **No backup tooling** | Five stateful volumes and no dump/restore script — see below. |

### Backup: what is actually stateful

There is still no backup tooling in the repository. You must handle these five named volumes
(all prefixed with your `COMPOSE_PROJECT_NAME`) yourself:

| Volume (compose key → actual name) | Holds | If you lose it |
|---|---|---|
| `conduwuit-db` → `<project>_conduwuit-db` | all users, rooms and **chat history**, access tokens | catastrophic: tokens invalid, admin room ID changes, all conversations gone |
| `agent-pool-workspace` → `<project>_agent-pool-workspace` | agent workspaces, the **secret stores** (SSH keys, GitHub tokens, MCP credentials), the audit log | catastrophic and secret-bearing |
| `claude-home` → `<project>_claude-home` | Claude session snapshots used by `--resume` | agents lose conversation continuity |
| `agent-control-plane` → `<project>_agent-control-plane` | live status and session logs | monitoring history lost |
| `skills-pool` → `<project>_claude-workspace` | the curated skill pool | recoverable via `make seed-pool`, minus local edits |

> Note the skill pool's compose key is `skills-pool` but its **volume name** is
> `<project>_claude-workspace` — enumerate by name, not by key, when you snapshot.

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

Agent containers are started **eagerly** — every enabled *persistent* agent has a container
running, whether or not anyone is talking to it. There is no spawn-on-first-message path for
them. (Two exceptions are on-demand: **agent-pool instances** — one ephemeral instance per
work item, reaped on release — and **ephemeral agents**; see
`docs/parallel-workers-concept.md`.)

Steady state = **4 service containers + one container per enabled persistent agent**, and:

- each agent container is capped at **2 GiB** (`AEE_AGENT_MEM_LIMIT`, default `2g`) and 512
  PIDs (`AEE_AGENT_PIDS_LIMIT`) — neither is in `.env.example`, both are settable;
- a role may ask for its own memory limit (`memoryLimit` in the agent's Settings tab, the Flow
  node inspector, or a process-template bundle, #2813). The effective limit is resolved
  **role → toolchain → `AEE_AGENT_MEM_LIMIT`**, on Podman and Kubernetes and for every pool
  instance. A role value is bounded by **`AEE_AGENT_MEM_CEILING`** (default `8g`): above it a
  save is refused, and a bundle being materialised is clamped to the ceiling with a warning.
  Set both variables on the **orchestrator** and the **admin-console** service (the console
  validates and displays, the orchestrator enforces). A change applies on the next container
  start; running containers keep their limit;
- there is **no CPU limit** on agents, and **no limits at all** on the four service
  containers;
- each agent also gets **its own Podman network**, with the orchestrator and homeserver
  attached to it. At high agent counts the number of network attachments is the first
  thing likely to strain.

A practical starting point for a pilot of ~10 agents: 8 vCPU, 32 GiB RAM, 100 GiB disk —
then measure, because real usage depends entirely on how busy the agents are. (The GCP VM
runbook pilots ~5 concurrent agents on an `e2-standard-4` — 4 vCPU / 16 GB / 64 GB disk.)

**Measuring it.** The admin console and the orchestrator each print one `[perf]` line a
minute — request count, client-aborted count, slow count, event-loop delay p50/p99/max
(net of the 20 ms sampling interval, so an idle loop reads ≈0), and the top routes by
total time with n/p50/p90/max — and log a request slower than `AEE_SLOW_REQUEST_MS`
(default `500`) at once as `[perf] slow …`, at most 5 per route per minute (the rest
show as `slow-suppressed=` in the summary). `AEE_PERF_LOG=0` turns both off. All
`[perf]` lines go to stdout: `podman logs admin-console | grep '\[perf\]'` (on Kubernetes:
`kubectl logs deploy/admin-console -n <namespace> | grep '\[perf\]'`).
The chat rail's roster (`GET /api/matrix/agents`) is built once per `AGENT_ROSTER_TTL_MS`
(default `2000`) and shared by every tab and user. A successful roster-affecting console
mutation (create, rename, enable/disable, delete, environment rename, a new DM room)
clears it; changes the orchestrator makes on its own (pool spawn/reap, idle reclaim)
show within one TTL. `AGENT_ROSTER_TTL_MS=0` turns the cache off: every request then
runs its own full, unscoped fleet sweep, which is more work than the pre-#566 per-caller
sweep, so it is a kill switch rather than a faithful "before" baseline.
`/api/agents/statuses` is served stale-while-revalidate (#570): within
`AGENT_STATUSES_TTL_MS` (default `5000`) a poll gets the cached set; after that, up to
`AGENT_STATUSES_MAX_STALE_MS` (default `30000`), it gets the cached set at once while one
rebuild runs in the background. The same console mutations invalidate it: the next poll
still gets the cached set and starts the rebuild. A failed rebuild is not retried for one
`AGENT_STATUSES_TTL_MS` (a poll that has to wait gets the same answer), and a failure
streak logs once when it starts and once when it recovers. `AGENT_STATUSES_TTL_MS=0`
turns it off. The rebuild's orchestrator hop (`/internal/agents/processes`) is one request
at a time, shared by every rebuild, with a hard deadline of `AGENT_PROCESSES_TIMEOUT_MS`
(default `60000`, at or above the orchestrator's observed stall). A rebuild waits at most
`AGENT_PROCESSES_WAIT_MS` (default `3000`) on it and otherwise uses the last good runtime
view: for as long as that request is still running (a slow orchestrator never turns agents
offline), and for `AGENT_PROCESSES_LAST_VIEW_MAX_MS` (default `15000`) after a failed answer.
With no view left, agents read offline. Right after a console restart there is no view yet,
so if the orchestrator takes longer than the wait, agents read offline until its first answer
lands. The trade-off: a lone 5 s poller now sees a status change about one poll later than
before (it gets the previous build while the next one runs). A stopped agent can read running
for up to last-view + max-stale (~45 s) while the orchestrator refuses connections, and up to
last-view + deadline + max-stale (~105 s) while it accepts them but never answers.

---

## C. Hosted Kubernetes / GKE (pilot)

The multi-team target: one central platform, many teams, each isolated. **This is now
implemented and running** — not a plan. The mechanics live in `deploy/k8s/` and are driven
by two runbooks: [`deploy/k8s/README.md`](../deploy/k8s/README.md) (overlay model, release
policy, kind, port map) and [`docs/hosting/gcp/gke-runbook.md`](hosting/gcp/gke-runbook.md)
(bootstrap + incident runbook).

### What exists

- **A container-runtime seam.** `orchestrator/container-runtime.js` selects Podman or
  Kubernetes on `AEE_CONTAINER_RUNTIME` (set to `kubernetes` in the k8s manifests). On k8s the
  orchestrator runs as a pod and creates **one agent Pod per agent** through the Kubernetes
  API with a projected service-account token (`orchestrator/spawn-kubernetes-pod.js`) — no
  host Podman socket. UI-bearing plugins run as **Deployment + Service + state PVC**
  (`spawn-kubernetes-plugin.js`). Filesystem isolation is a subPath on a shared workspace PVC.
- **One manifest source, per-environment overlays.** A kustomize **base** (`deploy/k8s/base/`)
  specialised by thin overlays: `kind` (local), `kind-e2e`, `test`, `preprod`. CI's
  `k8s-render` job asserts the overlay invariants; `set-images.sh` pins the image tag at
  deploy time.
- **Two live GKE environments** on cluster `agent-studio` (`acn-projectroots`,
  `europe-west3-b`): **test** (`agent-studio.projectroots-acn.com`) and **preprod**
  (`agent-studio-preprod.projectroots-acn.com`), each behind an HTTPS ManagedCertificate + IAP.
- **Google SSO via Cloud IAP.** With `IAP_AUDIENCE` set, an IAP-signed JWT (verified ES256
  against Google's keys, `iss`/`aud`/`exp` checked) logs you in as your Google identity — no
  console login form (`admin-console/api/iap-auth.js`). Auto-login applies only to registered
  Agent Studio users; any other IAP account still sees the password form. Sign in with your
  `@accenture.com` account; access is granted via `roles/iap.httpsResourceAccessor`.
- **Deployment automation.** The **deploy-gke** GitHub Actions workflow builds amd64 images,
  pushes an **immutable tag** to Artifact Registry, pins the overlay, and applies the manifests
  (core → Secret check → app). One-time environment bootstrap (Matrix admin, the
  `agent-studio-env` Secret, skill-pool seeding) is `deploy/k8s/gke-up.sh`. The Terraform
  layer (`infra/gcp/`) provisions the cluster, Artifact Registry, static IPs + DNS, and the
  IAP backend.

### Remaining gaps (why it is a "pilot", not "GA multi-tenant")

| Needed | Status today |
|---|---|
| Per-user identity in chat | ✅ each human has their own `@u-…:local` account |
| SSO | ✅ Google Cloud IAP (GKE) — but ❌ no generic OIDC/SAML yet (documented swap-point) |
| Per-request authorization by team role | ✅ management gates on mutations + a uniform-404 work-plane gate; a personal resource tier even a System Admin cannot break-glass into |
| TLS | ✅ ManagedCertificate on GKE ingress (still your own concern on a VM) |
| Kubernetes backend | ✅ agent Pods via the K8s API — no host socket |
| Per-agent network segmentation on k8s | ❌ agent pods share the cluster network; no NetworkPolicy ships |
| Broker plugins on k8s | ❌ per-agent broker reachability is **Podman-only**; UI-only plugins work. `podman-socket` plugins (e.g. `podman-sandbox`) are Podman-only and gated out on k8s |
| Horizontal scaling / multi-node | ⚠️ blocked on RWX storage (#1316); effectively single-node today (adding nodes is not yet the lever) |
| Context host-folder mounts on k8s | ⚠️ node-local, single-node, opt-in (`AEE_K8S_CONTEXT_HOSTPATH=1`); off on GKE |
| Backup / restore | ❌ no tooling — same as the VM path |
| A real Matrix `server_name` | ⚠️ still the literal `local` (compose **and** k8s). Fine while Matrix stays internal — but changing it is a destructive migration: wipe the homeserver DB, re-bootstrap, touch every hardcoded `:local` reference |

**The honest summary:** central hosting is no longer blocked on architecture — the runtime
seam, per-user identity, per-mutation authorization, and IAP SSO are all in. What remains for
true enterprise multi-tenancy is mostly **isolation depth and scale**: per-agent network
policy on k8s, broker plugins on k8s, RWX storage for horizontal scaling, generic OIDC/SAML,
and backup/restore tooling.

Design intent for the identity part is written up in
[multi-user-concept.md](multi-user-concept.md) (read the "Amendments" for what actually
shipped vs. what is still planned).

---

## Which model provider, and where

Independent of where the stack runs, the LLM endpoint is yours to choose: the public
Anthropic API, a LiteLLM proxy, Azure AI Foundry, or an internal corporate gateway —
anything speaking the Anthropic Messages API. Configure it in `.env`, or register it in the
console under **Model Providers**.

For a hosted deployment (B or C), prefer an **API-key** provider. Claude *subscription*
(OAuth) tokens are licensed for the subscription owner's own single-user use, which does not
fit a shared server — the console requires you to confirm this explicitly before creating
such a provider, and server-side one-shot assist calls skip OAuth providers.

See [model-providers.md](model-providers.md).

---

## Related

- [macOS setup](guides/mac-setup.md) · [Windows setup](guides/windows-setup.md) — local install
- [`deploy/k8s/README.md`](../deploy/k8s/README.md) — kind + GKE deployment
- [`docs/hosting/gcp/gke-runbook.md`](hosting/gcp/gke-runbook.md) · [`docs/hosting/gcp/vm-podman-runbook.md`](hosting/gcp/vm-podman-runbook.md) — hosted runbooks
- [credentials.md](credentials.md) — SSH keys and GitHub tokens
- [triggers.md](triggers.md) — the webhook endpoint on port 4003
- [admin-console.md](admin-console.md) — authentication and the audit trail
- [agent-chat-troubleshooting.md](agent-chat-troubleshooting.md) — when an agent stays silent

← Back to the [documentation index](README.md).
