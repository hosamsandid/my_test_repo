#!/bin/bash
set -uo pipefail

# verify-toolchain.sh — DEMONSTRATE a toolchain variant, don't assert it
# (#1941 AC5-AC9 + AC12; concept docs/agent-toolchains-concept.md §5).
#
#   ./toolchains/_shared/verify-toolchain.sh [image] [toolchain-id]
#   make toolchain-verify
#
# Every claim the ticket makes about the bootstrap model is a claim about
# RUNTIME behaviour, so each one is exercised here against a real container and
# the measured numbers are printed for the PR:
#
#   AC5  a pinned project compiles and `mvn test` passes
#   AC6  changing the pin changes the version — no image build, no push, no
#        respawn (same image id, same workspace, new container)
#   AC7  two projects on two Java versions, same image, separate caches
#   AC8  the cache is under the workspace and survives a respawn; cold and warm
#        first-build cost are both measured
#   AC9  a project with no pin gets the documented baseline, said out loud
#   AC12 image size, measured
#
# A container is started per step and thrown away, which is exactly what a
# respawn does to an agent — the workspace directory is the only thing that
# persists, so "survives a respawn" is what this actually measures rather than
# a proxy for it.

IMAGE="${1:-as-agent-jvm:latest}"
TOOLCHAIN_ID="${2:-jvm}"
BASE_IMAGE="${AEE_BASE_IMAGE:-as-agent:latest}"

CLI="${AEE_CONTAINER_CLI:-}"
if [ -z "$CLI" ]; then
  if command -v podman >/dev/null 2>&1; then CLI=podman
  elif command -v docker >/dev/null 2>&1; then CLI=docker
  else echo "verify-toolchain: no podman or docker on PATH" >&2; exit 2; fi
fi
RUN_OPTS=()
[ "$CLI" = "podman" ] && RUN_OPTS+=(--security-opt label=disable)

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SAMPLE="$REPO_ROOT/toolchains/$TOOLCHAIN_ID/sample"
[ -d "$SAMPLE" ] || { echo "verify-toolchain: no sample project at $SAMPLE" >&2; exit 2; }

WORK="$(mktemp -d)"
# Kept on failure: the maven/mise logs in there are the whole diagnosis.
cleanup() { if [ "${FAILED:-0}" -eq 0 ]; then rm -rf "$WORK"; else echo "logs kept in $WORK" >&2; fi; }
trap cleanup EXIT

FAILED=0
step()  { printf '\n== %s\n' "$1"; }
ok()    { printf '   ok    %s\n' "$1"; }
bad()   { printf '   FAIL  %s\n' "$1"; FAILED=1; }
fact()  { printf '   fact  %s\n' "$1"; }

# One throwaway container over one workspace directory — the shape an agent
# actually runs in: AEE_WORKSPACE points at the mounted workspace, and the
# entrypoint is overridden because we are driving a shell, not the runtime.
in_agent() { # in_agent <workspace-dir> <agent-id> <relative-cwd> <command...>
  local ws="$1" agent="$2" rel="$3"; shift 3
  "$CLI" run --rm "${RUN_OPTS[@]}" \
    -v "$ws:/workspace/agents/$agent" \
    -e "AEE_WORKSPACE=/workspace/agents/$agent" \
    -e "AGENT_ID=$agent" \
    -e "HOME=/root" \
    -w "/workspace/agents/$agent/$rel" \
    --entrypoint /bin/sh "$IMAGE" -c "$*" 2>&1
}

elapsed() { # elapsed <start-epoch> -> seconds
  echo $(( $(date +%s) - $1 ))
}

new_workspace() { # new_workspace <name> [java-version]
  local name="$1" java="${2:-}"
  mkdir -p "$WORK/$name"
  cp -r "$SAMPLE" "$WORK/$name/sample"
  if [ -n "$java" ]; then
    printf '[tools]\njava = "%s"\nmaven = "3.9"\n' "$java" > "$WORK/$name/sample/.mise.toml"
  else
    rm -f "$WORK/$name/sample/.mise.toml"
  fi
}

