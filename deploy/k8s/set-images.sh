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
#   both patches' AEE_TOOLCHAIN_IMAGE_TAG     the toolchain VARIANT tag (#1941)
#
# The variant images (as-agent-jvm:…) are the third kind of image that never
# appears as a pod `image:` field: a variant is named by a toolchain manifest at
# RUNTIME, so the transformer cannot see it either. The manifest declares only
# the bare `as-agent-jvm:latest` a local build produces; the deployment supplies
# WHERE (AEE_TOOLCHAIN_IMAGE_PREFIX, static per overlay) and WHICH RELEASE
# (AEE_TOOLCHAIN_IMAGE_TAG, pinned here), and the orchestrator joins the three at
# spawn time. Pinning it here is what makes AC11 hold: a release cannot ship a
# manifest referencing a tag nobody pushed, because deploy-gke.yml pushes every
# variant under the same ${TAG} this rewrites to. Both patch files carry the var
# (a strategic-merge patch addresses exactly one object, and the pair has to
# reach the orchestrator AND the console), so the rewrite runs over both.
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
TOOLCHAIN_PATCH="$APP_DIR/patch-toolchain-prefix.yaml"

rewrite() { # file awk-program — atomic in-place rewrite
  local file="$1" prog="$2" tmp
  tmp="$(mktemp)"
  awk -v tag="$TAG" "$prog" "$file" > "$tmp"
  mv "$tmp" "$file"
}

rewrite "$KUSTOMIZATION" '{ sub(/newTag: .*/, "newTag: " tag); print }'
rewrite "$AGENT_PATCH"   '{ sub(/as-agent:[A-Za-z0-9._-]+/, "as-agent:" tag); print }'
# The toolchain tag. Anchored on the LINE AFTER the var name rather than on a
# value pattern, because the placeholder is the bare word `latest` — a value
# match would also hit `imagePullPolicy` or any other trailing word. `as-agent:`
# above is safe from `as-agent-jvm:` for the opposite reason: the literal colon.
rewrite "$AGENT_PATCH"     '/AEE_TOOLCHAIN_IMAGE_TAG/ { print; getline; sub(/value: .*/, "value: " tag) } { print }'
rewrite "$TOOLCHAIN_PATCH" '/AEE_TOOLCHAIN_IMAGE_TAG/ { print; getline; sub(/value: .*/, "value: " tag) } { print }'

echo "[set-images] $ENV_NAME pinned to :$TAG"
grep -E "newTag:" "$KUSTOMIZATION" | sed 's/^/[set-images]   /'
grep -E "as-agent:" "$AGENT_PATCH" | sed 's/^/[set-images]   /'
for f in "$AGENT_PATCH" "$TOOLCHAIN_PATCH"; do
  grep -A1 -E "AEE_TOOLCHAIN_IMAGE_TAG" "$f" | grep -E "value:" \
    | sed "s|^|[set-images]   toolchain tag ($(basename "$f")) |"
done
