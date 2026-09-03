#!/bin/bash
set -euo pipefail

# Render invariants for the kustomize overlays (#1348) — the fast, cluster-free
# gate that catches overlay drift before it reaches a deploy. Run locally or in
# CI (ci.yml k8s-render job). Needs only kubectl (bundled kustomize renders);
# bash 3.2 compatible.
#
# Checks, per overlay:
#   kind / kind-e2e  local images (:latest, Never), no registry, no Ingress
#   test / preprod   AR images, Always, correct host/IP, and — after a
#                    simulated set-images.sh pin — zero `:latest` anywhere
#   preprod          namespace fully rewritten (Namespace object, RoleBinding
#                    subjects, no stray agent-studio), distinct AEE_INSTANCE_ID

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AR_PATH="europe-west3-docker.pkg.dev/acn-projectroots/agent-studio"
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
note() { echo "  ok: $*"; }

render() { # dir -> stdout
  kubectl kustomize "$1"
}

expect_grep() { # render-file pattern description (-e: pattern may start with "-")
  if grep -Eq -e "$2" "$1"; then note "$3"; else fail "$3 — pattern not found: $2"; fi
}
expect_absent() { # render-file pattern description
  if grep -Eq -e "$2" "$1"; then fail "$3 — forbidden pattern present: $2"; else note "$3"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== render: all kustomizations build"
for d in base/core base/app base/e2e \
         overlays/kind/core overlays/kind/app \
         overlays/kind-e2e/core overlays/kind-e2e/app \
         overlays/test/core overlays/test/app \
         overlays/preprod/core overlays/preprod/app; do
  if render "$SCRIPT_DIR/$d" > "$TMP/$(echo "$d" | tr / -).yaml"; then
    note "$d renders"
  else
    fail "$d does not render"
  fi
done

echo "== kind overlay (local dev)"
KIND_APP="$TMP/overlays-kind-app.yaml"
expect_grep   "$KIND_APP" 'imagePullPolicy: Never'          "kind: side-loaded images use Never"
expect_absent "$KIND_APP" 'pkg\.dev'                        "kind: no registry paths"
expect_absent "$KIND_APP" 'kind: Ingress'                   "kind: no Ingress"
expect_grep   "$KIND_APP" 'value: as-agent:latest'          "kind: AGENT_IMAGE is bare as-agent:latest"
# #1941 AC11. Asserted POSITIVELY (the var declared with an empty value) rather
# than by absence: a kind node side-loads a variant under exactly the bare tag
# its manifest names, so a non-empty prefix here would point every agent pod at
# a registry this flavour never pushes to — and an accidentally DELETED var
# would look identical to a correct empty one if we only checked for absence.
expect_grep   "$KIND_APP" 'name: AEE_TOOLCHAIN_IMAGE_PREFIX'  "kind: toolchain image prefix declared"
expect_grep   "$KIND_APP" 'name: AEE_TOOLCHAIN_IMAGE_TAG'     "kind: toolchain image tag declared"
# ...and both are EMPTY: 2 vars x 2 Deployments = 4, the only `value: ""` in the
# app base. A count, not a bare grep, because "declared" and "empty" are two
# different failures and only the pair together says "kind pulls the bare tag".
kind_tc_n="$(grep -c 'value: ""' "$KIND_APP")" || kind_tc_n=0
if [ "$kind_tc_n" -eq 4 ]; then
  note "kind: toolchain prefix+tag empty on both deployments (bare local tag)"
else
  fail "kind: expected 4 empty toolchain env values, found $kind_tc_n"
fi
expect_absent "$KIND_APP" 'namespace: agent-studio-preprod' "kind: namespace untouched"

echo "== kind-e2e overlay"
E2E_APP="$TMP/overlays-kind-e2e-app.yaml"
expect_grep "$E2E_APP" 'name: fake-github' "kind-e2e: fake-github present"
expect_grep "$E2E_APP" 'name: git-remote'  "kind-e2e: git-remote present"
expect_absent "$E2E_APP" 'pkg\.dev'        "kind-e2e: no registry paths"

echo "== test overlay (unpinned placeholder render)"
TEST_APP="$TMP/overlays-test-app.yaml"
for img in orchestrator admin-console bp-explorer; do
  expect_grep "$TEST_APP" "image: $AR_PATH/agent-studio-$img:" "test: $img from Artifact Registry"
done
expect_grep   "$TEST_APP" 'imagePullPolicy: Always'                          "test: pull policy Always"
expect_absent "$TEST_APP" 'imagePullPolicy: Never'                           "test: no Never left"
expect_grep   "$TEST_APP" "value: $AR_PATH/as-agent:"                        "test: AGENT_IMAGE from Artifact Registry"
# #1941 AC11: the toolchain image prefix must reach BOTH the orchestrator (which
# spawns from it) and the admin-console (which shows the operator what will be
# pulled). They live in two strategic-merge patches — one per Deployment — so a
# PAIR count is the thing worth asserting: a single hit means one of the two
# patches was dropped from kustomization.yaml and the two halves now disagree.
tc_n="$(grep -c "value: $AR_PATH$" "$TEST_APP")" || tc_n=0
if [ "$tc_n" -eq 2 ]; then
  note "test: toolchain image prefix on both orchestrator and admin-console"
else
  fail "test: expected 2 AEE_TOOLCHAIN_IMAGE_PREFIX values, found $tc_n"
fi
expect_grep   "$TEST_APP" 'global-static-ip-name: agent-studio-ip$'          "test: static IP agent-studio-ip"
expect_grep   "$TEST_APP" '- agent-studio\.projectroots-acn\.com'            "test: cert domain"
expect_absent "$TEST_APP" 'agent-studio-preprod'                             "test: no preprod values"

echo "== preprod overlay (unpinned placeholder render)"
PRE_CORE="$TMP/overlays-preprod-core.yaml"
PRE_APP="$TMP/overlays-preprod-app.yaml"
expect_grep   "$PRE_CORE" 'name: agent-studio-preprod$'                        "preprod: Namespace object renamed"
expect_absent "$PRE_CORE" 'namespace: agent-studio$'                           "preprod core: no stray agent-studio namespace"
expect_absent "$PRE_APP"  'namespace: agent-studio$'                           "preprod app: no stray agent-studio namespace"
expect_grep   "$PRE_APP"  'value: agent-studio-preprod'                        "preprod: AEE_INSTANCE_ID=agent-studio-preprod"
expect_grep   "$PRE_APP"  'global-static-ip-name: agent-studio-preprod-ip'     "preprod: static IP agent-studio-preprod-ip"
# #1941 AC11 — same pair invariant as test (see there). preprod additionally
# proves its patch matched at all: patch-toolchain-prefix.yaml names the BASE
# namespace so the overlay's namespace transformer can rewrite it, and a patch
# that failed to match would silently contribute nothing rather than error.
pre_tc_n="$(grep -c "value: $AR_PATH$" "$PRE_APP")" || pre_tc_n=0
if [ "$pre_tc_n" -eq 2 ]; then
  note "preprod: toolchain image prefix on both orchestrator and admin-console"
else
  fail "preprod: expected 2 AEE_TOOLCHAIN_IMAGE_PREFIX values, found $pre_tc_n"
fi
expect_grep   "$PRE_APP"  '- agent-studio-preprod\.projectroots-acn\.com'      "preprod: cert domain"
# RoleBinding subjects live in core — the namespace transformer must rewrite them.
if awk '/kind: RoleBinding/,0' "$PRE_CORE" | grep -q 'namespace: agent-studio-preprod'; then
  note "preprod: RoleBinding subject namespace rewritten"
else
  fail "preprod: RoleBinding subject still points at agent-studio"
fi

echo "== pinned-tag simulation (set-images.sh must remove every :latest)"
CHECK_TAG="v0.0.0-check"
cp -R "$SCRIPT_DIR" "$TMP/k8s-sim" # relative base refs stay inside deploy/k8s
for env in test preprod; do
  "$TMP/k8s-sim/set-images.sh" "$env" "$CHECK_TAG" > /dev/null
  SIM="$TMP/sim-$env.yaml"
  render "$TMP/k8s-sim/overlays/$env/app" > "$SIM"
  expect_absent "$SIM" ':latest' "$env pinned: zero :latest"
  n="$(grep -c ":$CHECK_TAG" "$SIM")" || n=0
  if [ "$n" -eq 4 ]; then # 3 pod images + AGENT_IMAGE
    note "$env pinned: all 4 image refs carry :$CHECK_TAG"
  else
    fail "$env pinned: expected 4 refs with :$CHECK_TAG, found $n"
  fi
  # #1941 AC11, the load-bearing half: a variant image is named by a toolchain
  # manifest at RUNTIME, so it is never a pod `image:` field and the four refs
  # above cannot cover it. Its tag rides on AEE_TOOLCHAIN_IMAGE_TAG (both
  # Deployments), which set-images.sh must pin to the SAME release tag the
  # deploy workflow pushed each variant under — otherwise a release ships a
  # manifest referencing a tag nobody pushed and every toolchain agent lands in
  # ImagePullBackOff. Counted as a bare value (no leading colon), which is also
  # why it does not inflate the count above.
  tn="$(grep -c "value: $CHECK_TAG$" "$SIM")" || tn=0
  if [ "$tn" -eq 2 ]; then
    note "$env pinned: toolchain image tag pinned on both deployments"
  else
    fail "$env pinned: expected 2 AEE_TOOLCHAIN_IMAGE_TAG values of $CHECK_TAG, found $tn"
  fi
done

echo
if [ "$FAILED" -ne 0 ]; then
  echo "render-check: FAILED" >&2
  exit 1
fi
echo "render-check: all invariants hold"
