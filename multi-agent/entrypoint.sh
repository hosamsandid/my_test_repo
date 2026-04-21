#!/bin/sh
set -e

# Initialize workspace if needed
if [ ! -f /workspace/CLAUDE.md ]; then
  cp /defaults/CLAUDE.md /workspace/CLAUDE.md
  mkdir -p /workspace/memory
fi

exec "$@"
