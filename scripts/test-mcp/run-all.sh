#!/usr/bin/env bash
# Runs the MCP-integration test suite. All three sub-tests are self-contained:
# they spawn the system-under-test, drive it, and clean up after themselves.
# No docker/podman, no real Matrix homeserver — pure host-side checks.
set -euo pipefail

cd "$(dirname "$0")/../.."

# admin-console/api needs its own node_modules for express/multer/cors.
if [ ! -d admin-console/api/node_modules ]; then
  echo "[mcp-tests] installing admin-console/api deps…" >&2
  (cd admin-console/api && npm install --no-audit --no-fund) >/dev/null
fi

fails=0
for t in test-wiki-server.js test-seed-path.js test-api-endpoints.js; do
  echo
  echo "=== $t ==="
  if ! node "scripts/test-mcp/$t"; then
    fails=$((fails + 1))
  fi
done

echo
if [ "$fails" -eq 0 ]; then
  echo "[mcp-tests] all suites passed"
else
  echo "[mcp-tests] $fails suite(s) failed" >&2
fi
exit "$fails"
