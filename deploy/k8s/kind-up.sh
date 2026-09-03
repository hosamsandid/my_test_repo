#!/bin/bash
set -euo pipefail

# One-shot local Kubernetes bring-up for the Agent Studio POC.
#
#   ./deploy/k8s/kind-up.sh          # dev stack (cluster agent-studio, .env.k8s)
#   ./deploy/k8s/kind-up.sh --e2e    # dedicated e2e stack (#1319) — see below
#
# What it does (idempotent, safe to re-run):
#   1. checks prerequisites (podman, kind, kubectl, jq, .env)
#   2. creates a single-node kind cluster (Podman provider) if missing
#   3. builds the 4 images with podman and loads them into the kind node
#      (no registry anywhere — mirrors the GCP no-Artifact-Registry reality)
#   4. applies the kind overlay's core (namespace / RBAC / PVCs / conduwuit)
#      — kustomize overlays under deploy/k8s/overlays/ (#1348)
#   5. bootstraps the Matrix admin user + token into .env if needed
#      (k8s equivalent of orchestrator/setup.sh: temporarily patches the
#      conduwuit Deployment with `--execute "users create-user …"`)
#   6. renders .env into the agent-studio-env Secret
#   7. applies the overlay's app (orchestrator / admin-console, plus the fakes
#      in --e2e mode) and waits for rollout
#
# Afterwards (4100, NOT 4000 — the compose stack owns :4000 locally):
#   kubectl -n agent-studio port-forward svc/admin-console 4100:4000
#   open http://localhost:4100
#
# Compatible with bash 3.2 (macOS default).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# --e2e (#1319): bring up the DEDICATED e2e kind cluster instead of the dev
# one — own cluster name / env file / bootstrap port, the LLM stubbed at the
# claude-binary seam (AEE_FAKE_CLAUDE=1), in-cluster fake-github + git-remote
# fixture services, and the context-mount hostPath opt-in. The dev kind
# cluster stays untouched: the k8s mirror of the compose `aee-e2e` project
# isolation (a fake-mode stack is useless for real dev work, so it gets its
# own cluster rather than flipping this one).
E2E_MODE=0
if [ "${1:-}" = "--e2e" ]; then E2E_MODE=1; fi

# Manifests come from the kustomize overlays (#1348): kind = local images
# (:latest, Never), kind-e2e = kind + the in-cluster fakes. Same base as the
# hosted test/preprod overlays — one manifest source, no drift.
if [ "$E2E_MODE" = "1" ]; then
  OVERLAY="${SCRIPT_DIR}/overlays/kind-e2e"
else
  OVERLAY="${SCRIPT_DIR}/overlays/kind"
fi

# The k8s stack keeps its OWN env file so it can coexist with the compose
# stack: the two homeservers are separate databases with different Matrix
# tokens, and the bootstrap below writes the token back into this file —
# sharing .env would corrupt the compose stack's credentials. On first run
# .env.k8s is seeded from .env (LLM endpoint, admin creds, etc.); the e2e
# stack's .env.k8s-e2e is seeded from .env.k8s when present (its LLM keys are
# overridden with dead values in the Secret step regardless).
if [ "$E2E_MODE" = "1" ]; then
  ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.k8s-e2e}"
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "${REPO_ROOT}/.env.k8s" ]; then cp "${REPO_ROOT}/.env.k8s" "$ENV_FILE"
    elif [ -f "${REPO_ROOT}/.env" ]; then cp "${REPO_ROOT}/.env" "$ENV_FILE"
    else touch "$ENV_FILE"; fi
    echo "[kind-up] created ${ENV_FILE} (e2e kind stack uses its own env file)"
  fi
  CLUSTER_NAME="${CLUSTER_NAME:-agent-studio-e2e}"
  BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-18449}"
