#!/bin/bash
set -euo pipefail

# Pin the image tag for a hosted-environment overlay (#1348) — the ONE
# image-pinning mechanism, used by the deploy-gke workflow and gke-up.sh.
#
#   ./deploy/k8s/set-images.sh <test|preprod> <tag>
#
# Rewrites, in the WORKING TREE only (never commit a pinned tag — the
# checked-in placeholder stays `latest` so a plain `kubectl kustomize`
# always renders):
#   overlays/<env>/app/kustomization.yaml     every `newTag:` (3 pod images)
#   overlays/<env>/app/patch-agent-image.yaml the as-agent tag (env var on the
#                                             orchestrator — invisible to the
#                                             kustomize images: transformer)
#
# Deliberately dumb text rewriting (awk-to-tmp-then-mv, same pattern as
# set_env_var in kind-up.sh) instead of `kustomize edit set image`: the files
# are ours with a fixed shape, and this keeps the deploy path dependency-free
# (kubectl's bundled kustomize renders; no standalone kustomize anywhere).
# Reset after a local run with: git checkout -- deploy/k8s/overlays

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ENV_NAME="${1:-}"
TAG="${2:-}"

case "$ENV_NAME" in
  test|preprod) ;;
  *) echo "usage: $0 <test|preprod> <tag>" >&2; exit 1 ;;
esac
# Valid image-tag charset only — this string lands inside YAML we then apply.
if ! printf '%s' "$TAG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'; then
  echo "ERROR: invalid image tag: '$TAG'" >&2
  exit 1
fi

APP_DIR="$SCRIPT_DIR/overlays/$ENV_NAME/app"
KUSTOMIZATION="$APP_DIR/kustomization.yaml"
AGENT_PATCH="$APP_DIR/patch-agent-image.yaml"

rewrite() { # file awk-program — atomic in-place rewrite
  local file="$1" prog="$2" tmp
  tmp="$(mktemp)"
  awk -v tag="$TAG" "$prog" "$file" > "$tmp"
  mv "$tmp" "$file"
}

rewrite "$KUSTOMIZATION" '{ sub(/newTag: .*/, "newTag: " tag); print }'
rewrite "$AGENT_PATCH"   '{ sub(/as-agent:[A-Za-z0-9._-]+/, "as-agent:" tag); print }'

echo "[set-images] $ENV_NAME pinned to :$TAG"
grep -E "newTag:" "$KUSTOMIZATION" | sed 's/^/[set-images]   /'
grep -E "as-agent:" "$AGENT_PATCH" | sed 's/^/[set-images]   /'
