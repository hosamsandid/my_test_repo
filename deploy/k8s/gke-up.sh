#!/bin/bash
set -euo pipefail

# Deploy Agent Studio to the stage-1 GKE cluster (single node, RWO storage,
# no Filestore — see docs/hosting/gcp/). Sibling of kind-up.sh: same manifests,
# with images rewritten to Artifact Registry and pull policy set for a real
# registry. Idempotent, safe to re-run.
#
#   ./deploy/k8s/gke-up.sh
#
# Prerequisites (one-time, done outside this script):
#   - GKE cluster `agent-studio` in europe-west3-b (gcloud container clusters create …)
#   - AR repo europe-west3-docker.pkg.dev/acn-projectroots/agent-studio
#   - images pushed there (podman push …) — MUST be linux/amd64: GKE nodes are
#     x86_64, so on an Apple Silicon Mac build with
#       podman build --platform linux/amd64 -t <AR>/<image>:latest …
#     (a default arm64 build crash-loops on GKE with "exec format error")
#   - gke-gcloud-auth-plugin on PATH
#
# What it does:
#   1. switches kubectl to the GKE context
#   2. applies namespace / RBAC / PVCs / conduwuit (images rewritten to AR)
#   3. bootstraps the Matrix admin into .env.gke (own homeserver DB ⇒ own token;
#      seeded from .env.k8s or .env on first run)
#   4. renders .env.gke into the agent-studio-env Secret
#   5. applies orchestrator / admin-console / bp-explorer and waits for rollout
#   6. seeds the skill pool into the workspace PVC
#
# Afterwards:
#   kubectl --context "$GKE_CONTEXT" -n agent-studio port-forward svc/admin-console 4200:4000
#   open http://localhost:4200

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MANIFESTS="${SCRIPT_DIR}/manifests"

PROJECT="${PROJECT:-acn-projectroots}"
ZONE="${ZONE:-europe-west3-b}"
CLUSTER="${CLUSTER:-agent-studio}"
GKE_CONTEXT="gke_${PROJECT}_${ZONE}_${CLUSTER}"
AR="${AR:-europe-west3-docker.pkg.dev/${PROJECT}/agent-studio}"
NAMESPACE="agent-studio"
SECRET_NAME="agent-studio-env"
BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-28448}"

# Own env file per stack (compose=.env, kind=.env.k8s, GKE=.env.gke): each
# homeserver is a separate DB with its own Matrix token.
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.gke}"
if [ ! -f "$ENV_FILE" ]; then
  for src in "${REPO_ROOT}/.env.k8s" "${REPO_ROOT}/.env"; do
    if [ -f "$src" ]; then
      cp "$src" "$ENV_FILE"
      echo "[gke-up] created ${ENV_FILE} from $(basename "$src")"
      break
    fi
  done
fi

log()  { echo "[gke-up] $*"; }
fail() { echo "[gke-up] ERROR: $*" >&2; exit 1; }

for tool in gcloud kubectl jq curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found (and no .env/.env.k8s to seed from)"
kubectl config use-context "$GKE_CONTEXT" >/dev/null 2>&1 || fail "kubectl context ${GKE_CONTEXT} not found — run: gcloud container clusters get-credentials ${CLUSTER} --zone ${ZONE} --project ${PROJECT}"

KC() { kubectl --context "$GKE_CONTEXT" "$@"; }

# Rewrite the kind manifests for a real registry: local image names -> AR
# paths, and imagePullPolicy Never -> Always. Always (not IfNotPresent) because
# we deploy mutable :latest tags: with IfNotPresent a node that once cached a
# bad build (e.g. the arm64 exec-format-error incident) would keep running it
# forever, since the tag name never changes.
apply_manifest() {
  sed -e "s|image: agent-studio-|image: ${AR}/agent-studio-|" \
      -e "s|imagePullPolicy: Never|imagePullPolicy: Always|" \
      -e "s|value: as-agent:latest|value: ${AR}/as-agent:latest|" \
      -e "s|value: IfNotPresent|value: Always|" \
      "$1" | KC apply -f -
}

# --- base resources + conduwuit ----------------------------------------------
apply_manifest "${MANIFESTS}/00-namespace.yaml"
apply_manifest "${MANIFESTS}/10-rbac.yaml"
apply_manifest "${MANIFESTS}/20-storage.yaml"
apply_manifest "${MANIFESTS}/30-conduwuit.yaml"
log "waiting for conduwuit ..."
KC -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=300s

# --- Matrix admin bootstrap (same flow as kind-up.sh) --------------------------
set -a; . "$ENV_FILE"; set +a
ADMIN_USER="${ADMIN_USER:-admin}"
HOMESERVER="http://localhost:${BOOTSTRAP_PORT}"

