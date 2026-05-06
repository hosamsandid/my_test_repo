#!/bin/bash
set -euo pipefail

# One-shot bootstrap for a fresh Conduwuit installation.
#
# Creates the admin (human) user via conduwuit's --execute flag, then logs
# in via the Matrix API to obtain the admin access token and prints the
# .env values.
#
# After this completes, manage all agents via the Admin Console. Each agent
# runs as its own Matrix user; conversations happen as direct messages
# between the human and a single agent — there is no shared room.
#
# Compatible with bash 3.2 (macOS default).

# Source .env from repo root if present (picks up ADMIN_USER, HOMESERVER, etc.)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/../.env" ]; then
  set -a; . "${SCRIPT_DIR}/../.env"; set +a
fi

HOMESERVER="${HOMESERVER:-http://localhost:${CONDUWUIT_PORT:-8448}}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.yml"

echo "=== Stack Bootstrap (admin user) ==="

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

# --- Create admin user via conduwuit --execute ---
BOOTSTRAP_OVERRIDE=$(mktemp)
cat > "$BOOTSTRAP_OVERRIDE" <<YAML
services:
  conduwuit:
    command:
      - /sbin/conduwuit
      - --execute
      - "users create-user ${ADMIN_USER} ${ADMIN_PASS}"
YAML
trap "rm -f '$BOOTSTRAP_OVERRIDE'" EXIT

echo "Creating admin Matrix user via conduwuit admin console ..."
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

# Restart without --execute immediately to avoid crash loop (user already exists on restart)
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

# --- Login to get the admin access token ---
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

ADMIN_TOKEN=""
if [ -n "${MATRIX_ACCESS_TOKEN:-}" ]; then
  whoami=$(curl -s "${HOMESERVER}/_matrix/client/v3/account/whoami" \
    -H "Authorization: Bearer ${MATRIX_ACCESS_TOKEN}" 2>/dev/null)
  if echo "$whoami" | jq -e '.user_id' >/dev/null 2>&1; then
    echo "Reusing existing admin token from .env"
    ADMIN_TOKEN="${MATRIX_ACCESS_TOKEN}"
  fi
fi

if [ -z "${ADMIN_TOKEN}" ]; then
  echo "Logging in @${ADMIN_USER}:local ..."
  ADMIN_TOKEN=$(login "${ADMIN_USER}" "${ADMIN_PASS}") || {
    echo "ERROR: failed to login admin user" >&2
    exit 1
  }
  echo "  OK"
fi

# --- Output ---
echo
echo "=========================================="
echo "  Add these lines to your .env file:"
echo "=========================================="
cat <<EOF

MATRIX_ACCESS_TOKEN=${ADMIN_TOKEN}
MATRIX_BOT_USER_ID=@${ADMIN_USER}:local

EOF
echo "Then start the stack with: make up"
echo "Manage agents at:           http://localhost:${ADMIN_PORT:-4000}"
