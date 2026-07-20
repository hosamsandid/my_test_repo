#!/bin/bash
# BA playbook (issue #711, §6.2): the Business Analyst's "thinking" for the IBAN
# story. Woken by a human DM, it creates the GitHub issue the human will then
# approve with the `ready` label. Content is deliberately minimal — the CI
# journey proves the wiring, not the prose (the IBAN narrative is for the
# docs/live lane). Talks to fake-github directly with curl (see _lib.sh).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"

REPO="$(resolve_repo)"; [ -n "$REPO" ] || REPO="e2e/fixture"
log "BA: creating IBAN-validation issue in $REPO"

BODY="$(python3 - <<'PY'
import json
title = "Validate the recipient IBAN on the SEPA transfer form"
body = (
    "## Human Section\n\n"
    "Today the transfer form accepts any text in the IBAN field and always "
    "reports success. It should validate the recipient IBAN before the transfer "
    "can go through.\n\n"
    "## Agent Section\n\n"
    "Problem: the SEPA transfer form does not verify the recipient IBAN.\n\n"
    "Acceptance criteria:\n"
    "1. Validate the IBAN when the field loses focus.\n"
    "2. Block submission on an invalid IBAN.\n"
    "3. Block submission when the validation service is unreachable.\n"
    "4. Show the resolved bank details for a valid IBAN.\n"
    "5. Only the recipient IBAN is in scope.\n\n"
    "(Scaffolded by the e2e fake Business Analyst playbook — #711.)"
)
print(json.dumps({"title": title, "body": body, "labels": []}))
PY
)"

RESP="$(gh_post "/repos/${REPO}/issues" "$BODY")"
NUM="$(printf '%s' "$RESP" | json_field number)"
if [ -n "$NUM" ]; then
  log "BA: created issue #${NUM} in ${REPO}"
else
  log "BA: issue create returned: ${RESP}"
fi
