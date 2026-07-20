#!/bin/bash
# Code Reviewer playbook (issue #711, §6.2): woken by `pull_request.labeled` =
# `ready-for-review`, it posts a structured review comment on the PR and applies
# `ready-to-merge` — the happy-path verdict (the Reworker / `revisions-required`
# loop is out of scope for the CI variant, matching the storyline). Talks to
# fake-github directly with curl (see _lib.sh).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"

REPO="$(resolve_repo)"; [ -n "$REPO" ] || REPO="e2e/fixture"
PR="$(pr_number)"
if [ -z "$PR" ]; then
  log "Reviewer: no PR number in the trigger payload — nothing to review"
  exit 0
fi
log "Reviewer: reviewing PR #${PR} on ${REPO}"

COMMENT='{"body":"Review verdict: all acceptance criteria met ✅. Verified the change is scoped to the issue; two non-blocking notes. Recommendation: ready to merge — a human performs the merge."}'
gh_post "/repos/${REPO}/issues/${PR}/comments" "$COMMENT" >/dev/null
gh_post "/repos/${REPO}/pulls/${PR}/labels" '{"labels":["ready-to-merge"]}' >/dev/null
log "Reviewer: commented + labelled ready-to-merge on PR #${PR}"
