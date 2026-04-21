FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Bridge dependencies
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY bridge.js .

# Default workspace files (copied to workspace volume on first run)
COPY CLAUDE.md /defaults/CLAUDE.md

# ACE plugin (installed into the auth volume on first run)
COPY ace-plugin /defaults/ace-plugin

WORKDIR /workspace

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/bridge.js"]
