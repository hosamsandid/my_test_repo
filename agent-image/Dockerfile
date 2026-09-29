# ---- aee-base: Agent Execution Environment runtime ----
# Python 3.12 + Node 20 + Claude Code CLI.
# Used by all three container tiers (bind, clone, image).
#
# The base image is digest-pinned (supply-chain hardening, #2458): the tag stays
# for readability while the @sha256 pins the exact multi-arch index, so a
# re-pointed or altered upstream `python:3.12-slim` can never be adopted silently
# on the next build. To intentionally bump it (e.g. a new Python patch or a
# security fix), resolve the new digest and replace it below:
#   docker buildx imagetools inspect python:3.12-slim   # copy the top-level Digest
# (or `docker pull python:3.12-slim` then `docker inspect --format '{{index .RepoDigests 0}}'`).
# Same pattern for the digest-pinned toolchain variants and the SHA-pinned GitHub
# Actions in .github/workflows/*.yml — see docs/supply-chain-pins.md.
FROM python:3.14-slim@sha256:caaf356f40667c496d405780745b9ac25771c189a51dfcc42430d531ea09f8a2 AS aee-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git curl ca-certificates openssh-client gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI. The baked-in CLAUDE.md instructs agents to use `gh issue view`
# and `gh pr create`, and the orchestrator injects GH_TOKEN / GITHUB_TOKEN into
# every agent container — but without the binary those commands fail and agents
# fall back to hand-rolled HTTPS pushes. Installed from the official apt repo so
# `gh` authenticates non-interactively via $GH_TOKEN.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Route github.com SSH via ssh.github.com:443 — same fix as the orchestrator
# image so agents that clone or push via SSH work on corporate networks that
# block outbound TCP 22.
RUN mkdir -p /root/.ssh \
  && { \
       echo 'Host github.com'; \
       echo '  HostName ssh.github.com'; \
       echo '  Port 443'; \
       echo '  User git'; \
       echo '  StrictHostKeyChecking accept-new'; \
       echo ''; \
       echo 'Host *.github.com'; \
       echo '  HostName ssh.github.com'; \
       echo '  Port 443'; \
       echo '  User git'; \
       echo '  StrictHostKeyChecking accept-new'; \
     } > /root/.ssh/config \
  && chmod 600 /root/.ssh/config

# Pin Claude Code CLI version for reproducible builds.
ARG CLAUDE_CODE_VERSION=2.1.212
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Python deps for the in-container Matrix DM listener (P4).
COPY requirements.txt /opt/ace/requirements.txt
RUN pip install --no-cache-dir -r /opt/ace/requirements.txt

# Copy the agent scripts (entrypoint + supporting CLIs).
COPY scripts/ /opt/ace/scripts/
COPY CLAUDE.md /opt/ace/CLAUDE.md

# Fake `claude` shim for end-to-end tests (#666, docs/e2e-testing-concept.md
# §4.2). Shipped in every image but inert: the entrypoint only prepends this
# dir to PATH when AEE_FAKE_CLAUDE=1, so with the flag unset the real Claude
# Code CLI installed above wins and production behaviour is byte-identical.
COPY e2e/ /opt/ace/e2e/
RUN chmod +x /opt/ace/e2e/claude

# `aee-artifact` — register/resolve flow artifacts by logical name via the
# git-committed manifest (.agent-studio/artifacts.jsonl). On PATH so agents call it
# directly to record what they produced and to resolve an upstream's outputs
# whose physical path varies per run.
RUN chmod +x /opt/ace/scripts/aee-artifact \
    && ln -sf /opt/ace/scripts/aee-artifact /usr/local/bin/aee-artifact

# `gh-as-agent` — do git/GitHub actions as this agent. (1) Stamps the agent's
# identity onto commits and issue/PR/comment bodies (`<!-- agent: $AGENT_ID -->`)
# so the central GitHub poller can attribute resulting events back to this agent
# — without it every agent shares one PAT, the poller reads the origin as `human`
# and allowlist `from` filters fail closed, breaking agent→agent GitHub hand-offs.
# (2) `push` / `pr` route the network step through the orchestrator, because on an
# enterprise-subscription model provider (authType "oauth-token") the org's
# managed Claude Code settings force interactive approval for `git push` /
# `gh pr create`, which is impossible in an unattended run.
RUN chmod +x /opt/ace/scripts/gh-as-agent \
    && ln -sf /opt/ace/scripts/gh-as-agent /usr/local/bin/gh-as-agent

