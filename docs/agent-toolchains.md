# Agent toolchains

The default agent image carries Python and Node and **no other language
runtime**. An agent on a Java repository can read it, edit it and open a pull
request against it — but it cannot compile it, and `mvn test` is
`command not found`.

A **toolchain** fixes that: a container image derived from the default agent
image, adding one language stack, selected per **Working Environment**.

This document is the practical half. The reasoning — why per-environment, why a
version manager instead of a pinned JDK, what was considered and rejected — is
in [`agent-toolchains-concept.md`](agent-toolchains-concept.md).

There are two audiences here and they do different jobs:

| You are | You want | Read |
|---|---|---|
| A **project** team whose agent must build your repository | to pick the Java version your build uses | [Pin your project's version](#pin-your-projects-version) |
| A **platform** team maintaining this installation | to add a stack, or to ship the images | [Add a toolchain](#add-a-toolchain) and [Build and install](#build-and-install) |

---

## The one idea

A toolchain image ships a **version manager**, not a version.

Which Java your build runs on is decided by a file **in your repository**, not
by the platform. Change it, commit, and the next agent run uses the new version:
no image rebuild, no registry push, no respawn, no ticket to the platform team.

That is the whole point. A JDK baked into the image would make every JDK patch a
platform release, and would put the platform team in the path of a decision that
belongs to the project.

The runtime is downloaded on first use and cached **inside the agent's own
workspace**, which is a volume and survives a respawn — unlike the container
filesystem, which does not. Two agents on two repositories pinning two different
Java versions therefore never touch each other's cache.

---

## Pin your project's version

*For the team that owns the repository. You need no platform access for this.*

Commit a `.mise.toml` at the root of your repository:

```toml
[tools]
java  = "temurin-21"
maven = "3.9"
```

That is it. The agent's `mvn`, `java` and `javac` resolve to exactly those
versions, from that directory downward.

```
$ mvn -version
Apache Maven 3.9.x
Java version: 21.x.x, vendor: Eclipse Adoptium
```

**Pin exactly.** `java = "temurin-21"` is a moving target within 21; if your
build is sensitive to the patch level, write `temurin-21.0.5+11`. The value of
committing the pin is that your repository's history records which version
applied when — a floating value throws that away.

**Upgrading Java is a commit:**

```bash
sed -i 's/temurin-21/temurin-25/' .mise.toml
git commit -am "build: move to Java 25"
git push
```

The next agent run picks it up. Nothing is rebuilt and nothing is redeployed.

### What counts as a pin

The first of these found walking **up** from the current directory wins:

`.mise.toml` · `mise.toml` · `.config/mise/config.toml` · `.tool-versions`

A monorepo can therefore pin per module, and a module without its own file
inherits the repository root's.

### If you pin nothing

You get the image's **baseline** — currently **Java 21 (Temurin) + Maven 3.9**.
This is deliberate: an unpinned repository builds immediately and pays no
download.

It is a convenience, not a contract. The baseline is the one version that lives
inside the image, so it moves when the image moves. **Pin if the version
matters to you**, which for a real build it does.

If you committed an `.sdkmanrc` or a `.java-version` instead, the agent does not
silently ignore it — it tells you those files were found and that this toolchain
reads the list above.

### Checking what resolved

Every variant ships `aee-toolchain`:

```bash
aee-toolchain doctor          # what resolves, and from which file
aee-toolchain install         # pre-fetch this project's pin (warms the cache)
aee-toolchain run ./mvnw test # run a wrapper script with the toolchain in scope
```

`aee-toolchain doctor` is the first thing to run when a build behaves as if it
is on the wrong version — it prints the pin file it used, the cache directory
and the resolved path of every tool.

### Wrapper scripts

`mvn`, `java`, `javac`, `jar`, `jshell` and `javap` are on `PATH` directly, so
plain `mvn test` works. A repository's own `./mvnw` or `./gradlew` is not on
`PATH` — run those through `aee-toolchain run ./mvnw test`, which puts the
resolved toolchain in scope first.

---

## Locked-down networks

*An agent that can compile but cannot fetch is not a working toolchain.*

Two different things need to reach the network, and they are configured
separately.

### 1. Your build's dependencies (Maven / Nexus)

Maven's local repository is redirected into the agent's workspace at
`<workspace>/.aee-toolchain/m2/repository`, so a respawn does not re-download
your whole dependency tree.

To point Maven at an internal Nexus, drop a `settings.xml` at:

```
<workspace>/.aee-toolchain/m2/settings.xml
```

It is picked up automatically on every `mvn` invocation, including through
`aee-toolchain run ./mvnw`. Put it there with the **Workspace browser** in the
agent's chat, or through a read-write [host context folder](context-mount.md).

```xml
<settings>
  <mirrors>
    <mirror>
      <id>nexus</id>
      <mirrorOf>*</mirrorOf>
      <url>https://nexus.internal/repository/maven-public/</url>
    </mirror>
  </mirrors>
</settings>
```

`GRADLE_USER_HOME` is redirected into the same tree, so a Gradle
`init.gradle` belongs at `<workspace>/.aee-toolchain/gradle/init.d/`.

### 2. The version manager's own downloads (the JDK itself)

`mise` fetches the JDK and Maven over HTTPS on first use. In a network that
requires a proxy, set the standard variables **on the orchestrator service** —
the agent container inherits the orchestrator's environment, so this reaches
every agent at once:

| Where | How |
|---|---|
| Compose / local | `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` in `.env` |
| Kubernetes | the same keys in the `agent-studio-env` Secret |

If nothing may be fetched at runtime at all, a proxy does not help you and you
want the [airgap exception](#the-airgap-exception) instead.

**Verify before you trust it.** `aee-toolchain install` in an agent chat is the
cheap end-to-end check: it exercises exactly the download path a real build
would, and fails loudly rather than at the first `mvn` three hours later.

---

## Add a toolchain

*For the platform team. Adding a stack is one Dockerfile and one manifest.*

Create `toolchains/<id>/` with two files.

### `toolchain.json`

```json
{
  "toolchainVersion": 1,
  "id": "jvm",
  "name": "JVM — Java + Maven (version pinned by the project)",
  "stack": "jvm",
  "description": "Lets an agent build and test a Java project... (plain language — this is what the System Admin reads before installing)",
  "image": "as-agent-jvm:latest",
  "platforms": ["podman", "kubernetes"],
  "versionSource": "bootstrap",
  "versionManager": "mise",
  "baseline": "java temurin-21, maven 3.9"
}
```

| Field | Meaning |
|---|---|
| `id` | Directory name and registry key. Must match the directory. |
| `name` | Shown in the Toolchains panel and the environment's Toolchain select. |
| `description` | **Required.** Plain language, no jargon — an unexplained image is not installable in good faith. |
| `image` | The **bare** `repo:tag` the build produces. Never a registry path — see [Where the image lives](#where-the-image-lives). |
| `platforms` | `["podman"]` or `["podman","kubernetes"]`. An image that only exists on a developer machine must not be offerable on GKE. |
| `versionSource` | `bootstrap` (the project pins the version) or `baked` (fixed in the image — the airgap exception). |
| `versionManager` | Required for `bootstrap`, forbidden for `baked`. |
| `baseline` | The version an unpinned repository gets, if the variant ships one. |

Validation is `validateToolchainManifest` in
`orchestrator/toolchain-registry.js` (byte-identical at
`admin-console/api/toolchain-registry.js`), unit-tested under `node --test`.

### `Dockerfile`

**It must start `FROM` the published agent image.** A variant may only *add*
layers — never re-implement the base:

```dockerfile
ARG AGENT_BASE_IMAGE=as-agent:latest
FROM ${AGENT_BASE_IMAGE}
# ... your layer ...
```

The build context is `toolchains/`, not `toolchains/<id>/`, because every
variant `COPY`s the shared bootstrap from `_shared/` and a build context cannot
reach a sibling directory.

This is not a style rule. The base carries a pinned Claude Code CLI, the
entrypoint, four platform CLIs and the `/opt/aee/plugin-bin` `PATH` hook that
makes granted plugin CLIs runnable. A variant that forks any of that builds
perfectly cleanly and then fails at **runtime**, as "command not found" for
something the agent's own `CLAUDE.md` told it to use — hours later, in an
unattended run.

So it is enforced. `toolchains/_shared/base-contract-check.sh` runs against
every built variant in CI and on the release path, and fails the build when the
entrypoint, `/opt/ace/scripts`, `/opt/ace/CLAUDE.md`, the `plugin-bin` `PATH`
entry, the four CLIs (`gh-as-agent`, `knowledge`, `aee-artifact`, `usage`) or
`git`/`gh`/`node`/`python3` have drifted.

### Wiring the version manager

Nothing in the shared bootstrap is Java-specific. A variant declares its stack
in a `toolchain.env` next to the Dockerfile:

```sh
AEE_TOOLCHAIN_ID=jvm
AEE_TOOLCHAIN_PIN_FILES=".mise.toml mise.toml .config/mise/config.toml .tool-versions"
AEE_TOOLCHAIN_SHIMS="java javac jar jshell javap mvn"
AEE_TOOLCHAIN_ALT_PINS=".sdkmanrc .java-version"
AEE_TOOLCHAIN_BASELINE="java temurin-21, maven 3.9"
```

and an optional `cache-env.sh`, sourced once the workspace root is known, to
redirect that stack's *own* caches into the workspace (for the JVM: Maven's
local repository and `GRADLE_USER_HOME`).

The next stack is therefore that pair plus a Dockerfile — no change to
`aee-toolchain`, to the Makefile, to CI or to the deploy workflow, all of which
discover variants by globbing `toolchains/*/`.

### Why `mise` and not `sdkman`

`sdkman` is a set of bash functions that must be sourced from a **login
shell's** init file. The agent's shell calls come from the Claude CLI as
non-interactive, non-login `sh -c` invocations — the one caller that sources
nothing. `mise` is a single static binary that resolves versions from the
current directory's config with no shell integration at all, and it manages
Java *and* Maven (and Node, Go, Python for later variants) in one tool.

---

## Build and install

Building an image and making it selectable are two separate acts, exactly as
with plugins.

```bash
make toolchain-images   # build every variant under toolchains/*/ and check the base contract
make seed-toolchains    # put the manifests in the pool so the console can offer them
```

`make toolchain-images` is **not** chained into `make up`, and — deliberately
diverging from the `plugin-images` precedent — **not** into `make build`
either. A broker image is a few MB and any installation that installs a plugin
needs it; a toolchain variant downloads a JDK and is only needed by
installations that actually register one. Run it explicitly.

Then, in the console, on **Working Environments → Toolchains** (System Admin
only):

1. **Available to install** lists the variants this repository ships, each with
   its description and its version story. **Install** registers it — the image
   reference comes from the manifest, so nobody retypes it.
2. Set **Toolchain** on a Working Environment. Its agents are now spawned from
   that image; every other environment keeps the default.

Registering grants nothing on its own, and only a System Admin may register:
an agent container receives its environment's SSH key, GitHub token and model
credential, so whoever picks the image picks what runs with those secrets.

**Changing an environment's toolchain respawns its running agents.** A
container's image is fixed for its lifetime, so there is no other way; the
console warns first. Pick a quiet moment.

The hand-registration form next to it stays for images this repository does not
ship. Both doors end at the same validator.

### Where the image lives

A manifest declares the bare tag its build produces (`as-agent-jvm:latest`) —
what `make toolchain-images` leaves in a developer's local image store, and what
a kind node has side-loaded. It deliberately names **no registry**: a
checked-in manifest has to serve every installation, and cannot know where a
given one pushed its images.

The deployment supplies the rest, as two environment variables on both the
orchestrator and the admin-console:

| Variable | Local / kind | Hosted (GKE) |
|---|---|---|
| `AEE_TOOLCHAIN_IMAGE_PREFIX` | empty | the Artifact Registry path |
| `AEE_TOOLCHAIN_IMAGE_TAG` | empty | the release tag, pinned by `set-images.sh` |

The two are joined onto the manifest's tag **at spawn time**, not baked into the
registry entry at install time — so a release that re-pins the tag reaches a
toolchain that was installed long before it, with no operator re-install. An
image reference that already carries a registry host or a digest (the
hand-registration path) is never rewritten.

`deploy/k8s/render-check.sh` asserts both halves, so a release cannot ship a
manifest referencing a tag nobody pushed.

---

## The airgap exception

Everything above assumes the agent can fetch a runtime once. In an installation
where nothing may be fetched at runtime, it cannot.

For that case a variant may set `"versionSource": "baked"` and install a fixed
runtime into the image. The version axis then collapses back into the image
**on purpose**: every version change becomes a platform release — build,
registry push, render check, and a respawn of every affected environment.

This is a deliberate trade for a constrained installation. It is not the
default, it is not the shape of the shipped `jvm` variant, and it should be
chosen because the network forbids the alternative, not because it is simpler.
The Toolchains panel states which of the two a variant is, before you install
it, for exactly this reason.

---

## Decision guide

Before reaching for a toolchain at all:

| Situation | Path |
|---|---|
| Stack used by several teams, versions differ per project | Bootstrap image + repo-pinned version — the default |
| Airgapped installation, nothing may be fetched at runtime | Baked-in variant with a pinned runtime |
| One-off exotic stack, one team, no image maintainer | Version manager alone, no new image |
| The agent only needs pass/fail | **No toolchain** — the agent reads the CI result |
| Untrusted code, real isolation required | A separate build-runner plugin — its own decision |

The fourth row is the cheapest answer and the easiest to forget: if an agent
only needs to know whether the build is green, it does not need a toolchain at
all. That is how this repository's own agents work.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `mvn: command not found` | The environment has no toolchain selected, or the agent was spawned before you set it (an image is fixed for a container's lifetime — respawn it). |
| `no toolchain version pinned` | The repository has no `.mise.toml` and the variant ships no baseline. Commit a pin. |
| Wrong Java version | Run `aee-toolchain doctor`; it names the pin file it actually used. A closer `.mise.toml` in a subdirectory wins. |
| First build very slow, later ones fast | Expected — the cold run downloads the JDK; it is then cached in the workspace and survives respawns. |
| Slow again after a respawn | The cache lives in the agent's workspace. Check that workspace isolation is on and the volume was not recreated. |
| Download hangs or fails | No route to the internet. See [Locked-down networks](#locked-down-networks). |
| Toolchain not offered on the environment | Its manifest declares `platforms` that exclude this installation's runtime — the panel says so on the row. |
| Agent refuses to spawn, naming the toolchain | Deliberate: an unhonourable selection never falls back silently to the default image, because that would boot a build agent without its toolchain and fail confusingly at the first `mvn`. |

## See also

- [`agent-toolchains-concept.md`](agent-toolchains-concept.md) — why it is
  shaped this way, and what was rejected
- [`working-environments.md`](working-environments.md) — where a toolchain is
  selected
- [`context-mount.md`](context-mount.md) — getting a `settings.xml` into a
  workspace from the host
