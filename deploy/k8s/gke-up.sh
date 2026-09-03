#!/bin/bash
set -euo pipefail

# Bootstrap / repair a HOSTED Agent Studio environment on the shared GKE
# cluster (single node, RWO storage — see docs/hosting/gcp/). Sibling of
# kind-up.sh: same kustomize base, hosted overlays (#1348). Idempotent.
#
#   ./deploy/k8s/gke-up.sh [--env test|preprod] [--tag <image-tag>]
#
#   --env   which hosted environment (default: test). test = namespace
#           agent-studio + agent-studio.projectroots-acn.com; preprod =
#           namespace agent-studio-preprod + its own hostname. Both live on
#           the SAME cluster; each has its own env file / Matrix DB / Secret.
#   --tag   image tag to pin (deploy/k8s/set-images.sh). Default `latest`
#           only exists for pre-#1348 images — routine deploys go through the
#           deploy-gke workflow; pass the release tag (vX.Y.Z) here when
#           bootstrapping, after that tag was deployed to test (which pushes
#           its images to the shared AR).
#
# ROUTINE deploys are the deploy-gke GitHub-Actions workflow (build + push +
# apply + rollout). This script is for FIRST-TIME environment bootstrap and
# for repairs that CI cannot do: the Matrix admin bootstrap and (re)creating
# the agent-studio-env Secret from the env file. It also rollout-restarts, so
# it picks up Secret-only changes CI's tag-pinned apply would not.
#
# Prerequisites (one-time, done outside this script):
#   - GKE cluster `agent-studio` in europe-west3-b (infra/gcp/ Terraform)
#   - for preprod: `terraform apply` first — static IP + DNS record must exist
#     before the ManagedCertificate can provision (15–30 min after first apply)
#   - AR repo europe-west3-docker.pkg.dev/acn-projectroots/agent-studio with
#     images for <tag> — normally pushed by a deploy-gke run; manual pushes
#     MUST be linux/amd64 (`podman build --platform linux/amd64 …`; a default
#     Apple-Silicon arm64 build crash-loops on GKE with "exec format error")
#   - gke-gcloud-auth-plugin on PATH
#
# What it does:
#   1. switches kubectl to the GKE context
#   2. pins images to --tag and applies the overlay's core
#      (namespace / RBAC / PVCs / conduwuit)
#   3. bootstraps the Matrix admin into the env file (own homeserver DB ⇒ own
#      token; seeded from .env.k8s or .env on first run)
#   4. renders the env file into the agent-studio-env Secret
#   5. applies the overlay's app (orchestrator / admin-console / ingress) and
#      waits for rollout
#   6. seeds the skill pool into the workspace PVC
#
# Afterwards:
#   kubectl --context "$GKE_CONTEXT" -n <namespace> port-forward svc/admin-console 4200:4000
#   (or the public URL once the ManagedCertificate is Active)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# --- arguments (bash 3.2) -----------------------------------------------------
DEPLOY_ENV="test"
IMAGE_TAG="latest"
while [ $# -gt 0 ]; do
  case "$1" in
    --env)  DEPLOY_ENV="${2:-}"; shift 2 ;;
    --tag)  IMAGE_TAG="${2:-}"; shift 2 ;;
    *) echo "usage: $0 [--env test|preprod] [--tag <image-tag>]" >&2; exit 1 ;;
  esac
done
case "$DEPLOY_ENV" in
  test)
    NAMESPACE="agent-studio"
    ENV_FILE_DEFAULT="${REPO_ROOT}/.env.gke"
    BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-28448}"
    ;;
  preprod)
    NAMESPACE="agent-studio-preprod"
    ENV_FILE_DEFAULT="${REPO_ROOT}/.env.gke-preprod"
    # Distinct default so test + preprod bootstraps can run concurrently.
    BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-28449}"
    ;;
  *) echo "[gke-up] ERROR: --env must be test or preprod (got: ${DEPLOY_ENV})" >&2; exit 1 ;;
esac
OVERLAY="${SCRIPT_DIR}/overlays/${DEPLOY_ENV}"

PROJECT="${PROJECT:-acn-projectroots}"
ZONE="${ZONE:-europe-west3-b}"
CLUSTER="${CLUSTER:-agent-studio}"
GKE_CONTEXT="gke_${PROJECT}_${ZONE}_${CLUSTER}"
SECRET_NAME="agent-studio-env"

# Own env file per stack/environment (compose=.env, kind=.env.k8s, GKE test=
# .env.gke, GKE preprod=.env.gke-preprod): each homeserver is a separate DB
# with its own Matrix token.
ENV_FILE="${ENV_FILE:-${ENV_FILE_DEFAULT}}"
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

# --- composed exit cleanup -----------------------------------------------------
# ONE trap for the whole script (a later `trap … EXIT` REPLACES the earlier one,
# which is exactly how the conduwuit bootstrap patch used to leak: the revert
# lived between two traps and an interrupted run left conduwuit crash-looping
# on "Username is not available" forever). Every cleanup step is a no-op until
# its state flag/variable is set.
PF_PID=""
SECRET_ENV=""
CONDUWUIT_PATCHED=0

# kill + wait reaps the background port-forward silently — without the wait,
# bash prints an async "Terminated: 15" job notice that reads like an error.
stop_port_forward() {
  [ -n "$PF_PID" ] || return 0
  { kill "$PF_PID" && wait "$PF_PID"; } 2>/dev/null || true
  PF_PID=""
}

