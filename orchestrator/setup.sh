#!/bin/bash
set -euo pipefail

# Multi-Agent Setup Script
# Registers Matrix users, creates a collaboration room, invites participants.
# Compatible with bash 3.2 (macOS default).

HOMESERVER="http://localhost:8448"
HUMAN_USER="@thorsten:local"
TIMESTAMP=$(date +%s)

echo "=== Multi-Agent Setup ==="
echo ""

# --- Check prerequisites ---
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq"
  exit 1
fi

echo "Checking Conduwuit connectivity..."
if ! curl -sf "${HOMESERVER}/_matrix/client/versions" > /dev/null 2>&1; then
  echo "ERROR: Cannot reach Conduwuit at ${HOMESERVER}"
  exit 1
fi
echo "OK"
echo ""

# --- Helper: register or login, returns token on stdout ---
get_token() {
  local username="$1"
  local password="$2"
  local response token

  # Try registration
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

  # Try login (user may already exist)
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

  echo "FAIL" >&2
  return 1
}

# --- Register users ---
echo "Registering @orchestrator:local ..."
ORCH_TOKEN=$(get_token "orchestrator" "orch-pass-${TIMESTAMP}")
echo "  OK"

echo "Registering @agent-a:local ..."
AGENT_A_TOKEN=$(get_token "agent-a" "agent-a-pass-${TIMESTAMP}")
echo "  OK"

echo "Registering @agent-b:local ..."
AGENT_B_TOKEN=$(get_token "agent-b" "agent-b-pass-${TIMESTAMP}")
echo "  OK"
echo ""

# --- Set display names ---
echo "Setting display names..."
curl -sf -X PUT "${HOMESERVER}/_matrix/client/v3/profile/@orchestrator:local/displayname" \
  -H "Authorization: Bearer ${ORCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"displayname": "Orchestrator"}' > /dev/null 2>&1 || true

curl -sf -X PUT "${HOMESERVER}/_matrix/client/v3/profile/@agent-a:local/displayname" \
  -H "Authorization: Bearer ${AGENT_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"displayname": "Agent A"}' > /dev/null 2>&1 || true

curl -sf -X PUT "${HOMESERVER}/_matrix/client/v3/profile/@agent-b:local/displayname" \
  -H "Authorization: Bearer ${AGENT_B_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"displayname": "Agent B"}' > /dev/null 2>&1 || true
echo "  OK"
echo ""

# --- Create collaboration room ---
echo "Creating multi-agent room..."
room_response=$(curl -sf -X POST "${HOMESERVER}/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer ${ORCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Multi-Agent Collaboration\",
    \"topic\": \"Orchestrator + Agent A + Agent B\",
    \"preset\": \"private_chat\",
    \"invite\": [\"@agent-a:local\", \"@agent-b:local\", \"${HUMAN_USER}\"]
  }")

ROOM_ID=$(echo "$room_response" | jq -r '.room_id // empty')
if [ -z "$ROOM_ID" ]; then
  echo "ERROR: Could not create room."
  echo "Response: ${room_response}"
  exit 1
fi
echo "  Room: ${ROOM_ID}"
echo ""

# --- Agents join the room ---
echo "Joining agents to room..."
curl -sf -X POST "${HOMESERVER}/_matrix/client/v3/join/${ROOM_ID}" \
  -H "Authorization: Bearer ${AGENT_A_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' > /dev/null 2>&1 || echo "  (warning: agent-a join failed)"

curl -sf -X POST "${HOMESERVER}/_matrix/client/v3/join/${ROOM_ID}" \
  -H "Authorization: Bearer ${AGENT_B_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' > /dev/null 2>&1 || echo "  (warning: agent-b join failed)"
echo "  OK"
echo ""

# --- Output ---
echo "==========================================="
echo "  Add these lines to your .env file:"
echo "==========================================="
echo ""
echo "# Multi-Agent"
echo "MULTI_AGENT_ROOM=${ROOM_ID}"
echo "ORCHESTRATOR_TOKEN=${ORCH_TOKEN}"
echo "AGENT_A_TOKEN=${AGENT_A_TOKEN}"
echo "AGENT_B_TOKEN=${AGENT_B_TOKEN}"
echo ""
echo "==========================================="
