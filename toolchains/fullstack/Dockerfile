# ---- as-agent-fullstack: the Java + Node toolchain variant (#1941) ----
#
# DERIVE, NEVER FORK (AC2). This starts FROM the published agent image, so the
# base contract — the pinned Claude Code CLI, the entrypoint, the four platform
# CLIs, the /opt/aee/plugin-bin PATH hook — is inherited rather than restated.
# A variant may only ADD layers; `toolchains/_shared/base-contract-check.sh`
# runs in CI and fails the build if any of that drifted.
#
# A BOOTSTRAP, NOT A VERSION (concept docs/agent-toolchains-concept.md §5).
# What this layer adds is a version MANAGER plus one baseline of each runtime.
# The versions an agent actually builds with come from the project repository's
# committed `.mise.toml`, cached under the agent's workspace volume — so a JDK
# or Node update is a commit in that repository and needs no image build, no
# registry push and no respawn.
#
# This is the `jvm` variant plus Node: the base already ships Node 20, but this
# image lets a repository pin the EXACT Node it wants (e.g. 22) the same way it
# pins Java, resolved per project through mise. Docker/container work is NOT
# added here — a toolchain only selects the image, it cannot grant a privileged
# container or a Docker socket; that is the podman-sandbox plugin's job.
#
# BUILD CONTEXT is `toolchains/`, not `toolchains/fullstack/`, because the
# bootstrap script is shared by every variant (a build context cannot reach a
# sibling directory) — the same reason the plugin brokers build from the
# repository root. Built by `make toolchain-images`.
ARG AGENT_BASE_IMAGE=as-agent:latest
FROM ${AGENT_BASE_IMAGE}

# Pinned for reproducible builds, exactly like the base's CLAUDE_CODE_VERSION.
# WHY mise AND NOT sdkman/nvm (AC5): those are sets of shell functions that must
# be sourced from a login shell's init file, and the agent's shell calls come
# from the Claude CLI as non-interactive, non-login `sh -c` — the one caller
# that never sources anything. mise is a single static binary that resolves
# versions from the current directory's config with no shell integration at all,
# and it manages Java, Node AND Maven in one tool, so nothing here is
# language-specific machinery.
ARG MISE_VERSION=2025.1.9
ARG BASELINE_JAVA=temurin-21
ARG BASELINE_NODE=22
ARG BASELINE_MAVEN=3.9

# ── extra developer CLIs (add-only OS layer) ────────────────────────────────
# git-delta (nicer diffs an agent can read), jq (JSON on the command line) and
# fzf — the three from the reference dev container that are genuinely useful to
# a headless agent. `--no-install-recommends` + apt-list cleanup follow the
# base's layer discipline (AC12); nothing else is pulled in. Editors, shells and
# the devcontainer firewall are deliberately NOT added — the agent runs `sh -c`,
# never an interactive session, so they are pure weight.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git-delta jq fzf; \
    rm -rf /var/lib/apt/lists/*

# ── the version manager ─────────────────────────────────────────────────────
# Installed from the pinned GitHub release rather than `curl https://mise.run |
# sh`, so the build states which artifact it takes; cache removal follows the
# base's layer discipline (AC12) — nothing but the binary is left behind.
RUN set -eux; \
    mkdir -p /opt/aee/toolchain/bin; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) march=x64 ;; \
      arm64) march=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${march}.tar.gz" \
      -o /tmp/mise.tar.gz; \
    tar -xzf /tmp/mise.tar.gz -C /tmp; \
    install -m 0755 /tmp/mise/bin/mise /opt/aee/toolchain/bin/mise; \
    rm -rf /tmp/mise /tmp/mise.tar.gz; \
    /opt/aee/toolchain/bin/mise --version

# ── the bootstrap + this variant's configuration ────────────────────────────
COPY _shared/aee-toolchain /opt/aee/toolchain/bin/aee-toolchain
COPY fullstack/toolchain.env /opt/aee/toolchain/toolchain.env
COPY fullstack/cache-env.sh /opt/aee/toolchain/cache-env.sh

# The shims. A FIXED directory on PATH plus one symlink per tool, because the
# per-agent workspace path is not known at build time and setting PATH on the
# container would REPLACE the image's own PATH (the reasoning the base states at
# its plugin-bin hook, applied here). `mise` itself is shimmed too, so an
# operator running `mise ls` over `podman exec` sees the same resolution the
# agent gets instead of an empty default profile.
RUN set -eux; \
    chmod 0755 /opt/aee/toolchain/bin/aee-toolchain; \
    ln -sf /opt/aee/toolchain/bin/aee-toolchain /usr/local/bin/aee-toolchain; \
    mkdir -p /opt/aee/toolchain-bin; \
    . /opt/aee/toolchain/toolchain.env; \
    for tool in $AEE_TOOLCHAIN_SHIMS mise; do \
      ln -sf /opt/aee/toolchain/bin/aee-toolchain "/opt/aee/toolchain-bin/$tool"; \
    done
ENV PATH="${PATH}:/opt/aee/toolchain-bin"

# ── the baseline runtimes ───────────────────────────────────────────────────
# "The versions you get if you do not pin" (AC9). Installed into an IMAGE-side
# data dir, read-only at runtime and shared by every agent on this image, so an
# unpinned repository builds immediately and pays no download. A pinned
# repository never reads this dir — it resolves entirely from its own workspace
# cache, which is what keeps two projects on two versions from interfering
# (AC7). This is the one set of versions inside the image, and it is the stated
# cost of shipping a baseline at all.
RUN set -eux; \
    mkdir -p /opt/aee/toolchain/baseline; \
    printf '[tools]\njava = "%s"\nnode = "%s"\nmaven = "%s"\n' \
      "$BASELINE_JAVA" "$BASELINE_NODE" "$BASELINE_MAVEN" \
      > /opt/aee/toolchain/baseline/config.toml; \
    MISE_YES=1 \
    MISE_DATA_DIR=/opt/aee/toolchain/baseline \
    MISE_CACHE_DIR=/tmp/mise-build-cache \
    MISE_STATE_DIR=/tmp/mise-build-state \
    MISE_GLOBAL_CONFIG_FILE=/opt/aee/toolchain/baseline/config.toml \
      /opt/aee/toolchain/bin/mise install; \
    rm -rf /tmp/mise-build-cache /tmp/mise-build-state /root/.cache/mise

# Advertised to the runtime so the agent's generated context can mention the
# toolchain without the orchestrator having to inspect the image.
ENV AEE_TOOLCHAIN_ID=fullstack
