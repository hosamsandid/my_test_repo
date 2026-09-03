#!/bin/bash
set -euo pipefail

# Runs ON the VM as the operating (OS Login) user, after:
#   - vm-bootstrap.sh has finished (see /var/log/agent-studio-bootstrap.log)
#   - the repo tarball has been copied to ~/agent-studio.tar.gz
#   - a prepared .env has been copied to ~/agent-studio.env
#     (ANTHROPIC_* carried over from the source machine; MATRIX_ACCESS_TOKEN
#      and CONDUWUIT_ADMIN_ROOM left for setup.sh to fill in)
#
# Idempotent: safe to re-run after a failure.

STACK_DIR="${STACK_DIR:-$HOME/agent-studio}"
ADMIN_PASS="${ADMIN_PASS:?set ADMIN_PASS (Matrix admin password) in the environment}"

echo "=== [1/6] rootless podman socket ==="
# Runs as the local service user `aee` (created + lingered by vm-bootstrap.sh;
# linger keeps the podman socket + containers alive without an SSH session).
# Non-interactive sudo sessions carry no user-bus env, so set it explicitly.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user enable --now podman.socket
SOCK="${XDG_RUNTIME_DIR}/podman/podman.sock"
test -S "${SOCK}" && echo "socket ok: ${SOCK}"

echo "=== [2/6] unpack repo ==="
mkdir -p "${STACK_DIR}"
tar -xzf "$HOME/agent-studio.tar.gz" -C "${STACK_DIR}"
cp "$HOME/agent-studio.env" "${STACK_DIR}/.env"

echo "=== [3/6] host files the compose mounts expect ==="
# The orchestrator's baseline SSH identity is OPTIONAL (ORCHESTRATOR_SSH_KEY,
# defaults to /dev/null in docker-compose.yml). We still generate a fresh
# keypair for the pilot and point the var at it in [4/6] so the orchestrator can
# clone an environment's repositories over SSH — replace it with a real GitHub
# deploy key when the orchestrator should push.
#
# ~/.gitconfig used to be generated here too, because bp-explorer bind-mounted
# it and refused to start without it. That service was deleted in #1963 and no
# compose service mounts the file any more, so the VM no longer needs one.
if [ ! -f "$HOME/.ssh/id_orchestrator" ]; then
  ssh-keygen -t ed25519 -N "" -C "agent-studio-pilot" \
    -f "$HOME/.ssh/id_orchestrator"
fi

echo "=== [4/6] pin VM-specific .env values ==="
cd "${STACK_DIR}"
# Rootless socket path for this uid (compose default is the macOS uid-501 path)
grep -q '^PODMAN_HOST_SOCKET=' .env \
  && sed -i "s|^PODMAN_HOST_SOCKET=.*|PODMAN_HOST_SOCKET=${SOCK}|" .env \
  || echo "PODMAN_HOST_SOCKET=${SOCK}" >> .env
# Point the optional orchestrator baseline SSH key at the pilot key from [3/6].
grep -q '^ORCHESTRATOR_SSH_KEY=' .env \
  && sed -i "s|^ORCHESTRATOR_SSH_KEY=.*|ORCHESTRATOR_SSH_KEY=${HOME}/.ssh/id_orchestrator|" .env \
  || echo "ORCHESTRATOR_SSH_KEY=${HOME}/.ssh/id_orchestrator" >> .env
# Console credentials: never ship the admin/admin default on a cloud host.
# (tr on /dev/urandom, not openssl — Fedora Cloud minimal doesn't ship openssl)
if ! grep -q '^ADMIN_PASSWORD=' .env; then
  echo "ADMIN_USERNAME=admin"                                          >> .env
  echo "ADMIN_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)" >> .env
fi
if ! grep -q '^AUTH_SESSION_SECRET=' .env; then
  echo "AUTH_SESSION_SECRET=$(tr -dc 'a-f0-9' </dev/urandom | head -c 64)" >> .env
fi
# Pin the hosted ports regardless of what the source .env used. Console on
# 14000 (NOT 4000 — that's reserved for local development on operator
# machines; the firewall + all tunnel docs use 14000).
sed -i 's/^ADMIN_PORT=.*/ADMIN_PORT=14000/; s/^CONDUWUIT_PORT=.*/CONDUWUIT_PORT=8448/' .env

echo "=== [5/6] bootstrap conduwuit admin user (writes Matrix token to .env) ==="
ADMIN_PASS="${ADMIN_PASS}" ENV_FILE="${STACK_DIR}/.env" ./orchestrator/setup.sh

echo "=== [6/6] build + start the stack ==="
# The Makefile reads COMPOSE_PROJECT_NAME (volume names!) from the
# environment, not from .env — export everything so `make`/seeds and
# compose agree on volume naming.
set -a; . ./.env; set +a
make up
make seed-pool || echo "WARN: seed-pool had a non-fatal failure (i-sase skill is optional)"

echo "=== boot autostart unit (rootless 'restart: unless-stopped' does not survive reboots) ==="
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/agent-studio.service <<UNIT
[Unit]
Description=Agent Studio compose stack
Wants=podman.socket network-online.target
After=podman.socket network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${STACK_DIR}
ExecStart=/bin/bash -c 'set -a; . ./.env; set +a; podman compose -f docker-compose.yml up -d'
ExecStop=/bin/bash -c 'set -a; . ./.env; set +a; podman compose -f docker-compose.yml down'
TimeoutStartSec=600

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable agent-studio.service

echo ""
echo "Stack is up. Console credentials are in ${STACK_DIR}/.env (ADMIN_PASSWORD)."
echo "Access from your workstation:"
echo "  gcloud compute start-iap-tunnel agent-studio-pilot 14000 \\"
echo "    --local-host-port=localhost:14000 --zone=europe-west3-b --project=acn-projectroots"
