#!/usr/bin/env bash
# Sync bp-explorer backend files from ACE → AEE.
# Run manually when ACE scripts/bp-explorer/ has been updated.
# Usage: ./scripts/sync-bp-explorer.sh [ACE_ROOT]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ACE_ROOT="${1:-${AEE_ROOT}/../314092_agent-command-environment}"
SRC="${ACE_ROOT}/scripts/bp-explorer"
DST="${AEE_ROOT}/bp-explorer"

if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: ACE bp-explorer not found at ${SRC}" >&2
  exit 1
fi

echo "Syncing bp-explorer: ${SRC} → ${DST}"

# Files that live in AEE (backend-only, no standalone UI)
FILES=(server.py aee_bridge.py qg_prompt_template.md)

for f in "${FILES[@]}"; do
  cp -v "${SRC}/${f}" "${DST}/${f}"
done

# requirements.txt: strip claude-agent-sdk (not needed in AEE mode)
grep -v '^claude-agent-sdk' "${SRC}/requirements.txt" > "${DST}/requirements.txt"
echo "  requirements.txt synced (claude-agent-sdk stripped)"

echo "Done. Review changes before committing."
