#!/usr/bin/env python3
"""
Build the BP index for i-SASE.

Scans artifacts/briefings/ (excluding .archive/) and produces:
  - artifacts/briefings/.index.json  (machine-readable flat dict)

Uses only stdlib. No external dependencies.

Usage:
    python3 scripts/build-index.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIEFINGS_DIR = REPO_ROOT / "artifacts" / "briefings"
INDEX_JSON = BRIEFINGS_DIR / ".index.json"

# Pattern: 12-char hex hash, then dash, then slug
DIR_PATTERN = re.compile(r"^([0-9a-f]{12})-(.+)$")

# Fields to extract from YAML frontmatter
SCALAR_FIELDS = [
    "id", "slug", "mission", "status", "rigor",
    "created", "agent-id", "phase", "last-heartbeat",
]
LIST_FIELDS = ["author", "depends-on", "execution-order"]
# artifacts is a structured list (list of objects) parsed separately


# ---------------------------------------------------------------------------
# YAML frontmatter parser (stdlib only)
# ---------------------------------------------------------------------------

def parse_frontmatter(text: str) -> dict:
    """Parse YAML frontmatter between --- markers. Simple key: value parsing."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}

    fm_lines = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        fm_lines.append(line)

    result = {}
    current_key = None
    current_list = None
    # State for parsing structured list items (e.g. artifacts)
    in_structured_list = False
    current_obj = None

    for line in fm_lines:
        # Skip blank lines and comments
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # Detect structured list item start or continuation: "  - key: value"
        # Keys may contain hyphens (e.g. source-bp, flagged-at, previous-status).
        if re.match(r"^  - [\w-]+:", line):
            if current_key and current_list is not None:
                # Switch to structured list mode if not already
                if not in_structured_list:
                    in_structured_list = True
                # Save previous object if any
                if current_obj is not None:
                    current_list.append(current_obj)
                current_obj = {}
                # Parse the key: value on this line
                item_stripped = line.strip().lstrip("- ").strip()
                if ":" in item_stripped:
                    k = item_stripped[:item_stripped.index(":")].strip()
                    v = item_stripped[item_stripped.index(":") + 1:].strip().strip('"').strip("'")
                    current_obj[k] = v
            continue

        # Detect structured list field continuation: "    key: value"
        # Keys may contain hyphens (e.g. revision-reason, agent-id, previous-status).
        if in_structured_list and current_obj is not None and re.match(r"^    [\w-]+:", line):
            item_stripped = line.strip()
            if ":" in item_stripped:
                k = item_stripped[:item_stripped.index(":")].strip()
                v = item_stripped[item_stripped.index(":") + 1:].strip().strip('"').strip("'")
                current_obj[k] = v
            continue

        # If we were in a structured list and hit a non-continuation line, close it
        if in_structured_list:
            if current_obj is not None:
                current_list.append(current_obj)
                current_obj = None
            result[current_key] = current_list
            in_structured_list = False
            current_list = None

        # Detect list continuation (indented "- ")
        if line.startswith("  - ") or line.startswith("  -\t") or line.startswith("    - "):
            if current_key and current_list is not None:
                item = line.strip().lstrip("- ").strip()
                # Handle inline arrays like ["a", "b"]
                if item.startswith("[") and item.endswith("]"):
                    inner = item[1:-1]
                    sub_items = [s.strip().strip('"').strip("'") for s in inner.split(",")]
                    current_list.append(sub_items)
                else:
                    item = item.strip('"').strip("'")
                    current_list.append(item)
                result[current_key] = current_list
            continue

        # Top-level key: value
        if ":" in stripped:
            colon_idx = stripped.index(":")
            key = stripped[:colon_idx].strip()
            value = stripped[colon_idx + 1:].strip()

            # Start a new list if value is empty (next lines are list items)
            if not value:
                current_key = key
                current_list = []
                result[key] = current_list
                # Check if this is a structured list (like artifacts)
                # We'll detect on the first item line
                continue

            # Inline list: [a, b, c]
            if value.startswith("[") and value.endswith("]"):
                inner = value[1:-1].strip()
                if not inner:
                    items = []
                else:
                    items = [s.strip().strip('"').strip("'") for s in inner.split(",")]
                result[key] = items
                current_key = key
                current_list = items
                continue

            # Scalar value
            value = value.strip('"').strip("'")
            result[key] = value
            current_key = key
            current_list = None

    # Flush any remaining structured list object
    if in_structured_list and current_obj is not None:
        current_list.append(current_obj)
        result[current_key] = current_list

    return result


# ---------------------------------------------------------------------------
# Scanner
# ---------------------------------------------------------------------------

