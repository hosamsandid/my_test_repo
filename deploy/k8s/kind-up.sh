#!/bin/bash
set -euo pipefail

# One-shot local Kubernetes bring-up for the Agent Studio POC.
#
#   ./deploy/k8s/kind-up.sh
#
# What it does (idempotent, safe to re-run):
#   1. checks prerequisites (podman, kind, kubectl, jq, .env)
#   2. creates a single-node kind cluster (Podman provider) if missing
#   3. builds the 4 images with podman and loads them into the kind node
#      (no registry anywhere — mirrors the GCP no-Artifact-Registry reality)
#   4. applies namespace / RBAC / PVCs / conduwuit
#   5. bootstraps the Matrix admin user + token into .env if needed
#      (k8s equivalent of orchestrator/setup.sh: temporarily patches the
#      conduwuit Deployment with `--execute "users create-user …"`)
#   6. renders .env into the agent-studio-env Secret
#   7. applies orchestrator / admin-console / bp-explorer and waits for rollout
#
# Afterwards (4100, NOT 4000 — the compose stack owns :4000 locally):
#   kubectl -n agent-studio port-forward svc/admin-console 4100:4000
#   open http://localhost:4100
#
# Compatible with bash 3.2 (macOS default).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MANIFESTS="${SCRIPT_DIR}/manifests"
# The k8s stack keeps its OWN env file so it can coexist with the compose
# stack: the two homeservers are separate databases with different Matrix
# tokens, and the bootstrap below writes the token back into this file —
# sharing .env would corrupt the compose stack's credentials. On first run
# .env.k8s is seeded from .env (LLM endpoint, admin creds, etc.).
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.k8s}"
if [ ! -f "$ENV_FILE" ] && [ -f "${REPO_ROOT}/.env" ]; then
  cp "${REPO_ROOT}/.env" "$ENV_FILE"
  echo "[kind-up] created ${ENV_FILE} from .env (k8s stack uses its own env file)"
fi

CLUSTER_NAME="${CLUSTER_NAME:-agent-studio}"
NAMESPACE="agent-studio"
SECRET_NAME="agent-studio-env"
# Local port used only for the bootstrap port-forward (avoid clashing with a
# concurrently running compose stack on 8448).
BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-18448}"

log()  { echo "[kind-up] $*"; }
fail() { echo "[kind-up] ERROR: $*" >&2; exit 1; }

# --- 1. prerequisites -------------------------------------------------------
for tool in podman kind kubectl jq curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required (brew install $tool)"
done
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found — run: cp .env.example .env"

# kind needs a container engine. A `docker` CLI may exist but point at a dead
# daemon (e.g. a stopped colima) — probe the daemon, don't trust the binary.
if ! docker info >/dev/null 2>&1; then
  export KIND_EXPERIMENTAL_PROVIDER=podman
  log "docker daemon not reachable — using kind with the Podman provider"
fi

podman info >/dev/null 2>&1 || fail "podman is not running — start it with: podman machine start"

# --- 2. cluster -------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  log "kind cluster '$CLUSTER_NAME' already exists"
else
  log "creating kind cluster '$CLUSTER_NAME' ..."
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
fi
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null

# --- 3. images --------------------------------------------------------------
# Build with podman, then load into the kind node's containerd. Images are
# tagged into docker.io/library/ because that is how Kubernetes normalizes a
# bare image name like `as-agent:latest` (podman would otherwise tag them
# localhost/..., which the kubelet would not match).
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

build_and_load() {
  local name="$1" context="$2"; shift 2
  local ref="docker.io/library/${name}:latest"
  log "building ${name} ..."
  podman build -t "$ref" "$@" "$context"
  log "loading ${name} into kind ..."
  local archive
  archive="$(mktemp -t "${name}.XXXXXX").tar"
  podman save --output "$archive" "$ref"
  kind load image-archive --name "$CLUSTER_NAME" "$archive"
  rm -f "$archive"
}

build_and_load agent-studio-orchestrator  "${REPO_ROOT}/orchestrator"
build_and_load agent-studio-admin-console "${REPO_ROOT}/admin-console" \
  --build-arg "GIT_COMMIT=${GIT_COMMIT}" --build-arg "GIT_DIRTY="
build_and_load agent-studio-bp-explorer   "${REPO_ROOT}/bp-explorer"
build_and_load as-agent "${REPO_ROOT}/agent-image" -f "${REPO_ROOT}/agent-image/Dockerfile"

