#!/usr/bin/env python3
"""
Deterministic agent worktree lifecycle management for i-SASE.

Handles worktree creation (branch + worktree + push) and cleanup
(remove worktree + delete local/remote branch). Replaces multi-step
git commands scattered across dispatch, brief, status, and review-mrp.

Usage:
    python3 scripts/worktree-ops.py create  --agent-id <id> --bp-hash <hash> [--push]
    python3 scripts/worktree-ops.py cleanup --agent-id <id> --bp-hash <hash> [--delete-remote]
    python3 scripts/worktree-ops.py status  --bp-hash <hash>
    python3 scripts/worktree-ops.py list

Naming conventions:
    Branch:   agent/{agent-id}/{bp-hash}
    Worktree: .worktrees/{agent-id}-{bp-hash}/
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    REPO_ROOT, git_run, rel_path,
    agent_branch_name as branch_name,
    agent_worktree_path as worktree_path,
)

WORKTREES_DIR = REPO_ROOT / ".worktrees"


def worktree_exists(agent_id: str, bp_hash: str) -> bool:
    """Check if a worktree exists for this agent/BP combination."""
    wt_path = worktree_path(agent_id, bp_hash)
    if not wt_path.exists():
        return False
    # Also verify git knows about it
    r = git_run(["worktree", "list", "--porcelain"], check=False)
    return str(wt_path) in r.stdout


def branch_exists_local(branch: str) -> bool:
    """Check if a local branch exists."""
    r = git_run(["rev-parse", "--verify", branch], check=False)
    return r.returncode == 0


def branch_exists_remote(branch: str) -> bool:
    """Check if a remote branch exists."""
    r = git_run(["rev-parse", "--verify", f"origin/{branch}"], check=False)
    return r.returncode == 0


# ---------------------------------------------------------------------------
# Create worktree
# ---------------------------------------------------------------------------

def create_worktree(
    agent_id: str,
    bp_hash: str,
    push: bool = False,
) -> dict:
    """Create a new agent worktree with its own branch.

    Steps:
    1. Create the worktree directory
    2. Create a new branch from current HEAD
    3. Add the worktree
    4. Optionally push the branch to origin
    """
    branch = branch_name(agent_id, bp_hash)
    wt_path = worktree_path(agent_id, bp_hash)

    result = {
        "action": "create",
        "agent_id": agent_id,
        "bp_hash": bp_hash,
        "branch": branch,
        "worktree": rel_path(wt_path),
    }

    # Check if already exists
    if worktree_exists(agent_id, bp_hash):
        print(f"ERROR: Worktree already exists: {rel_path(wt_path)}",
              file=sys.stderr)
        sys.exit(1)

    if branch_exists_local(branch):
        print(f"ERROR: Branch already exists: {branch}", file=sys.stderr)
        sys.exit(1)

    # Ensure .worktrees directory exists
    WORKTREES_DIR.mkdir(exist_ok=True)

    # Create worktree + branch
    r = git_run(
        ["worktree", "add", str(wt_path), "-b", branch],
        check=False,
    )
    if r.returncode != 0:
        print(f"ERROR: Failed to create worktree:\n{r.stderr}", file=sys.stderr)
        sys.exit(1)

    print(f"Created worktree: {rel_path(wt_path)}")
    print(f"  branch: {branch}")
    result["created"] = True

    # Push if requested
    if push:
        r = git_run(
            ["push", "-u", "origin", branch],
            cwd=str(wt_path),
            check=False,
        )
        if r.returncode == 0:
            print(f"  pushed: origin/{branch}")
            result["pushed"] = True
        else:
            print(f"  push failed: {r.stderr.strip()}", file=sys.stderr)
            result["pushed"] = False

    return result


# ---------------------------------------------------------------------------
# Cleanup worktree
# ---------------------------------------------------------------------------

def cleanup_worktree(
    agent_id: str,
    bp_hash: str,
    delete_remote: bool = False,
) -> dict:
    """Remove an agent worktree and clean up branches.

    Steps:
    1. Remove the git worktree (if exists)
    2. Delete the local branch (if exists)
    3. Optionally delete the remote branch
    """
    branch = branch_name(agent_id, bp_hash)
    wt_path = worktree_path(agent_id, bp_hash)

    result = {
        "action": "cleanup",
        "agent_id": agent_id,
        "bp_hash": bp_hash,
        "branch": branch,
        "worktree": rel_path(wt_path) if wt_path.exists() else None,
    }

    cleaned = []

    # 1. Remove worktree
    if wt_path.exists():
        r = git_run(["worktree", "remove", str(wt_path), "--force"], check=False)
        if r.returncode == 0:
            cleaned.append(f"worktree {rel_path(wt_path)} removed")
        else:
            # Try without --force first
            r2 = git_run(["worktree", "remove", str(wt_path)], check=False)
            if r2.returncode == 0:
                cleaned.append(f"worktree {rel_path(wt_path)} removed")
            else:
                cleaned.append(f"worktree removal failed: {r.stderr.strip()}")
    else:
        cleaned.append("worktree: not found locally (already removed or remote-only)")

    # 2. Delete local branch
    if branch_exists_local(branch):
        r = git_run(["branch", "-d", branch], check=False)
        if r.returncode != 0:
            # Try force delete if not fully merged
            r = git_run(["branch", "-D", branch], check=False)
        if r.returncode == 0:
            cleaned.append(f"local branch {branch} deleted")
        else:
            cleaned.append(f"local branch deletion failed: {r.stderr.strip()}")
    else:
        cleaned.append("local branch: not found")

    # 3. Delete remote branch (if requested)
    if delete_remote:
        if branch_exists_remote(branch):
            r = git_run(
                ["push", "origin", "--delete", branch],
                check=False,
            )
            if r.returncode == 0:
                cleaned.append(f"remote branch origin/{branch} deleted")
            else:
                cleaned.append(f"remote branch deletion failed (may already be gone)")
        else:
            cleaned.append("remote branch: not found")

    result["cleaned"] = cleaned
    for item in cleaned:
        print(f"  {item}")

    return result


# ---------------------------------------------------------------------------
# Status: show worktree info for a BP
# ---------------------------------------------------------------------------

def worktree_status(bp_hash: str) -> dict:
    """Show worktree and branch status for a BP hash."""
    # Find all worktrees
    r = git_run(["worktree", "list", "--porcelain"], check=False)
    worktrees = []
    if r.returncode == 0:
        current_wt = {}
        for line in r.stdout.split("\n"):
            if line.startswith("worktree "):
                if current_wt:
                    worktrees.append(current_wt)
                current_wt = {"path": line[9:]}
            elif line.startswith("branch "):
                current_wt["branch"] = line[7:]
            elif line.strip() == "":
                if current_wt:
                    worktrees.append(current_wt)
                current_wt = {}

    # Find branches for this BP
    r = git_run(
        ["for-each-ref", "--format=%(refname:short)", f"refs/heads/agent/*/{bp_hash}"],
        check=False,
    )
    local_branches = [b.strip() for b in r.stdout.strip().split("\n") if b.strip()]

    r = git_run(
        ["for-each-ref", "--format=%(refname:short)", f"refs/remotes/origin/agent/*/{bp_hash}"],
        check=False,
    )
    remote_branches = [b.strip() for b in r.stdout.strip().split("\n") if b.strip()]

    # Match worktrees to this BP
    bp_worktrees = []
    for wt in worktrees:
        path = wt.get("path", "")
        branch = wt.get("branch", "")
        if bp_hash in path or bp_hash in branch:
            bp_worktrees.append(wt)

    result = {
        "bp_hash": bp_hash,
        "local_worktrees": bp_worktrees,
        "local_branches": local_branches,
        "remote_branches": remote_branches,
    }

    print(f"Worktree status for bp:{bp_hash[:6]}")
    if bp_worktrees:
        for wt in bp_worktrees:
            print(f"  worktree: {wt['path']}")
            if wt.get("branch"):
                print(f"  branch:   {wt['branch']}")
    else:
        print("  No local worktrees")
    if local_branches:
        print(f"  local branches: {', '.join(local_branches)}")
    if remote_branches:
        print(f"  remote branches: {', '.join(remote_branches)}")

    return result


# ---------------------------------------------------------------------------
# List: show all agent worktrees
# ---------------------------------------------------------------------------

def list_worktrees() -> list[dict]:
    """List all agent worktrees."""
    r = git_run(["worktree", "list"], check=False)
    if r.returncode != 0:
        print("No worktrees found")
        return []

    agent_pattern = re.compile(r"agent/([0-9a-f]{8})/([0-9a-f]{12})")
    results = []

    for line in r.stdout.strip().split("\n"):
        if ".worktrees/" not in line:
            continue
        parts = line.split()
        if len(parts) >= 3:
            path = parts[0]
            branch_match = agent_pattern.search(line)
            if branch_match:
                results.append({
                    "path": path,
                    "agent_id": branch_match.group(1),
                    "bp_hash": branch_match.group(2),
                    "branch": f"agent/{branch_match.group(1)}/{branch_match.group(2)}",
                })

    if results:
        print(f"Agent worktrees ({len(results)}):")
        for wt in results:
            print(f"  {wt['path']}")
            print(f"    agent: {wt['agent_id']}  bp: {wt['bp_hash'][:6]}  branch: {wt['branch']}")
    else:
        print("No agent worktrees found")

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Agent worktree lifecycle management for i-SASE",
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # create
    p_create = sub.add_parser("create", help="Create agent worktree + branch")
    p_create.add_argument("--agent-id", required=True, help="8-char hex agent ID")
    p_create.add_argument("--bp-hash", required=True, help="12-char hex BP hash")
    p_create.add_argument("--push", action="store_true", help="Push branch to origin")
    p_create.add_argument("--json", action="store_true", help="JSON output")

    # cleanup
    p_clean = sub.add_parser("cleanup", help="Remove worktree + delete branches")
    p_clean.add_argument("--agent-id", required=True, help="8-char hex agent ID")
    p_clean.add_argument("--bp-hash", required=True, help="12-char hex BP hash")
    p_clean.add_argument("--delete-remote", action="store_true",
                        help="Also delete remote branch")
    p_clean.add_argument("--json", action="store_true", help="JSON output")

    # status
    p_status = sub.add_parser("status", help="Show worktree info for a BP")
    p_status.add_argument("--bp-hash", required=True, help="BP hash (or prefix)")
    p_status.add_argument("--json", action="store_true", help="JSON output")

    # list
    p_list = sub.add_parser("list", help="List all agent worktrees")
    p_list.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()

    if args.action == "create":
        result = create_worktree(args.agent_id, args.bp_hash, push=args.push)
        if args.json:
            print(json.dumps(result, indent=2))
    elif args.action == "cleanup":
        result = cleanup_worktree(
            args.agent_id, args.bp_hash,
            delete_remote=args.delete_remote,
        )
        if args.json:
            print(json.dumps(result, indent=2))
    elif args.action == "status":
        result = worktree_status(args.bp_hash)
        if args.json:
            print(json.dumps(result, indent=2))
    elif args.action == "list":
        results = list_worktrees()
        if args.json:
            print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
