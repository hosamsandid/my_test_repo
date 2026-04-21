FROM python:3.12-slim

# Node.js is required by the Claude Code CLI (which claude-agent-sdk invokes).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pin Claude Code CLI version (must match the version used by claude-agent).
ARG CLAUDE_CODE_VERSION=2.1.104
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Server code is volume-mounted at runtime via /repo.
# This image only provides the Python runtime + dependencies.
EXPOSE 8765

CMD ["python3", "server.py", "--port", "8765"]
