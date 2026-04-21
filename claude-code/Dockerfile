FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Bridge dependencies
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY bridge.js .

# Default CLAUDE.md (copied to workspace on first run)
COPY CLAUDE.md /defaults/CLAUDE.md

WORKDIR /workspace

# Entrypoint: restore config + init workspace
RUN printf '#!/bin/sh\n\
if [ ! -f /root/.claude.json ] && [ -d /root/.claude/backups ]; then\n\
  latest=$(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)\n\
  [ -n "$latest" ] && cp "$latest" /root/.claude.json\n\
fi\n\
if [ ! -f /workspace/CLAUDE.md ]; then\n\
  cp /defaults/CLAUDE.md /workspace/CLAUDE.md\n\
  mkdir -p /workspace/memory /workspace/skills\n\
fi\n\
exec "$@"\n' > /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/bridge.js"]
