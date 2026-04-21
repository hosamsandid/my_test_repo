#!/usr/bin/env python3
"""
Deterministic git merge workflow for agent work in i-SASE.

Handles both direct merge and PR-based merge workflows from review-mrp.md Step 6.
Replaces 7+ step manual git operations with a single script call.

Usage:
    python3 scripts/merge-agent-work.py --agent-id <id> --bp-hash <hash> [--slug <slug>] [--title <title>]
    python3 scripts/merge-agent-work.py --agent-id <id> --bp-hash <hash> --pr-mode

Modes:
    direct (default): git merge --no-ff + push
    --pr-mode:        create PR branch, squash merge, gh pr create, gh pr merge

Exit codes:
    0  Merge successful
    1  Merge failed
    2  Missing arguments
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import REPO_ROOT, git_run, git_user, agent_branch_name as branch_name


# ---------------------------------------------------------------------------
# Direct merge
# ---------------------------------------------------------------------------

def merge_direct(
    agent_id: str,
    bp_hash: str,
    title: str = "",
) -> dict:
    """Direct merge: git merge --no-ff + push."""
    branch = branch_name(agent_id, bp_hash)
    user = git_user()
    commit_msg = f"merge(bp:{bp_hash[:6]}): approved work by {user}"

    result = {
        "mode": "direct",
        "branch": branch,
        "steps": [],
    }

    # Merge
    r = git_run(
        ["merge", "--no-ff", branch, "-m", commit_msg],
        check=False,
    )
    if r.returncode != 0:
        result["error"] = f"Merge failed: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git merge --no-ff {branch}")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Merged {branch} into main")
    result["merged"] = True

    # Push
    r = git_run(["push"], check=False)
    if r.returncode != 0:
        result["error"] = f"Push failed: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git push")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append("Pushed to origin")

    result["success"] = True
    result["commit_message"] = commit_msg
    return result


# ---------------------------------------------------------------------------
# PR-based merge
# ---------------------------------------------------------------------------

def merge_pr(
    agent_id: str,
    bp_hash: str,
    slug: str = "",
    title: str = "",
) -> dict:
    """PR-based merge: create PR branch, squash, create PR, merge PR."""
    branch = branch_name(agent_id, bp_hash)
    pr_branch = f"pr/{bp_hash[:6]}-{slug}" if slug else f"pr/{bp_hash[:6]}"
    commit_msg = f"feat(bp:{bp_hash[:6]}): {title} [agent:{agent_id}]"
    pr_title = f"feat(bp:{bp_hash[:6]}): {title}" if title else f"feat(bp:{bp_hash[:6]})"

    result = {
        "mode": "pr",
        "branch": branch,
        "pr_branch": pr_branch,
        "steps": [],
    }

    # 1. Create PR branch from main
    r = git_run(["checkout", "-b", pr_branch], check=False)
    if r.returncode != 0:
        result["error"] = f"Failed to create PR branch: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git checkout -b {pr_branch}")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Created PR branch: {pr_branch}")

    # 2. Squash merge agent work
    r = git_run(["merge", "--squash", branch], check=False)
    if r.returncode != 0:
        # Abort and go back to main
        git_run(["merge", "--abort"], check=False)
        git_run(["checkout", "main"], check=False)
        git_run(["branch", "-D", pr_branch], check=False)
        result["error"] = f"Squash merge failed: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git merge --squash {branch}")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Squash merged {branch}")

    # 3. Commit
    r = git_run(["commit", "-m", commit_msg], check=False)
    if r.returncode != 0:
        result["error"] = f"Commit failed: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git commit")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Committed: {commit_msg}")

    # 4. Push PR branch
    r = git_run(["push", "-u", "origin", pr_branch], check=False)
    if r.returncode != 0:
        result["error"] = f"Push failed: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git push -u origin {pr_branch}")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Pushed to origin/{pr_branch}")

    # 5. Create PR via gh
    pr_body = (
        f"## Summary\n\n"
        f"- Agent `{agent_id}` completed BP `{bp_hash[:6]}`\n"
        f"- Branch: `{branch}`\n\n"
        f"## Merge Strategy\n\n"
        f"Squash merge of agent work.\n"
    )
    r = subprocess.run(
        ["gh", "pr", "create",
         "--title", pr_title,
         "--body", pr_body,
         "--base", "main",
         "--head", pr_branch],
        capture_output=True, text=True,
        cwd=str(REPO_ROOT),
        check=False,
    )
    if r.returncode != 0:
        result["warning"] = f"gh pr create failed (PR may need manual creation): {r.stderr.strip()}"
        result["steps"].append(f"WARN: gh pr create failed — create PR manually for {pr_branch}")
        result["pr_created"] = False
        result["merged"] = False
    else:
        pr_url = r.stdout.strip()
        result["pr_url"] = pr_url
        result["pr_created"] = True
        result["steps"].append(f"Created PR: {pr_url}")

        # 6. Try to merge PR
        # Extract PR number from URL
        pr_match = re.search(r"/pull/(\d+)", pr_url)
        if pr_match:
            pr_number = pr_match.group(1)
            r = subprocess.run(
                ["gh", "pr", "merge", pr_number,
                 "--squash", "--delete-branch"],
                capture_output=True, text=True,
                cwd=str(REPO_ROOT),
                check=False,
            )
            if r.returncode == 0:
                result["merged"] = True
                result["steps"].append(f"Merged PR #{pr_number}")
            else:
                result["merged"] = False
                result["warning"] = f"Auto-merge failed (may need manual approval): {r.stderr.strip()}"
                result["steps"].append(f"WARN: gh pr merge failed — merge PR #{pr_number} manually")
        else:
            result["merged"] = False

    # 7. Return to main and sync
    git_run(["checkout", "main"], check=False)
    r = git_run(["pull", "--rebase", "origin", "main"], check=False)
    if r.returncode == 0:
        result["steps"].append("Synced main with remote")
    else:
        result["steps"].append("WARN: Failed to sync main — run 'git pull --rebase' manually")

    result["success"] = True  # git merge+push succeeded; gh PR is optional
    result["commit_message"] = commit_msg
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Deterministic git merge workflow for agent work",
    )
    parser.add_argument("--agent-id", required=True, help="Agent ID")
    parser.add_argument("--bp-hash", required=True, help="BP hash")
    parser.add_argument("--slug", default="", help="BP slug (for PR branch naming)")
    parser.add_argument("--title", default="", help="BP title (for commit/PR message)")
    parser.add_argument("--pr-mode", action="store_true",
                       help="Use PR-based merge instead of direct merge")

    args = parser.parse_args()

    if args.pr_mode:
        result = merge_pr(args.agent_id, args.bp_hash, args.slug, args.title)
    else:
        result = merge_direct(args.agent_id, args.bp_hash, args.title)

    print(json.dumps(result, indent=2))

    for step in result["steps"]:
        if step.startswith("FAIL") or step.startswith("WARN"):
            print(f"  {step}", file=sys.stderr)


if __name__ == "__main__":
    main()
