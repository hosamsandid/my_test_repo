FROM node:22-slim

RUN apt-get -o Acquire::Check-Valid-Until=false update && apt-get install -y --no-install-recommends \
    git ca-certificates curl openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY orchestrator.js .
COPY agent-runner.js .

# Bundled fallback template: used by orchestrator when /template-workspace/CLAUDE.md
# is not available in the mounted skills-pool volume (e.g. fresh installation).
COPY CLAUDE-template.md /defaults/CLAUDE.md

WORKDIR /workspace
RUN mkdir -p /workspace/agents

CMD ["node", "/app/orchestrator.js"]
