FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY agent-pool.js .
COPY orchestrator.js .

WORKDIR /workspace
RUN mkdir -p /workspace/agents

CMD ["node", "/app/orchestrator.js"]