PF_PID=""
start_port_forward() {
  KC -n "$NAMESPACE" port-forward svc/conduwuit "${BOOTSTRAP_PORT}:6167" >/dev/null 2>&1 &
  PF_PID=$!
  for i in $(seq 1 30); do
    curl -sf "${HOMESERVER}/_matrix/client/versions" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "cannot reach conduwuit through port-forward on :${BOOTSTRAP_PORT}"
}
stop_port_forward() { [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true; PF_PID=""; }
trap stop_port_forward EXIT

start_port_forward

token_valid() {
  [ -n "${1:-}" ] || return 1
  curl -s "${HOMESERVER}/_matrix/client/v3/account/whoami" \
    -H "Authorization: Bearer $1" | jq -e '.user_id' >/dev/null 2>&1
}

if token_valid "${MATRIX_ACCESS_TOKEN:-}"; then
  log "existing MATRIX_ACCESS_TOKEN is valid against the GKE homeserver"
else
  log "bootstrapping Matrix admin user @${ADMIN_USER}:local ..."
  if [ -z "${ADMIN_PASS:-}" ]; then
    echo -n "Password for admin user @${ADMIN_USER}:local: "
    read -rs ADMIN_PASS; echo
    [ -n "$ADMIN_PASS" ] || fail "empty password"
  fi
  PATCH_ADD=$(jq -cn --arg cmd "users create-user ${ADMIN_USER} ${ADMIN_PASS}" '[
    {op:"add", path:"/spec/template/spec/containers/0/command", value:["/sbin/conduwuit"]},
    {op:"add", path:"/spec/template/spec/containers/0/args",    value:["--execute", $cmd]}
  ]')
  KC -n "$NAMESPACE" patch deploy/conduwuit --type=json -p "$PATCH_ADD" >/dev/null
  KC -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=180s >/dev/null
  KC -n "$NAMESPACE" patch deploy/conduwuit --type=json -p '[
    {"op":"remove", "path":"/spec/template/spec/containers/0/command"},
    {"op":"remove", "path":"/spec/template/spec/containers/0/args"}
  ]' >/dev/null
  KC -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=180s >/dev/null

  stop_port_forward; start_port_forward

  login_resp=$(curl -s -X POST "${HOMESERVER}/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"${ADMIN_USER}\"},\"password\":\"${ADMIN_PASS}\"}")
  MATRIX_ACCESS_TOKEN=$(echo "$login_resp" | jq -r '.access_token // empty')
  [ -n "$MATRIX_ACCESS_TOKEN" ] || fail "admin login failed: $login_resp"
  log "admin token obtained"
fi

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

# --- secret from env file ------------------------------------------------------
SECRET_ENV=$(mktemp)
trap 'stop_port_forward; rm -f "$SECRET_ENV"' EXIT
grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
  | grep -Ev '^(MATRIX_ACCESS_TOKEN|CONDUWUIT_ADMIN_ROOM|ADMIN_USER_ID)=' \
  | sed -e 's/^\([^=]*\)="\(.*\)"$/\1=\2/' -e "s/^\([^=]*\)='\(.*\)'\$/\1=\2/" \
  > "$SECRET_ENV"
{
  echo "MATRIX_ACCESS_TOKEN=${MATRIX_ACCESS_TOKEN}"
  echo "CONDUWUIT_ADMIN_ROOM=${CONDUWUIT_ADMIN_ROOM}"
  echo "ADMIN_USER_ID=@${ADMIN_USER}:local"
} >> "$SECRET_ENV"
KC -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-env-file="$SECRET_ENV" --dry-run=client -o yaml | KC apply -f -

# --- the rest of the stack -----------------------------------------------------
apply_manifest "${MANIFESTS}/40-orchestrator.yaml"
apply_manifest "${MANIFESTS}/50-admin-console.yaml"
apply_manifest "${MANIFESTS}/60-bp-explorer.yaml"
KC -n "$NAMESPACE" rollout restart deploy/orchestrator deploy/admin-console deploy/bp-explorer >/dev/null
for d in orchestrator admin-console bp-explorer; do
  log "waiting for ${d} ..."
  KC -n "$NAMESPACE" rollout status "deploy/${d}" --timeout=300s
done

# --- seed the skill pool -------------------------------------------------------
POOL_POD=$(KC -n "$NAMESPACE" get pod -l app.kubernetes.io/component=admin-console \
  -o jsonpath='{.items[0].metadata.name}')
log "seeding skill pool via ${POOL_POD} ..."
KC -n "$NAMESPACE" cp "${REPO_ROOT}/orchestrator/skill-pool/." "${POOL_POD}:/pool/"
KC -n "$NAMESPACE" cp "${REPO_ROOT}/mcp-servers/." "${POOL_POD}:/pool/mcp-servers/"

echo
log "done. Agent Studio is running on GKE cluster '${CLUSTER}' (${ZONE})."
echo
echo "  Open the console:"
echo "    kubectl --context ${GKE_CONTEXT} -n ${NAMESPACE} port-forward svc/admin-console 4200:4000"
echo "    open http://localhost:4200"
echo
echo "  Watch agent pods:"
echo "    kubectl --context ${GKE_CONTEXT} -n ${NAMESPACE} get pods -l app.kubernetes.io/component=as-agent -w"
