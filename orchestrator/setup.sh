#!/bin/bash
set -euo pipefail

# One-shot bootstrap for a fresh Conduwuit installation.
#
# Creates the admin (human) user and the @orchestrator:local bot via
# conduwuit's --execute flag, then logs in via the Matrix API to obtain
# tokens, creates the shared room, and prints the .env values.
#
# After this completes, manage all expert/synthesizer/autonomous agents
# via the Admin Console.
#
# Compatible with bash 3.2 (macOS default).

# Source .env from repo root if present (picks up ADMIN_USER, HOMESERVER, etc.)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/../.env" ]; then
  set -a; . "${SCRIPT_DIR}/../.env"; set +a
fi

HOMESERVER="${HOMESERVER:-http://localhost:${CONDUWUIT_PORT:-8448}}"
ADMIN_USER="${ADMIN_USER:-thorsten}"
ADMIN_PASS="${ADMIN_PASS:-}"
ORCH_USER="orchestrator"
ORCH_PASS="${ORCH_PASS:-orch-$(date +%s)}"
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.yml"

echo "=== Stack Bootstrap (admin user + orchestrator) ==="

# --- Prerequisites ---
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

if [ -z "$ADMIN_PASS" ]; then
  echo -n "Password for admin user @${ADMIN_USER}:local: "
  read -rs ADMIN_PASS
  echo
  if [ -z "$ADMIN_PASS" ]; then
    echo "ERROR: empty password" >&2
    exit 1
  fi
fi

# --- Create users via conduwuit --execute ---
BOOTSTRAP_OVERRIDE=$(mktemp)
cat > "$BOOTSTRAP_OVERRIDE" <<YAML
services:
  conduwuit:
    command:
      - /sbin/conduwuit
      - --execute
      - "users create-user ${ADMIN_USER} ${ADMIN_PASS}"
      - --execute
      - "users create-user ${ORCH_USER} ${ORCH_PASS}"
YAML
trap "rm -f '$BOOTSTRAP_OVERRIDE'" EXIT

echo "Creating Matrix users via conduwuit admin console ..."
podman compose -f "${COMPOSE_FILE}" -f "${BOOTSTRAP_OVERRIDE}" up -d --no-deps conduwuit >/dev/null 2>&1

echo -n "Waiting for Conduwuit to be ready ..."
for i in $(seq 1 30); do
  if curl -sf "${HOMESERVER}/_matrix/client/versions" >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  sleep 1
  echo -n "."
  if [ "$i" -eq 30 ]; then
    echo
    echo "ERROR: Cannot reach Conduwuit at ${HOMESERVER}" >&2
    exit 1
  fi
done

# Restart without --execute immediately to avoid crash loop (users already exist on restart)
echo "Restarting Conduwuit (normal mode) ..."
podman compose -f "${COMPOSE_FILE}" up -d --no-deps conduwuit >/dev/null 2>&1
echo -n "Waiting for Conduwuit to be ready ..."
for i in $(seq 1 30); do
  if curl -sf "${HOMESERVER}/_matrix/client/versions" >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  sleep 1
  echo -n "."
done

# --- Login to get access tokens ---
login() {
  local username="$1"
  local password="$2"
  local response token

  response=$(curl -s -X POST "${HOMESERVER}/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"m.login.password\",
      \"identifier\": {\"type\": \"m.id.user\", \"user\": \"${username}\"},
      \"password\": \"${password}\"
    }") || true

  token=$(echo "$response" | jq -r '.access_token // empty' 2>/dev/null)
  if [ -n "$token" ]; then
    echo "$token"
    return 0
  fi

  echo "  [debug] login response: ${response}" >&2
  return 1
}

echo "Logging in @${ADMIN_USER}:local ..."
ADMIN_TOKEN=$(login "${ADMIN_USER}" "${ADMIN_PASS}") || {
  echo "ERROR: failed to login admin user" >&2
  exit 1
}
echo "  OK"

echo "Logging in @${ORCH_USER}:local ..."
ORCH_TOKEN=$(login "${ORCH_USER}" "${ORCH_PASS}") || {
  echo "ERROR: failed to login orchestrator" >&2
  exit 1
}
echo "  OK"

curl -sf -X PUT "${HOMESERVER}/_matrix/client/v3/profile/@${ORCH_USER}:local/displayname" \
  -H "Authorization: Bearer ${ORCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"displayname": "Orchestrator"}' >/dev/null 2>&1 || true

# --- Create collaboration room ---
echo "Creating Multi-Agent Collaboration room ..."
room_response=$(curl -sf -X POST "${HOMESERVER}/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer ${ORCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Multi-Agent Collaboration\",
    \"topic\": \"Shared room: orchestrator routes messages to expert agents\",
    \"preset\": \"private_chat\",
    \"invite\": [\"@${ADMIN_USER}:local\"]
  }")

ROOM_ID=$(echo "$room_response" | jq -r '.room_id // empty')
if [ -z "$ROOM_ID" ]; then
  echo "ERROR: Could not create room. Response: ${room_response}" >&2
  exit 1
fi
echo "  Room: ${ROOM_ID}"

# --- Output ---
echo
echo "=========================================="
echo "  Add these lines to your .env file:"
echo "=========================================="
cat <<EOF

MATRIX_ACCESS_TOKEN=${ADMIN_TOKEN}
MATRIX_BOT_USER_ID=@${ADMIN_USER}:local
MATRIX_DEFAULT_ROOM=${ROOM_ID}
MULTI_AGENT_ROOM=${ROOM_ID}
ORCHESTRATOR_TOKEN=${ORCH_TOKEN}

EOF
echo "Then start the stack with: make up"
echo "Manage agents at:           http://localhost:${ADMIN_PORT:-4000}"
