#!/bin/bash
# Tear down the disposable `aee-e2e` stack and every dynamic artifact it spawned
# (#666, docs/e2e-testing-concept.md §5). Best-effort: never abort on a single
# cleanup failure, so a partial bring-up still gets cleaned. Everything is
# project-prefixed or instance-labelled, so this cannot touch the developer's
# normal `vgh-claw` stack.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT=aee-e2e
ENV_FILE="$REPO_ROOT/.env.e2e"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.e2e.yml"

echo "=== Tearing down ${PROJECT} ==="

# 0. Capture orchestrator logs BEFORE the containers are removed. The workflow's
# dump-on-failure step runs after `make e2e`, but Playwright's global-teardown
# calls this script inside `make e2e` — so by then the containers are gone and
# that step only covers the crash-before-teardown case. Diagnosing #719 needed
# a local repro precisely because CI had no server-side logs; this closes that
# gap for the normal teardown path. Best-effort, lands in e2e/test-results/
# which CI already uploads on failure.
mkdir -p "$REPO_ROOT/e2e/test-results"
for c in $(podman ps -a --format '{{.Names}}' 2>/dev/null | grep "^${PROJECT}.*orchestrator" || true); do
  echo "=== podman logs ${c} ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ===" >> "$REPO_ROOT/e2e/test-results/orchestrator.log"
  podman logs "$c" >> "$REPO_ROOT/e2e/test-results/orchestrator.log" 2>&1 || true
done

# 1. Compose down + named volumes + orphans. --env-file only if it still exists
# (a failed gen-env leaves none); compose still resolves the project by -p.
if [ -f "$ENV_FILE" ]; then
  podman compose ${COMPOSE_FILES} -p "${PROJECT}" --env-file "${ENV_FILE}" down -v --remove-orphans || true
else
  podman compose ${COMPOSE_FILES} -p "${PROJECT}" down -v --remove-orphans || true
fi

# 2. Agent containers are spawned by the orchestrator over libpod (NOT compose),
# so `down` never sees them. Remove anything stamped with this instance label.
mapfile -t agent_containers < <(podman ps -aq --filter "label=aee.instance=e2e" 2>/dev/null || true)
if [ "${#agent_containers[@]}" -gt 0 ]; then
  echo "Removing ${#agent_containers[@]} agent container(s) labelled aee.instance=e2e"
  podman rm -f "${agent_containers[@]}" || true
fi

# 3. Per-agent dedicated volumes (`<project>_agent-<id>`, #185) are created
# outside compose too. Remove every volume carrying the project prefix.
mapfile -t vols < <(podman volume ls -q 2>/dev/null | grep -E "^${PROJECT}_" || true)
if [ "${#vols[@]}" -gt 0 ]; then
  echo "Removing ${#vols[@]} volume(s) prefixed ${PROJECT}_"
  podman volume rm -f "${vols[@]}" || true
fi

echo "=== Teardown complete ==="
