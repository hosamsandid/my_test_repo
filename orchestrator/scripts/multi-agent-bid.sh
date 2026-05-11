#!/usr/bin/env bash
# multi-agent-bid — Work-distribution pre-check for Developer agents.
#
# The script has two independent phases that can be run separately or together,
# selected via BID_MODE:
#
#   BID_MODE=both       (default) — Phase 1 then, if no assignment, Phase 2.
#   BID_MODE=safetynet  — Phase 1 only. Used as a missed-event safety net.
#   BID_MODE=bid        — Phase 2 only. Pure-shell bidding, never invokes LLM.
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
#   List open issues labelled `$DISPATCH_LABEL` (the label the Dispatcher
#   applies to release work) that have no `assigned:*` or `started:*` label.
#   For each: create `bid:<AGENT_ID>` in the repo (if absent) and add it to
#   the issue. Exit 1 — bidding is pure shell, no LLM needed.
#
# Environment:
#   GH_REPO        — owner/repo (e.g. "acme/my-repo"). Always required.
#   AGENT_ID       — agent identifier (e.g. "aee-team-developer"). Always required.
#   DISPATCH_LABEL — label the Dispatcher applies (e.g. "dispatch"). Required for
#                    BID_MODE=both and BID_MODE=bid. Ignored for BID_MODE=safetynet.
#   BID_MODE       — "both" (default), "safetynet", or "bid".
#   COORDINATOR_WORKFLOW — workflow file name to dispatch after a successful bid
#                    (default: "coordinator.yml"). Set to "" to disable. Failures
#                    are ignored — the scheduled cron remains as a safety net.
#   GH_TOKEN       — GitHub PAT (typically already present in the container env).

set -euo pipefail

REPO="${GH_REPO:-}"
AID="${AGENT_ID:-}"
DISPATCH_LABEL="${DISPATCH_LABEL:-}"
MODE="${BID_MODE:-both}"

case "$MODE" in
  both|safetynet|bid) ;;
  *)
    echo "multi-agent-bid: BID_MODE must be one of: both, safetynet, bid (got '$MODE')" >&2
    exit 2
    ;;
esac

if [[ -z "$REPO" || -z "$AID" ]]; then
  echo "multi-agent-bid: GH_REPO and AGENT_ID are required" >&2
  exit 2
fi
if [[ "$MODE" != "safetynet" && -z "$DISPATCH_LABEL" ]]; then
  echo "multi-agent-bid: DISPATCH_LABEL is required for BID_MODE=$MODE" >&2
  exit 2
fi

# ── Phase 1: Check for assignment ────────────────────────────────────────────
if [[ "$MODE" == "both" || "$MODE" == "safetynet" ]]; then
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

  # safetynet mode stops here — bidding is not its job.
  if [[ "$MODE" == "safetynet" ]]; then
    exit 1
  fi
fi

# ── Self-busy guard: don't bid if I already hold work in flight ──────────────
# Skips bidding when *this* agent already has an open issue carrying
# `assigned:<AID>` or `started:<AID>`. Without this guard a Developer that's
# currently implementing one issue would still bid on every newly dispatched
# one — and might win and end up double-booked.
#
# Phase 1 (above) already catches `assigned:<AID>` in `both` mode, but the
# `bid` mode skips Phase 1, so the check has to live here too. Closed issues
# never count: a finished PR's `started:<AID>` rides into the closed state and
# must not block future bids.
self_busy=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --json labels \
  --limit 200 \
  2>/dev/null \
  || echo "[]")
self_busy=$(echo "$self_busy" | jq --arg me "$AID" '[.[] | select(
    .labels | map(.name) | any(. == ("assigned:" + $me) or . == ("started:" + $me))
  )] | length')
if [[ "${self_busy:-0}" -gt 0 ]]; then
  exit 1
fi

# ── Phase 2: Bid on dispatched issues ─────────────────────────────────────────
ready_issues=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --label "$DISPATCH_LABEL" \
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

# Wake the coordinator workflow immediately via workflow_dispatch instead of
# waiting for the scheduled cron tick. GitHub schedules scheduled workflows on
# a best-effort basis — measured gaps of 60–80 min are common on private repos
# under load. A workflow_dispatch trigger typically queues in seconds. The
# scheduled `*/5 * * * *` remains as a safety net for missed dispatches.
#
# Idempotent: if two Developers fire workflow_dispatch concurrently, the
# coordinator handles both runs; the second sees `assigned:*` already in place
# and exits as a no-op. Failures are swallowed by design — the scheduled cron
# will catch up later.
# Use ${VAR-default} (no colon) so an explicitly empty COORDINATOR_WORKFLOW=""
# disables the trigger; only an *unset* variable falls back to coordinator.yml.
WORKFLOW="${COORDINATOR_WORKFLOW-coordinator.yml}"
if [[ -n "$WORKFLOW" ]]; then
  gh workflow run "$WORKFLOW" --repo "$REPO" 2>/dev/null || true
fi

exit 1  # Bidding is pure shell — no LLM call needed.