# --- 4. base resources + conduwuit ------------------------------------------
kubectl apply -f "${MANIFESTS}/00-namespace.yaml"
kubectl apply -f "${MANIFESTS}/10-rbac.yaml"
kubectl apply -f "${MANIFESTS}/20-storage.yaml"
kubectl apply -f "${MANIFESTS}/30-conduwuit.yaml"
log "waiting for conduwuit ..."
kubectl -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=180s

# --- 5. Matrix admin bootstrap ----------------------------------------------
# Reads ADMIN_USER / MATRIX_ACCESS_TOKEN from .env; creates the admin user +
# token against the FRESH in-cluster homeserver when the token is absent or
# invalid (a token from the compose stack won't work here — different DB).
set -a; . "$ENV_FILE"; set +a
ADMIN_USER="${ADMIN_USER:-admin}"
HOMESERVER="http://localhost:${BOOTSTRAP_PORT}"

PF_PID=""
start_port_forward() {
  kubectl -n "$NAMESPACE" port-forward svc/conduwuit "${BOOTSTRAP_PORT}:6167" >/dev/null 2>&1 &
  PF_PID=$!
  for i in $(seq 1 20); do
    curl -sf "${HOMESERVER}/_matrix/client/versions" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "cannot reach conduwuit through port-forward on :${BOOTSTRAP_PORT}"
}
# kill + wait reaps the background port-forward silently — without the wait,
# bash prints an async "Terminated: 15" job notice that reads like an error.
stop_port_forward() {
  [ -n "$PF_PID" ] || return 0
  { kill "$PF_PID" && wait "$PF_PID"; } 2>/dev/null || true
  PF_PID=""
}
trap stop_port_forward EXIT

start_port_forward

token_valid() {
  [ -n "${1:-}" ] || return 1
  curl -s "${HOMESERVER}/_matrix/client/v3/account/whoami" \
    -H "Authorization: Bearer $1" | jq -e '.user_id' >/dev/null 2>&1
}

if token_valid "${MATRIX_ACCESS_TOKEN:-}"; then
  log "existing MATRIX_ACCESS_TOKEN is valid against the in-cluster homeserver"
else
  log "bootstrapping Matrix admin user @${ADMIN_USER}:local ..."
  if [ -z "${ADMIN_PASS:-}" ]; then
    echo -n "Password for MATRIX admin user @${ADMIN_USER}:local (homeserver admin — NOT the console login): "
    read -rs ADMIN_PASS; echo
    [ -n "$ADMIN_PASS" ] || fail "empty password"
  fi

  # k8s equivalent of setup.sh's compose override: run conduwuit once with
  # --execute to create the user, then revert to the normal command.
  PATCH_ADD=$(jq -cn --arg cmd "users create-user ${ADMIN_USER} ${ADMIN_PASS}" '[
    {op:"add", path:"/spec/template/spec/containers/0/command", value:["/sbin/conduwuit"]},
    {op:"add", path:"/spec/template/spec/containers/0/args",    value:["--execute", $cmd]}
  ]')
  kubectl -n "$NAMESPACE" patch deploy/conduwuit --type=json -p "$PATCH_ADD" >/dev/null
  kubectl -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=120s >/dev/null
  kubectl -n "$NAMESPACE" patch deploy/conduwuit --type=json -p '[
    {"op":"remove", "path":"/spec/template/spec/containers/0/command"},
    {"op":"remove", "path":"/spec/template/spec/containers/0/args"}
  ]' >/dev/null
  kubectl -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=120s >/dev/null

  stop_port_forward; start_port_forward # pod changed — re-establish

  login_resp=$(curl -s -X POST "${HOMESERVER}/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"${ADMIN_USER}\"},\"password\":\"${ADMIN_PASS}\"}")
  MATRIX_ACCESS_TOKEN=$(echo "$login_resp" | jq -r '.access_token // empty')
  [ -n "$MATRIX_ACCESS_TOKEN" ] || fail "admin login failed: $login_resp"
  log "admin token obtained"
fi

# Resolve the conduwuit admin room via the #admins:local alias (id differs per DB).
ADMIN_ROOM=""
for i in $(seq 1 10); do
  ADMIN_ROOM=$(curl -s "${HOMESERVER}/_matrix/client/v3/directory/room/%23admins%3Alocal" \
    -H "Authorization: Bearer ${MATRIX_ACCESS_TOKEN}" | jq -r '.room_id // empty')
  [ -n "$ADMIN_ROOM" ] && break
  sleep 1
