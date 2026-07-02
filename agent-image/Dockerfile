# ---- aee-base: Agent Execution Environment runtime ----
# Python 3.12 + Node 20 + Claude Code CLI.
# Used by all three container tiers (bind, clone, image).
FROM python:3.12-slim AS aee-base

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
ARG CLAUDE_CODE_VERSION=2.1.121
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Python deps for the in-container Matrix DM listener (P4).
COPY requirements.txt /opt/ace/requirements.txt
RUN pip install --no-cache-dir -r /opt/ace/requirements.txt

# Copy ACE scripts (entrypoint + sase_lib + supporting scripts).
COPY scripts/ /opt/ace/scripts/
COPY CLAUDE.md /opt/ace/CLAUDE.md

# `aee-artifact` — register/resolve mission artifacts by logical name via the
# git-committed manifest (.aee/artifacts.jsonl). On PATH so agents call it
# directly to record what they produced and to resolve an upstream's outputs
# whose physical path varies per run.
RUN chmod +x /opt/ace/scripts/aee-artifact \
    && ln -sf /opt/ace/scripts/aee-artifact /usr/local/bin/aee-artifact

# `gh-as-agent` — stamps the agent's identity onto commits and issue/PR/comment
# bodies (`<!-- agent: $AGENT_ID -->`) so the central GitHub poller can attribute
# resulting events back to this agent. Without it every agent shares one PAT, so
# the poller reads the origin as `human` and allowlist `from` filters fail closed —
# breaking agent→agent GitHub hand-offs. Mirrors the copy in the orchestrator image.
RUN chmod +x /opt/ace/scripts/gh-as-agent \
    && ln -sf /opt/ace/scripts/gh-as-agent /usr/local/bin/gh-as-agent

ENV NODE_ENV=production

ENTRYPOINT ["python3", "/opt/ace/scripts/agent-entrypoint.py"]


# ---- aee-agent: Tier 1 target (no additional layers) ----
FROM aee-base AS aee-agent
# Skills, mentorscripts, and loopscripts are bind-mounted at runtime
# for fast iteration without image rebuilds.
