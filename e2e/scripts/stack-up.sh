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

# --- 6. Readiness poll (no compose healthchecks — §4.4) ---
ADMIN_PORT="${ADMIN_PORT:-4010}"
CONDUWUIT_PORT="${CONDUWUIT_PORT:-8449}"
ADMIN_BASE="http://localhost:${ADMIN_PORT}"

wait_http() { # url desc
  local url="$1" desc="$2" i
  echo -n "Waiting for ${desc} "
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$url"; then echo " ok"; return 0; fi
    echo -n "."; sleep 2
  done
  echo; echo "ERROR: timed out waiting for ${desc} (${url})" >&2; return 1
}

# conduwuit (Matrix) — public endpoint
wait_http "http://localhost:${CONDUWUIT_PORT}/_matrix/client/versions" "conduwuit"
# admin-console SPA served
wait_http "${ADMIN_BASE}/" "admin-console SPA"

# Auth up + orchestrator reachable: login round-trip, then a proxied list call.
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT
echo -n "Waiting for admin login "
login_code=""
for i in $(seq 1 60); do
  login_code=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" \
    -X POST "${ADMIN_BASE}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}" || true)
  if [ "$login_code" = "200" ]; then echo " ok"; break; fi
  echo -n "."; sleep 2
done
if [ "$login_code" != "200" ]; then
  echo; echo "ERROR: admin login never succeeded (last HTTP ${login_code})" >&2; exit 1
fi

agents_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "${ADMIN_BASE}/api/agents" || true)
if [ "$agents_code" != "200" ]; then
  echo "ERROR: GET /api/agents returned ${agents_code} (orchestrator proxy not ready)" >&2; exit 1
fi

# STT — model is pre-baked but the HTTP server takes a few seconds.
# POST a tiny payload through the admin-console proxy (stt has no host port).
echo -n "Waiting for stt "
for i in $(seq 1 60); do
  wh_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
    -X POST "${ADMIN_BASE}/api/transcribe" \
    -F "audio_file=@${SCRIPT_DIR}/../fixtures/audio/stt-test.wav;type=audio/wav" || true)
  if [ "$wh_code" = "200" ]; then echo " ok"; break; fi
  echo -n "."; sleep 2
done
if [ "$wh_code" != "200" ]; then
  echo; echo "WARNING: stt not ready (last HTTP ${wh_code}) — STT tests will skip" >&2
fi

# --- 7. Register the mock LLM Model Provider (#710, journey-spec §6.3) ---
# `resolveGenerationTarget` picks the first registered (non-oauth) endpoint, so
# POST /api/agent-prompt/generate reaches fake-github's canned /v1/messages
# instead of the deliberately-dead ANTHROPIC_BASE_URL. Idempotent: a fixed id
# means a re-run returns 409, which we treat as already-present.
MOCK_LLM_BASE_URL="${MOCK_LLM_BASE_URL:-http://fake-github}"
echo -n "Registering mock LLM provider "
llm_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -X POST "${ADMIN_BASE}/api/llm-endpoints" \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"e2e-mock\",\"name\":\"E2E Mock (fake-github)\",\"baseUrl\":\"${MOCK_LLM_BASE_URL}\",\"authToken\":\"e2e-mock-token\",\"models\":[{\"id\":\"claude-fake-e2e\",\"displayName\":\"claude-fake-e2e\",\"kind\":\"sonnet\"}],\"defaultModelId\":\"claude-fake-e2e\"}" || true)
if [ "$llm_code" = "201" ] || [ "$llm_code" = "409" ]; then
  echo " ok (HTTP ${llm_code})"
else
  echo " WARNING: mock LLM provider registration returned HTTP ${llm_code} (flows-draft prompt gen may fail)" >&2
fi

# The orchestrator migrates the ANTHROPIC_* env into a `default` LLM endpoint at
# startup (baseUrl = the deliberately-dead http://127.0.0.1:1). It sorts BEFORE
# `e2e-mock`, so `resolveGenerationTarget` (which picks endpoints[0]) would hit
# the dead URL and POST /api/agent-prompt/generate would 502 — breaking the
# flows-draft "Generate agent prompt" step (#733). Remove it so `e2e-mock` is the
# effective target. Best-effort: 204 (deleted) / 404 (already gone) are fine.
echo -n "Removing dead env-migrated 'default' LLM endpoint "
del_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -X DELETE "${ADMIN_BASE}/api/llm-endpoints/default" || true)
echo " (HTTP ${del_code})"

# --- 8. Preconfigure a standalone agent for UI-level e2e tests ---
# Create a minimal Working Environment + agent so chat-based tests (STT, etc.)
# have something to open. Idempotent: 409 = already exists.
echo -n "Creating e2e Working Environment "
env_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -X POST "${ADMIN_BASE}/api/environments" \
  -H 'Content-Type: application/json' \
  -d '{"id":"e2e-env","name":"E2E Environment"}' || true)
echo " (HTTP ${env_code})"

echo -n "Creating e2e agent "
agent_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -X POST "${ADMIN_BASE}/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"id":"e2e-agent","displayName":"E2E Agent","role":"agent","environmentId":"e2e-env","systemPrompt":"You are a helpful test agent."}' || true)
echo " (HTTP ${agent_code})"

echo -n "Enabling e2e agent "
enable_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -X PUT "${ADMIN_BASE}/api/agents/e2e-agent" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' || true)
echo " (HTTP ${enable_code})"

echo -n "Creating DM room for e2e agent "
dm_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  -X POST "${ADMIN_BASE}/api/matrix/agents/e2e-agent/dm" || true)
echo " (HTTP ${dm_code})"

echo
echo "=========================================="
echo "  aee-e2e stack ready"
echo "  Admin console: ${ADMIN_BASE}"
echo "  Matrix:        http://localhost:${CONDUWUIT_PORT}"
echo "=========================================="
