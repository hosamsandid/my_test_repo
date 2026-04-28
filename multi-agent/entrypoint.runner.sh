#!/bin/sh
set -e

# Agent runner entrypoint
# AGENT_ID must be set by the orchestrator when creating this container.
if [ -z "$AGENT_ID" ]; then
  echo "[Runner] AGENT_ID is not set — aborting"
  exit 1
fi

AGENT_WORKDIR="/workspace/agents/${AGENT_ID}"

# Ensure the agent workspace directory exists (it should already be seeded by
# the orchestrator during !agent add, but create it just in case).
mkdir -p "${AGENT_WORKDIR}"

# Change into the agent workspace so Claude CLI runs in the right directory
cd "${AGENT_WORKDIR}"

exec node /app/agent-runner.js