def find_bp_dirs(root: Path) -> list[Path]:
    """Find all directories matching the BP naming pattern, excluding .archive."""
    bp_dirs = []
    for path in root.rglob("brief.md"):
        parent = path.parent
        if ".archive" in parent.parts:
            continue
        if DIR_PATTERN.match(parent.name):
            bp_dirs.append(parent)
    return sorted(bp_dirs)


def extract_hash_slug(dirname: str) -> tuple[str, str] | None:
    """Extract (hash, slug) from a directory name like '5d300b06a8fe-ace-plugin'."""
    m = DIR_PATTERN.match(dirname)
    if m:
        return m.group(1), m.group(2)
    return None


def determine_parent(bp_dir: Path, briefings_root: Path) -> str | None:
    """Determine parent BP hash from directory nesting."""
    parent_dir = bp_dir.parent
    if parent_dir == briefings_root:
        return None
    parsed = extract_hash_slug(parent_dir.name)
    if parsed:
        return parsed[0]
    return None


def determine_children(bp_dir: Path) -> list[str]:
    """Find child BP hashes from immediate subdirectories."""
    children = []
    if not bp_dir.is_dir():
        return children
    for child in sorted(bp_dir.iterdir()):
        if child.is_dir():
            parsed = extract_hash_slug(child.name)
            if parsed and (child / "brief.md").exists():
                children.append(parsed[0])
    return children


# Branch status ordering — higher number = more advanced in lifecycle
_STATUS_ORDER = {
    "draft": 0, "ready": 1, "dispatched": 2, "claimed": 3,
    "in-progress": 4, "completed": 5, "reviewed": 6, "stale": 7,
}


def _derive_status_from_children(bp_hash: str, briefings: dict, visited: set) -> str:
    """Recursively derive a parent BP's status from its children.

    Rules (checked in order):
    - Any child stale  -> stale  (parent surfaces the integrity concern)
    - All children reviewed  -> reviewed
    - All children completed or reviewed  -> completed
    - Any child dispatched/claimed/in-progress (not all done)  -> in-progress
    - All children at least ready  -> ready
    - Otherwise  -> draft
    """
    if bp_hash in visited:
        return briefings.get(bp_hash, {}).get("status", "draft")
    visited.add(bp_hash)

    entry = briefings.get(bp_hash)
    if not entry:
        return "draft"

    children = entry.get("children", [])
    if not children:
        return entry.get("status") or "draft"

    # Recurse into children first (bottom-up)
    child_statuses = []
    for child_hash in children:
        child = briefings.get(child_hash)
        if not child:
            continue
        if child.get("children"):
            cs = _derive_status_from_children(child_hash, briefings, visited)
        else:
            visited.add(child_hash)
            cs = child.get("status") or "draft"
        child_statuses.append(cs)

    if not child_statuses:
        return entry.get("status") or "draft"

    if any(s == "stale" for s in child_statuses):
        return "stale"
    if all(s == "reviewed" for s in child_statuses):
        return "reviewed"
    if all(s in ("completed", "reviewed") for s in child_statuses):
        return "completed"
    if any(s in ("dispatched", "claimed", "in-progress") for s in child_statuses):
        return "in-progress"
    if all(_STATUS_ORDER.get(s, 0) >= _STATUS_ORDER.get("ready", 1) for s in child_statuses):
        return "ready"
    return "draft"


def _derive_parent_statuses(briefings: dict) -> None:
    """Derive status for all parent BPs (those with children) in-place."""
    visited: set = set()
    for bp_hash, entry in briefings.items():
        if entry.get("children"):
            entry["status"] = _derive_status_from_children(bp_hash, briefings, visited)
            entry["is_parent"] = True
        else:
            entry["is_parent"] = False


def discover_agent_branches() -> dict[str, dict]:
    """Discover remote agent branches and map BP hashes to branch info."""
    try:
        result = subprocess.run(
            [
                "git", "for-each-ref",
                "--format=%(refname:short)",
                "refs/remotes/origin/agent/",
            ],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT), timeout=10,
        )
    except Exception:
        return {}
    if result.returncode != 0:
        return {}

    branches: dict[str, dict] = {}
    pattern = re.compile(r"^origin/agent/([0-9a-f]{8})/([0-9a-f]{12})$")
    for line in result.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        m = pattern.match(line)
        if m:
            agent_id, bp_hash = m.group(1), m.group(2)
            branches[bp_hash] = {
                "branch": line,
                "agent_id": agent_id,
            }
    return branches


