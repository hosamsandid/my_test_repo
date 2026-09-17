# Agent toolchains — running language stacks inside an agent container

> Status: concept — proposed 2026-09-02. Epic #1939; children #1940 (image
> selectable per Working Environment) and #1941 (toolchain registry + first
> JVM variant).
> Decision: an agent's language stack is decided along **three separate
> axes** — the *mechanism* (which image an agent is spawned from, per Working
> Environment, from an operator-curated registry), the *stack* (one derived
> image per language ecosystem), and the *version* (pinned in the project
> repository, provisioned into the workspace at runtime — **not** baked into
> the image). Baking a fixed runtime stays supported as the airgap exception.
> Rejected: a global `AGENT_IMAGE` flag day, a free-text image field, runtime
> `apt install`, and using the `podman-sandbox` plugin as a build runner (§7).

## 1. Problem

An agent that is supposed to *develop* software has to be able to build it:
compile, run, run unit tests. The concrete request was Java + Maven. Java is
only the first stack — .NET, Go, Python with native dependencies and mixed
stacks follow the same shape.

Today an agent cannot do any of that, and the reason is structural rather
than accidental:

| Question | Current answer |
|---|---|
| How many agent images exist? | Exactly one: `as-agent:latest` — Python 3.12, Node 20, `git`/`curl`/`openssh`/`gh`, the pinned Claude Code CLI and the four platform CLIs (`agent-image/Dockerfile`). No JDK, no Maven, no other language runtime. |
| Can an operator select a different image? | No. A Working Environment has no image field (`admin-console/api/api.js`, environment create/update), and neither has an agent config. |
| Is there any override? | Only the process-wide `AGENT_IMAGE` env var (`orchestrator/spawn-container.js`, `orchestrator/spawn-kubernetes-pod.js`), which applies to **every** agent of the installation. The k8s overlays set it; `docker-compose.yml` does not, so the compose path always runs the hardcoded default. |
| Can software be installed at runtime? | There is no hook — no postCreate script, no apt/pip step in `agent-image/scripts/agent-entrypoint.py`. Everything is baked at build time. |

Three properties of the existing design carry everything below:

1. **The image is already layered.** `agent-image/Dockerfile` builds
   `aee-base` and then `aee-agent` with the explicit comment *"Tier 1 target
   (no additional layers)"*. A toolchain variant is an added layer, not a
   fork of the base.
2. **The agent container has outbound network.** The per-agent network is
   created with `dns_enabled: true` and without the `internal` flag
   (`orchestrator/spawn-container.js`) — it must, since agents clone from
   GitHub and reach the model endpoint. So a toolchain *can* be fetched at
   runtime.
3. **The container filesystem is ephemeral; the workspace volume is not.**
   Every respawn recreates the container, so anything installed into the
   container root at runtime is lost. The per-agent workspace is a SubPath
   mount of the pool volume and survives. This single asymmetry decides
   *where* a runtime-provisioned toolchain has to live — and it is why a
   runtime `apt install` is a dead end rather than a shortcut.

## 2. The three axes

The mistake to avoid is treating "give agents Java" as one problem. It is
three, with different owners and different cadences:

| Axis | Question | Owner | Changes |
|---|---|---|---|
| **Mechanism** | Which image is this agent spawned from? | Platform | Once |
| **Stack** | Which language ecosystem is available? | Platform team, per stack | Rarely — one Dockerfile per ecosystem |
| **Version** | Which JDK / Node / Go version exactly? | The **project** | Constantly — patches, majors, per-project divergence |

Collapsing *version* into *stack* is what makes toolchain support expensive:
the image set becomes N stacks × M versions, and every JDK patch turns into
a platform release (build → registry push → deploy check → respawn), with
the platform team standing in the path of a decision that belongs to the
project team.

## 3. Mechanism — image selectable per Working Environment

