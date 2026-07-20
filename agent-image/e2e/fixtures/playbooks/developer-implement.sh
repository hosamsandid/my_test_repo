#!/bin/bash
# Developer playbook (issue #711, §6.2): woken by `issues.labeled` = `ready`, it
# does the Developer's part of the loop — a REAL branch + commit in the workspace
# clone, then opens a PR on fake-github and labels it `ready-for-review` (the hop
# that wakes the Code Reviewer). The scripted diff is arbitrary (§6.2): it just
# touches a file so git is genuinely exercised.
#
# PUSH TO THE git-remote IS INTENTIONALLY BEST-EFFORT / SKIPPED. The #667
# in-stack git-remote is READ-ONLY dumb-HTTP by design (docker-compose.e2e.yml
# mounts it `ro`; seed-fixture-repo.sh serves it via `python -m http.server`),
# so an anonymous push cannot succeed there today. None of the label-chain
# assertions depend on a shared push — the branch/commit are real and local, the
# PR + labels + events (the asserted hops) live in fake-github. Making the remote
# writable (smart-HTTP / git-daemon + a writable mount) is a separable infra
# follow-up; see README.md and the issue thread.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"

REPO="$(resolve_repo)"; [ -n "$REPO" ] || REPO="e2e/fixture"
ISSUE="$(issue_number)"; [ -n "$ISSUE" ] || ISSUE="0"
BRANCH="e2e/iban-validation-${ISSUE}"
log "Developer: implementing issue #${ISSUE} on ${REPO} (branch ${BRANCH})"

# ── Real git in the workspace clone (best-effort; never fatal) ───────────────
CLONE="$(repo_dir)"
if [ -n "$CLONE" ]; then
  (
    cd "$CLONE" || exit 0
    git checkout -B "$BRANCH" >&2 2>&1 || true
    printf 'IBAN validation scaffold for issue #%s\n' "$ISSUE" >> IBAN_VALIDATION.md
    git -c user.name='e2e-developer' -c user.email='developer@e2e.local' \
      add IBAN_VALIDATION.md >&2 2>&1 || true
    git -c user.name='e2e-developer' -c user.email='developer@e2e.local' \
      commit -m "feat: scaffold IBAN validation (refs #${ISSUE})" >&2 2>&1 || true
    # Read-only remote (#667): the push cannot succeed — log, don't fail.
    if git push origin "$BRANCH" >&2 2>&1; then
      echo "[playbook] Developer: pushed ${BRANCH}" >&2
    else
      echo "[playbook] Developer: push skipped — git-remote is read-only (#667)" >&2
    fi
  ) || true
else
  log "Developer: no workspace clone found — skipping local git (PR still opened)"
fi

# ── Open the PR + signal for review on fake-github (the asserted hops) ───────
PR_BODY="$(BRANCH="$BRANCH" ISSUE="$ISSUE" python3 - <<'PY'
import json, os
print(json.dumps({
    "title": "Validate recipient IBAN on the SEPA transfer form",
    "head": os.environ["BRANCH"],
    "base": "main",
    "body": f"Implements IBAN validation. Closes #{os.environ['ISSUE']}.",
}))
PY
)"
RESP="$(gh_post "/repos/${REPO}/pulls" "$PR_BODY")"
PR="$(printf '%s' "$RESP" | json_field number)"
if [ -z "$PR" ]; then
  log "Developer: PR create returned: ${RESP}"
  exit 0
fi
gh_post "/repos/${REPO}/pulls/${PR}/labels" '{"labels":["ready-for-review"]}' >/dev/null
log "Developer: opened PR #${PR}, labelled ready-for-review"
