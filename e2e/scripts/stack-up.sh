#!/bin/bash
set -euo pipefail

# Bring up the disposable `aee-e2e` compose stack from a clean state
# (#666, docs/e2e-testing-concept.md §4–§6). Single source of truth for the
# stack lifecycle: Playwright's global-setup calls this, and so do the
# `make e2e-up` authoring helper. Idempotent enough to re-run, but designed to
# start from fresh volumes (pair with stack-down.sh between runs).
#
# Steps: generate .env.e2e -> build images -> seed the skill pool ->
# bootstrap Matrix (setup.sh) -> bring the full stack up -> poll readiness.
# No healthchecks exist in the compose file, so readiness is polled here.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT=aee-e2e
ENV_FILE="$REPO_ROOT/.env.e2e"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.e2e.yml"
COMPOSE="podman compose ${COMPOSE_FILES} -p ${PROJECT} --env-file ${ENV_FILE}"

# --- 1. Generate .env.e2e (isolated ports/project, fake-claude, dead LLM) ---
"$SCRIPT_DIR/gen-env.sh"
set -a; . "$ENV_FILE"; set +a

# --- 2. Build images ---
# The per-agent image is not a compose service — the orchestrator pulls it from
# the local store at spawn time, so it must be built explicitly.
echo "=== Building images ==="
make agent-image
${COMPOSE} build orchestrator admin-console

# --- 3. Seed the skill pool (templates/process-templates for the wizard) ---
# seed-pool derives the volume name from COMPOSE_PROJECT_NAME (exported above),
# so this fills aee-e2e_claude-workspace, never the dev stack's pool.
echo "=== Seeding skill pool ==="
make seed-pool

# --- 4. Bootstrap Matrix admin user + token into .env.e2e ---
# setup.sh is env-file- and compose-invocation-aware; point both at the e2e
# overlay/project so the bootstrap never touches the developer's real .env.
echo "=== Bootstrapping Matrix admin ==="
ENV_FILE="$ENV_FILE" \
  COMPOSE_CMD="${COMPOSE}" \
  ADMIN_PASS="${ADMIN_PASSWORD}" \
  "$REPO_ROOT/orchestrator/setup.sh"

# Re-read the env file: setup.sh has just written MATRIX_ACCESS_TOKEN /
# CONDUWUIT_ADMIN_ROOM, and the shell exports from step 1 (empty on a fresh CI
# runner, stale locally) would otherwise take precedence over --env-file in
# compose variable substitution at step 5 — so the orchestrator would start
# with no admin credentials, silently disabling Matrix user provisioning (#719).
set -a; . "$ENV_FILE"; set +a

# --- 4b. Seed the in-stack git-remote fixture repo (#667) ---
# Host-side git builds the bare repo at the git-remote bind-mount root BEFORE
# `up`, so the static file server has it to serve the moment it starts. The dev
# stack never references this path.
echo "=== Seeding git-remote fixture repo ==="
"$SCRIPT_DIR/seed-fixture-repo.sh"

# --- 5. Bring the full stack up ---
echo "=== Starting stack (${PROJECT}) ==="
${COMPOSE} up -d --build

# --- 6/7/8. Readiness poll + stack configuration (shared with the kind stack) ---
# Everything from "wait for the console" onwards is target-agnostic console-API
# work, extracted into post-up-config.sh (#1319) so kind-stack-up.sh runs the
# byte-same configuration. Only the conduwuit host-port probe stays here (the
# kind stack doesn't publish Matrix).
ADMIN_PORT="${ADMIN_PORT:-4010}"
CONDUWUIT_PORT="${CONDUWUIT_PORT:-8449}"
ADMIN_BASE="http://localhost:${ADMIN_PORT}"

echo -n "Waiting for conduwuit "
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:${CONDUWUIT_PORT}/_matrix/client/versions"; then echo " ok"; break; fi
  echo -n "."; sleep 2
  if [ "$i" = "60" ]; then echo; echo "ERROR: timed out waiting for conduwuit" >&2; exit 1; fi
done

ADMIN_BASE="$ADMIN_BASE" \
  ADMIN_USERNAME="$ADMIN_USERNAME" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  MOCK_LLM_BASE_URL="${MOCK_LLM_BASE_URL:-http://fake-github}" \
  WITH_STT=1 \
  WITH_E2E_AGENT=1 \
  "$SCRIPT_DIR/post-up-config.sh"

echo
echo "=========================================="
echo "  aee-e2e stack ready"
echo "  Admin console: ${ADMIN_BASE}"
echo "  Matrix:        http://localhost:${CONDUWUIT_PORT}"
echo "=========================================="
