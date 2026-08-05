#!/bin/bash
# Tear down the dedicated KIND e2e stack (#1319): reap the port-forwards
# started by kind-stack-up.sh, then delete the whole cluster — everything the
# stack owned (pods, PVCs, secrets, side-loaded images) lives inside the kind
# node container, so cluster deletion is the complete cleanup. The dev kind
# cluster (`agent-studio`) and both compose stacks are untouched.
# Best-effort like stack-down.sh: never abort on a single cleanup failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CLUSTER_NAME="${CLUSTER_NAME:-agent-studio-e2e}"
KIND_E2E_DIR="$REPO_ROOT/e2e/.kind-e2e"

# Same provider probe as kind-up.sh: with a dead docker daemon, a bare `kind
# get clusters` ERRORS (it can't list) — which read as "nothing to delete" and
# silently left the cluster running. Probe the daemon, fall back to podman.
if ! docker info >/dev/null 2>&1; then
  export KIND_EXPERIMENTAL_PROVIDER=podman
fi

echo "=== Tearing down kind e2e stack (${CLUSTER_NAME}) ==="

for pidfile in "$KIND_E2E_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  # The pid is a restart LOOP (kind-stack-up.sh): kill it first so it cannot
  # respawn kubectl, then reap its current kubectl child.
  pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  pkill -P "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$pidfile"
done
rm -rf "$KIND_E2E_DIR"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  kind delete cluster --name "$CLUSTER_NAME" || true
else
  echo "kind cluster '${CLUSTER_NAME}' not present — nothing to delete"
fi

echo "=== kind e2e stack removed ==="
