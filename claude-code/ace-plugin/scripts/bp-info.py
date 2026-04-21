#!/usr/bin/env python3
"""
Deterministic BP lookup and field extraction for i-SASE.

Finds a BP by hash prefix, reads all frontmatter fields, optionally
enriches with CRP/MRP counts, resolves loopscript, and checks agent
branch status. Replaces repeated "Search artifacts/briefings/" patterns.

Usage:
    python3 scripts/bp-info.py <bp-hash-prefix>
    python3 scripts/bp-info.py <bp-hash-prefix> --with-guidance    # include CRP/MRP counts
    python3 scripts/bp-info.py <bp-hash-prefix> --with-branch      # include agent branch info
    python3 scripts/bp-info.py <bp-hash-prefix> --text             # human-readable output

Exit codes:
    0  BP found
    1  BP not found
    2  Ambiguous prefix
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    REPO_ROOT, GUIDANCE_DIR,
    parse_frontmatter, find_bp, has_children, resolve_loopscript,
    minutes_ago as _minutes_ago, parse_iso_datetime,
)


# ---------------------------------------------------------------------------
# Guidance artifact counts
# ---------------------------------------------------------------------------

def count_guidance(bp_hash: str) -> dict:
    """Count CRPs and MRPs for a given BP hash."""
    crp_dir = GUIDANCE_DIR / "crp"
    mrp_dir = GUIDANCE_DIR / "mrp"
    vcr_dir = GUIDANCE_DIR / "vcr"

    crps = {"open": 0, "resolved": 0, "deferred": 0, "total": 0}
    mrps = {"pending": 0, "reviewed": 0, "total": 0}

    # Build VCR resolved set
    resolved_ids = set()
    if vcr_dir.exists():
        for path in vcr_dir.glob("*.md"):
            text = path.read_text(encoding="utf-8")
            fm = parse_frontmatter(text)
            resolves = fm.get("resolves", "")
            if resolves:
                resolved_ids.add(resolves)

    # Count CRPs
    if crp_dir.exists():
        for path in crp_dir.glob("*.md"):
            text = path.read_text(encoding="utf-8")
            fm = parse_frontmatter(text)
            bp = fm.get("bp") or fm.get("briefing-pack", "")
            if bp != bp_hash:
                continue
            crps["total"] += 1
            status = fm.get("status", "open")
            mode = fm.get("mode", "blocking")
            if status == "resolved":
                crps["resolved"] += 1
            elif mode == "deferred" or status == "deferred-to-mrp":
                crps["deferred"] += 1
            else:
                crps["open"] += 1

    # Count MRPs
    if mrp_dir.exists():
        for path in mrp_dir.glob("*.md"):
            text = path.read_text(encoding="utf-8")
            fm = parse_frontmatter(text)
            bp = fm.get("bp") or fm.get("briefing-pack", "")
            if bp != bp_hash:
                continue
            mrps["total"] += 1
            mrp_id = fm.get("id", "")
            if mrp_id in resolved_ids or fm.get("status") in ("approved", "rejected"):
                mrps["reviewed"] += 1
            else:
                mrps["pending"] += 1

    return {"crps": crps, "mrps": mrps}


# ---------------------------------------------------------------------------
# Agent branch info
# ---------------------------------------------------------------------------

def get_branch_info(bp_hash: str, agent_id: str | None) -> dict | None:
    """Get agent branch info for a BP."""
    if not agent_id:
        return None

    branch = f"agent/{agent_id}/{bp_hash}"
    worktree_path = f".worktrees/{agent_id}-{bp_hash}"

    info = {
        "branch": branch,
        "worktree_path": worktree_path,
        "local_worktree_exists": (REPO_ROOT / worktree_path).exists(),
    }

    # Check remote branch
    r = subprocess.run(
        ["git", "rev-parse", "--verify", f"origin/{branch}"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    info["remote_branch_exists"] = r.returncode == 0

    # Get modified files from agent branch
    if info["remote_branch_exists"]:
        r = subprocess.run(
            ["git", "diff", "--name-only", f"main...origin/{branch}"],
            capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
        if r.returncode == 0:
            info["modified_files"] = [f for f in r.stdout.strip().split("\n") if f]
        else:
            info["modified_files"] = []

    return info


def heartbeat_age_minutes(timestamp: str | None) -> float | None:
    """Calculate minutes since heartbeat using sase_lib utilities."""
    dt = parse_iso_datetime(timestamp)
    return _minutes_ago(dt)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def get_bp_info(
    bp_prefix: str,
    with_guidance: bool = False,
    with_branch: bool = False,
) -> dict:
    """Get full BP info as structured dict."""
    brief_path, bp_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent

    text = brief_path.read_text(encoding="utf-8")
    fm = parse_frontmatter(text)

    # Core fields
    result = {
        "bp_hash": bp_hash,
        "slug": slug,
        "path": str(brief_path.relative_to(REPO_ROOT)),
        "directory": str(bp_dir.relative_to(REPO_ROOT)),
        "is_parent": has_children(bp_dir),
        "is_leaf": not has_children(bp_dir),
    }

    # All frontmatter fields
    result["frontmatter"] = fm

    # Key fields at top level for convenience
    result["status"] = fm.get("status", "draft")
    result["mission"] = fm.get("mission") or fm.get("title", "")
    result["rigor"] = fm.get("rigor", "standard")
    result["agent_id"] = fm.get("agent-id")
    result["phase"] = fm.get("phase")
    result["last_heartbeat"] = fm.get("last-heartbeat")
    result["created"] = fm.get("created")
    result["claimed"] = fm.get("claimed")
    result["completed"] = fm.get("completed")

    # Heartbeat age
    if result["last_heartbeat"]:
        age = heartbeat_age_minutes(result["last_heartbeat"])
        result["heartbeat_age_minutes"] = round(age, 1) if age else None
        result["is_stale"] = age is not None and age > 180  # 3 hours
    else:
        result["heartbeat_age_minutes"] = None
        result["is_stale"] = None

    # Cancellable status check
    result["is_cancellable"] = result["status"] in ("dispatched", "claimed", "in-progress")

    # Resolve loopscript
    ls_value = fm.get("loop-script") or fm.get("loopscript")
    result["resolved_loopscript"] = resolve_loopscript(ls_value, result["rigor"])

    # MentorScripts
    ms = fm.get("mentor-scripts") or fm.get("mentorscripts") or []
    if isinstance(ms, str):
        ms = [ms]
    result["mentorscripts"] = ms

    # Execution mode
    result["execution_mode"] = "high" if result["rigor"] in ("high", "critical") else "standard"

    # Guidance counts
    if with_guidance:
        result["guidance"] = count_guidance(bp_hash)

    # Branch info
    if with_branch and result["agent_id"]:
        result["branch_info"] = get_branch_info(bp_hash, result["agent_id"])

    return result


def format_text(info: dict) -> str:
    """Format BP info as human-readable text."""
    lines = [
        f"BP: bp:{info['bp_hash'][:6]} ({info['slug']})",
        f"  mission: {info['mission']}",
        f"  status: {info['status']}",
        f"  rigor: {info['rigor']}",
        f"  path: {info['path']}",
    ]

    if info.get("agent_id"):
        lines.append(f"  agent-id: {info['agent_id']}")
    if info.get("phase"):
        lines.append(f"  phase: {info['phase']}")
    if info.get("last_heartbeat"):
        age = info.get("heartbeat_age_minutes")
        stale = " [STALE]" if info.get("is_stale") else ""
        lines.append(f"  last-heartbeat: {info['last_heartbeat']} ({int(age)}m ago){stale}" if age else f"  last-heartbeat: {info['last_heartbeat']}")
    if info.get("resolved_loopscript"):
        lines.append(f"  loopscript: {info['resolved_loopscript']}")
    if info.get("execution_mode"):
        lines.append(f"  execution-mode: {info['execution_mode']}")

    if "guidance" in info:
        g = info["guidance"]
        lines.append(f"  CRPs: {g['crps']['open']} open, {g['crps']['resolved']} resolved, {g['crps']['deferred']} deferred")
        lines.append(f"  MRPs: {g['mrps']['pending']} pending, {g['mrps']['reviewed']} reviewed")

    if "branch_info" in info and info["branch_info"]:
        bi = info["branch_info"]
        lines.append(f"  branch: {bi['branch']}")
        lines.append(f"  worktree: {bi['worktree_path']} ({'exists' if bi['local_worktree_exists'] else 'not found locally'})")
        if bi.get("modified_files"):
            lines.append(f"  modified files: {len(bi['modified_files'])}")

    return "\n".join(lines)


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="BP lookup and field extraction for i-SASE",
    )
    parser.add_argument("bp_prefix", help="BP hash or unique prefix")
    parser.add_argument("--with-guidance", action="store_true",
                       help="Include CRP/MRP counts")
    parser.add_argument("--with-branch", action="store_true",
                       help="Include agent branch info")
    parser.add_argument("--text", action="store_true",
                       help="Human-readable output")

    args = parser.parse_args()

    info = get_bp_info(
        args.bp_prefix,
        with_guidance=args.with_guidance,
        with_branch=args.with_branch,
    )

    if args.text:
        print(format_text(info))
    else:
        print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
