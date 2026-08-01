#!/bin/bash
set -euo pipefail

# GCE startup script (runs as root on first boot of the Fedora Cloud VM).
# Installs everything the Agent Studio stack needs at the host level.
# The stack itself is brought up later, per-user, by vm-stack-setup.sh.

exec >>/var/log/agent-studio-bootstrap.log 2>&1
echo "=== agent-studio bootstrap $(date -Is) ==="

# Podman 5.x (Fedora default), git for repo updates, make for the Makefile,
# jq for orchestrator/setup.sh.
dnf install -y podman git make jq

# docker-compose v2 — the compose provider `podman compose` delegates to.
# (podman-compose from dnf would also work; docker-compose is closer to what
# the stack is developed against.)
if [ ! -x /usr/local/bin/docker-compose ]; then
  curl -fsSL -o /usr/local/bin/docker-compose \
    "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64"
  chmod +x /usr/local/bin/docker-compose
fi

# OS Login is org-enforced; plain osLogin does not guarantee sudo. The pilot
# operator needs root for linger/package fixes, so grant it explicitly.
# Adjust/remove for anything beyond the temporary pilot.
echo "k_zyskowski_accenture_com ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-agent-studio-operator
chmod 0440 /etc/sudoers.d/90-agent-studio-operator

# Dedicated local service user for the stack. systemd cannot resolve OS Login
# users (their NSS module is invisible to PID 1), so linger + `systemctl
# --user` — which rootless podman needs — only work for a real local user.
# Operators reach it via `sudo -H -u aee`.
id aee >/dev/null 2>&1 || useradd -m aee
# loginctl (not a manual flag-file touch) — logind must register the linger
# live, otherwise it kills the user manager (and all containers) as soon as
# the last aee session closes.
loginctl enable-linger aee

echo "=== bootstrap done $(date -Is) ==="