def _discover_worktree_briefings() -> dict[str, dict]:
    """Discover BP data from local worktree directories.

    Scans ``.worktrees/`` (ACE) and ``.claude/worktrees/`` (Claude Code)
    for brief.md files.  Returns dict: bp_hash -> {frontmatter, branch}.
    """
    results: dict[str, dict] = {}
    worktree_dirs = [
        REPO_ROOT / ".worktrees",
        REPO_ROOT / ".claude" / "worktrees",
    ]
    # Resolve worktree -> branch mapping
    branch_by_path: dict[str, str] = {}
    try:
        wt_result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT), timeout=10,
        )
        if wt_result.returncode == 0:
            current_path = None
            for line in wt_result.stdout.split("\n"):
                if line.startswith("worktree "):
                    current_path = line[len("worktree "):]
                elif line.startswith("branch refs/heads/") and current_path:
                    branch_by_path[current_path] = line[len("branch refs/heads/"):]
    except Exception:
        pass

    for wt_base in worktree_dirs:
        if not wt_base.is_dir():
            continue
        for wt_dir in wt_base.iterdir():
            if not wt_dir.is_dir():
                continue
            briefings_dir = wt_dir / "artifacts" / "briefings"
            if not briefings_dir.is_dir():
                continue
            for bp_path in briefings_dir.rglob("brief.md"):
                if ".archive" in bp_path.parts:
                    continue
                try:
                    text = bp_path.read_text(encoding="utf-8")
                except Exception:
                    continue
                fm = parse_frontmatter(text)
                bp_id = fm.get("id", "")
                if not bp_id:
                    dir_name = bp_path.parent.name
                    if re.match(r"^[0-9a-f]{12}-", dir_name):
                        bp_id = dir_name[:12]
                if not bp_id:
                    continue
                # Skip files without valid BP schema
                if not fm.get("status"):
                    continue
                wt_abs = str(wt_dir.resolve())
                branch = branch_by_path.get(wt_abs, "")
                # Prefer entry with more advanced status
                prev = results.get(bp_id)
                if prev:
                    prev_status = prev["frontmatter"].get("status", "")
                    new_status = fm.get("status", "")
                    if (_STATUS_ORDER.get(prev_status, -1)
                            > _STATUS_ORDER.get(new_status, -1)):
                        continue
                results[bp_id] = {
                    "frontmatter": fm,
                    "branch": branch,
                }
    return results


def git_show_file(branch: str, file_path: str) -> str | None:
    """Read a file from a git branch without checkout."""
    try:
        result = subprocess.run(
            ["git", "show", f"{branch}:{file_path}"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT), timeout=10,
        )
        if result.returncode == 0:
            return result.stdout
    except Exception:
        pass
    return None