java_feature() { # java_feature <log> -> the JDK the test actually ran on
  grep -o 'AEE_TOOLCHAIN_JAVA_FEATURE=[0-9]*' <<<"$1" | tail -1 | cut -d= -f2
}

echo "=== toolchain verification: $IMAGE (engine: $CLI)"

# ── AC12: image size, measured ──────────────────────────────────────────────
step "AC12 — image size"
size_of() { "$CLI" inspect --format '{{.Size}}' "$1" 2>/dev/null || echo 0; }
human() { awk -v b="$1" 'BEGIN{printf "%.0f MB", b/1048576}'; }
BASE_SIZE="$(size_of "$BASE_IMAGE")"
VAR_SIZE="$(size_of "$IMAGE")"
if [ "$BASE_SIZE" -gt 0 ] && [ "$VAR_SIZE" -gt 0 ]; then
  fact "base    $BASE_IMAGE: $(human "$BASE_SIZE")"
  fact "variant $IMAGE: $(human "$VAR_SIZE")"
  fact "added by the variant layer: $(human $((VAR_SIZE - BASE_SIZE))) (version manager + the baseline JDK/Maven)"
else
  bad "could not read image sizes (base=$BASE_SIZE variant=$VAR_SIZE)"
fi

# ── AC9: no pin at all ──────────────────────────────────────────────────────
step "AC9 — a project that pins nothing"
new_workspace nopin ""
OUT="$(in_agent "$WORK/nopin" demo-nopin sample 'aee-toolchain doctor; echo ---; java -version 2>&1 | head -1')"
echo "$OUT" | sed 's/^/         /'
if grep -q 'falling back to the image baseline' <<<"$OUT"; then
  ok "the fallback is stated out loud, not silent"
else
  bad "doctor did not report the baseline fallback"
fi
if grep -qE 'openjdk|java) version' <<<"$OUT"; then
  ok "java resolves from the baseline (no 'command not found')"
else
  bad "java did not resolve for an unpinned project"
fi

# ── AC5 + AC8 (cold): a pinned project builds ───────────────────────────────
step "AC5 — pinned project: compile + mvn test (COLD workspace)"
new_workspace a temurin-21
T0=$(date +%s)
OUT="$(in_agent "$WORK/a" demo-a sample 'mvn -B -ntp test')"
COLD=$(elapsed "$T0")
tail -25 <<<"$OUT" | sed 's/^/         /'
if grep -q 'BUILD SUCCESS' <<<"$OUT"; then ok "mvn test passed"; else bad "mvn test did not report BUILD SUCCESS"; fi
FEAT="$(java_feature "$OUT")"
if [ "$FEAT" = "21" ]; then ok "ran on the pinned JDK (feature $FEAT)"; else bad "expected feature 21, test reported '${FEAT:-none}'"; fi
fact "cold first build (JDK + Maven + dependencies downloaded): ${COLD}s"

# ── AC8 (warm): a new container over the same workspace ─────────────────────
step "AC8 — respawn: same workspace, brand-new container (WARM)"
JDK_BEFORE="$(ls -A "$WORK/a/.aee-toolchain/mise/installs/java" 2>/dev/null | tr '\n' ' ')"
T0=$(date +%s)
OUT="$(in_agent "$WORK/a" demo-a sample 'mvn -B -ntp test')"
WARM=$(elapsed "$T0")
JDK_AFTER="$(ls -A "$WORK/a/.aee-toolchain/mise/installs/java" 2>/dev/null | tr '\n' ' ')"
if grep -q 'BUILD SUCCESS' <<<"$OUT"; then ok "mvn test passed again after the container was replaced"; else bad "warm run failed"; fi
if [ -n "$JDK_BEFORE" ] && [ "$JDK_BEFORE" = "$JDK_AFTER" ]; then
  ok "the JDK was NOT re-downloaded (workspace cache: $JDK_AFTER)"
else
  bad "JDK install set changed across the respawn ('$JDK_BEFORE' -> '$JDK_AFTER')"
fi
if grep -qi 'downloading.*(java|jdk|temurin)' <<<"$OUT"; then bad "the warm run downloaded a runtime"; else ok "no runtime download in the warm run"; fi
fact "warm build (everything cached in the workspace): ${WARM}s   [cold was ${COLD}s]"
fact "cache lives at <workspace>/.aee-toolchain — a volume mount, so it outlives the container"