revert_conduwuit_patch() {
  [ "$CONDUWUIT_PATCHED" = 1 ] || return 0
  log "reverting conduwuit bootstrap --execute patch ..."
  if KC -n "$NAMESPACE" patch deploy/conduwuit --type=json -p '[
    {"op":"remove", "path":"/spec/template/spec/containers/0/command"},
    {"op":"remove", "path":"/spec/template/spec/containers/0/args"}
  ]' >/dev/null; then
    CONDUWUIT_PATCHED=0
  else
    echo "[gke-up] WARNING: could not revert the conduwuit bootstrap patch — conduwuit will crash-loop until you run:" >&2
    echo "  kubectl --context ${GKE_CONTEXT} -n ${NAMESPACE} patch deploy/conduwuit --type=json -p '[{\"op\":\"remove\",\"path\":\"/spec/template/spec/containers/0/command\"},{\"op\":\"remove\",\"path\":\"/spec/template/spec/containers/0/args\"}]'" >&2
  fi
  return 0
}

cleanup() {
  stop_port_forward
  revert_conduwuit_patch
  [ -n "$SECRET_ENV" ] && rm -f "$SECRET_ENV"
  return 0
}
trap cleanup EXIT

# --- pin images + base resources + conduwuit ----------------------------------
# The historic sed rewrites (local image names -> AR, Never -> Always) live in
# the overlay now (kustomize images: block + patches); set-images.sh pins the
# tag in the working tree. Reset afterwards: git checkout -- deploy/k8s/overlays
"${SCRIPT_DIR}/set-images.sh" "$DEPLOY_ENV" "$IMAGE_TAG"
KC apply -k "${OVERLAY}/core"

# Self-heal a bootstrap patch left by an interrupted previous run: the base
# manifest never sets `command`, and kubectl apply's three-way merge never
# removes imperatively-patched fields — so a non-empty `command` here can only
# be a stale --execute patch (symptom: CrashLoopBackOff, "Username is not
# available"). Revert it before waiting on the rollout.
STALE_CMD=$(KC -n "$NAMESPACE" get deploy/conduwuit \
  -o jsonpath='{.spec.template.spec.containers[0].command}' 2>/dev/null || true)
if [ -n "$STALE_CMD" ]; then
  log "conduwuit carries a bootstrap patch from an interrupted previous run — reverting"
  CONDUWUIT_PATCHED=1
  revert_conduwuit_patch
fi

log "waiting for conduwuit ..."
KC -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=300s

# --- Matrix admin bootstrap (same flow as kind-up.sh) --------------------------
set -a; . "$ENV_FILE"; set +a
ADMIN_USER="${ADMIN_USER:-admin}"
HOMESERVER="http://localhost:${BOOTSTRAP_PORT}"

start_port_forward() {
  KC -n "$NAMESPACE" port-forward svc/conduwuit "${BOOTSTRAP_PORT}:6167" >/dev/null 2>&1 &
  PF_PID=$!
  for i in $(seq 1 30); do
    curl -sf "${HOMESERVER}/_matrix/client/versions" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "cannot reach conduwuit through port-forward on :${BOOTSTRAP_PORT}"
}

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
    echo -n "Password for MATRIX admin user @${ADMIN_USER}:local (homeserver admin — NOT the console login): "
    read -rs ADMIN_PASS; echo
    [ -n "$ADMIN_PASS" ] || fail "empty password"
  fi
  PATCH_ADD=$(jq -cn --arg cmd "users create-user ${ADMIN_USER} ${ADMIN_PASS}" '[
    {op:"add", path:"/spec/template/spec/containers/0/command", value:["/sbin/conduwuit"]},
    {op:"add", path:"/spec/template/spec/containers/0/args",    value:["--execute", $cmd]}
  ]')
  # Flag BEFORE the patch: a kill between the two can only cause a harmless
  # spurious revert; the reverse order would leak the patch (the failure mode
  # this trap design exists to close).
  CONDUWUIT_PATCHED=1
  KC -n "$NAMESPACE" patch deploy/conduwuit --type=json -p "$PATCH_ADD" >/dev/null
  KC -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=180s >/dev/null
  revert_conduwuit_patch
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
SECRET_ENV=$(mktemp)   # removed by the EXIT trap (cleanup)
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
# app = orchestrator / admin-console / ingress (test + preprod overlays
# include the env's Ingress + ManagedCertificate + IAP BackendConfig, so
# ingress changes no longer need a manual out-of-band apply).
KC apply -k "${OVERLAY}/app"
# bp-explorer was removed from the stack (#1963). `apply -k` does not prune, so
# an environment first deployed before the removal would keep the old
# Deployment and Service running against the workspace PVC indefinitely. Reap
# them here instead of orphaning them; a no-op where it never existed.
KC -n "$NAMESPACE" delete deploy/bp-explorer svc/bp-explorer --ignore-not-found >/dev/null \
  || log "note: could not remove the legacy bp-explorer workload — remove it by hand"
# CI's tag-pinned apply rolls pods only when the tag changes; this script also
# restarts so a re-run picks up Secret-only changes (e.g. rotated credentials).
KC -n "$NAMESPACE" rollout restart deploy/orchestrator deploy/admin-console >/dev/null
for d in orchestrator admin-console; do
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
log "done. Agent Studio '${DEPLOY_ENV}' (namespace ${NAMESPACE}, images :${IMAGE_TAG}) is running on GKE cluster '${CLUSTER}' (${ZONE})."
echo
echo "  Open the console:"
echo "    kubectl --context ${GKE_CONTEXT} -n ${NAMESPACE} port-forward svc/admin-console 4200:4000"
echo "    open http://localhost:4200"
echo
echo "  Watch agent pods:"
echo "    kubectl --context ${GKE_CONTEXT} -n ${NAMESPACE} get pods -l app.kubernetes.io/component=as-agent -w"
