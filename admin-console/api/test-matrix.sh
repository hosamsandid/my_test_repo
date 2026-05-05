#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Smoke test for the /api/matrix/* proxy endpoints.
#
# Hits the admin-console API (default http://localhost:4000) and exercises:
#   1. GET  /api/matrix/agents                 — list enabled agents
#   2. POST /api/matrix/agents/:agentId/dm     — create or reuse DM room
#   3. POST /api/matrix/rooms/:roomId/messages — send a "Hello from curl" line
#   4. GET  /api/matrix/rooms/:roomId/messages — fetch recent history
#
# Usage:
#   ./admin-console/api/test-matrix.sh                    # uses first enabled agent
#   ./admin-console/api/test-matrix.sh <agent-id>         # specific agent
#   API_BASE=http://localhost:4000 ./test-matrix.sh       # override base URL
#
# Requires: curl, jq.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4000}"
AGENT_ID="${1:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

echo "==> [1/4] GET ${API_BASE}/api/matrix/agents"
agents_json="$(curl -fsS "${API_BASE}/api/matrix/agents")"
echo "${agents_json}" | jq .

if [[ -z "${AGENT_ID}" ]]; then
  AGENT_ID="$(echo "${agents_json}" | jq -r '.[0].id // empty')"
  if [[ -z "${AGENT_ID}" ]]; then
    echo "error: no enabled agents with Matrix tokens found" >&2
    exit 1
  fi
  echo "    (auto-selected agent: ${AGENT_ID})"
fi

echo
echo "==> [2/4] POST ${API_BASE}/api/matrix/agents/${AGENT_ID}/dm"
dm_json="$(curl -fsS -X POST -H 'Content-Type: application/json' \
  "${API_BASE}/api/matrix/agents/${AGENT_ID}/dm")"
echo "${dm_json}" | jq .
ROOM_ID="$(echo "${dm_json}" | jq -r '.roomId')"
if [[ -z "${ROOM_ID}" || "${ROOM_ID}" == "null" ]]; then
  echo "error: no roomId in response" >&2
  exit 1
fi

echo
echo "==> [3/4] POST ${API_BASE}/api/matrix/rooms/${ROOM_ID}/messages"
send_json="$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"body\":\"Hello from curl @ $(date -u +%FT%TZ)\"}" \
  "${API_BASE}/api/matrix/rooms/${ROOM_ID}/messages")"
echo "${send_json}" | jq .

echo
echo "==> [4/4] GET ${API_BASE}/api/matrix/rooms/${ROOM_ID}/messages?dir=b&limit=10"
curl -fsS "${API_BASE}/api/matrix/rooms/$(printf %s "${ROOM_ID}" | jq -sRr @uri)/messages?dir=b&limit=10" \
  | jq '{start, end, chunk: (.chunk // [] | map({event_id, sender, type, content: (.content // {} | {body, msgtype})}))}'

echo
echo "ok — agent='${AGENT_ID}' room='${ROOM_ID}'"
