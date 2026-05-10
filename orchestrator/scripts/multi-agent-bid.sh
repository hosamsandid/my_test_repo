#!/usr/bin/env bash
# multi-agent-bid — Two-phase work-distribution pre-check for Developer agents.
#
# Exit codes:
#   0  — an issue is assigned to this agent; caller should invoke the LLM.
#        Stdout contains issue number, title, and body as context for the LLM.
#   1  — no LLM needed (either bids were placed, or there is nothing to do).
#   2  — configuration error.
#
# Phase 1 (Assignment check):
#   If any open issue carries `assigned:<AGENT_ID>`, print a summary and
#   exit 0 so agent-runner proceeds to LLM invocation.
#
# Phase 2 (Bidding):
#   List open issues labelled `ready` that have no `assigned:*` or `started:*`
#   label. For each: create `bid:<AGENT_ID>` in the repo (if absent) and add
#   it to the issue. Exit 1 — bidding is pure shell, no LLM needed.
#
# Environment (all required):
#   GH_REPO   — owner/repo (e.g. "acme/my-repo")
#   AGENT_ID  — agent identifier (e.g. "aee-team-developer")
#   GH_TOKEN  — GitHub PAT (typically already present in the container env)

set -euo pipefail

REPO="${GH_REPO:-}"
AID="${AGENT_ID:-}"

if [[ -z "$REPO" || -z "$AID" ]]; then
  echo "multi-agent-bid: GH_REPO and AGENT_ID are required" >&2
  exit 2
fi

# ── Phase 1: Check for assignment ────────────────────────────────────────────
ASSIGNED_LABEL="assigned:${AID}"

assigned_issues=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --label "$ASSIGNED_LABEL" \
  --json number,title,body \
  --limit 1 \
  2>/dev/null || echo "[]")

assigned_count=$(echo "$assigned_issues" | jq 'length')

if [[ "$assigned_count" -gt 0 ]]; then
  num=$(echo "$assigned_issues"   | jq -r '.[0].number')
  title=$(echo "$assigned_issues" | jq -r '.[0].title')
  body=$(echo "$assigned_issues"  | jq -r '.[0].body // ""')
  printf 'Issue #%s is assigned to you.\nTitle: %s\n\nBody:\n%s\n' \
    "$num" "$title" "$body"
  exit 0
fi

# ── Phase 2: Bid on ready issues ──────────────────────────────────────────────
ready_issues=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --label "ready" \
  --json number,labels \
  --limit 50 \
  2>/dev/null || echo "[]")

# Keep only issues that carry no assigned:* or started:* label.
biddable=$(echo "$ready_issues" | jq '[.[] | select(
  .labels | map(.name) | any(test("^(assigned|started):")) | not
)]')

biddable_count=$(echo "$biddable" | jq 'length')

if [[ "$biddable_count" -eq 0 ]]; then
  exit 1
fi

BID_LABEL="bid:${AID}"

# Create the bid label in the repo if it does not exist yet.
if ! gh label list \
    --repo "$REPO" \
    --json name \
    --limit 500 \
    2>/dev/null \
    | jq -r '.[].name' | grep -qxF "$BID_LABEL"; then
  gh label create "$BID_LABEL" \
    --repo "$REPO" \
    --color "ededed" \
    --description "Bid from agent ${AID}" \
    2>/dev/null || true
fi

# Place a bid on every biddable issue.
echo "$biddable" | jq -r '.[].number' | while read -r issue_num; do
  gh issue edit "$issue_num" \
    --repo "$REPO" \
    --add-label "$BID_LABEL" \
    2>/dev/null || true
done

exit 1  # Bidding is pure shell — no LLM call needed.