done
[ -n "$ADMIN_ROOM" ] || fail "cannot resolve #admins:local"
CONDUWUIT_ADMIN_ROOM="$ADMIN_ROOM"
log "admin room: ${CONDUWUIT_ADMIN_ROOM}"

# Persist back to .env (same awk upsert as setup.sh, sed -i-free for macOS).
set_env_var() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^"key"=" { print key"="value; found = 1; next }
    { print }
    END { if (!found) print key"="value }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}
set_env_var MATRIX_ACCESS_TOKEN "$MATRIX_ACCESS_TOKEN"
set_env_var CONDUWUIT_ADMIN_ROOM "$CONDUWUIT_ADMIN_ROOM"

# --- 6. secret from .env -----------------------------------------------------
# Strip comments/blank lines and surrounding quotes (compose strips them;
# kubectl --from-env-file would keep them literally). Adds the derived
# ADMIN_USER_ID, which compose computes inline.
SECRET_ENV=$(mktemp)
trap 'stop_port_forward; rm -f "$SECRET_ENV"' EXIT
# Keys re-emitted explicitly below are filtered out here — kubectl
# --from-env-file rejects duplicate keys.
grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
  | grep -Ev '^(MATRIX_ACCESS_TOKEN|CONDUWUIT_ADMIN_ROOM|ADMIN_USER_ID)=' \
  | sed -e 's/^\([^=]*\)="\(.*\)"$/\1=\2/' -e "s/^\([^=]*\)='\(.*\)'\$/\1=\2/" \
  > "$SECRET_ENV"
{
  echo "MATRIX_ACCESS_TOKEN=${MATRIX_ACCESS_TOKEN}"
  echo "CONDUWUIT_ADMIN_ROOM=${CONDUWUIT_ADMIN_ROOM}"
  echo "ADMIN_USER_ID=@${ADMIN_USER}:local"
} >> "$SECRET_ENV"
kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-env-file="$SECRET_ENV" --dry-run=client -o yaml | kubectl apply -f -

# --- 7. the rest of the stack ------------------------------------------------
kubectl apply -f "${MANIFESTS}/40-orchestrator.yaml"
kubectl apply -f "${MANIFESTS}/50-admin-console.yaml"
kubectl apply -f "${MANIFESTS}/60-bp-explorer.yaml"
# Pick up changed images/secret even when the manifests are unchanged.
kubectl -n "$NAMESPACE" rollout restart deploy/orchestrator deploy/admin-console deploy/bp-explorer >/dev/null
for d in orchestrator admin-console bp-explorer; do
  log "waiting for ${d} ..."
  kubectl -n "$NAMESPACE" rollout status "deploy/${d}" --timeout=180s
done

# --- 8. seed the skill pool ---------------------------------------------------
# k8s equivalent of `make seed-pool`: the compose targets fill the skills-pool
# volume via helper containers; here we kubectl-cp the same content into the
# skills PVC through the admin-console pod (the only RW mount at /pool).
POOL_POD=$(kubectl -n "$NAMESPACE" get pod -l app.kubernetes.io/component=admin-console \
  -o jsonpath='{.items[0].metadata.name}')
log "seeding skill pool into PVC via ${POOL_POD} ..."
kubectl -n "$NAMESPACE" cp "${REPO_ROOT}/orchestrator/skill-pool/." "${POOL_POD}:/pool/"
kubectl -n "$NAMESPACE" cp "${REPO_ROOT}/mcp-servers/." "${POOL_POD}:/pool/mcp-servers/"
kubectl -n "$NAMESPACE" exec "$POOL_POD" -- ls /pool

echo
log "done. Agent Studio is running on kind cluster '${CLUSTER_NAME}'."
echo
echo "  Open the console:"
echo "    kubectl -n ${NAMESPACE} port-forward svc/admin-console 4100:4000"
echo "    open http://localhost:4100"
echo "    (4100 on purpose — the compose stack owns :4000; console login = ADMIN_USERNAME/ADMIN_PASSWORD from .env)"
echo
echo "  Watch agent pods appear as you enable agents:"
echo "    kubectl -n ${NAMESPACE} get pods -l app.kubernetes.io/component=as-agent -w"
echo
echo "  Tear down:  kind delete cluster --name ${CLUSTER_NAME}"
