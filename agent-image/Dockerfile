# ---- aee-base: Agent Execution Environment runtime ----
# Python 3.12 + Node 20 + Claude Code CLI.
# Used by all three container tiers (bind, clone, image).
FROM python:3.12-slim AS aee-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pin Claude Code CLI version for reproducible builds.
ARG CLAUDE_CODE_VERSION=2.1.121
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Copy ACE scripts (entrypoint + sase_lib + supporting scripts).
COPY scripts/ /opt/ace/scripts/
COPY CLAUDE.md /opt/ace/CLAUDE.md

ENV NODE_ENV=production

ENTRYPOINT ["python3", "/opt/ace/scripts/agent-entrypoint.py"]


# ---- aee-agent: Tier 1 target (no additional layers) ----
FROM aee-base AS aee-agent
# Skills, mentorscripts, and loopscripts are bind-mounted at runtime
# for fast iteration without image rebuilds.
