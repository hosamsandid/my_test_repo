FROM node:22-slim

RUN apt-get -o Acquire::Check-Valid-Until=false update && apt-get install -y --no-install-recommends \
    git ca-certificates curl openssh-client gnupg \
  && rm -rf /var/lib/apt/lists/*

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

RUN npm install -g @anthropic-ai/claude-code

# Default git identity. Agents can override with GIT_AUTHOR_*/GIT_COMMITTER_*
# env vars (or per-repo `git config`) — this just makes plain `git commit`
# work out of the box without each agent having to configure itself.
RUN git config --system user.name  "claw-agent" \
 && git config --system user.email "claw-agent@local"

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY *.js .

# `gh-as-agent` wrapper: tags git commits and PR/review/comment bodies
# with the per-agent identity so the GitHub poller can filter out events
# the agent itself caused. See orchestrator/scripts/gh-as-agent.
COPY scripts/gh-as-agent /usr/local/bin/gh-as-agent
RUN chmod +x /usr/local/bin/gh-as-agent

# Bundled fallback template: used by orchestrator when /template-workspace/CLAUDE.md
# is not available in the mounted skills-pool volume (e.g. fresh installation).
COPY CLAUDE-template.md /defaults/CLAUDE.md

WORKDIR /workspace
RUN mkdir -p /workspace/agents

CMD ["node", "/app/orchestrator.js"]
