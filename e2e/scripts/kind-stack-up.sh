#!/bin/bash
set -euo pipefail

# Bring up the dedicated KIND e2e stack and make it reachable from the host
# (#1319) — the kind counterpart of stack-up.sh. One command flow:
#
#   deploy/k8s/kind-up.sh --e2e   cluster + images + manifests + e2e fakes
#   port-forwards                 console :4110, fake-github :4114
#   post-up-config.sh             readiness + mock LLM provider registration
#
# Ports: compose dev owns :4000, compose e2e :4010/:4014, dev kind :4100 —
# the e2e kind stack takes :4110/:4114 so all four can coexist.
#
# The Playwright run then targets it WITHOUT bringing up the compose stack:
#   E2E_SKIP_STACK=1 E2E_BASE_URL=http://localhost:4110 \
#   E2E_FAKE_GITHUB_URL=http://localhost:4114 E2E_LANE=ci,kind \
#   npx playwright test --project=journeys
# (`make e2e-kind` wraps exactly that.)
#
# Pair with kind-stack-down.sh, which kills the port-forwards and deletes the
# cluster. Re-running this script is safe: kind-up is idempotent and the
# port-forwards are restarted.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NAMESPACE=agent-studio
KIND_E2E_DIR="$REPO_ROOT/e2e/.kind-e2e"
CONSOLE_PORT="${E2E_KIND_CONSOLE_PORT:-4110}"
FAKE_GITHUB_PORT="${E2E_KIND_FAKE_GITHUB_PORT:-4114}"

# --- 1. cluster + stack -------------------------------------------------------
"$REPO_ROOT/deploy/k8s/kind-up.sh" --e2e

# --- 2. port-forwards ---------------------------------------------------------
# Background kubectl port-forwards, PIDs persisted so kind-stack-down.sh (or a
# re-run here) can reap them. A stale forward from a previous run would hold
# the port, so kill first. Each forward runs in a RESTART LOOP: kubectl
# port-forward exits on the first connection error (a known kubectl
# behaviour), which would otherwise fail every request after one hiccup —
# observed as sporadic "socket hang up" mid-journey. One in-flight request
# still fails when the tunnel drops; the loop is back within a second.
mkdir -p "$KIND_E2E_DIR"
kill_pf() { # pidfile — kill the loop FIRST (no restart race), then its child
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  pkill -P "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$1"
}
start_pf() { # name svc portmap
  local name="$1" svc="$2" portmap="$3"
  # The subshell fully detaches its stdio: an inherited stdout would hold any
  # pipe reading THIS script (tee in CI) open forever after the script exits.
  (
    exec </dev/null >>"$KIND_E2E_DIR/${name}.port-forward.log" 2>&1
    while true; do
      kubectl -n "$NAMESPACE" port-forward "svc/${svc}" "$portmap"
      echo "[kind-stack-up] ${name} port-forward exited; restarting"
      sleep 1
    done
  ) &
  echo $! > "$KIND_E2E_DIR/${name}.pid"
}
kill_pf "$KIND_E2E_DIR/console.pid"
kill_pf "$KIND_E2E_DIR/fake-github.pid"
start_pf console admin-console "${CONSOLE_PORT}:4000"
start_pf fake-github fake-github "${FAKE_GITHUB_PORT}:80"

# --- 3. post-up configuration (shared with the compose stack) ------------------
# No STT service in the k8s manifests, and journeys create their own agents —
# so both compose-only extras stay off.
ADMIN_BASE="http://localhost:${CONSOLE_PORT}" \
  ADMIN_USERNAME=admin \
  ADMIN_PASSWORD=e2e-admin-pass \
  MOCK_LLM_BASE_URL="http://fake-github" \
  WITH_STT=0 \
  WITH_E2E_AGENT=0 \
  "$SCRIPT_DIR/post-up-config.sh"

# fake-github reachable from the host? (journey gh.* steps assert against it)
if ! curl -sf -o /dev/null "http://localhost:${FAKE_GITHUB_PORT}/_state"; then
  echo "ERROR: fake-github not reachable on :${FAKE_GITHUB_PORT}" >&2
  exit 1
fi

echo
echo "=========================================="
echo "  kind e2e stack ready"
echo "  Admin console: http://localhost:${CONSOLE_PORT}"
echo "  fake-github:   http://localhost:${FAKE_GITHUB_PORT}"
echo "  Run journeys:  make e2e-kind (or the npx line in this header)"
echo "  Tear down:     e2e/scripts/kind-stack-down.sh"
echo "=========================================="
