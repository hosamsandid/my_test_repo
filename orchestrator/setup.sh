#!/bin/bash
set -euo pipefail

# One-shot bootstrap for a fresh Conduwuit installation.
#
# Creates the admin (human) user via conduwuit's --execute flag, logs in via
# the Matrix API to obtain the admin access token, resolves the conduwuit
# admin room via the #admins:local alias, and writes both values directly
# into ./.env. After this completes, `make up` brings the rest of the stack
# up with the correct Matrix wiring already in place.
#
# After bootstrap, manage all agents via the Admin Console. Each agent runs
# as its own Matrix user; conversations happen as direct messages between
# the human and a single agent — there is no shared room.
#
# Compatible with bash 3.2 (macOS default).

# Source the env file from repo root if present (picks up ADMIN_USER,
# HOMESERVER, etc.). ENV_FILE is overridable so the E2E harness can bootstrap
# against a generated .env.e2e without touching the developer's real .env
# (defaults to ../.env — unchanged behaviour when unset).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/../.env}"
if [ -f "${ENV_FILE}" ]; then
  set -a; . "${ENV_FILE}"; set +a
fi

HOMESERVER="${HOMESERVER:-http://localhost:${CONDUWUIT_PORT:-8448}}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.yml"
# The compose invocation prefix (files + project + env-file). Overridable so the
# E2E harness can point it at the e2e overlay/project; defaults to the base file
# alone — unchanged behaviour when unset.
COMPOSE_CMD="${COMPOSE_CMD:-podman compose -f ${COMPOSE_FILE}}"

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
${COMPOSE_CMD} -f "${BOOTSTRAP_OVERRIDE}" up -d --no-deps conduwuit >/dev/null 2>&1

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
${COMPOSE_CMD} up -d --no-deps conduwuit >/dev/null 2>&1
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

# --- Resolve admin room ID via the #admins:<server> alias ---
# Conduwuit creates an admin control room on first start and registers the
# alias for it. The room ID is non-deterministic across instances, so we
# query the alias each time and cache the result in .env.
echo -n "Resolving admin room (#admins:local) "
ADMIN_ROOM=""
for i in $(seq 1 10); do
  ADMIN_ROOM=$(curl -s "${HOMESERVER}/_matrix/client/v3/directory/room/%23admins%3Alocal" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" 2>/dev/null \
    | jq -r '.room_id // empty' 2>/dev/null) || true
  if [ -n "$ADMIN_ROOM" ]; then
    echo " ${ADMIN_ROOM}"
    break
  fi
  echo -n "."
  sleep 1
done
if [ -z "$ADMIN_ROOM" ]; then
  echo
  echo "ERROR: cannot resolve #admins:local — is conduwuit fully started?" >&2
  exit 1
fi

# --- Persist values to the env file (ENV_FILE, resolved at the top) ---
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Run: cp .env.example .env" >&2
  exit 1
fi

# Replace KEY=... line in-place, or append if missing. Portable across
# bash 3.2 and the macOS / GNU sed split (avoids `sed -i` entirely).
set_env_var() {
  local key="$1" value="$2"
  local tmp
  tmp=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^"key"=" { print key"="value; found = 1; next }
    { print }
    END { if (!found) print key"="value }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}

set_env_var MATRIX_ACCESS_TOKEN "$ADMIN_TOKEN"
set_env_var CONDUWUIT_ADMIN_ROOM "$ADMIN_ROOM"

echo
echo "=========================================="
echo "  Bootstrap complete"
echo "=========================================="
echo
echo "  Admin user:    @${ADMIN_USER}:local"
echo "  Admin room:    ${ADMIN_ROOM}"
echo "  .env updated:  ${ENV_FILE}"
echo "                 (MATRIX_ACCESS_TOKEN, CONDUWUIT_ADMIN_ROOM)"
echo
echo "Next: make up"
echo "Then: http://localhost:${ADMIN_PORT:-4000}"
