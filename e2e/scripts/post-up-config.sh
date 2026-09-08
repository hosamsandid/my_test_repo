#!/bin/bash
set -euo pipefail

# Shared post-up configuration for an already-running e2e stack (#1319).
# Extracted from stack-up.sh so the compose stack (stack-up.sh) and the kind
# stack (kind-stack-up.sh) configure the SAME things through the SAME console
# API calls — readiness, the mock LLM provider, the dead default endpoint —
# against whatever base URL the caller port-mapped.
#
# Parameters (env):
#   ADMIN_BASE       (required) e.g. http://localhost:4010
#   ADMIN_USERNAME / ADMIN_PASSWORD  console login
#   MOCK_LLM_BASE_URL  in-stack URL of the mock /v1/messages (default http://fake-github)
#   WITH_STT=1         also poll the STT service (compose-only; kind has no stt)
#   WITH_E2E_AGENT=1   also pre-create the standalone e2e-agent used by the
#                      hand-written chat/STT specs (journeys create their own)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ADMIN_BASE="${ADMIN_BASE:?ADMIN_BASE is required}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-e2e-admin-pass}"
MOCK_LLM_BASE_URL="${MOCK_LLM_BASE_URL:-http://fake-github}"
WITH_STT="${WITH_STT:-0}"
WITH_E2E_AGENT="${WITH_E2E_AGENT:-0}"

wait_http() { # url desc
  local url="$1" desc="$2" i
  echo -n "Waiting for ${desc} "
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$url"; then echo " ok"; return 0; fi
    echo -n "."; sleep 2
  done
  echo; echo "ERROR: timed out waiting for ${desc} (${url})" >&2; return 1
}

# admin-console SPA served
wait_http "${ADMIN_BASE}/" "admin-console SPA"

# The first-boot System-Admin seed (#2059). The configured credential is no
# longer a login of its own, so signing in only works once the orchestrator has
# created the real user record from it — and the console starts without waiting
# for the orchestrator (`depends_on` names only conduwuit). Poll the readiness
# probe first, so a premature login attempt cannot be mistaken for bad
# credentials. It answers 200 {"ready":true} once the users index holds a record.
echo -n "Waiting for the System-Admin seed "
ready_code=""
for i in $(seq 1 60); do
  ready_code=$(curl -s -o /dev/null -w '%{http_code}' "${ADMIN_BASE}/api/auth/ready" || true)
  if [ "$ready_code" = "200" ]; then echo " ok"; break; fi
  echo -n "."; sleep 2
done
if [ "$ready_code" != "200" ]; then
  echo; echo "ERROR: the System-Admin seed never landed (last HTTP ${ready_code})." >&2
  echo "       The orchestrator seeds it at boot from ADMIN_USERNAME/ADMIN_PASSWORD" >&2
  echo "       (or BOOTSTRAP_SYSTEM_ADMIN_SUBJECT); check the orchestrator log." >&2
  exit 1
fi

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
if [ "$WITH_STT" = "1" ]; then
  echo -n "Waiting for stt "
  wh_code=""
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
fi

# Register the mock LLM Model Provider (#710, journey-spec §6.3).
# `resolveGenerationTarget` picks the first registered (non-oauth) endpoint, so
# POST /api/agent-prompt/generate reaches fake-github's canned /v1/messages
# instead of the deliberately-dead ANTHROPIC_BASE_URL. Idempotent: a fixed id
# means a re-run returns 409, which we treat as already-present.
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

# Preconfigure a standalone agent for UI-level e2e tests (chat/STT specs).
# Idempotent: 409 = already exists.
if [ "$WITH_E2E_AGENT" = "1" ]; then
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
fi
