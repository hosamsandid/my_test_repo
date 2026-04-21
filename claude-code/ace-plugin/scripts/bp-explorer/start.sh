#!/usr/bin/env bash
# Start the Agent Dashboard in Docker.
# Run from anywhere inside the repository.
set -euo pipefail
cd "$(dirname "$0")"
docker compose up --build -d
echo ""
echo "Agent Dashboard running at http://localhost:8765"
echo "Stop with: docker compose -f scripts/bp-explorer/docker-compose.yml down"
