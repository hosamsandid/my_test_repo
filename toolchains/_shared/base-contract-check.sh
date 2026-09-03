#!/bin/bash
set -uo pipefail

# base-contract-check.sh — assert that a toolchain variant image still IS an
# agent image (#1941 AC3; concept docs/agent-toolchains-concept.md §4).
#
#   ./toolchains/_shared/base-contract-check.sh <image> [toolchain-id]
#
# WHY THIS IS A TEST AND NOT A DOCUMENTED RULE. "Derive, never fork" is
# unenforceable by review: a variant that re-implements the base, drops the
# plugin-bin PATH hook or shadows one of the platform CLIs builds perfectly
# cleanly and then fails at RUNTIME as "command not found" — for something the
# agent's own CLAUDE.md instructed it to use, hours later, in an unattended run.
# Every assertion below is one of those silent failures made loud at build time.
#
# Run from the repository root. Engine: podman if present, else docker (CI has
# docker, a developer machine has podman) — override with AEE_CONTAINER_CLI.

IMAGE="${1:-}"
TOOLCHAIN_ID="${2:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: $0 <image> [toolchain-id]" >&2
  exit 2
fi

CLI="${AEE_CONTAINER_CLI:-}"
if [ -z "$CLI" ]; then
  if command -v podman >/dev/null 2>&1; then CLI=podman
  elif command -v docker >/dev/null 2>&1; then CLI=docker
  else echo "base-contract: no podman or docker on PATH" >&2; exit 2; fi
fi

FAILED=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

echo "== base contract: $IMAGE (engine: $CLI)"

# ── 1. the entrypoint (image config, not a runtime probe) ───────────────────
# A variant that sets its own ENTRYPOINT — a wrapper that "just" sources a
# profile first, say — takes the agent runtime out of PID 1 and breaks the
# stop/commit lifecycle the orchestrator relies on. Read from the image config,
# because a `run --entrypoint` probe would overwrite the very thing under test.
ENTRY="$($CLI inspect --format '{{.Config.Entrypoint}}' "$IMAGE" 2>/dev/null || echo '<unreadable>')"
if [[ "$ENTRY" == *"/opt/ace/scripts/agent-entrypoint.py"* ]]; then
  pass "entrypoint is the agent runtime ($ENTRY)"
else
  fail "entrypoint is '$ENTRY', expected to invoke /opt/ace/scripts/agent-entrypoint.py"
fi

# The pinned Claude CLI version lives in exactly one place — the base
# Dockerfile's ARG — so read it from there rather than restating it here.
CLAUDE_PIN="$(sed -n 's/^ARG CLAUDE_CODE_VERSION=//p' agent-image/Dockerfile | head -1)"

report() { # stdin: "verdict|text" lines from an in-container check
  while IFS='|' read -r verdict text; do
    case "$verdict" in
      ok) pass "$text" ;;
      FAIL) fail "$text" ;;
      '') ;;
      *) echo "  $verdict${text:+|$text}" ;;
    esac
  done
}

# ── 2. everything else, in one container ────────────────────────────────────
# One `run` for all runtime assertions: each extra container start costs a
# second and this job already builds two images.
#
# NOTE the deliberate use of `command -v` rather than `test -x /usr/local/bin/x`:
# the contract is that the name RESOLVES for the agent, which is what a shadowed
# CLI would break, and a path check would not notice.
# NOTE: `read -r -d ''` rather than `$(cat <<'CHECKS' … )`. macOS ships bash 3.2,
# whose parser mishandles a here-document inside `$(…)` command substitution
# whenever the body contains `case`/`;;` (fixed in bash 4.0) — a developer running
# `make toolchain-images` locally would hit a syntax error the Linux CI never sees.
# `read -d ''` reads to EOF (returns non-zero at EOF, hence `|| true`) and parses
# cleanly on both bash 3.2 and modern bash.
IFS= read -r -d '' IN_CONTAINER <<'CHECKS' || true
set -u
status=0
say() { echo "$1|$2"; }