*(Child #1940 — **shipped**. The registry store, the environment field, the
seam change, label-based eviction and respawn-on-change are live; the pure
decision core is `orchestrator/toolchain-registry.js` ⇄ its byte-identical
admin-console twin. No toolchain image ships with it — see §4/#1941.)*

A Working Environment names a **toolchain**; agents bound to it are spawned
from that toolchain's image. Everything else keeps using `AGENT_IMAGE` /
`as-agent:latest`, byte-identically.

The image is threaded through the `orchestrator/container-runtime.js` seam —
which today carries no image at all, so its spawn signature widens — into
both implementations (`spawn-container.js`, `spawn-kubernetes-pod.js`).

**Why the Working Environment and not the agent:** the environment is
already the platform's "infrastructure template" — repositories,
credentials, MCP references, model provider. A repository's build stack is
an infrastructure property of that kind, and it is decided per repository,
not per role. The cost is stated openly: two teams working the same
repository with different toolchains need two environments. Per-agent
selection remains possible later; the seam change is the prerequisite either
way (§8, open question 1).

**Not a free-text image field.** `startAgentProcess` injects the
environment's SSH identity, its GitHub PAT and the model credential into
every agent container. Whoever chooses the image chooses what executes with
those secrets. The authorisation split therefore copies the plugin registry
rather than inventing a second model:

* a **System Admin installs** a toolchain into the operator registry — the
  same two-volume move as promoting a skill to global, and the same
  plain-language review before the confirm;
* a **Team Admin selects** from what is installed, and can do nothing else;
* the client sends an **id**, never an image reference; the server resolves
  it.

Two consequences that are easy to miss and are therefore acceptance
criteria on #1940:

* **A spawn-time image is immutable for the container's lifetime**, so
  changing an environment's toolchain has to respawn its running agents —
  the mechanism that already exists for a rotated `githubTokenId`. That
  interrupts in-flight work, so the console has to say so.
* **`evictStaleAgentContainers` currently filters by image ancestor**
  (`{ ancestor: [AGENT_IMAGE] }` in `orchestrator/orchestrator.js`). The
  moment agents run from variant images, orphaned containers become
  invisible to that sweep and are left running. Eviction has to key on the
  platform's own `aee.agent.id` label instead.

## 4. Stack — a toolchain registry of derived images

*(Child #1941 — **shipped**. The `toolchains/<id>/` source tree, `make
toolchain-images` / `make seed-toolchains`, the per-variant base-contract smoke
test and the first JVM bootstrap variant are live; `validateToolchainManifest`
governs the manifest and `resolveToolchainImage` joins the deployment's prefix +
release tag onto it at spawn time. Operator + project guide:
`docs/agent-toolchains.md`.)*

```
toolchains/<id>/toolchain.json    # id, name, description, image tag, platforms
toolchains/<id>/Dockerfile        # FROM as-agent:latest → + the stack's bootstrap
```

built by `make toolchain-images`, modelled on the existing `make
plugin-images` target, and installed/selected through the flow of §3.
Adding a stack is one Dockerfile plus one manifest — **no platform code**.

Two rules keep that promise:

* **Derive, never fork** (`FROM as-agent:latest`). A variant may only add
  layers.
* **A base-contract smoke test per variant**, run in CI: the entrypoint is
  `/opt/ace/scripts/agent-entrypoint.py`, `/opt/ace/scripts` and
  `/opt/ace/CLAUDE.md` exist, `PATH` contains `/opt/aee/plugin-bin`, and all
  four platform CLIs resolve (`gh-as-agent`, `knowledge`, `aee-artifact`,
  `usage`). Without this test, "derive, never fork" is a hope: a variant
  that drops the plugin-bin `PATH` hook or shadows a CLI builds cleanly and
  fails at runtime as *command not found* for something the agent's own
  CLAUDE.md instructed it to use.

`platforms` in the manifest is not decoration: a `localhost/…` tag that only
exists in a developer's image store must not be offerable on GKE. Same field,
same purpose as in a plugin manifest.

**One image per stack; combinations only on real demand.** Java+Node is a
further layer, not a new mechanism — but pre-building every combination is
the matrix explosion this concept exists to avoid.

## 5. Version — pinned in the project repository

*(Shipped with #1941. The JVM variant carries **mise** as its version manager
(not `sdkman`, which needs a login shell the agent's `sh -c` calls never are);
the project repository pins via a committed `.mise.toml`, and a repository that
pinned for a different manager (`.sdkmanrc` / `.java-version`) is told so by
name. See `docs/agent-toolchains.md`.)*

The image carries the **bootstrap**, not the version:

* a version manager (`mise` / `sdkman`) and, optionally, one baseline
  runtime so a cold start is fast and a pin-less repository still works;
* the **project repository declares the version** — `.mise.toml` /
  `.sdkmanrc`, exactly pinned and committed;
* the toolchain **cache lives under the workspace volume**, so it survives a
  respawn (§1, property 3).

What this buys:

* **A version update is a commit**, not a platform release. No image build,
  no registry push, no deploy check, no platform-triggered respawn.
* **Two projects can sit on different versions** of the same stack at the
  same time, on one image.
* **It is more reproducible than a floating image tag.** With a baked
  runtime behind `…:latest`, agents move to a new JDK silently on their next
  respawn — right for a security patch, wrong for reproducibility, and
  invisible either way. A committed pin has a history: which version applied
  when is answerable.

What it costs, stated rather than glossed:

* the **first run downloads** the toolchain (minutes);
* a locked-down customer network needs **proxy/mirror configuration** — for
  the version manager's downloads *and* for Maven dependencies; the second
  is required regardless of which path is chosen, so this is one question,
  not a new one;
* without root, only **user-space toolchains** work. That covers
  JDK/Maven/Node/Go. It does not cover natively-compiled Python wheels or
  anything that genuinely needs `apt`.

A further detail that matters in practice: the bootstrap has to be on `PATH`
for **non-interactive, non-login** shells, because the agent's shell calls
come from the Claude CLI. The platform already solved the equivalent problem
for plugin CLIs — a fixed directory on `PATH` plus a per-agent symlink — and
the comment at that hook in `agent-image/Dockerfile` explains why mutating
`os.environ` in the entrypoint is not sufficient (it is invisible to
`podman exec`, so an operator debugging the agent sees a missing command
that is in fact installed). The same reasoning applies here.

**The airgap exception.** Where nothing may be fetched at runtime, a variant
with a fixed, baked runtime (`toolchains/jvm-21-offline/` in shape) is the
correct answer, and the version axis collapses back into the image on
purpose. This is a deliberate choice for a constrained installation — not
the default, and not the shape of the first variant.

## 6. Decision guide

| Situation | Path |
|---|---|
| Stack used by several teams, versions differ per project | Bootstrap image (§4) + repo-pinned version (§5) |
| Airgapped installation, nothing may be fetched at runtime | Baked-in variant with a pinned runtime (§5, exception) |
| One-off exotic stack, one team, no image maintainer | Version manager alone, no new image |
| The agent only needs pass/fail | CI-first — no toolchain; the agent reads the Actions result |
| Untrusted code, real isolation required | A separate build-runner plugin (§7.4) — its own decision |

The fourth row deserves emphasis, because it is the cheapest answer and the
easiest to forget: if an agent only needs to know whether the build is green,
it does not need a toolchain at all. That is how this repository's own agents
work today.

## 7. Alternatives considered and rejected

### 7.1 Repoint `AGENT_IMAGE` globally

The only mechanism that exists today. Moves *every* agent of the installation
onto the new image, so a JVM toolchain for one team drags along every other
team's agents, and image growth is paid by everyone. On the compose path it
degenerates further: `docker-compose.yml` never sets the variable, so the
only lever is rebuilding the `as-agent:latest` tag itself. Rejected as an
operating model; kept as the installation-wide default (§3).

### 7.2 A free-text image field on the environment

Superficially the flexible option, in reality a privilege-escalation path: an
agent container receives the environment's SSH key, GitHub PAT and model
credential, so a Team Admin who can type an image reference can run arbitrary
code with those secrets. Rejected in favour of the curated registry (§3).

### 7.3 Install the toolchain at runtime with `apt`

Fails on §1 property 3: the container filesystem is recreated on every
respawn, so the installation is lost and silently re-run — slow, and
non-reproducible in the worst way (whatever the distribution mirror serves
that day). Also needs root. The workspace-level variant of the same idea
(§5) is the survivable form of it.

### 7.4 Let the `podman-sandbox` plugin run the build

Tempting, since plugin #1 already spawns containers on the agent's behalf.
It does not work, and the reasons are deliberate hardening rather than gaps:

* its broker **rejects host bind mounts and external/pre-existing volumes**
  (`plugins/podman-sandbox/broker/compose-validate.js`), so the agent's
  workspace code cannot get into a sandbox container in the first place;
* it forces **`internal: true` on every network**
  (`plugins/podman-sandbox/broker/compose-harden.js`), so there is no
  outbound route and no dependency download;
* it is Podman-only, quota-capped, and defaults each container to 512 MB /
  1 CPU.

Both restrictions exist because a security test round demonstrated real
escapes through them. Turning the sandbox into a build runner means loosening
exactly those two controls, which is a separate, larger decision — the right
one for *untrusted* code, and disproportionate for building your own
repository. Out of scope here; noted as §6's last row.

### 7.5 Build the image on demand from a declared feature list

Devcontainer-style: the environment declares `toolchains: ["java-21"]` and
the platform builds and caches an image. Most flexible, and by far the most
infrastructure — an in-platform build service, a cache, and on Kubernetes a
build path without a Podman socket (Kaniko/BuildKit). The §4+§5 split gets
most of the benefit for a fraction of the machinery. Not pursued.

## 8. Open questions

1. **Environment or agent** as the place where the toolchain is selected.
   §3 argues for the environment; per-agent is more granular but puts an
   infrastructure concern on the construct that otherwise carries role and
   prompt. The seam change is the same either way.
2. **Where the version manager's cache root lives** — under the agent's own
   workspace (isolated, downloaded once per agent) or on a shared pool
   volume (downloaded once per installation, but a new cross-agent shared
   write surface). The isolation model currently gives every agent its own
   SubPath mount, so a shared cache is a deliberate exception that needs its
   own justification.
3. **Whether the bootstrap image ships a baseline runtime at all.** A
   baseline is friendlier (fast cold start, a pin-less repository still
   builds) but re-introduces a version inside the image that somebody will
   eventually have to update — a small dose of the very problem §5 removes.
   Current inclination: ship one, and document it as *the version you get if
   you do not pin*.
4. **Digest or floating tag** for a variant's `FROM`. A digest makes the
   variant reproducible but forces a re-pin of every variant on each base
   rebuild (for example a Claude CLI version bump) — the n-copies
   maintenance cost §4's rules exist to avoid. Current inclination: floating
   tag plus the base-contract smoke test as the guard.

## 9. Sequencing

| Step | Ticket | Content |
|---|---|---|
| 1 | #1940 | Mechanism: image selectable per Working Environment, curated registry, System-Admin gated, label-based eviction, respawn on change |
| 2 | #1941 | Registry (`toolchains/<id>/`), `make toolchain-images`, base-contract smoke test, JVM bootstrap variant, demonstrated version-update path |
| 3 | #2282 Band 1 | Optional `resources: {memoryLimit, memoryRequest, cpuRequest}` on the manifest, sized at spawn time into both spawners' memory limit/requests (podman `resource_limits`, k8s pod `resources`); `fullstack`/`jvm` raised to `4g` and given JVM/Gradle/Maven `MaxRAMPercentage`/`workers.max` caps, since neither JVM-based variant fit the `2g`/`2Gi` fleet default under a Gradle build (docs/agent-toolchains.md field table) |
| later | — | Further stacks (one Dockerfile each), the airgap variant when an airgapped installation demands it, a build-runner plugin if untrusted builds ever become a requirement |

#1940 lands first: #1941 has nothing to be selected *by* without it.
