#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Smoke test for the /api/agents/:agentId/session/:roomId endpoints.
#
# Hits the admin-console API (default http://localhost:4000) and exercises:
#   1. GET /api/agents/foo/session/!room123:local              — static backfill
#   2. GET /api/agents/foo/session/!room123:local/stream       — SSE tail (5 s)
#
# ──────────────────────────────────────────────────────────────────────────────
# PREREQUISITES
# ──────────────────────────────────────────────────────────────────────────────
# 1. The admin-console container must be running and reachable at API_BASE.
#    From the repo root:
#        make up
#
# 2. A session-log file must exist at the path the API expects. Inside the
#    container that path is `/workspace/agents/foo/sessions/!room123:local.jsonl`.
#    Because the host bind-mounts `/workspace` into the admin-console container
#    (see docker-compose.yml), creating the file on the *host* makes it visible
#    to the API. Adapt as needed for your setup. For a quick host-side test
#    (without containers) run the API with `WORKSPACE=/tmp/agent-studio-test`:
#
#        mkdir -p /tmp/agent-studio-test/agents/foo/sessions
#        printf '{"ts":"2026-01-01T00:00:00Z","type":"message.received","from":"@u:local","body":"hi"}\n{"ts":"2026-01-01T00:00:01Z","type":"assistant_text","text":"hello"}\n' \
#          > '/tmp/agent-studio-test/agents/foo/sessions/!room123:local.jsonl'
#
# Usage:
#   ./admin-console/api/test-session-log.sh
#   API_BASE=http://localhost:4000 ./test-session-log.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4000}"
AGENT_ID="${AGENT_ID:-foo}"
ROOM_ID="${ROOM_ID:-!room123:local}"

# URL-encode the room id so the leading ! and the colon survive transit.
encoded_room="$(printf %s "${ROOM_ID}" | sed 's/!/%21/g; s/:/%3A/g')"

echo "==> [1/2] GET ${API_BASE}/api/agents/${AGENT_ID}/session/${ROOM_ID}"
curl -fsS "${API_BASE}/api/agents/${AGENT_ID}/session/${encoded_room}" || true
echo

echo
echo "==> [2/2] GET ${API_BASE}/api/agents/${AGENT_ID}/session/${ROOM_ID}/stream  (5 s tail)"
# `--max-time 5` cleanly terminates the long-lived SSE stream.
curl -fsS --max-time 5 -N \
  "${API_BASE}/api/agents/${AGENT_ID}/session/${encoded_room}/stream" || true

echo
echo "ok"
