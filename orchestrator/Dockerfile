FROM node:22-slim

RUN apt-get -o Acquire::Check-Valid-Until=false update && apt-get install -y --no-install-recommends \
    git ca-certificates curl openssh-client gnupg jq \
  && rm -rf /var/lib/apt/lists/*

# Route github.com SSH via ssh.github.com:443 — works on corporate networks
# that block outbound TCP 22 and is a no-op on permissive networks (GitHub
# exposes the same SSH service on port 443 via ssh.github.com).
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

# GitHub CLI (gh) — official APT repo. Authenticates via GH_TOKEN, which the
# orchestrator injects per-agent from the GitHub-token store managed in the
# Admin Console.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Pin Claude Code CLI version for reproducible builds (kept identical to
# agent-image/Dockerfile's ARG CLAUDE_CODE_VERSION).
ARG CLAUDE_CODE_VERSION=2.1.293
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Default git identity. Agents can override with GIT_AUTHOR_*/GIT_COMMITTER_*
# env vars (or per-repo `git config`) — this just makes plain `git commit`
# work out of the box without each agent having to configure itself.
RUN git config --system user.name  "claw-agent" \
 && git config --system user.email "claw-agent@local"

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY *.js ./
# PR readiness verdict rules (#2796), required by pr-readiness.js and shared
# byte-identical with the agent image's `aee-wait-ci`.
COPY pr-readiness-rules.json ./

# `gh-as-agent` wrapper: tags git commits and PR/review/comment bodies
# with the per-agent identity so the GitHub poller can filter out events
# the agent itself caused. See orchestrator/scripts/gh-as-agent.
COPY scripts/gh-as-agent /usr/local/bin/gh-as-agent
RUN chmod +x /usr/local/bin/gh-as-agent

# `multi-agent-bid` pre-check script: runs on every Developer agent cron tick
# to bid on ready issues and detect assignments without an LLM call.
COPY scripts/multi-agent-bid.sh /usr/local/bin/multi-agent-bid
RUN chmod +x /usr/local/bin/multi-agent-bid

# Bundled fallback template: used by orchestrator when /template-workspace/CLAUDE.md
# is not available in the mounted skills-pool volume (e.g. fresh installation).
COPY CLAUDE-template.md /defaults/CLAUDE.md

WORKDIR /workspace
RUN mkdir -p /workspace/agents

CMD ["node", "/app/orchestrator.js"]