else
  ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.k8s}"
  if [ ! -f "$ENV_FILE" ] && [ -f "${REPO_ROOT}/.env" ]; then
    cp "${REPO_ROOT}/.env" "$ENV_FILE"
    echo "[kind-up] created ${ENV_FILE} from .env (k8s stack uses its own env file)"
  fi
  CLUSTER_NAME="${CLUSTER_NAME:-agent-studio}"
  # Local port used only for the bootstrap port-forward (avoid clashing with a
  # concurrently running compose stack on 8448).
  BOOTSTRAP_PORT="${BOOTSTRAP_PORT:-18448}"
fi

NAMESPACE="agent-studio"
SECRET_NAME="agent-studio-env"

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
build_and_load as-agent "${REPO_ROOT}/agent-image" -f "${REPO_ROOT}/agent-image/Dockerfile"

if [ "$E2E_MODE" = "1" ]; then
  # The compose e2e stack bind-mounts the seeded fixture repo into git-remote;
  # kind has no host bind-mounts, so seed FIRST and bake the content into the
  # image (see e2e/git-remote/Dockerfile). Re-running kind-up re-seeds fresh.
  "${REPO_ROOT}/e2e/scripts/seed-fixture-repo.sh"
  build_and_load aee-fake-github "${REPO_ROOT}/e2e/fake-github"
  build_and_load aee-git-remote  "${REPO_ROOT}/e2e/git-remote"
fi

# --- 4. base resources + conduwuit ------------------------------------------
# core = namespace / RBAC / PVCs / conduwuit — everything the Matrix bootstrap
# and Secret creation below need; the app stack (which envFrom's the Secret)
# is applied afterwards from the overlay's app/ kustomization.
kubectl apply -k "${OVERLAY}/core"
log "waiting for conduwuit ..."
kubectl -n "$NAMESPACE" rollout status deploy/conduwuit --timeout=180s

# --- 5. Matrix admin bootstrap ----------------------------------------------
# Reads ADMIN_USER / MATRIX_ACCESS_TOKEN from .env; creates the admin user +
# token against the FRESH in-cluster homeserver when the token is absent or
# invalid (a token from the compose stack won't work here — different DB).
set -a; . "$ENV_FILE"; set +a
ADMIN_USER="${ADMIN_USER:-admin}"
# e2e must never sit on an interactive password prompt (CI / make e2e-kind).
if [ "$E2E_MODE" = "1" ]; then ADMIN_PASS="${ADMIN_PASS:-e2e-matrix-admin}"; fi
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
# Keys the e2e overlay overrides (fake LLM, fixture services, opt-ins) join
# the duplicate filter so a value carried in from .env.k8s/.env can't shadow
# the deterministic e2e one.
DUP_KEYS='MATRIX_ACCESS_TOKEN|CONDUWUIT_ADMIN_ROOM|ADMIN_USER_ID'
if [ "$E2E_MODE" = "1" ]; then
  DUP_KEYS="${DUP_KEYS}|AEE_FAKE_CLAUDE|AEE_FAKE_CLAUDE_FIXTURES|AEE_FAKE_CLAUDE_PLAYBOOKS|GITHUB_API_BASE|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_DEFAULT_SONNET_MODEL|ANTHROPIC_DEFAULT_HAIKU_MODEL|CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS|AEE_GITHUB_POLL_INTERVAL_MS|AEE_K8S_CONTEXT_HOSTPATH|ADMIN_USERNAME|ADMIN_PASSWORD"
