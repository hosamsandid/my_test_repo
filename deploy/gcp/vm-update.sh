#!/bin/bash
set -euo pipefail

# Updates the running Agent Studio stack on the GCP VM from a repo tarball.
# This is the SINGLE on-VM update path, shared by both deployment flows so
# they cannot drift:
#   - GitHub Actions: the self-hosted runner on the VM (running as `aee`)
#     calls this after actions/checkout (see .github/workflows/deploy-gcp.yml)
#   - Manual: deploy/gcp/deploy.sh copies the tarball + this script over IAP
#
# Never touches .env — that is VM-local state (secrets, ports, socket path).
#
# Usage: vm-update.sh <repo-tarball.tar.gz>

TARBALL="${1:?usage: vm-update.sh <repo-tarball.tar.gz>}"
STACK_DIR="${STACK_DIR:-$HOME/agent-studio}"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
tar -xzf "${TARBALL}" -C "${STAGE}"
test -f "${STAGE}/docker-compose.yml" || { echo "ERROR: tarball has no docker-compose.yml at its root" >&2; exit 1; }

echo "=== sync new tree into ${STACK_DIR} (keeping .env) ==="
rsync -a --delete --exclude='.env' "${STAGE}/" "${STACK_DIR}/"

cd "${STACK_DIR}"
# Makefile + compose read COMPOSE_PROJECT_NAME etc. from the environment
set -a; . ./.env; set +a

echo "=== rebuild + restart changed services ==="
make up
make seed-pool || echo "WARN: seed-pool non-fatal failure (i-sase skill is optional)"

echo "=== health check ==="
sleep 3
curl -sf -o /dev/null "http://localhost:${ADMIN_PORT:-14000}/login"
echo "deploy ok: console answers on :${ADMIN_PORT:-14000}"