for path in /opt/ace/scripts /opt/ace/CLAUDE.md /opt/ace/scripts/agent-entrypoint.py; do
  if [ -e "$path" ]; then say ok "$path present"; else say FAIL "$path MISSING"; status=1; fi
done

case ":$PATH:" in
  *":/opt/aee/plugin-bin:"*)
    say ok "PATH carries /opt/aee/plugin-bin (granted plugin CLIs runnable)" ;;
  *)
    say FAIL "PATH does not carry /opt/aee/plugin-bin — granted plugin CLIs would not resolve (PATH=$PATH)"
    status=1 ;;
esac

for cli in gh-as-agent knowledge aee-artifact aee-emit usage; do
  resolved="$(command -v "$cli" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then say ok "$cli -> $resolved"; else say FAIL "$cli does not resolve"; status=1; fi
done

for bin in git gh node python3 claude; do
  resolved="$(command -v "$bin" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then say ok "$bin -> $resolved"; else say FAIL "$bin does not resolve"; status=1; fi
done

# The Claude CLI is pinned in the base; a variant that reinstalled or upgraded
# it has forked the base contract even though every name still resolves.
if [ -n "${AEE_EXPECT_CLAUDE_VERSION:-}" ]; then
  actual="$(claude --version 2>/dev/null | head -1 || true)"
  case "$actual" in
    *"$AEE_EXPECT_CLAUDE_VERSION"*) say ok "Claude CLI still at the base's pinned $AEE_EXPECT_CLAUDE_VERSION" ;;
    *) say FAIL "Claude CLI is '$actual', base pins $AEE_EXPECT_CLAUDE_VERSION"; status=1 ;;
  esac
fi
exit $status
CHECKS

$CLI run --rm --entrypoint /bin/sh \
  -e "AEE_EXPECT_CLAUDE_VERSION=${CLAUDE_PIN}" \
  "$IMAGE" -c "$IN_CONTAINER" 2>&1 | report
[ "${PIPESTATUS[0]}" -eq 0 ] || FAILED=1

# ── 3. the variant's own promise ────────────────────────────────────────────
# Only for a variant (the base itself ships no toolchain): the bootstrap must be
# on PATH for a non-interactive, non-login shell — which is the ONLY kind the
# Claude CLI ever spawns — and it must be able to report its own resolution.
if [ -n "$TOOLCHAIN_ID" ]; then
  # `read -r -d ''` not `$(cat <<'CHECKS' … )` — bash 3.2 parser bug, see above.
  IFS= read -r -d '' VARIANT_CHECKS <<'CHECKS' || true
set -u
status=0
say() { echo "$1|$2"; }
resolved="$(command -v aee-toolchain 2>/dev/null || true)"
if [ -n "$resolved" ]; then say ok "aee-toolchain -> $resolved"; else say FAIL "aee-toolchain does not resolve"; status=1; fi
case ":$PATH:" in
  *":/opt/aee/toolchain-bin:"*) say ok "PATH carries /opt/aee/toolchain-bin" ;;
  *) say FAIL "PATH does not carry /opt/aee/toolchain-bin (PATH=$PATH)"; status=1 ;;
esac
if aee-toolchain doctor >/tmp/doctor.txt 2>&1; then
  say ok "doctor: $(tr '\n' ' ' </tmp/doctor.txt | cut -c1-200)"
else
  say FAIL "aee-toolchain doctor failed: $(tr '\n' ' ' </tmp/doctor.txt | cut -c1-200)"
  status=1
fi
exit $status
CHECKS
  $CLI run --rm --entrypoint /bin/sh "$IMAGE" -c "$VARIANT_CHECKS" 2>&1 | report
  [ "${PIPESTATUS[0]}" -eq 0 ] || FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "== base contract VIOLATED by $IMAGE — a variant may only ADD layers on top of as-agent:latest" >&2
  exit 1
fi
echo "== base contract holds for $IMAGE"
