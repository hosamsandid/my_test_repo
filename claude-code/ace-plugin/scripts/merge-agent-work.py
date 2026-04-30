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
    0  Merge successful (push/PR may have warnings — see JSON output)
    1  Merge failed (the local merge itself did not succeed)
    2  Missing arguments

Push and PR-creation failures are reported in the JSON output (`pushed: false`,
`pr_created: false`) but do NOT change the exit code: the success of the
local merge is what matters for downstream review-side automation.
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
# Helpers
# ---------------------------------------------------------------------------

def _has_remote() -> bool:
    """Return True if the repo has at least one configured git remote."""
    r = git_run(["remote"], check=False)
    return r.returncode == 0 and bool(r.stdout.strip())


# ---------------------------------------------------------------------------
# Direct merge
# ---------------------------------------------------------------------------

def merge_direct(
    agent_id: str,
    bp_hash: str,
    title: str = "",
) -> dict:
    """Direct merge: git merge --no-ff + push (push best-effort)."""
    branch = branch_name(agent_id, bp_hash)
    user = git_user()
    commit_msg = f"merge(bp:{bp_hash[:6]}): approved work by {user}"

    result = {
        "mode": "direct",
        "branch": branch,
        "steps": [],
        "merged": False,
        "pushed": False,
    }

    # Merge — only this step gates the exit code.
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
    result["commit_message"] = commit_msg

    # Push — best-effort. Local-only repos and transient push failures should
    # not abort the review workflow once the merge has already landed.
    if not _has_remote():
        result["steps"].append("SKIP: git push (no remote configured)")
    else:
        r = git_run(["push"], check=False)
        if r.returncode != 0:
            err = r.stderr.strip()
            result["push_error"] = err
            result["steps"].append(f"WARN: git push failed — {err}")
        else:
            result["pushed"] = True
            result["steps"].append("Pushed to origin")

    result["success"] = True  # success owned by `merged`, not `pushed`
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
    """PR-based merge: create PR branch, squash, create PR, merge PR.

    Failure semantics:
    - Squash-merge or commit failure: real merge failure → exit 1.
    - Branch-push or `gh pr create` / `gh pr merge` failure: reported as
      warning, exit 0. The local PR branch is still ready for manual push.
    - Missing remote: PR mode requires a remote; surfaces as branch-push
      warning rather than aborting before the merge has been recorded.
    """
    branch = branch_name(agent_id, bp_hash)
    pr_branch = f"pr/{bp_hash[:6]}-{slug}" if slug else f"pr/{bp_hash[:6]}"
    commit_msg = f"feat(bp:{bp_hash[:6]}): {title} [agent:{agent_id}]"
    pr_title = f"feat(bp:{bp_hash[:6]}): {title}" if title else f"feat(bp:{bp_hash[:6]})"

    result = {
        "mode": "pr",
        "branch": branch,
        "pr_branch": pr_branch,
        "steps": [],
        "merged": False,
        "pushed": False,
        "pr_created": False,
    }

    # 1. Create PR branch from main — checkout failure is a real failure.
    r = git_run(["checkout", "-b", pr_branch], check=False)
    if r.returncode != 0:
        result["error"] = f"Failed to create PR branch: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git checkout -b {pr_branch}")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Created PR branch: {pr_branch}")

    # 2. Squash merge agent work — real merge failure if this fails.
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

    # 3. Commit — real failure if this fails (nothing to PR otherwise).
    r = git_run(["commit", "-m", commit_msg], check=False)
    if r.returncode != 0:
        result["error"] = f"Commit failed: {r.stderr.strip()}"
        result["steps"].append(f"FAIL: git commit")
        print(json.dumps(result, indent=2))
        sys.exit(1)
    result["steps"].append(f"Committed: {commit_msg}")
    result["commit_message"] = commit_msg

    # 4. Push PR branch — best-effort from here on.
    if not _has_remote():
        result["steps"].append("SKIP: git push (no remote configured — PR mode requires a remote)")
    else:
        r = git_run(["push", "-u", "origin", pr_branch], check=False)
        if r.returncode != 0:
            err = r.stderr.strip()
            result["push_error"] = err
            result["steps"].append(f"WARN: git push -u origin {pr_branch} failed — {err}")
        else:
            result["pushed"] = True
            result["steps"].append(f"Pushed to origin/{pr_branch}")

    # 5. Create PR via gh — only if push succeeded; otherwise the remote
    #    branch doesn't exist and `gh pr create` would fail anyway.
    if result["pushed"]:
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
            result["pr_create_error"] = r.stderr.strip()
            result["steps"].append(
                f"WARN: gh pr create failed — create PR manually for {pr_branch}: {r.stderr.strip()}"
            )
        else:
            pr_url = r.stdout.strip()
            result["pr_url"] = pr_url
            result["pr_created"] = True
            result["steps"].append(f"Created PR: {pr_url}")

            # 6. Try to merge PR
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
                    result["pr_merge_error"] = r.stderr.strip()
                    result["steps"].append(
                        f"WARN: gh pr merge failed — merge PR #{pr_number} manually: {r.stderr.strip()}"
                    )

    # 7. Return to main and sync (best-effort)
    git_run(["checkout", "main"], check=False)
    if _has_remote():
        r = git_run(["pull", "--rebase", "origin", "main"], check=False)
        if r.returncode == 0:
            result["steps"].append("Synced main with remote")
        else:
            result["steps"].append("WARN: Failed to sync main — run 'git pull --rebase' manually")

    result["success"] = True  # local merge+commit succeeded; remote ops are optional
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