def build_index(include_branches: bool = False) -> dict:
    """Build the full index dict.

    When *include_branches* is True, also reads BP status from active
    agent branches and overlays more-advanced status values.
    """
    if not BRIEFINGS_DIR.exists():
        return {"generated": datetime.now(timezone.utc).isoformat(), "briefings": {}}

    bp_dirs = find_bp_dirs(BRIEFINGS_DIR)
    briefings = {}

    for bp_dir in bp_dirs:
        parsed = extract_hash_slug(bp_dir.name)
        if not parsed:
            continue
        bp_hash, slug = parsed

        brief_file = bp_dir / "brief.md"
        if not brief_file.exists():
            continue

        text = brief_file.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)

        # Build relative path from briefings root
        rel_path = str(bp_dir.relative_to(BRIEFINGS_DIR))

        entry = {
            "slug": slug,
            "mission": fm.get("mission") or fm.get("title"),
            "status": fm.get("status"),
            "rigor": fm.get("rigor"),
            "author": fm.get("author") if isinstance(fm.get("author"), list) else ([fm["author"]] if fm.get("author") else []),
            "created": fm.get("created"),
            "parent": determine_parent(bp_dir, BRIEFINGS_DIR),
            "children": determine_children(bp_dir),
            "depends-on": fm.get("depends-on", []),
            "execution-order": fm.get("execution-order", []),
            "agent-id": fm.get("agent-id"),
            "phase": fm.get("phase"),
            "last-heartbeat": fm.get("last-heartbeat"),
            "artifacts": fm.get("artifacts", []),
            "revision": fm.get("revision"),
            "stale-because": fm.get("stale-because", []),
            "dependents": [],
            "path": rel_path,
            "branch": None,
        }
        # Reorder children according to execution-order when present
        exec_order = entry["execution-order"]
        if exec_order and entry["children"]:
            # Schema requires 12-char hex IDs; slice defensively in case slug is appended
            # execution-order may contain strings (sequential) or lists (parallel groups)
            ordered_hashes = []
            for e in exec_order:
                if isinstance(e, list):
                    ordered_hashes.extend(item[:12] for item in e)
                elif isinstance(e, dict):
                    ordered_hashes.append(e.get("id", "")[:12])
                else:
                    ordered_hashes.append(e[:12])
            child_set = set(entry["children"])
            reordered = [h for h in ordered_hashes if h in child_set]
            # Append any children not listed in execution-order
            reordered += [h for h in entry["children"] if h not in reordered]
            entry["children"] = reordered

        briefings[bp_hash] = entry

    # --- Branch overlay ---------------------------------------------------
    if include_branches:
        agent_branches = discover_agent_branches()
        overlaid = 0
        for bp_hash, branch_info in agent_branches.items():
            entry = briefings.get(bp_hash)
            if not entry:
                continue

            # Read brief.md from the agent branch
            brief_rel = f"artifacts/briefings/{entry['path']}/brief.md"
            branch_text = git_show_file(branch_info["branch"], brief_rel)
            if not branch_text:
                continue

            branch_fm = parse_frontmatter(branch_text)
            branch_status = branch_fm.get("status", "")
            main_status = entry["status"] or ""

            # Skip overlay when BP was cancelled/released on main:
            # agent-id is removed and status reset to ready — main wins.
            if not entry.get("agent-id") and main_status == "ready":
                entry["branch"] = branch_info["branch"]
                continue

            if _STATUS_ORDER.get(branch_status, -1) > _STATUS_ORDER.get(main_status, -1):
                entry["status"] = branch_status
                entry["phase"] = branch_fm.get("phase", entry["phase"])
                entry["last-heartbeat"] = branch_fm.get("last-heartbeat", entry["last-heartbeat"])
                entry["agent-id"] = branch_fm.get("agent-id", entry["agent-id"])
                overlaid += 1

            entry["branch"] = branch_info["branch"]

        if overlaid:
            print(f"  Branch overlay: {overlaid} BPs updated from agent branches")

        # --- Worktree overlay: read from local worktree filesystem ----------
        # Captures uncommitted changes and Claude Code worktree branches
        # (worktree-agent-* naming) that discover_agent_branches misses.
        wt_overlaid = 0
        wt_bps = _discover_worktree_briefings()
        for bp_hash, wt_info in wt_bps.items():
            entry = briefings.get(bp_hash)
            if not entry:
                continue

            wt_fm = wt_info["frontmatter"]
            wt_status = wt_fm.get("status", "")
            main_status = entry["status"] or ""

            if not entry.get("agent-id") and main_status == "ready":
                if wt_info["branch"]:
                    entry["branch"] = wt_info["branch"]
                continue

            wt_has_agent = bool(wt_fm.get("agent-id"))
            main_has_agent = bool(entry.get("agent-id"))
            status_advanced = (
                _STATUS_ORDER.get(wt_status, -1)
                > _STATUS_ORDER.get(main_status, -1)
            )
            agent_claimed = wt_has_agent and not main_has_agent

            if status_advanced or agent_claimed:
                if status_advanced:
                    entry["status"] = wt_status
                entry["phase"] = wt_fm.get("phase", entry["phase"])
                entry["last-heartbeat"] = wt_fm.get(
                    "last-heartbeat", entry["last-heartbeat"]
                )
                entry["agent-id"] = wt_fm.get("agent-id", entry["agent-id"])
                wt_overlaid += 1

            if wt_info.get("branch"):
                entry["branch"] = wt_info["branch"]

        if wt_overlaid:
            print(f"  Worktree overlay: {wt_overlaid} BPs updated from local worktrees")

    # --- Compute forward dependents (inverse of depends-on) -----------------
    # For each BP, list the hashes of BPs whose depends-on contains it.
    # Used by /ace:status and /ace:revise to compute transitive impact on
    # cascade flagging (revise -> stale).
    for bp_hash, entry in briefings.items():
        for dep_hash in (entry.get("depends-on") or []):
            target = briefings.get(dep_hash)
            if target is not None:
                target["dependents"].append(bp_hash)

    # --- Derive parent status from children (bottom-up) --------------------
    _derive_parent_statuses(briefings)

    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "briefings": briefings,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Build BP index for i-SASE")
    parser.add_argument(
        "--include-branches",
        action="store_true",
        help="Also scan agent branches and overlay their BP status into the index",
    )
    args = parser.parse_args()

    index = build_index(include_branches=args.include_branches)
    briefings = index["briefings"]

    # Write .index.json
    BRIEFINGS_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_JSON.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Summary
    active = len(briefings)
    archive_dir = BRIEFINGS_DIR / ".archive"
    archived = sum(1 for _ in archive_dir.rglob("brief.md")) if archive_dir.is_dir() else 0
    on_branch = sum(1 for e in briefings.values() if e.get("branch"))
    parts = [f"{active} active", f"{archived} archived"]
    if on_branch:
        parts.append(f"{on_branch} on agent branches")
    print(f"Indexed {active} BPs ({', '.join(parts)})")

    # Also regenerate Blueprint index if blueprints directory exists
    blueprints_dir = REPO_ROOT / "artifacts" / "blueprints"
    if blueprints_dir.exists() and any(blueprints_dir.rglob("blueprint.md")):
        subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "build-blueprint-index.py")],
            cwd=str(REPO_ROOT),
        )


if __name__ == "__main__":
    main()
