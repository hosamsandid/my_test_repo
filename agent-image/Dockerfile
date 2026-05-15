# ---- aee-base: Agent Execution Environment runtime ----
# Python 3.12 + Node 20 + Claude Code CLI.
# Used by all three container tiers (bind, clone, image).
FROM python:3.12-slim AS aee-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git curl ca-certificates openssh-client \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
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

ENV NODE_ENV=production

ENTRYPOINT ["python3", "/opt/ace/scripts/agent-entrypoint.py"]


# ---- aee-agent: Tier 1 target (no additional layers) ----
FROM aee-base AS aee-agent
# Skills, mentorscripts, and loopscripts are bind-mounted at runtime
# for fast iteration without image rebuilds.