# `gh` itself is wrapped (#2559): /usr/local/bin precedes /usr/bin on PATH, so
# agents' `gh …` reaches `aee-gh`, which forwards a live chat turn's GitHub
# WRITES to the orchestrator to run under the chat sender's personal token (the
# secret never enters the container) and execs the real /usr/bin/gh for
# everything else — reads, local commands and every autonomous run.
ENV AEE_REAL_GH=/usr/bin/gh
RUN chmod +x /opt/ace/scripts/aee-gh \
    && ln -sf /opt/ace/scripts/aee-gh /usr/local/bin/gh

# `knowledge` — record + query the shared team Knowledge Base (Shared Agent
# Learning). On PATH so agents call it directly: `knowledge search` (offline
# search over the synced working copy) and `knowledge add` (append a durable,
# provenance-stamped fact to the agent's own shard, commit, and push via the
# orchestrator to the shared agent-knowledge branch).
RUN chmod +x /opt/ace/scripts/knowledge \
    && ln -sf /opt/ace/scripts/knowledge /usr/local/bin/knowledge

# `aee-emit` — DEPRECATED compatibility shim (#2578), kept for one release so
# agents whose authored prompts still say `aee-emit` keep handing off. It no
# longer talks to the orchestrator: it just applies the label on the issue / PR
# (`gh … --add-label`, creating the label if missing) and the GitHub poller
# delivers it like any other label. Remove in the release after #2578.
RUN chmod +x /opt/ace/scripts/aee-emit \
    && ln -sf /opt/ace/scripts/aee-emit /usr/local/bin/aee-emit

# `aee-wake` — hand off directly to a wired same-team agent (#2030). The
# target-LESS alternative to a label hand-off: no label, no issue/PR, no GitHub
# trace, so the platform's own event log is the audit trail. Fails LOUD
# (exit 1) on an unknown / self / cross-team target — a `wakeAgent` target is
# an explicitly wired role, so reaching nobody is a wiring bug rather than an
# ambiguous outcome. (Labelled hand-offs are plain GitHub labels delivered by
# the poller; `aee-emit` survives only as the deprecated shim above.)
RUN chmod +x /opt/ace/scripts/aee-wake \
    && ln -sf /opt/ace/scripts/aee-wake /usr/local/bin/aee-wake

# `aee-ask` — put a structured decision to the human and pause the run (#2523).
# The CLI-facade replacement for the policy-blocked `aee-ask` MCP server (see
# AEE_DISABLE_ASK_MCP below): it writes the question to the per-turn sentinel
# file the entrypoint hands it via AEE_ASK_FILE, and the entrypoint posts it as
# the turn's terminal quick-reply message. No network, no MCP.
RUN chmod +x /opt/ace/scripts/aee-ask \
    && ln -sf /opt/ace/scripts/aee-ask /usr/local/bin/aee-ask

# `usage` — read-only view of this agent's / its team's token usage (#679). On
# PATH so agents call it directly: `usage me` / `usage team` query the
# orchestrator's read-only usage endpoint across the volume-isolation boundary
# (the agent can't read /workspace/usage/ itself). Token counts only, never money.
RUN chmod +x /opt/ace/scripts/usage \
    && ln -sf /opt/ace/scripts/usage /usr/local/bin/usage

# Plugin CLI facades (#1547). Built-in CLIs above are symlinked into
# /usr/local/bin at build time; plugin CLIs cannot be, because they are seeded
# per agent into `<workspace>/.agent-studio/bin` when a plugin is GRANTED — a live
# file sync with no respawn. So the image puts a STABLE directory on PATH and the
# entrypoint points it at this agent's seed dir with a single symlink.
#
# Why not append the per-agent path to PATH in the container env instead:
# setting PATH there REPLACES the image's own PATH rather than extending it,
# and why not mutate os.environ in the entrypoint: that is invisible to
# `podman exec`, so a human debugging a granted plugin sees "command not
# found". This way a plugin granted minutes from now is instantly on PATH for
# the agent AND for an operator shell, with no respawn either way.
RUN mkdir -p /opt/aee
ENV PATH="${PATH}:/opt/aee/plugin-bin"

ENV NODE_ENV=production

# LOCAL OPT-OUT: this environment's Claude Code managed policy blocks MCP servers,
# so the bundled aee-ask server is refused and every agent turn exits non-zero.
# Human decision prompts go through the `aee-ask` CLI instead (#2523), so we
# skip injecting the MCP server.
# Remove this line once the enterprise policy allowlists MCP (the entrypoint gate
# defaults to off, so upstream behaviour is unchanged without it).
ENV AEE_DISABLE_ASK_MCP=1

ENTRYPOINT ["python3", "/opt/ace/scripts/agent-entrypoint.py"]


# ---- aee-agent: Tier 1 target (no additional layers) ----
FROM aee-base AS aee-agent
# Skills, mentorscripts, and loopscripts are bind-mounted at runtime
# for fast iteration without image rebuilds.
