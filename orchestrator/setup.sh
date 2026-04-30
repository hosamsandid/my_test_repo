#!/bin/bash
set -euo pipefail

# One-shot bootstrap for a fresh Conduwuit installation.
#
# Registers the admin (human) user and the @orchestrator:local bot,
# creates the shared Multi-Agent Collaboration room, and emits the
# .env values you need.
#
# After this completes, manage all expert/synthesizer/autonomous agents
# via the Admin Console at http://localhost:4000.
#
# Compatible with bash 3.2 (macOS default).

HOMESERVER="${HOMESERVER:-http://localhost:8448}"
ADMIN_USER="${ADMIN_USER:-thorsten}"
ADMIN_PASS="${ADMIN_PASS:-}"
ORCH_USER="orchestrator"
ORCH_PASS="${ORCH_PASS:-orch-$(date +%s)}"

echo "=== Stack Bootstrap (admin user + orchestrator) ==="

# --- Prerequisites ---
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

if ! curl -sf "${HOMESERVER}/_matrix/client/versions" >/dev/null 2>&1; then
  echo "ERROR: Cannot reach Conduwuit at ${HOMESERVER}" >&2
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

# --- Helper: register or login, returns token on stdout ---
get_token() {
  local username="$1"
  local password="$2"
  local response token

  response=$(curl -s -X POST "${HOMESERVER}/_matrix/client/v3/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"${username}\",
      \"password\": \"${password}\",
      \"auth\": {\"type\": \"m.login.dummy\"},
      \"inhibit_login\": false
    }") || true

  token=$(echo "$response" | jq -r '.access_token // empty' 2>/dev/null)
  if [ -n "$token" ]; then
    echo "$token"
    return 0
  fi

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

  return 1
}

echo "Registering @${ADMIN_USER}:local ..."
ADMIN_TOKEN=$(get_token "${ADMIN_USER}" "${ADMIN_PASS}") || {
  echo "ERROR: failed to register or login admin user" >&2
  exit 1
}
echo "  OK"

echo "Registering @${ORCH_USER}:local ..."
ORCH_TOKEN=$(get_token "${ORCH_USER}" "${ORCH_PASS}") || {
  echo "ERROR: failed to register orchestrator" >&2
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
echo "Then start the stack with: ./start-stack.fish"
echo "Manage agents at:           http://localhost:4000"