# ── AC6: change the pin, nothing else ───────────────────────────────────────
step "AC6 — change the pinned version: no image build, no push, no respawn"
IMAGE_ID_BEFORE="$("$CLI" inspect --format '{{.Id}}' "$IMAGE")"
printf '[tools]\njava = "temurin-17"\nmaven = "3.9"\n' > "$WORK/a/sample/.mise.toml"
fact "edited only the project's .mise.toml (temurin-21 -> temurin-17)"
OUT="$(in_agent "$WORK/a" demo-a sample 'mvn -B -ntp test')"
IMAGE_ID_AFTER="$("$CLI" inspect --format '{{.Id}}' "$IMAGE")"
FEAT="$(java_feature "$OUT")"
if grep -q 'BUILD SUCCESS' <<<"$OUT"; then ok "mvn test passed on the new pin"; else bad "build failed after the pin change"; fi
if [ "$FEAT" = "17" ]; then ok "the new pin took effect (feature $FEAT)"; else bad "expected feature 17 after the pin change, got '${FEAT:-none}'"; fi
if [ "$IMAGE_ID_BEFORE" = "$IMAGE_ID_AFTER" ]; then
  ok "same image id before and after — the version change involved no image build and no registry push"
else
  bad "image id changed, which means something rebuilt the image"
fi

# ── AC7: two projects, two versions, one image ──────────────────────────────
step "AC7 — two projects on different Java versions at the same time"
printf '[tools]\njava = "temurin-21"\nmaven = "3.9"\n' > "$WORK/a/sample/.mise.toml"
new_workspace b temurin-17
# Genuinely at the same time — two containers over two workspaces off one
# image. A background job cannot hand a variable back to this shell, so each
# writes to its own file and the results are read once both have finished.
in_agent "$WORK/a" demo-a sample 'mvn -B -ntp test' > "$WORK/out-a.log" 2>&1 &
PID_A=$!
in_agent "$WORK/b" demo-b sample 'mvn -B -ntp test' > "$WORK/out-b.log" 2>&1
wait $PID_A 2>/dev/null || true
OUT_A="$(cat "$WORK/out-a.log")"
OUT_B="$(cat "$WORK/out-b.log")"
if grep -q 'BUILD SUCCESS' <<<"$OUT_A" && grep -q 'BUILD SUCCESS' <<<"$OUT_B"; then
  ok "both concurrent builds passed"
else
  bad "a concurrent build failed (see $WORK/out-a.log / out-b.log)"
fi
FEAT_A="$(java_feature "$OUT_A")"
FEAT_B="$(java_feature "$OUT_B")"
fact "workspace A pins temurin-21 -> feature ${FEAT_A:-none}"
fact "workspace B pins temurin-17 -> feature ${FEAT_B:-none}"
if [ "$FEAT_A" = "21" ] && [ "$FEAT_B" = "17" ]; then
  ok "each project got its own version from the same image"
else
  bad "expected 21 and 17, got '${FEAT_A:-none}' and '${FEAT_B:-none}'"
fi
A_JDKS="$(ls -A "$WORK/a/.aee-toolchain/mise/installs/java" 2>/dev/null | tr '\n' ' ')"
B_JDKS="$(ls -A "$WORK/b/.aee-toolchain/mise/installs/java" 2>/dev/null | tr '\n' ' ')"
fact "A cache: ${A_JDKS:-<empty>}"
fact "B cache: ${B_JDKS:-<empty>}"
if [ -n "$A_JDKS" ] && [ -n "$B_JDKS" ] && [ "$A_JDKS" != "$B_JDKS" ]; then
  ok "the caches are separate per workspace — neither project can disturb the other's"
else
  bad "the two workspaces do not hold distinct caches"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "=== toolchain verification FAILED for $IMAGE" >&2
  exit 1
fi
echo "=== toolchain verification passed for $IMAGE"
echo "    cold ${COLD}s / warm ${WARM}s / variant layer $(human $((VAR_SIZE - BASE_SIZE)))"