fi
grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" \
  | grep -Ev "^(${DUP_KEYS})=" \
  | sed -e 's/^\([^=]*\)="\(.*\)"$/\1=\2/' -e "s/^\([^=]*\)='\(.*\)'\$/\1=\2/" \
  > "$SECRET_ENV"
{
  echo "MATRIX_ACCESS_TOKEN=${MATRIX_ACCESS_TOKEN}"
  echo "CONDUWUIT_ADMIN_ROOM=${CONDUWUIT_ADMIN_ROOM}"
  echo "ADMIN_USER_ID=@${ADMIN_USER}:local"
} >> "$SECRET_ENV"
if [ "$E2E_MODE" = "1" ]; then
  # Mirror of docker-compose.e2e.yml + gen-env.sh: the orchestrator spreads its
  # process.env into every agent pod, so one Secret turns on the fake `claude`
  # shim stack-wide, routes GitHub API calls at the in-cluster fake-github, and
  # points the proxy vars at a dead address (a shim bypass fails fast/offline).
  # AEE_K8S_CONTEXT_HOSTPATH=1 is the #1319 context-mount opt-in the
  # context-mount journey exercises. No AEE_PER_AGENT_NETWORK_SERVICES here —
  # that is podman-only wiring; agent pods share the flat cluster network.
  {
    echo "AEE_FAKE_CLAUDE=1"
    echo "AEE_FAKE_CLAUDE_FIXTURES=/opt/ace/e2e/fixtures/iban-story.fixtures.json"
    echo "AEE_FAKE_CLAUDE_PLAYBOOKS=/opt/ace/e2e/fixtures/playbooks"
    echo "GITHUB_API_BASE=http://fake-github"
    echo "ANTHROPIC_BASE_URL=http://127.0.0.1:1"
    echo "ANTHROPIC_AUTH_TOKEN=e2e-dead-token"
    echo "ANTHROPIC_DEFAULT_SONNET_MODEL=claude-fake-e2e"
    echo "ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-fake-e2e"
    echo "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1"
    echo "AEE_GITHUB_POLL_INTERVAL_MS=2000"
    echo "AEE_K8S_CONTEXT_HOSTPATH=1"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=e2e-admin-pass"
  } >> "$SECRET_ENV"
fi
kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-env-file="$SECRET_ENV" --dry-run=client -o yaml | kubectl apply -f -

# --- 7. the rest of the stack ------------------------------------------------
# The kind-e2e overlay's app/ already includes the fakes (base/e2e).
kubectl apply -k "${OVERLAY}/app"
# bp-explorer was removed from the stack (#1963). `apply -k` does not prune, so
# a cluster first brought up before the removal would keep the old Deployment
# and Service running against the workspace PVC indefinitely. Reap them here
# instead of orphaning them; a no-op on every cluster that never had it.
kubectl -n "$NAMESPACE" delete deploy/bp-explorer svc/bp-explorer --ignore-not-found >/dev/null \
  || log "note: could not remove the legacy bp-explorer workload — remove it by hand"
# Pick up changed images/secret even when the manifests are unchanged.
kubectl -n "$NAMESPACE" rollout restart deploy/orchestrator deploy/admin-console >/dev/null
for d in orchestrator admin-console; do
  log "waiting for ${d} ..."
  kubectl -n "$NAMESPACE" rollout status "deploy/${d}" --timeout=180s
done
if [ "$E2E_MODE" = "1" ]; then
  kubectl -n "$NAMESPACE" rollout restart deploy/fake-github deploy/git-remote >/dev/null
  for d in fake-github git-remote; do
    log "waiting for ${d} ..."
    kubectl -n "$NAMESPACE" rollout status "deploy/${d}" --timeout=120s
  done
fi

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
if [ "$E2E_MODE" = "1" ]; then
  echo "  E2E stack (fake claude/github). Next: e2e/scripts/kind-stack-up.sh"
  echo "  handles the port-forwards (console :4110, fake-github :4114) and the"
  echo "  post-up configuration; 'make e2e-kind' runs the journeys."
else
  echo "  Open the console:"
  echo "    kubectl -n ${NAMESPACE} port-forward svc/admin-console 4100:4000"
  echo "    open http://localhost:4100"
  echo "    (4100 on purpose — the compose stack owns :4000; console login = ADMIN_USERNAME/ADMIN_PASSWORD from .env)"
fi
echo
echo "  Watch agent pods appear as you enable agents:"
echo "    kubectl -n ${NAMESPACE} get pods -l app.kubernetes.io/component=as-agent -w"
echo
echo "  Tear down:  kind delete cluster --name ${CLUSTER_NAME}"
