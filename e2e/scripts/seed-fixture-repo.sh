#!/bin/bash
set -euo pipefail

# Seed the in-stack git-remote fixture repository (#667, docs/e2e-testing-concept.md
# §2 v1.1 — option B). Builds a bare repo on the host at the git-remote service's
# bind-mount root so the `git-remote` container serves it over anonymous,
# read-only dumb HTTP as `http://git-remote/e2e/fixture.git`.
#
# Run on the HOST (host git makes the commit), from stack-up.sh BEFORE `up`, so
# the repo is already present when the container starts. The dev stack never
# references this path, so it is unaffected. Rebuilt fresh on every run for a
# deterministic starting state — the repo is static fixture content, and F1
# teams are created with unique ids + torn down, so within-run isolation holds.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SRV_ROOT="$REPO_ROOT/e2e/git-remote/srv"
BARE="$SRV_ROOT/e2e/fixture.git"
# Default branch the Team-Setup wizard clones (`repository.branch` → 'main').
BRANCH=main

# Inline identity so the seed works on a host/CI runner with no git user config.
GIT_ID=(-c user.name=aee-e2e -c user.email=e2e@git-remote.local -c init.defaultBranch="$BRANCH")

echo "=== Seeding git-remote fixture repo ($BARE) ==="
rm -rf "$SRV_ROOT/e2e"
mkdir -p "$SRV_ROOT/e2e"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git "${GIT_ID[@]}" init -q "$WORK"
cat > "$WORK/README.md" <<'EOF'
# AEE E2E fixture repository

Seeded by `e2e/scripts/seed-fixture-repo.sh` and served by the `git-remote`
service over anonymous, read-only HTTP. Used by the F1 create-team journey so
the Team-Setup wizard can materialise a team with zero external dependencies.
EOF
git "${GIT_ID[@]}" -C "$WORK" add README.md
git "${GIT_ID[@]}" -C "$WORK" commit -q -m "chore: seed AEE e2e fixture repository"
# Normalise the branch name regardless of the host git's default.
git "${GIT_ID[@]}" -C "$WORK" branch -M "$BRANCH"

# Bare mirror the container serves; update-server-info writes info/refs +
# objects/info/packs so git's dumb-HTTP transport can clone it statically.
git "${GIT_ID[@]}" clone -q --bare "$WORK" "$BARE"
git "${GIT_ID[@]}" -C "$BARE" symbolic-ref HEAD "refs/heads/$BRANCH"
git "${GIT_ID[@]}" -C "$BARE" update-server-info

echo "Seeded fixture repo on branch '$BRANCH' → $BARE"
