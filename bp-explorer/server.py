#!/usr/bin/env python3
"""Agent Dashboard — FastAPI server with JSON API.

Serves the canvas UI and provides live access to agent data
from artifacts/briefings/. Also provides agent invocation endpoints
powered by the Claude Agent SDK (SSE streaming).

Requires fastapi, uvicorn, and claude-agent-sdk.

Usage:
    python3 server.py [--port 8765]
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import logging
import os
import re
import subprocess
import sys
import time
import warnings

# Python 3.14+ deprecated asyncio.iscoroutinefunction; Starlette still uses it.
warnings.filterwarnings(
    "ignore",
    message=r"'asyncio\.iscoroutinefunction' is deprecated",
    category=DeprecationWarning,
)

import yaml
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path

from aee_bridge import AEEBridge
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Branch status ordering — higher number = more advanced in lifecycle
_STATUS_ORDER = {
    "draft": 0, "ready": 1, "dispatched": 2, "claimed": 3,
    "completed": 4, "reviewed": 5,
}


def find_briefings(base_dir: Path) -> list[Path]:
    """Recursively find all brief.md files under base_dir."""
    return sorted(base_dir.rglob("brief.md"))


# BP directory naming convention: "<12-hex-hash>-<slug>".
_BP_DIR_RE = re.compile(r"^([0-9a-f]{12})-")


def derive_parent_from_path(bp_path: Path, briefings_dir: Path) -> str | None:
    """Return the parent BP's 12-char hash inferred from on-disk nesting.

    Walks the relative path from `briefings_dir` to `bp_path` outward from
    the BP's own directory and returns the hash of the closest ancestor
    that is itself a BP directory (matches `<12-hex>-<slug>`). Non-BP
    intermediates (e.g. `.archive`) are skipped without breaking the chain.
    Returns None when the BP sits at the top level of `artifacts/briefings/`.

    The directory structure is the authoritative source for the BP
    parent-child hierarchy; frontmatter `parent:` is only consulted as a
    fallback when nesting yields no answer.
    """
    try:
        rel = bp_path.relative_to(briefings_dir)
    except ValueError:
        return None
    # rel.parts ends with ("<bp-dir>", "brief.md"); strip both to get ancestors.
    ancestors = rel.parts[:-2]
    for part in reversed(ancestors):
        m = _BP_DIR_RE.match(part)
        if m:
            return m.group(1)
    return None


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse YAML frontmatter and return (metadata_dict, markdown_body).

    Handles the subset of YAML used in briefing packs:
    - key: value (scalars)
    - key: [] (empty lists)
    - key: followed by indented - item lines (string lists)
    - key: followed by indented - subkey: val groups (object lists)
    """
    lines = text.split("\n")

    # Find frontmatter boundaries (--- delimiters)
    delimiters = [i for i, line in enumerate(lines) if line.strip() == "---"]
    if len(delimiters) < 2:
        return {}, text

    fm_lines = lines[delimiters[0] + 1 : delimiters[1]]
    body = "\n".join(lines[delimiters[1] + 1 :]).strip()

    result: dict = {}
    current_key: str | None = None
    current_list: list | None = None
    current_obj: dict | None = None

    def flush_list():
        nonlocal current_key, current_list, current_obj
        if current_key is not None and current_list is not None:
            if current_obj:
                current_list.append(current_obj)
                current_obj = None
            result[current_key] = current_list
            current_list = None
            current_key = None

    for line in fm_lines:
        stripped = line.rstrip()
        if not stripped:
            continue

        # Top-level key: value (no leading whitespace)
        if not stripped[0].isspace():
            flush_list()

            colon_idx = stripped.find(":")
            if colon_idx == -1:
                continue

            key = stripped[:colon_idx].strip()
            val = stripped[colon_idx + 1 :].strip()

            if val == "[]":
                result[key] = []
            elif val.startswith("[") and val.endswith("]"):
                # JSON-array inline syntax: ["item1", "item2"] or ["id1"]
                try:
                    import json as _json
                    result[key] = _json.loads(val)
                except (ValueError, Exception):
                    result[key] = val
            elif val == "":
                # Start of a list
                current_key = key
                current_list = []
            else:
                # Strip surrounding quotes
                if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
                    val = val[1:-1]
                result[key] = val

        elif stripped.lstrip().startswith("- "):
            # List item
            indent = len(stripped) - len(stripped.lstrip())
            item_text = stripped.lstrip()[2:].strip()

            if ": " in item_text and current_list is not None:
                # Object item (e.g., "id: 7cd8e66dcfab")
                if current_obj:
                    current_list.append(current_obj)
                current_obj = {}
                k, _, v = item_text.partition(":")
                v = v.strip().strip('"')
                current_obj[k.strip()] = v
            else:
                # Scalar item
                if current_obj:
                    current_list.append(current_obj)
                    current_obj = None
                if current_list is not None:
                    item_text = item_text.strip('"')
                    current_list.append(item_text)

        elif current_obj is not None:
            # Continuation of object item (deeper indent)
            kv = stripped.strip()
            if ":" in kv:
                k, _, v = kv.partition(":")
                v = v.strip().strip('"')
                current_obj[k.strip()] = v

    flush_list()
    return result, body


def discover_agent_branches(project_root: Path) -> dict[str, dict]:
    """Discover local AND remote agent branches and map BP hashes to branch info.

    Returns dict: bp_hash -> {branch, agent_id, bp_hash, source}.
    Scans both ``refs/heads/agent/`` (local worktrees) and
    ``refs/remotes/origin/agent/`` (pushed by colleagues).
    Local branches take precedence over remote for the same BP.
    Uses ``git for-each-ref`` which is faster than ``git branch -r``.
    """
    branches: dict[str, dict] = {}

    # Scan both local and remote agent branches
    ref_specs = [
        ("refs/heads/agent/", "local"),
        ("refs/remotes/origin/agent/", "remote"),
    ]

    for ref_prefix, source in ref_specs:
        try:
            result = subprocess.run(
                [
                    "git", "for-each-ref",
                    "--format=%(refname:short)",
                    ref_prefix,
                ],
                capture_output=True, text=True,
                cwd=str(project_root), timeout=10,
            )
        except Exception:
            continue
        if result.returncode != 0:
            continue

        # Local branches: agent/{agent_id}/{bp_hash}
        # Remote branches: origin/agent/{agent_id}/{bp_hash}
        if source == "local":
            pattern = re.compile(r"^agent/([0-9a-f]{8})/([0-9a-f]{12})$")
        else:
            pattern = re.compile(r"^origin/agent/([0-9a-f]{8})/([0-9a-f]{12})$")

        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            m = pattern.match(line)
            if m:
                agent_id, bp_hash = m.group(1), m.group(2)
                # Local branches take precedence (more up-to-date than remote)
                if bp_hash not in branches or source == "local":
                    branches[bp_hash] = {
                        "branch": line,
                        "agent_id": agent_id,
                        "bp_hash": bp_hash,
                        "source": source,
                    }
    return branches


def discover_worktree_briefings(project_root: Path) -> dict[str, dict]:
    """Discover BP data from local worktree directories (uncommitted or committed).

    Scans ``.worktrees/`` (ACE) and ``.claude/worktrees/`` (Claude Code)
    for brief.md files.  Returns dict: bp_id -> {frontmatter, body, branch,
    agent_id, worktree_path}.  Reads directly from the filesystem, so it
    captures uncommitted worktree changes that ``git show`` misses.
    """
    results: dict[str, dict] = {}
    worktree_dirs = [
        project_root / ".worktrees",
        project_root / ".claude" / "worktrees",
    ]
    # Resolve worktree → branch mapping via ``git worktree list --porcelain``
    branch_by_path: dict[str, str] = {}
    try:
        wt_result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=10,
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
            # Scan for brief.md files in this worktree
            briefings_dir = wt_dir / "artifacts" / "briefings"
            if not briefings_dir.is_dir():
                continue
            for bp_path in briefings_dir.rglob("brief.md"):
                # Skip archive
                if ".archive" in bp_path.parts:
                    continue
                try:
                    text = bp_path.read_text(encoding="utf-8")
                except Exception:
                    continue
                meta, body = parse_frontmatter(text)
                bp_id = meta.get("id", "")
                if not bp_id:
                    # Try to extract from directory name
                    dir_name = bp_path.parent.name
                    if re.match(r"^[0-9a-f]{12}-", dir_name):
                        bp_id = dir_name[:12]
                if not bp_id:
                    continue
                # Only accept files with valid BP schema (skip stale/draft files
                # that may share a directory prefix but lack proper frontmatter)
                has_valid_schema = meta.get("schema", "").startswith("sase/")
                has_status = bool(meta.get("status"))
                if not has_valid_schema and not has_status:
                    continue
                # Resolve branch name for this worktree
                wt_abs = str(wt_dir.resolve())
                branch = branch_by_path.get(wt_abs, "")
                agent_id = meta.get("agent-id", "")
                # Prefer entries with more advanced status; otherwise
                # later worktrees win (Claude Code > ACE)
                prev = results.get(bp_id)
                if prev:
                    prev_status = prev["frontmatter"].get("status", "")
                    new_status = meta.get("status", "")
                    if (_STATUS_ORDER.get(prev_status, -1)
                            > _STATUS_ORDER.get(new_status, -1)):
                        continue
                results[bp_id] = {
                    "frontmatter": meta,
                    "body": body,
                    "branch": branch,
                    "agent_id": agent_id,
                    "worktree_path": str(wt_dir),
                }
    return results


def git_show_file(project_root: Path, branch: str, file_path: str) -> str | None:
    """Read a file from a git branch without checkout via ``git show``."""
    try:
        result = subprocess.run(
            ["git", "show", f"{branch}:{file_path}"],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=10,
        )
        if result.returncode == 0:
            return result.stdout
    except Exception:
        pass
    return None


def git_branch_head_date(project_root: Path, branch: str) -> str | None:
    """Return the ISO 8601 commit date of a branch's HEAD, or None on failure."""
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%cI", branch],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
    except Exception:
        pass
    return None


def git_file_size(project_root: Path, branch: str, file_path: str) -> int:
    """Return the size (in bytes) of a file on a git branch, or 0 on failure."""
    try:
        result = subprocess.run(
            ["git", "cat-file", "-s", f"{branch}:{file_path}"],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=10,
        )
        if result.returncode == 0:
            return int(result.stdout.strip())
    except Exception:
        pass
    return 0


def git_ls_tree(project_root: Path, branch: str, dir_path: str) -> list[dict]:
    """List files in a directory on a git branch via ``git ls-tree``.

    Returns list of dicts with keys: mode, type, hash, path.
    """
    # Ensure trailing slash for directory listing
    ref = f"{branch}:{dir_path.rstrip('/')}/"
    try:
        result = subprocess.run(
            ["git", "ls-tree", "--name-only", ref],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=10,
        )
        if result.returncode != 0:
            return []
        entries = []
        base = dir_path.rstrip("/")
        for name in result.stdout.strip().split("\n"):
            name = name.strip()
            if name:
                entries.append({"path": f"{base}/{name}", "name": name})
        return entries
    except Exception:
        return []


def fetch_agent_refs(project_root: Path) -> None:
    """Fetch agent branch refs from remote (lightweight, refs only)."""
    try:
        subprocess.run(
            ["git", "fetch", "origin", "refs/heads/agent/*:refs/remotes/origin/agent/*"],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=30,
        )
    except Exception:
        logger.debug("Failed to fetch agent refs from remote")


# Throttle state for fetch_agent_refs — avoid hammering git on every API call
_last_fetch_time: float = 0.0
_FETCH_THROTTLE_SECONDS: float = 15.0


def fetch_agent_refs_throttled(project_root: Path) -> None:
    """Fetch agent refs from remote, but at most once per _FETCH_THROTTLE_SECONDS."""
    global _last_fetch_time
    now = time.monotonic()
    if now - _last_fetch_time < _FETCH_THROTTLE_SECONDS:
        return
    _last_fetch_time = now
    fetch_agent_refs(project_root)


def _derive_status_from_children(bp_id: str, by_id: dict, visited: set) -> str:
    """Recursively derive a parent BP's status from its children."""
    if bp_id in visited:
        return by_id.get(bp_id, {}).get("status", "draft")
    visited.add(bp_id)

    bp = by_id.get(bp_id)
    if not bp:
        return "draft"

    children = bp.get("children", [])
    if not children:
        return bp.get("status") or "draft"

    child_statuses = []
    for cid in children:
        child = by_id.get(cid)
        if not child:
            continue
        if child.get("children"):
            cs = _derive_status_from_children(cid, by_id, visited)
        else:
            visited.add(cid)
            cs = child.get("status") or "draft"
        child_statuses.append(cs)

    if not child_statuses:
        return bp.get("status") or "draft"

    if all(s == "reviewed" for s in child_statuses):
        return "reviewed"
    if all(s in ("completed", "reviewed") for s in child_statuses):
        return "completed"
    if any(s in ("dispatched", "claimed") for s in child_statuses):
        return "claimed"
    if all(_STATUS_ORDER.get(s, 0) >= _STATUS_ORDER.get("ready", 1) for s in child_statuses):
        return "ready"
    return "draft"


def _derive_parent_statuses(results: list[dict], by_id: dict) -> None:
    """Derive status for all parent BPs in-place."""
    visited: set = set()
    for bp in results:
        if bp.get("children"):
            bp["status"] = _derive_status_from_children(bp["id"], by_id, visited)
            bp["is_parent"] = True
        else:
            bp["is_parent"] = False


def load_all_briefings(project_root: Path) -> list[dict]:
    """Load and parse all briefing packs, returning a JSON-serializable list.

    After loading from the filesystem (main branch), this function discovers
    active agent branches and overlays their BP status where it is more
    advanced than main.  This gives a unified view across all branches.
    """
    briefings_dir = project_root / "artifacts" / "briefings"
    bp_files = find_briefings(briefings_dir)

    results = []
    for bp_path in bp_files:
        text = bp_path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(text)

        # Relative path from project root (needed for git show on branches)
        rel_path = str(bp_path.relative_to(project_root))

        # Normalize field names (YAML uses hyphens, JSON uses underscores)
        # Detect if this BP lives inside .archive/
        is_archived = ".archive" in bp_path.relative_to(briefings_dir).parts

        # Fallback: extract id/slug from directory name ({hash}-{slug})
        bp_dir_name = bp_path.parent.name
        dir_id = ""
        dir_slug = ""
        if re.match(r"^[0-9a-f]{12}-", bp_dir_name):
            dir_id = bp_dir_name[:12]
            dir_slug = bp_dir_name[13:]

        # Parent BP: directory nesting is the source of truth. Frontmatter
        # `parent:` is only used as a fallback when nesting yields no parent
        # (top-level BP). When both exist and disagree, the directory wins
        # and we log a warning so the inconsistency is visible.
        parent_from_dir = derive_parent_from_path(bp_path, briefings_dir)
        parent_from_meta = meta.get("parent")
        if parent_from_dir is not None:
            parent = parent_from_dir
            if parent_from_meta and parent_from_meta != parent_from_dir:
                logger.warning(
                    "BP %s: frontmatter parent=%s disagrees with directory "
                    "nesting parent=%s; using directory.",
                    bp_path, parent_from_meta, parent_from_dir,
                )
        else:
            parent = parent_from_meta

        bp = {
            "id": meta.get("id") or dir_id,
            "slug": meta.get("slug") or dir_slug,
            "title": meta.get("mission", meta.get("title", "")),
            "status": meta.get("status", ""),
            "rigor": meta.get("rigor", ""),
            "stage": meta.get("stage", ""),
            "created": meta.get("created", ""),
            "parent": parent,
            "children": meta.get("children", []),
            "depends_on": meta.get("depends-on", []),
            "execution_order": meta.get("execution-order", []),
            "loopscript": meta.get("loop-script", meta.get("loopscript", "")),
            "mentorscripts": meta.get("mentor-scripts", meta.get("mentorscripts", [])),
            "artifacts": meta.get("artifacts", []),
            "agent_id": meta.get("agent-id", ""),
            "claimed": meta.get("claimed", ""),
            "completed": meta.get("completed", ""),
            "revision": meta.get("revision", ""),
            "revision_log": meta.get("revision-log", []),
            "re_execution_scope": meta.get("re-execution-scope", {}),
            "body": body,
            "archived": is_archived,
            # Branch-awareness fields
            "_rel_path": rel_path,
            "branch": None,
            "branch_agent_id": None,
        }
        results.append(bp)

    # --- Branch overlay: read status from agent branches -------------------
    agent_branches = discover_agent_branches(project_root)
    if agent_branches:
        by_id = {bp["id"]: bp for bp in results if bp["id"]}
        for bp_hash, branch_info in agent_branches.items():
            bp = by_id.get(bp_hash) or by_id.get(f"bp:{bp_hash}")
            if not bp:
                continue

            # Read brief.md from the agent branch
            branch_text = git_show_file(
                project_root, branch_info["branch"], bp["_rel_path"]
            )
            if not branch_text:
                continue

            branch_meta, branch_body = parse_frontmatter(branch_text)
            branch_status = branch_meta.get("status", "")
            main_status = bp["status"]

            # Skip overlay when the BP was cancelled/released on main:
            # cancel/release remove agent-id and reset status to ready.
            # The agent branch still has the old (more advanced) status,
            # but main's reset takes precedence.
            if not bp["agent_id"] and main_status == "ready":
                bp["branch"] = branch_info["branch"]
                bp["branch_agent_id"] = branch_info["agent_id"]
                continue

            # Override if branch status is more advanced in the lifecycle
            if _STATUS_ORDER.get(branch_status, -1) > _STATUS_ORDER.get(main_status, -1):
                bp["status"] = branch_status
                bp["agent_id"] = branch_meta.get("agent-id", bp["agent_id"])
                bp["claimed"] = branch_meta.get("claimed", bp["claimed"])
                bp["completed"] = branch_meta.get("completed", bp["completed"])
                # Use branch body too (may contain updated content)
                bp["body"] = branch_body

            # Always overlay artifacts from branch if present — agents may
            # update the artifacts list during execution (e.g. adding outputs)
            branch_artifacts = branch_meta.get("artifacts", [])
            if branch_artifacts:
                bp["artifacts"] = branch_artifacts

            bp["branch"] = branch_info["branch"]
            bp["branch_agent_id"] = branch_info["agent_id"]

    # --- Worktree overlay: read status from local worktree filesystem ------
    # This captures uncommitted changes and Claude Code worktree branches
    # (worktree-agent-* naming) that discover_agent_branches misses.
    worktree_bps = discover_worktree_briefings(project_root)
    if worktree_bps:
        by_id = {bp["id"]: bp for bp in results if bp["id"]}
        for bp_id, wt_info in worktree_bps.items():
            bp = by_id.get(bp_id)
            if not bp:
                continue

            wt_meta = wt_info["frontmatter"]
            wt_body = wt_info["body"]
            wt_status = wt_meta.get("status", "")
            main_status = bp["status"]

            # Same cancel/release guard as branch overlay
            if not bp["agent_id"] and main_status == "ready":
                if wt_info["branch"]:
                    bp["branch"] = wt_info["branch"]
                    bp["branch_agent_id"] = wt_info["agent_id"]
                continue

            # Overlay if worktree status is more advanced, OR if the
            # worktree has agent-id set while main doesn't (claim in progress)
            wt_has_agent = bool(wt_meta.get("agent-id"))
            main_has_agent = bool(bp["agent_id"])
            status_advanced = (
                _STATUS_ORDER.get(wt_status, -1)
                > _STATUS_ORDER.get(main_status, -1)
            )
            agent_claimed = wt_has_agent and not main_has_agent

            if status_advanced or agent_claimed:
                bp["status"] = wt_status if status_advanced else bp["status"]
                bp["agent_id"] = wt_meta.get("agent-id", bp["agent_id"])
                bp["claimed"] = wt_meta.get("claimed", bp["claimed"])
                bp["completed"] = wt_meta.get("completed", bp["completed"])
                bp["body"] = wt_body

            # Always overlay artifacts from worktree if present
            wt_artifacts = wt_meta.get("artifacts", [])
            if wt_artifacts:
                bp["artifacts"] = wt_artifacts

            if wt_info["branch"]:
                bp["branch"] = wt_info["branch"]
                bp["branch_agent_id"] = wt_info["agent_id"]

    # --- Completion inference: detect completed BPs from MRP existence -----
    # If the executor's final commit forgot to update status to "completed",
    # the MRP's presence on the branch is a reliable signal.
    for bp in results:
        if bp["status"] in ("completed", "reviewed"):
            continue  # already done
        branch = bp.get("branch")
        if not branch or not bp.get("agent_id"):
            continue  # not on an agent branch
        _, _, has_mrp_on_branch = _find_mrp(
            project_root, bp["id"], bp["slug"], branch=branch,
        )
        if has_mrp_on_branch:
            bp["status"] = "completed"
            if not bp.get("completed"):
                bp["completed"] = git_branch_head_date(project_root, branch) or ""

    # Infer children from parent references (some BPs don't list children explicitly)
    by_id = {bp["id"]: bp for bp in results}
    for bp in results:
        if bp["parent"] and bp["parent"] in by_id:
            parent = by_id[bp["parent"]]
            if bp["id"] not in parent["children"]:
                parent["children"].append(bp["id"])

    # Derive parent status from children (bottom-up)
    _derive_parent_statuses(results, by_id)

    return results


def find_bp_file(project_root: Path, bp_id: str) -> Path | None:
    """Find the brief.md file for a given BP id by scanning the briefings dir."""
    briefings_dir = project_root / "artifacts" / "briefings"
    for bp_path in find_briefings(briefings_dir):
        text = bp_path.read_text(encoding="utf-8")
        meta, _ = parse_frontmatter(text)
        if meta.get("id") == bp_id:
            return bp_path
    return None


def topo_sort(ids: list[str], by_id: dict) -> list[str]:
    """Topological sort: dependencies first, then dependents."""
    id_set = set(ids)
    result = []
    visited = set()

    def visit(bid):
        if bid in visited:
            return
        visited.add(bid)
        bp = by_id.get(bid)
        if not bp:
            return
        for dep_id in bp.get("depends_on", []):
            if dep_id in id_set:
                visit(dep_id)
        result.append(bid)

    for bid in ids:
        visit(bid)
    return result


def _collect_descendants(bp_id: str, by_id: dict, result: set) -> None:
    """Recursively collect all descendant IDs of a BP."""
    bp = by_id.get(bp_id)
    if not bp:
        return
    for cid in bp.get("children", []):
        result.add(cid)
        _collect_descendants(cid, by_id, result)


def topo_sort_roots(root_ids: list[str], by_id: dict) -> list[str]:
    """Topological sort for root-level BPs considering cross-level dependencies.

    If any descendant of root B depends_on any member of root A's tree,
    then A must come before B. This handles cases where child BPs have
    cross-tree dependencies without a direct root-to-root depends_on.
    """
    # Build tree membership: root -> set of all IDs in its tree
    tree_members: dict[str, set] = {}
    for root_id in root_ids:
        members = {root_id}
        _collect_descendants(root_id, by_id, members)
        tree_members[root_id] = members

    # Reverse lookup: any BP id -> which root tree it belongs to
    id_to_root: dict[str, str] = {}
    for root_id, members in tree_members.items():
        for member_id in members:
            id_to_root[member_id] = root_id

    # Derive root-level edges from all descendants' depends_on
    root_deps: dict[str, set] = {rid: set() for rid in root_ids}
    for root_id, members in tree_members.items():
        for member_id in members:
            bp = by_id.get(member_id)
            if not bp:
                continue
            for dep_id in bp.get("depends_on", []):
                dep_root = id_to_root.get(dep_id)
                if dep_root and dep_root != root_id:
                    root_deps[root_id].add(dep_root)

    # Topological sort using derived edges
    root_set = set(root_ids)
    result: list[str] = []
    visited: set = set()

    def visit(rid):
        if rid in visited:
            return
        visited.add(rid)
        for dep_root in root_deps.get(rid, set()):
            if dep_root in root_set:
                visit(dep_root)
        result.append(rid)

    for rid in root_ids:
        visit(rid)
    return result


def _parse_acceptance_criteria(body: str) -> list[dict]:
    """Extract acceptance criteria from BP body markdown.

    Looks for lines matching: - [ ] AC-N: **Title** — description
    Returns list of {code, title, description}.
    """
    criteria = []
    ac_pattern = re.compile(
        r'^- \[[ x]\] (AC-\d+):\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+)',
        re.MULTILINE,
    )
    for m in ac_pattern.finditer(body):
        criteria.append({
            "code": m.group(1),
            "title": m.group(2).strip(),
            "description": m.group(3).strip(),
        })
    return criteria


def _first_paragraph(body: str) -> str:
    """Extract the first real paragraph from markdown body."""
    for line in body.split("\n"):
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and not stripped.startswith(">") and not stripped.startswith("-"):
            return stripped
    return ""


def _bare_hash(bp_id: str) -> str:
    """Strip optional ``bp:`` prefix from a BP ID."""
    return bp_id[3:] if bp_id.startswith("bp:") else bp_id


def _contain_under(root: Path, candidate: Path) -> Path | None:
    """Resolve *candidate* and return it only when it stays within *root*.

    Normalizes both paths with ``os.path.realpath`` (removes ``..`` segments and
    follows symlinks) and then verifies the candidate stays under *root* with a
    SINGLE, DIRECT ``str.startswith`` check in the guard condition — the exact
    barrier shape CodeQL models for py/path-injection (normalize, then
    prefix-check the normalized value; the "contained" branch must be reachable
    *only* when the check holds).

    A prior form OR-ed ``full == root_resolved`` with the ``startswith`` test.
    CodeQL only recognises ``str.startswith`` as a path barrier when the safe
    (return) branch cannot be reached without ``startswith`` being true; the
    ``== ... or ...`` disjunction left it reachable via the equality alone, so
    the guard was not modelled and every value returned from here (and the
    downstream ``.exists()`` / ``.read_text()`` / ``.glob()`` sinks it fed)
    stayed flagged. The trailing ``os.sep`` keeps prefix-sibling safety
    (``/root-evil`` is rejected); every caller passes a strict subpath of
    *root* (``root / <rel>``), never *root* itself, so requiring the separator
    loses no valid path. Returns the resolved absolute ``Path`` when contained,
    otherwise ``None`` so callers can skip the path.
    """
    root_resolved = os.path.realpath(root)
    full = os.path.realpath(candidate)
    if full.startswith(root_resolved + os.sep):
        return Path(full)
    return None


def _mrp_candidates(bp_id: str, slug: str) -> list[tuple[str, str]]:
    """Return (mrp_dir_rel, mrp_file_rel) candidate paths for an MRP.

    Agents may store MRPs in different layouts:
      1. ``artifacts/guidance/mrp/{id}-{slug}/mrp.md``       (directory)
      2. ``artifacts/guidance/mrp/{hash}-{slug}/mrp.md``      (directory, bare hash)
      3. ``artifacts/guidance/mrp/mrp-{hash}.md``             (flat file)
      4. ``artifacts/guidance/mrp/{hash}-{slug}-mrp.md``      (flat file, slug variant)
      5. ``artifacts/briefings/{id}-{slug}/mrp.md``           (inside BP directory)
      6. ``artifacts/briefings/{hash}-{slug}/mrp.md``         (inside BP directory, bare hash)
    """
    bare = _bare_hash(bp_id)
    base = "artifacts/guidance/mrp"
    bp_base = "artifacts/briefings"
    return [
        (f"{base}/{bp_id}-{slug}", f"{base}/{bp_id}-{slug}/mrp.md"),
        (f"{base}/{bare}-{slug}", f"{base}/{bare}-{slug}/mrp.md"),
        (f"{base}", f"{base}/mrp-{bare}.md"),
        (f"{base}", f"{base}/{bare}-{slug}-mrp.md"),
        (f"{bp_base}/{bp_id}-{slug}", f"{bp_base}/{bp_id}-{slug}/mrp.md"),
        (f"{bp_base}/{bare}-{slug}", f"{bp_base}/{bare}-{slug}/mrp.md"),
    ]


def _find_mrp(
    project_root: Path, bp_id: str, slug: str, branch: str | None = None,
) -> tuple[Path, Path, bool]:
    """Locate an MRP on filesystem or branch.

    Returns (mrp_dir, mrp_path, found_on_branch).
    ``mrp_path.exists()`` or ``found_on_branch`` is True when found.
    """
    bare = _bare_hash(bp_id)
    mrp_base = project_root / "artifacts" / "guidance" / "mrp"

    # 1. Check named candidates on filesystem
    for dir_rel, file_rel in _mrp_candidates(bp_id, slug):
        fpath = _contain_under(project_root, project_root / file_rel)
        if fpath is not None and fpath.exists():
            return project_root / dir_rel, fpath, False

    # 2. Scan MRP directory for files referencing this BP (own-id naming)
    mrp_base_safe = _contain_under(project_root, mrp_base)
    if mrp_base_safe is not None and mrp_base_safe.is_dir():
        for md in mrp_base_safe.glob("*.md"):
            try:
                head = md.read_text(encoding="utf-8")[:500]
                fm, _ = parse_frontmatter(head)
                if _bare_hash(fm.get("bp", "")) == bare:
                    return mrp_base, md, False
            except Exception:
                continue

    # 3. Check named candidates on branch
    if branch:
        for dir_rel, file_rel in _mrp_candidates(bp_id, slug):
            if git_show_file(project_root, branch, file_rel) is not None:
                return project_root / dir_rel, project_root / file_rel, True

    # 4. Scan MRP directory on branch via git ls-tree
    if branch:
        branch_files = git_ls_tree(project_root, branch, "artifacts/guidance/mrp")
        for entry in branch_files:
            if not entry["name"].endswith(".md"):
                continue
            content = git_show_file(
                project_root, branch, entry["path"]
            )
            if content:
                fm, _ = parse_frontmatter(content[:500])
                if _bare_hash(fm.get("bp", "")) == bare:
                    return mrp_base, project_root / entry["path"], True

    # Not found — return first candidate as default
    dir_rel, file_rel = _mrp_candidates(bp_id, slug)[0]
    return project_root / dir_rel, project_root / file_rel, False


def _collect_mrp_artifacts(
    mrp_dir: Path,
    mrp_path: Path,
    project_root: Path,
    bp_artifacts: list[dict],
    branch: str | None = None,
) -> list[dict]:
    """Collect artifacts from the MRP that are not already in the BP artifact list.

    Sources:
    1. Files in the MRP directory (excluding mrp.md itself)
    2. Artifact paths referenced in MRP frontmatter 'artifacts' field
    3. File paths from the "Files Changed" table in the MRP body

    When *branch* is provided and the MRP only exists on the branch,
    content is read via ``git show`` instead of the local filesystem.
    """
    on_branch = branch is not None
    mrp_rel = str(mrp_path.relative_to(project_root)) if mrp_path.parts else None
    # Contain the MRP path/dir under project_root before any filesystem access
    # (paths derive from user-supplied bp_id/slug via _mrp_candidates).
    mrp_path_safe = _contain_under(project_root, mrp_path)
    mrp_dir_safe = _contain_under(project_root, mrp_dir)
    mrp_on_fs = mrp_path_safe is not None and mrp_path_safe.exists()

    if not mrp_on_fs and not on_branch:
        return []

    bp_paths = {a["path"] for a in bp_artifacts}
    seen_paths: set[str] = set()
    mrp_artifacts: list[dict] = []

    def _add(rel_path: str, description: str = "", *, check_branch: bool = False):
        if rel_path in bp_paths or rel_path in seen_paths:
            return
        seen_paths.add(rel_path)
        fpath = _contain_under(project_root, project_root / rel_path)
        exists = fpath is not None and fpath.exists()
        exists_on_branch = False
        if exists:
            size = fpath.stat().st_size
        elif check_branch and on_branch:
            exists_on_branch = git_show_file(project_root, branch, rel_path) is not None
            size = git_file_size(project_root, branch, rel_path) if exists_on_branch else 0
        else:
            size = 0
        mrp_artifacts.append({
            "path": rel_path,
            "description": description,
            "exists": exists,
            "exists_on_branch": exists_on_branch,
            "size": size,
        })

    # Read MRP content — filesystem first, then branch
    mrp_meta: dict = {}
    mrp_body: str = ""
    try:
        if mrp_on_fs:
            mrp_text = mrp_path_safe.read_text(encoding="utf-8")
        elif on_branch and mrp_rel:
            mrp_text = git_show_file(project_root, branch, mrp_rel)
            if mrp_text is None:
                return []
        else:
            return []
        mrp_meta, mrp_body = parse_frontmatter(mrp_text)
    except Exception:
        return []

    # Source 1: Additional files in the MRP directory
    mrp_dir_rel = str(mrp_dir.relative_to(project_root)) if mrp_dir.parts else None
    skip_names = {"mrp.md", "brief.md"}
    if mrp_dir_safe is not None and mrp_dir_safe.is_dir():
        for f in sorted(mrp_dir_safe.iterdir()):
            if f.is_file() and f.name not in skip_names:
                _add(str(f.relative_to(project_root)), "")
    elif on_branch and mrp_dir_rel:
        # List MRP directory contents from the branch
        for entry in git_ls_tree(project_root, branch, mrp_dir_rel):
            if entry["name"] not in skip_names:
                _add(entry["path"], "", check_branch=True)

    # Source 2: Artifacts listed in MRP frontmatter
    for a in mrp_meta.get("artifacts", []):
        path = a.get("path", a) if isinstance(a, dict) else a
        desc = a.get("description", "") if isinstance(a, dict) else ""
        if path:
            _add(path, desc, check_branch=True)

    # Source 3: Parse "Files Changed" table from MRP body
    # Matches rows like: | `path/to/file` | Description |
    file_row_pattern = re.compile(
        r'^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|', re.MULTILINE
    )
    for m in file_row_pattern.finditer(mrp_body):
        path = m.group(1).strip()
        desc = m.group(2).strip()
        # Must look like a file path (contains / or .)
        if "/" not in path and "." not in path:
            continue
        # Skip table headers and the MRP/BP files themselves
        if path.lower() in ("file", "---"):
            continue
        if path.endswith("/mrp.md") or path.endswith("/brief.md"):
            continue
        _add(path, desc, check_branch=True)

    return mrp_artifacts


def _build_child_detail(child: dict, project_root: Path) -> dict:
    """Build detailed info for a child BP (subtask of a phase)."""
    branch = child.get("branch")
    on_branch = branch is not None

    # Output artifacts with file-system metadata
    output_artifacts = []
    for a in child.get("artifacts", []):
        if a.get("direction") != "output":
            continue
        fpath = project_root / a["path"]
        exists = fpath.exists()
        # For BPs on branches, artifact may only exist on the branch
        if not exists and on_branch:
            exists_on_branch = git_show_file(project_root, branch, a["path"]) is not None
        else:
            exists_on_branch = False
        if exists:
            size = fpath.stat().st_size
        elif exists_on_branch:
            size = git_file_size(project_root, branch, a["path"])
        else:
            size = 0
        output_artifacts.append({
            "path": a["path"],
            "ac": a.get("ac", ""),
            "description": a.get("description", ""),
            "exists": exists,
            "exists_on_branch": exists_on_branch,
            "size": size,
        })

    # Check MRP existence and collect MRP artifacts
    mrp_dir, mrp_path, has_mrp_on_branch = _find_mrp(
        project_root, child["id"], child["slug"],
        branch=branch if on_branch else None,
    )
    has_mrp = mrp_path.exists() or has_mrp_on_branch

    mrp_artifacts = _collect_mrp_artifacts(
        mrp_dir, mrp_path, project_root, output_artifacts,
        branch=branch if (on_branch and has_mrp_on_branch) else None,
    )

    # Extract description and acceptance criteria from body
    body = child.get("body", "")
    description = _first_paragraph(body)
    acceptance_criteria = _parse_acceptance_criteria(body)

    return {
        "id": child["id"],
        "slug": child["slug"],
        "title": child["title"],
        "status": child["status"],
        "rigor": child.get("rigor", ""),
        "claimed": child.get("claimed", ""),
        "completed": child.get("completed", ""),
        "agent_id": child.get("agent_id", ""),
        "loopscript": child.get("loopscript", ""),
        "description": description,
        "acceptance_criteria": acceptance_criteria,
        "output_artifacts": output_artifacts,
        "mrp_artifacts": mrp_artifacts,
        "has_mrp": has_mrp or has_mrp_on_branch,
        "has_mrp_on_branch": has_mrp_on_branch,
        "depends_on": child.get("depends_on", []),
        "branch": branch,
    }


def build_phases(briefings: list[dict], project_root: Path) -> list[dict]:
    """Build phase data for ALL root-level BPs.

    Each root BP becomes a section. Its children become phases, sorted by
    dependency order (topological sort). Children are enriched with output
    artifact metadata and MRP existence checks.
    """
    by_id = {bp["id"]: bp for bp in briefings}
    roots = [bp for bp in briefings if not bp.get("parent")]
    roots_sorted = topo_sort_roots([bp["id"] for bp in roots], by_id)
    phase_groups = []

    for root_id in roots_sorted:
        bp = by_id[root_id]
        child_ids = bp.get("children", [])
        ordered_ids = topo_sort(child_ids, by_id)

        phases = []
        for idx, child_id in enumerate(ordered_ids):
            child = by_id.get(child_id)
            if not child:
                continue

            # Aggregate status from grandchildren (or self if leaf)
            grandchildren = [by_id[gid] for gid in child.get("children", []) if gid in by_id]
            status_counts = {"draft": 0, "ready": 0, "active": 0, "completed": 0, "reviewed": 0}
            active_statuses = {"dispatched", "claimed"}
            if grandchildren:
                total = len(grandchildren)
                for gc in grandchildren:
                    s = gc["status"]
                    if s in active_statuses:
                        status_counts["active"] += 1
                    elif s in status_counts:
                        status_counts[s] += 1
                completed = status_counts["completed"] + status_counts["reviewed"]
            else:
                total = 1
                s = child["status"]
                if s in active_statuses:
                    status_counts["active"] = 1
                elif s in status_counts:
                    status_counts[s] = 1
                completed = 1 if s in ("completed", "reviewed") else 0

            # Build detailed child info
            child_details = []
            if grandchildren:
                gc_ids = child.get("children", [])
                gc_ordered = topo_sort(gc_ids, by_id)
                for gc_id in gc_ordered:
                    gc = by_id.get(gc_id)
                    if gc:
                        child_details.append(_build_child_detail(gc, project_root))
            else:
                child_details.append(_build_child_detail(child, project_root))

            # Extract first paragraph of body as description
            body = child.get("body", "")
            first_para = ""
            for line in body.split("\n"):
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and not stripped.startswith(">"):
                    first_para = stripped
                    break

            label = child.get("title", child.get("slug", ""))

            phases.append({
                "phase_number": idx + 1,
                "phase_label": label,
                "bp_id": child["id"],
                "bp_slug": child["slug"],
                "bp_title": child["title"],
                "bp_status": child["status"],
                "description": first_para,
                "children": child.get("children", []),
                "child_details": child_details,
                "depends_on": child.get("depends_on", []),
                "artifacts": child.get("artifacts", []),
                "progress": {
                    "total": total,
                    "completed": completed,
                    "status_counts": status_counts,
                },
            })

        # For standalone root BPs (no children), include full detail so the
        # frontend can render them with the same rich card as leaf subtasks.
        self_detail = _build_child_detail(bp, project_root) if not child_ids else None

        phase_groups.append({
            "parent_id": bp["id"],
            "parent_slug": bp["slug"],
            "parent_title": bp["title"],
            "parent_status": bp["status"],
            "phases": phases,
            "self_detail": self_detail,
        })

    return phase_groups


def load_mrp(project_root: Path, bp_id: str, briefings: list[dict]) -> str | None:
    """Load MRP markdown for a given BP id.

    Tries multiple MRP path patterns on the filesystem first, then falls
    back to reading from the agent branch via ``git show``.
    """
    by_id = {bp["id"]: bp for bp in briefings}
    bp = by_id.get(bp_id)
    if not bp:
        return None

    branch = bp.get("branch")
    _dir, mrp_path, on_branch = _find_mrp(
        project_root, bp["id"], bp["slug"], branch=branch,
    )

    # Try filesystem first
    if mrp_path.exists():
        return mrp_path.read_text(encoding="utf-8")

    # Read from branch
    if on_branch and branch:
        mrp_rel = str(mrp_path.relative_to(project_root))
        content = git_show_file(project_root, branch, mrp_rel)
        if content:
            return content

    return None


# ---------------------------------------------------------------------------
# Structured MRP parsing
# ---------------------------------------------------------------------------

_SECTION_SPLIT_RE = re.compile(r'^## \d+\.\s+', re.MULTILINE)
_SECTION_HEADER_RE = re.compile(r'^## (\d+)\.\s+(.+)$', re.MULTILINE)

# AC formats: bold-paragraph and table
_AC_BOLD_RE = re.compile(
    r'\*\*AC-(\d+)\s*[:(]\s*(.+?)\s*[):]?\*\*\s*'
    r'(?:--\s*(PASS|FAIL|pass|fail|partial|Met|met)\.?\s*)?'
    r'(.*?)(?=\n\n\*\*AC-|\n\n---|\n\n##|\Z)',
    re.DOTALL,
)
_AC_TABLE_RE = re.compile(
    r'^\|\s*AC-(\d+)\s*\|\s*(.+?)\s*\|\s*'
    r'(Met|Pass|Fail|done|partial|open|PASS|FAIL)\s*\|\s*(.*?)\s*\|',
    re.MULTILINE,
)

_COMMIT_ROW_RE = re.compile(
    r'^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|',
    re.MULTILINE,
)

_FILE_ROW_RE = re.compile(
    r'^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|',
    re.MULTILINE,
)


def _normalise_ac_status(raw: str) -> str:
    """Normalise AC status to pass/fail/partial."""
    low = raw.strip().lower()
    if low in ("pass", "met", "done"):
        return "pass"
    if low in ("fail",):
        return "fail"
    if low in ("partial", "open"):
        return "partial"
    return low


def _parse_section_functional(body: str) -> dict:
    """Parse Section 1: Functional Completeness."""
    # Extract summary (first non-empty line before AC items)
    lines = body.strip().split("\n")
    summary = ""
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("|") and not stripped.startswith("**AC"):
            summary = stripped
            break

    ac_items: list[dict] = []

    # Try table format first
    table_matches = list(_AC_TABLE_RE.finditer(body))
    if table_matches:
        for m in table_matches:
            ac_items.append({
                "code": f"AC-{m.group(1)}",
                "title": m.group(2).strip(),
                "status": _normalise_ac_status(m.group(3)),
                "evidence": m.group(4).strip(),
            })
    else:
        # Bold-paragraph format
        for m in _AC_BOLD_RE.finditer(body):
            title_raw = m.group(2).strip().rstrip("*").rstrip(":").strip(")")
            explicit_status = m.group(3)
            evidence = m.group(4).strip() if m.group(4) else ""
            # If no explicit status, infer from summary
            if explicit_status:
                status = _normalise_ac_status(explicit_status)
            elif "all" in summary.lower() and "met" in summary.lower():
                status = "pass"
            else:
                status = "pass"  # default assumption if in MRP
            # If evidence starts with the title text (no explicit status), the evidence IS the description
            if not explicit_status and not evidence:
                evidence = ""
            ac_items.append({
                "code": f"AC-{m.group(1)}",
                "title": title_raw,
                "status": status,
                "evidence": evidence,
            })

    passed = sum(1 for a in ac_items if a["status"] == "pass")
    total = len(ac_items)

    return {
        "summary": summary,
        "ac_items": ac_items,
        "passed": passed,
        "total": total,
        "all_passed": passed == total and total > 0,
    }


def _parse_section_verification(body: str) -> dict:
    """Parse Section 2: Sound Verification."""
    # Extract test count
    test_count = 0
    has_tests = True
    m = re.search(r'(\d+)\+?\s*test(?:\s*case)?s?\b', body, re.IGNORECASE)
    if m:
        test_count = int(m.group(1))
    if re.search(r'no\s+test\s+suite|no\s+automated', body, re.IGNORECASE):
        has_tests = False

    # Coverage
    coverage = ""
    m = re.search(r'coverage[:\s]*(\d+(?:\.\d+)?)\s*%', body, re.IGNORECASE)
    if m:
        coverage = f"{m.group(1)}%"

    # Summary: first meaningful line
    summary = ""
    for line in body.strip().split("\n"):
        stripped = line.strip()
        if stripped and not stripped.startswith("-") and not stripped.startswith("|") and not stripped.startswith("```"):
            summary = stripped[:200]
            break

    return {
        "summary": summary,
        "test_count": test_count,
        "coverage": coverage,
        "has_tests": has_tests,
    }


def _parse_section_hygiene(body: str) -> dict:
    """Parse Section 3: SE Hygiene."""
    items: list[dict] = []
    for line in body.strip().split("\n"):
        stripped = line.strip()
        if stripped.startswith("- "):
            items.append({"text": stripped[2:].strip()})

    return {
        "summary": f"{len(items)} items checked",
        "items": items,
    }


def _parse_section_rationale(body: str) -> dict:
    """Parse Section 4: Clear Rationale."""
    decisions: list[str] = []
    crps: list[str] = []
    deviations: list[str] = []

    # Extract numbered or bold decisions
    for m in re.finditer(r'(?:^\d+\.\s*\*\*|^-\s*\*\*)(.+?)\*\*', body, re.MULTILINE):
        decisions.append(m.group(1).strip().rstrip(":"))

    # CRP references
    for m in re.finditer(r'[`-]\s*([0-9a-f]{12})\b', body):
        crps.append(m.group(1))

    # Check for "No CRPs"
    has_crps = bool(crps)
    if re.search(r'no\s+(?:inline\s+)?crps?\s+were', body, re.IGNORECASE):
        has_crps = False

    return {
        "decisions_count": len(decisions),
        "decisions": decisions,
        "crps": crps,
        "has_crps": has_crps,
        "deviations": deviations,
    }


def _parse_section_auditability(body: str) -> dict:
    """Parse Section 5: Full Auditability."""
    commits: list[dict] = []
    files_changed: list[dict] = []

    # Split body at ### sub-headings OR **bold:** sub-headers
    sections: dict[str, str] = {}
    current_key = "_top"
    current_lines: list[str] = []
    bold_header_re = re.compile(r'^\*\*(.+?)\*\*\s*$')
    for line in body.split("\n"):
        if line.startswith("### "):
            sections[current_key] = "\n".join(current_lines)
            current_key = line[4:].strip().lower().rstrip(":")
            current_lines = []
        else:
            bm = bold_header_re.match(line.strip())
            if bm:
                sections[current_key] = "\n".join(current_lines)
                current_key = bm.group(1).strip().lower().rstrip(":")
                current_lines = []
            else:
                current_lines.append(line)
    sections[current_key] = "\n".join(current_lines)

    # Parse commits from "git trail" or "commit history" section
    commit_keys = [k for k in sections if "commit" in k or "git trail" in k or "git" in k]
    commit_text = sections.get(commit_keys[0], "") if commit_keys else ""
    if not commit_text:
        commit_text = sections.get("_top", body)

    for m in _COMMIT_ROW_RE.finditer(commit_text):
        val = m.group(1).strip()
        msg = m.group(2).strip()
        if val.lower() in ("commit", "hash", "---"):
            continue
        if msg.startswith("---"):
            continue
        commits.append({"hash": val, "message": msg})

    # Parse files changed
    file_keys = [k for k in sections if "file" in k and k not in commit_keys]
    files_text = sections.get(file_keys[0], "") if file_keys else ""
    if not files_text:
        files_text = sections.get("_top", "")

    for m in _FILE_ROW_RE.finditer(files_text):
        path = m.group(1).strip()
        desc = m.group(2).strip()
        if path.lower() in ("file", "---"):
            continue
        if desc.startswith("---"):
            continue
        if "/" not in path and "." not in path:
            continue
        files_changed.append({"path": path, "description": desc})

    return {
        "commits": commits,
        "commits_count": len(commits),
        "files_changed": files_changed,
        "files_count": len(files_changed),
    }


def parse_mrp_structured(raw_text: str, bp_id: str) -> dict:
    """Parse an MRP into structured sections for the review UI.

    Returns a dict with frontmatter metadata and parsed sections.
    Falls back to raw body text when section parsing fails.
    """
    meta, body = parse_frontmatter(raw_text)

    # Split body into sections at ## N. headings
    section_bodies: dict[int, str] = {}
    parts = list(_SECTION_HEADER_RE.finditer(body))
    for i, m in enumerate(parts):
        num = int(m.group(1))
        start = m.end()
        end = parts[i + 1].start() if i + 1 < len(parts) else len(body)
        section_bodies[num] = body[start:end].strip()

    # Parse each section with fallback
    sections: dict[str, dict] = {}
    parsers = {
        1: ("functional", _parse_section_functional),
        2: ("verification", _parse_section_verification),
        3: ("hygiene", _parse_section_hygiene),
        4: ("rationale", _parse_section_rationale),
        5: ("auditability", _parse_section_auditability),
    }
    for num, (key, parser) in parsers.items():
        section_text = section_bodies.get(num, "")
        if section_text:
            try:
                sections[key] = parser(section_text)
            except Exception:
                sections[key] = {"raw": section_text}
        else:
            sections[key] = {"raw": ""}

    return {
        "bp_id": bp_id,
        "status": meta.get("status", ""),
        "tier": meta.get("tier", ""),
        "auto_score": meta.get("auto-score"),
        "produced_by": meta.get("produced-by", ""),
        "created": meta.get("created", ""),
        "sections": sections,
        "raw_body": body,
    }


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

def resolve_workspace(path: str) -> Path:
    # Normalize the untrusted path with os.path.realpath (removes ".." segments
    # and follows symlinks), then containment-check with a SINGLE, direct
    # str.startswith against a constant safe-root prefix — the exact shape from
    # the py/path-injection query's own recommended remediation ("normalize the
    # path ... then check that the normalized path starts with the root folder").
    #
    # This is the choke point for the `workspace` query parameter: every
    # bp-explorer handler resolves it here, so sanitising `full` on this branch
    # kills the taint for the whole family of downstream filesystem accesses.
    #
    # A prior form OR-ed `full == agents_root` with the startswith test and
    # compared against an os.path.realpath()-computed (non-constant) root. CodeQL
    # only models str.startswith as a path barrier guard when the safe (continue)
    # branch is reachable *only* when the startswith holds; the `== ... or ...`
    # disjunction made the continue branch reachable without startswith being
    # true, so the guard was not recognised and `full` (and everything derived
    # from it in the callers) stayed tainted. The trailing os.sep on the constant
    # root keeps prefix-sibling safety ("/workspace/agents-evil" is rejected) — a
    # valid workspace is always a strict subdirectory, so requiring the separator
    # loses no real path.
    agents_root = "/workspace/agents/"
    full = os.path.realpath(path)
    if not full.startswith(agents_root):
        raise HTTPException(status_code=403, detail="Access denied")
    p = Path(full)
    briefings = p / "artifacts" / "briefings"
    if not briefings.is_dir():
        raise HTTPException(status_code=404, detail="No briefings found at this path")
    return p


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Init agent bridge at startup and store in app state."""
    print("Briefing Pack Explorer")

    # --- Agent bridge startup (AC-5: startup checks) ----------------------
    agent_available = False
    try:
        from agent_bridge import AgentBridge

        bridge = AgentBridge(Path("."))
        bridge.check_prerequisites()
        app.state.agent_bridge = bridge
        agent_available = True
        app.state.agent_available = True
        app.state.agent_unavailable_reason = None
        print("  Agent SDK: available")
    except ImportError:
        logger.info("agent_bridge module not importable; agent endpoints disabled")
        print("  Agent SDK: not installed (agent features disabled)")
        app.state.agent_bridge = None
        app.state.agent_available = False
        app.state.agent_unavailable_reason = "claude-agent-sdk not installed"
    except EnvironmentError as exc:
        logger.info("Agent bridge prerequisites not met: %s", exc)
        print(f"  Agent SDK: not configured ({exc})")
        app.state.agent_bridge = None
        app.state.agent_available = False
        # Do not surface the raw exception text to API clients (stack-trace
        # exposure); the actionable detail is logged/printed server-side above.
        app.state.agent_unavailable_reason = "Agent SDK prerequisites not met"
    except Exception as exc:
        logger.warning("Agent bridge init failed: %s", exc)
        print(f"  Agent SDK: unavailable ({exc})")
        app.state.agent_bridge = None
        app.state.agent_available = False
        # Static, non-sensitive reason for clients; full detail is logged above.
        app.state.agent_unavailable_reason = "Agent SDK initialisation failed"

    # --- AEE Bridge startup ---------------------------------------------------
    aee_enabled_env = os.environ.get("AEE_ENABLED", "").strip().lower()
    aee_url = os.environ.get("AEE_ORCHESTRATOR_URL", "").strip()
    if aee_enabled_env in ("true", "1") and aee_url:
        app.state.aee = AEEBridge(aee_url)
        print(f"  AEE Bridge: enabled ({aee_url})")
    else:
        app.state.aee = None
        print("  AEE Bridge: disabled")

    print()
    yield

    # --- Shutdown: close AEE session -----------------------------------------
    if app.state.aee is not None:
        await app.state.aee.close()


app = FastAPI(title="Briefing Pack Explorer", lifespan=lifespan)

# CORS middleware — allow all origins (internal tool, no auth needed)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _json_response(data: object, *, indent: int | None = None) -> Response:
    """Return a JSON response matching the original server's format.

    Uses ``json.dumps`` with ``ensure_ascii=False`` so that the byte-level
    output is identical to the stdlib-based server.  ``Cache-Control: no-cache``
    is set on every JSON response.
    """
    content = json.dumps(data, indent=indent, ensure_ascii=False)
    return Response(
        content=content,
        media_type="application/json; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


def _ensure_git_identity(cwd: Path) -> None:
    """Ensure git user.name and user.email are set in the repo config.

    Idempotent — skips if already configured.
    """
    try:
        r = subprocess.run(
            ["git", "config", "user.name"], capture_output=True, text=True, cwd=cwd
        )
        if not r.stdout.strip():
            subprocess.run(["git", "config", "user.name", "BP Explorer"], cwd=cwd, capture_output=True)
            subprocess.run(["git", "config", "user.email", "bp-explorer@localhost"], cwd=cwd, capture_output=True)
    except Exception:
        pass


def _git_env() -> dict[str, str]:
    """Return env dict with git author/committer identity for containers.

    Inside Docker the git user is typically unconfigured (root@<hash>).
    This reads the repo's .gitconfig or falls back to sensible defaults
    so that ``git commit`` never fails with 'Author identity unknown'.
    """
    env = {**os.environ}
    # Try reading from the repo's git config first
    try:
        name = subprocess.run(
            ["git", "config", "user.name"], capture_output=True, text=True
        ).stdout.strip()
        email = subprocess.run(
            ["git", "config", "user.email"], capture_output=True, text=True
        ).stdout.strip()
    except Exception:
        name = email = ""
    if not name:
        name = "BP Explorer"
    if not email:
        email = "bp-explorer@localhost"
    env["GIT_AUTHOR_NAME"] = name
    env["GIT_AUTHOR_EMAIL"] = email
    env["GIT_COMMITTER_NAME"] = name
    env["GIT_COMMITTER_EMAIL"] = email
    return env


def build_qg_prompt(bp_id: str, workspace: Path) -> str:
    """Read the QG prompt template and fill in bp_id and today's date."""
    template_path = Path(__file__).parent / "qg_prompt_template.md"
    template = template_path.read_text()
    return template.replace("{bp_id}", bp_id).replace("{date}", datetime.date.today().isoformat())


async def monitor_bp_completion(
    execution_agent_id: str,
    qg_environment_id: str,
    bp_id: str,
    workspace: Path,
    aee: "AEEBridge",
):
    """Poll the execution agent until it exits, then run the QG agent and clean up."""
    while True:
        await asyncio.sleep(10)
        try:
            status = await aee.poll_agent(execution_agent_id)
        except Exception:
            continue

        if status.get("exitedAt"):
            # 1. BP-Status → completed
            # Containment: normalize the fixed script path with os.path.realpath,
            # then assert it stays under the (already contained) project root with a
            # single direct startswith prefix check — the barrier shape CodeQL models
            # for py/path-injection. The script is a fixed strict subpath
            # (scripts/bp-transition.py), never the root itself, so a plain startswith
            # (no equality branch, no boolean-stored commonpath) fully covers
            # containment before the fs check and the subprocess invocation below.
            # This runs on a background asyncio task with no HTTP response context, so
            # a containment breach is a silent skip (no HTTPException 403), preserving
            # the prior failure mode.
            root_resolved = os.path.realpath(workspace)
            script_real = os.path.realpath(workspace / "scripts" / "bp-transition.py")
            # Keep the guarded, realpath-normalised STRING all the way through to
            # the fs check and the subprocess: wrapping it in Path() before the
            # barrier gives CodeQL a second tainted value the startswith guard
            # does not cover (alert #580). os.path.isfile + create_subprocess_exec
            # both take the string directly, so no Path() wrapper is needed.
            if script_real.startswith(root_resolved + os.sep) and os.path.isfile(script_real):
                proc = await asyncio.create_subprocess_exec(
                    "python3", script_real,
                    "--workspace", str(workspace),
                    "--bp-id", bp_id,
                    "--action", "complete",
                )
                await proc.wait()

            # 2. QG-Agent starten
            try:
                qg_prompt = build_qg_prompt(bp_id, workspace)
                await aee.create_ephemeral_agent(
                    display_name=f"QG: {bp_id}",
                    mission_prompt=qg_prompt,
                    environment_id=qg_environment_id,
                )
            except Exception as e:
                print(f"[monitor] QG agent creation failed: {e}")

            # 3. Ausführungsagenten löschen
            try:
                await aee.delete_agent(execution_agent_id)
            except Exception as e:
                print(f"[monitor] Delete execution agent failed: {e}")

            break


# --- Routes ----------------------------------------------------------------


@app.get("/api/workspace/tree")
async def workspace_tree(root: str, path: str = ""):
    # Normalize the user-supplied paths with os.path.realpath and verify
    # containment with a SINGLE DIRECT str.startswith check (trailing os.sep for
    # prefix-sibling safety) — the barrier shape CodeQL models for
    # py/path-injection: normalize, then prefix-check the normalized value in a
    # guard whose safe branch is reachable ONLY when the check holds. The prior
    # ``x == base or x.startswith(base + os.sep)`` disjunction was NOT recognised
    # as a barrier — its safe branch was reachable through the equality arm
    # without the prefix test — so the sinks stayed flagged. `root` is always an
    # agent workspace strictly under /workspace/agents/ (the sole caller passes
    # safeAgentPath(agentId, '')), and an empty `path` lists that root directly,
    # so no legitimate request relies on the dropped equality arms.
    base = os.path.realpath(root)
    if not base.startswith("/workspace/agents" + os.sep):
        raise HTTPException(status_code=403, detail="Access denied")
    if path:
        target = os.path.realpath(os.path.join(base, path))
        if not target.startswith(base + os.sep):
            raise HTTPException(status_code=403, detail="Path traversal denied")
        target_dir = Path(target)
    else:
        target_dir = Path(base)
    if not target_dir.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")
    dirs = [d.name for d in sorted(target_dir.iterdir()) if d.is_dir()]
    return dirs


@app.get("/api/briefings")
async def serve_briefings(workspace: str):
    """Return all briefing packs as JSON.

    Includes a throttled ``git fetch`` of agent refs so remote branches
    from colleagues are picked up without hammering git on every call.
    """
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        # Fetch remote agent refs (throttled to max once per 15s)
        await loop.run_in_executor(
            None, fetch_agent_refs_throttled, project_root
        )
        data = await loop.run_in_executor(
            None, load_all_briefings, project_root
        )
        return _json_response(data, indent=2)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/phases")
async def serve_phases(workspace: str):
    """Return phase data for all root-level BPs."""
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        # Fetch remote agent refs (throttled to max once per 15s)
        await loop.run_in_executor(
            None, fetch_agent_refs_throttled, project_root
        )
        briefings = await loop.run_in_executor(
            None, load_all_briefings, project_root
        )
        data = await loop.run_in_executor(
            None, partial(build_phases, briefings, project_root)
        )
        return _json_response(data, indent=2)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/agent-branches")
async def serve_agent_branches(workspace: str):
    """Return active agent branches with BP associations.

    Also triggers a lightweight ``git fetch`` of agent refs so the
    response reflects the latest remote state.
    """
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)
    try:
        await loop.run_in_executor(None, fetch_agent_refs, project_root)
        branches = await loop.run_in_executor(
            None, discover_agent_branches, project_root
        )
        return _json_response(list(branches.values()), indent=2)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/mrp-structured/{bp_id}")
async def serve_mrp_structured(bp_id: str, workspace: str):
    """Return a structured MRP for the review UI."""
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        briefings = await loop.run_in_executor(
            None, load_all_briefings, project_root
        )
        content = await loop.run_in_executor(
            None, partial(load_mrp, project_root, bp_id, briefings)
        )
        if content is None:
            raise HTTPException(status_code=404, detail=f"No MRP found for BP {bp_id}")

        result = parse_mrp_structured(content, bp_id)

        # Enrich with BP metadata
        by_id = {b["id"]: b for b in briefings}
        bp = by_id.get(bp_id, {})
        result["title"] = bp.get("title", bp.get("slug", ""))
        result["slug"] = bp.get("slug", "")
        branch = bp.get("branch")

        # Merge artifact existence data into files_changed
        bp_artifacts = bp.get("artifacts", [])
        mrp_dir, mrp_path, _ = _find_mrp(
            project_root, bp_id, bp.get("slug", ""), branch=branch,
        )
        mrp_artifacts = await loop.run_in_executor(
            None,
            partial(
                _collect_mrp_artifacts,
                mrp_dir, mrp_path, project_root, bp_artifacts,
                branch=branch,
            ),
        )
        # Build a lookup from MRP artifacts for existence/size info
        art_lookup = {a["path"]: a for a in mrp_artifacts}

        audit = result.get("sections", {}).get("auditability", {})
        enriched_files: list[dict] = []
        for fc in audit.get("files_changed", []):
            art = art_lookup.get(fc["path"])
            fpath = project_root / fc["path"]
            exists_fs = fpath.exists()
            enriched_files.append({
                "path": fc["path"],
                "description": fc.get("description", ""),
                "exists": exists_fs or (art["exists"] if art else False),
                "exists_on_branch": art.get("exists_on_branch", False) if art else False,
                "size": (fpath.stat().st_size if exists_fs else
                         (art.get("size", 0) if art else 0)),
            })
        result["files_changed"] = enriched_files
        if branch:
            result["branch"] = branch

        return _json_response(result, indent=2)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/loopscript-phases")
async def serve_loopscript_phases(workspace: str):
    """Return phase definitions for all LoopScripts.

    Reads YAML files from skills/engineering/loops/ and extracts phase id/name pairs.
    """
    project_root: Path = resolve_workspace(workspace)
    loops_dir = project_root / "skills" / "engineering" / "loops"
    # Containment: loops_dir is a fixed strict sub-path of the (already
    # contained) project root, but re-assert it under project_root with
    # os.path.realpath + a single DIRECT str.startswith check in the branch
    # condition — the exact barrier CodeQL models for py/path-injection
    # (normalize, then prefix-check the normalized value in the guard). A prior
    # form OR-ed an `== root_resolved` equality arm onto the startswith; that
    # was functionally safe but the disjunction is NOT recognised as a barrier
    # by CodeQL, so the downstream sinks stayed flagged. loops_dir can never
    # equal the root (it always carries the "skills/engineering/loops" suffix),
    # so the equality arm was dead — dropping it leaves the bare, recognised
    # trailing-os.sep prefix test, which also rejects prefix-siblings before
    # any filesystem access.
    root_resolved = os.path.realpath(project_root)
    loops_real = os.path.realpath(loops_dir)
    result = {}
    if loops_real.startswith(root_resolved + os.sep) and os.path.isdir(loops_real):
        for yf in sorted(Path(loops_real).glob("*.yaml")):
            try:
                data = yaml.safe_load(yf.read_text(encoding="utf-8"))
                phases = [
                    {"id": p["id"], "name": p.get("name", p["id"])}
                    for p in data.get("phases", [])
                    if "id" in p
                ]
                key = yf.stem  # e.g. "standard", "high-rigor"
                result[key] = phases
            except Exception:
                continue
    return _json_response(result, indent=2)


@app.get("/api/bp-artifacts/{bp_id}")
async def serve_bp_artifacts(bp_id: str, workspace: str):
    """Return enriched artifact list for a BP (existence, size, branch info)."""
    loop = asyncio.get_running_loop()
    try:
        project_root: Path = resolve_workspace(workspace)
        briefings = await loop.run_in_executor(
            None, load_all_briefings, project_root
        )
        by_id = {bp["id"]: bp for bp in briefings}
        bp = by_id.get(bp_id)
        if not bp:
            raise HTTPException(status_code=404, detail="BP not found")

        branch = bp.get("branch")
        on_branch = branch is not None
        raw_artifacts = bp.get("artifacts", [])
        enriched = []
        for a in raw_artifacts:
            if a.get("direction") != "output":
                continue
            fpath = project_root / a["path"]
            # Containment: reject artifact paths that resolve outside the
            # project root before any filesystem access. os.path.realpath
            # normalises the path (following symlinks, stripping ``..``); the
            # single direct ``startswith(root + os.sep)`` check in the guard is
            # the exact py/path-injection barrier CodeQL recognises. The prior
            # ``full_real == root_resolved or full_real.startswith(...)``
            # disjunction was functionally safe but NOT modelled as a sanitizer
            # (the ``or`` with the equality branch stops the guarded value from
            # flowing through a recognised barrier), so the fs sinks below stayed
            # flagged. Output artifacts always carry a real sub-path (never the
            # root itself), so the equality branch is dead here and dropping it
            # is behaviour-safe while still rejecting prefix-siblings such as
            # ``/proj-evil`` that a bare ``startswith(root)`` would accept. The
            # normalised path is used for every fs operation.
            root_resolved = os.path.realpath(project_root)
            full_real = os.path.realpath(fpath)
            if not full_real.startswith(root_resolved + os.sep):
                continue
            full = Path(full_real)
            exists = full.exists()
            is_dir = full.is_dir() if exists else False
            if not exists and on_branch:
                exists_on_branch = (
                    git_show_file(project_root, branch, a["path"]) is not None
                )
            else:
                exists_on_branch = False
            if exists:
                size = full.stat().st_size if not is_dir else 0
            elif exists_on_branch:
                size = git_file_size(project_root, branch, a["path"])
            else:
                size = 0
            enriched.append({
                "path": a["path"],
                "ac": a.get("ac", ""),
                "description": a.get("description", ""),
                "exists": exists,
                "exists_on_branch": exists_on_branch,
                "is_dir": is_dir,
                "size": size,
            })

        # Also collect MRP artifacts
        mrp_dir, mrp_path, has_mrp_on_branch = _find_mrp(
            project_root, bp["id"], bp["slug"],
            branch=branch if on_branch else None,
        )
        mrp_artifacts = _collect_mrp_artifacts(
            mrp_dir, mrp_path, project_root, enriched,
            branch=branch if (on_branch and has_mrp_on_branch) else None,
        )

        return _json_response({
            "bp_id": bp_id,
            "branch": branch,
            "artifacts": enriched,
            "mrp_artifacts": mrp_artifacts,
        }, indent=2)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/mrp/{bp_id}")
async def serve_mrp(bp_id: str, workspace: str):
    """Return the MRP body for a given BP id."""
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        briefings = await loop.run_in_executor(
            None, load_all_briefings, project_root
        )
        content = await loop.run_in_executor(
            None, partial(load_mrp, project_root, bp_id, briefings)
        )
        if content is None:
            raise HTTPException(status_code=404, detail=f"No MRP found for BP {bp_id}")
        _, body = parse_frontmatter(content)
        return _json_response({"bp_id": bp_id, "body": body})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/bp/{bp_id}/raw")
async def get_bp_raw(bp_id: str, workspace: str):
    """Return the raw file content (YAML frontmatter + body) of a briefing pack."""
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        bp_path = await loop.run_in_executor(None, partial(find_bp_file, project_root, bp_id))
        if bp_path is None:
            raise HTTPException(status_code=404, detail=f"BP not found: {bp_id}")
        content = bp_path.read_text(encoding="utf-8")
        rel_path = str(bp_path.relative_to(project_root))
        return _json_response({"bp_id": bp_id, "content": content, "path": rel_path})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class BpRawUpdateRequest(BaseModel):
    content: str
    commit_message: str | None = None


class BpTransitionRequest(BaseModel):
    action: str
    reason: str | None = None


class BpDispatchRequest(BaseModel):
    environment_id: str | None = None
    qg_environment_id: str | None = None


@app.post("/api/bp/{bp_id}/transition")
async def transition_bp(bp_id: str, body: BpTransitionRequest, workspace: str):
    """Execute a deterministic BP state transition via bp-transition.py."""
    allowed = {"approve", "dispatch", "cancel", "release", "complete", "review", "archive", "restore", "unapprove", "reset", "revise", "confirm-valid"}
    if body.action not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid action: {body.action}. Allowed: {', '.join(sorted(allowed))}")

    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)
    # Containment: normalize the fixed script path with os.path.realpath, then
    # assert it stays under the (already contained) project root with a single
    # direct startswith prefix check — the barrier shape CodeQL models for
    # py/path-injection. The script is a fixed strict subpath
    # (scripts/bp-transition.py), never the root itself, so a plain startswith
    # (no equality branch, no boolean-stored commonpath) fully covers containment
    # before the fs check and the subprocess invocation below.
    root_resolved = os.path.realpath(project_root)
    script_real = os.path.realpath(project_root / "scripts" / "bp-transition.py")
    if not script_real.startswith(root_resolved + os.sep):
        raise HTTPException(status_code=403, detail="Path outside project root")
    script = Path(script_real)
    if not script.exists():
        raise HTTPException(status_code=500, detail="bp-transition.py not found")

    def _run_transition():
        _ensure_git_identity(project_root)
        cmd = ["python3", str(script), body.action, bp_id]
        if body.action == "release":
            if not body.reason:
                raise ValueError("Release action requires a reason")
            cmd += ["--reason", body.reason]
        elif body.action == "revise":
            if not body.reason:
                raise ValueError("Revise action requires a reason")
            cmd += ["--reason", body.reason, "--push"]
        elif body.action == "confirm-valid":
            if body.reason:
                cmd += ["--reason", body.reason]
            cmd += ["--push"]
        result = subprocess.run(cmd, cwd=project_root, capture_output=True, text=True, env=_git_env())
        return result

    def _cleanup_worktree(agent_id: str, bp_hash: str):
        """Clean up agent worktree and branches after a reset transition."""
        cleanup_script = project_root / "scripts" / "worktree-ops.py"
        if not cleanup_script.exists():
            return
        _ensure_git_identity(project_root)
        subprocess.run(
            ["python3", str(cleanup_script), "cleanup",
             "--agent-id", agent_id, "--bp-hash", bp_hash, "--delete-remote"],
            cwd=project_root, capture_output=True, text=True, env=_git_env(),
        )

    try:
        result = await loop.run_in_executor(None, _run_transition)
        if result.returncode != 0:
            err = result.stderr.strip() or result.stdout.strip() or f"Exit code {result.returncode}"
            raise HTTPException(status_code=422, detail=err)

        # For reset: clean up agent worktree and branch
        if body.action == "reset":
            for line in result.stdout.splitlines():
                if "removed-agent-id:" in line:
                    removed_agent_id = line.split(":", 1)[1].strip()
                    await loop.run_in_executor(None, _cleanup_worktree, removed_agent_id, bp_id)
                    break

        return _json_response({"ok": True, "action": body.action, "bp_id": bp_id, "output": result.stdout.strip()})
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/bp/{bp_id}/dispatch")
async def dispatch_bp(bp_id: str, workspace: str, body: BpDispatchRequest = BpDispatchRequest()):
    """Full dispatch orchestration: validate, transition, worktree, bp-info.

    Mirrors the /dispatch CLI command (Steps 1-4) so that agent execution
    from the web UI is identical to terminal dispatch.

    Returns JSON with all data needed to assemble the agent prompt:
    agent_id, worktree_path, branch, bp_content, resolved_loopscript,
    mentorscripts, execution_mode.
    """
    loop = asyncio.get_running_loop()
    project_root: Path = resolve_workspace(workspace)

    def _run() -> dict:
        _ensure_git_identity(project_root)
        env = _git_env()

        # Step 1: Validate BP
        validate_script = project_root / "scripts" / "validate-bp.py"
        if not validate_script.exists():
            raise FileNotFoundError("validate-bp.py not found")
        vr = subprocess.run(
            ["python3", str(validate_script), bp_id, "--json"],
            cwd=project_root, capture_output=True, text=True, env=env,
        )
        if vr.returncode == 2:
            raise ValueError(vr.stderr.strip() or vr.stdout.strip() or "BP not found")
        validation = json.loads(vr.stdout) if vr.stdout.strip().startswith("{") else {}
        if vr.returncode != 0:
            failed = [c for c in validation.get("checks", []) if not c.get("passed")]
            detail = "; ".join(c.get("message", c.get("name", "?")) for c in failed)
            raise ValueError(f"Validation failed: {detail}")
        bp_hash = validation.get("bp_hash", bp_id)

        # Step 2: Transition ready → dispatched (with push)
        transition_script = project_root / "scripts" / "bp-transition.py"
        if not transition_script.exists():
            raise FileNotFoundError("bp-transition.py not found")
        tr = subprocess.run(
            ["python3", str(transition_script), "dispatch", bp_hash, "--push"],
            cwd=project_root, capture_output=True, text=True, env=env,
        )
        if tr.returncode != 0:
            raise RuntimeError(tr.stderr.strip() or tr.stdout.strip() or "Transition failed")

        # Parse agent-id from transition output
        agent_id = None
        for line in tr.stdout.splitlines():
            if "agent-id:" in line.lower() or "agent_id:" in line.lower():
                agent_id = line.split(":", 1)[1].strip()
                break

        # Step 3: Create agent worktree
        worktree_script = project_root / "scripts" / "worktree-ops.py"
        if not worktree_script.exists():
            raise FileNotFoundError("worktree-ops.py not found")
        if not agent_id:
            raise RuntimeError("Could not parse agent-id from transition output")
        wr = subprocess.run(
            ["python3", str(worktree_script), "create",
             "--agent-id", agent_id, "--bp-hash", bp_hash, "--push", "--json"],
            cwd=project_root, capture_output=True, text=True, env=env,
        )
        if wr.returncode != 0:
            raise RuntimeError(wr.stderr.strip() or wr.stdout.strip() or "Worktree creation failed")
        worktree_info = json.loads(wr.stdout) if wr.stdout.strip().startswith("{") else {}

        # Step 4: Read BP info (resolved loopscript, execution mode, mentorscripts)
        bp_info_script = project_root / "scripts" / "bp-info.py"
        if not bp_info_script.exists():
            raise FileNotFoundError("bp-info.py not found")
        ir = subprocess.run(
            ["python3", str(bp_info_script), bp_hash],
            cwd=project_root, capture_output=True, text=True, env=env,
        )
        if ir.returncode != 0:
            raise RuntimeError(ir.stderr.strip() or ir.stdout.strip() or "bp-info failed")
        bp_info = json.loads(ir.stdout) if ir.stdout.strip().startswith("{") else {}

        # Read actual BP content
        bp_path = None
        for candidate in (project_root / "artifacts" / "briefings").rglob("*/brief.md"):
            parent_name = candidate.parent.name
            if parent_name.startswith(bp_hash[:6]) or bp_hash in parent_name:
                bp_path = candidate
                break
        bp_content = bp_path.read_text(encoding="utf-8") if bp_path else ""

        # Read resolved LoopScript content
        ls_name = bp_info.get("resolved_loopscript", "standard.yaml")
        ls_path = project_root / "skills" / "ale" / "loops" / ls_name
        loopscript_content = ls_path.read_text(encoding="utf-8") if ls_path.exists() else ""

        # Read MentorScript content
        mentorscripts = {}
        ms_list = bp_info.get("frontmatter", {}).get("mentor-scripts",
                   bp_info.get("frontmatter", {}).get("mentorscripts", []))
        if not ms_list:
            ms_list = ["mentorscripts/global.md"]
        for ms_ref in ms_list:
            ms_path = project_root / ms_ref
            if ms_path.exists():
                mentorscripts[ms_ref] = ms_path.read_text(encoding="utf-8")

        return {
            "bp_hash": bp_hash,
            "slug": bp_info.get("slug", validation.get("slug", "")),
            "agent_id": agent_id,
            "worktree_path": worktree_info.get("worktree", f".worktrees/{agent_id}-{bp_hash}"),
            "branch": worktree_info.get("branch", f"agent/{agent_id}/{bp_hash}"),
            "execution_mode": bp_info.get("frontmatter", {}).get("execution-mode",
                              bp_info.get("execution_mode", "standard")),
            "resolved_loopscript": ls_name,
            "loopscript_content": loopscript_content,
            "mentorscript_refs": list(mentorscripts.keys()),
            "mentorscript_contents": mentorscripts,
            "bp_content": bp_content,
            "title": bp_info.get("mission", bp_info.get("frontmatter", {}).get("title", "")),
            "rigor": bp_info.get("frontmatter", {}).get("rigor", "standard"),
        }

    try:
        result = await loop.run_in_executor(None, _run)

        # Start background monitor only when AEE is active and an execution agent exists
        aee = app.state.aee
        execution_agent_id = result.get("agent_id")
        if aee is not None and execution_agent_id:
            qg_env_id = (body.qg_environment_id or body.environment_id or "")
            asyncio.create_task(
                monitor_bp_completion(
                    execution_agent_id=execution_agent_id,
                    qg_environment_id=qg_env_id,
                    bp_id=result.get("bp_hash", bp_id),
                    workspace=project_root,
                    aee=aee,
                )
            )

        return _json_response(result)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.put("/api/bp/{bp_id}/raw")
async def update_bp_raw(bp_id: str, body: BpRawUpdateRequest, workspace: str):
    """Save updated BP content and create a git commit."""
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        bp_path = await loop.run_in_executor(None, partial(find_bp_file, project_root, bp_id))
        if bp_path is None:
            raise HTTPException(status_code=404, detail=f"BP not found: {bp_id}")

        rel_path = str(bp_path.relative_to(project_root))
        commit_msg = body.commit_message or f"refine(bp:{bp_id[:6]}): inline edit via BP Explorer"

        def _write_and_commit():
            _ensure_git_identity(project_root)
            env = _git_env()
            bp_path.write_text(body.content, encoding="utf-8")
            subprocess.run(["git", "add", rel_path], cwd=project_root, check=True, capture_output=True, env=env)
            subprocess.run(["git", "commit", "-m", commit_msg], cwd=project_root, check=True, capture_output=True, env=env)
            # Rebuild the fast-path index
            build_index = project_root / "scripts" / "build-index.py"
            if build_index.exists():
                subprocess.run(["python3", str(build_index)], cwd=project_root, capture_output=True)

        await loop.run_in_executor(None, _write_and_commit)
        return _json_response({"ok": True, "path": rel_path, "commit_message": commit_msg})
    except HTTPException:
        raise
    except subprocess.CalledProcessError as exc:
        err = exc.stderr.decode() if exc.stderr else str(exc)
        raise HTTPException(status_code=500, detail=f"Git error: {err}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Structured frontmatter editing (Unified Orchestration #362, UI rework D2) ──
# Add/remove a dependency or a data-flow artifact on a BP, editing only that
# key's block in the YAML frontmatter (other lines are preserved verbatim), then
# git-commit — the same write+commit path as the raw editor.

def _yaml_scalar(v) -> str:
    import json
    # JSON strings are valid YAML double-quoted scalars — robust quoting.
    return json.dumps(v if v is not None else "", ensure_ascii=False)


def _serialize_depends_on(items: list) -> list[str]:
    if not items:
        return ["depends_on: []"]
    out = ["depends_on:"]
    for it in items:
        out.append(f"  - {_yaml_scalar(it)}")
    return out


def _serialize_artifacts(items: list) -> list[str]:
    if not items:
        return ["artifacts: []"]
    out = ["artifacts:"]
    for a in items:
        out.append(f"  - path: {_yaml_scalar(a.get('path', ''))}")
        out.append(f"    direction: {_yaml_scalar(a.get('direction', ''))}")
        if a.get("description"):
            out.append(f"    description: {_yaml_scalar(a['description'])}")
    return out


def _replace_fm_block(content: str, aliases: set[str], new_block_lines: list[str]) -> str:
    """Replace (or insert) a single top-level frontmatter key's block, leaving
    every other line untouched. `aliases` matches the key name variants."""
    lines = content.split("\n")
    delims = [i for i, l in enumerate(lines) if l.strip() == "---"]
    if len(delims) < 2:
        raise ValueError("brief.md has no YAML frontmatter")
    start, end = delims[0], delims[1]
    key_idx = None
    for i in range(start + 1, end):
        l = lines[i]
        if l and not l[0].isspace():
            k = l.split(":", 1)[0].strip()
            if k in aliases:
                key_idx = i
                break
    if key_idx is None:
        return "\n".join(lines[:end] + new_block_lines + lines[end:])
    block_end = end
    for j in range(key_idx + 1, end):
        l = lines[j]
        if l and not l[0].isspace():
            block_end = j
            break
    return "\n".join(lines[:key_idx] + new_block_lines + lines[block_end:])


class BpFrontmatterEditRequest(BaseModel):
    op: str  # add-dependency | remove-dependency | add-artifact | remove-artifact
    value: dict | str | None = None


@app.post("/api/bp/{bp_id}/frontmatter-edit")
async def edit_bp_frontmatter(bp_id: str, body: BpFrontmatterEditRequest, workspace: str):
    """Add/remove a dependency or artifact on a BP's brief.md frontmatter + commit."""
    loop = asyncio.get_running_loop()
    try:
        project_root = resolve_workspace(workspace)
        bp_path = await loop.run_in_executor(None, partial(find_bp_file, project_root, bp_id))
        if bp_path is None:
            raise HTTPException(status_code=404, detail=f"BP not found: {bp_id}")
        content = bp_path.read_text(encoding="utf-8")
        meta, _ = parse_frontmatter(content)
        op = body.op

        if op in ("add-dependency", "remove-dependency"):
            deps = meta.get("depends_on") or meta.get("depends-on") or []
            if not isinstance(deps, list):
                deps = []
            dep = body.value if isinstance(body.value, str) else (body.value or {}).get("id")
            deps = [d for d in deps if d != dep]
            if op == "add-dependency" and dep:
                deps.append(dep)
            new_block, aliases = _serialize_depends_on(deps), {"depends_on", "depends-on"}
        elif op in ("add-artifact", "remove-artifact"):
            arts = meta.get("artifacts") or []
            if not isinstance(arts, list):
                arts = []
            v = body.value if isinstance(body.value, dict) else {}
            path, direction = v.get("path"), v.get("direction")
            arts = [a for a in arts if not (a.get("path") == path and a.get("direction") == direction)]
            if op == "add-artifact" and path and direction:
                entry = {"path": path, "direction": direction}
                if v.get("description"):
                    entry["description"] = v["description"]
                arts.append(entry)
            new_block, aliases = _serialize_artifacts(arts), {"artifacts"}
        elif op == "set-stage":
            stage = body.value if isinstance(body.value, str) else (body.value or {}).get("stage", "")
            stage = (stage or "").strip()
            new_block = [f"stage: {_yaml_scalar(stage)}"] if stage else []
            aliases = {"stage"}
        else:
            raise HTTPException(status_code=400, detail=f"unknown op: {op}")

        new_content = _replace_fm_block(content, aliases, new_block)
        rel_path = str(bp_path.relative_to(project_root))

        def _write_and_commit():
            _ensure_git_identity(project_root)
            env = _git_env()
            bp_path.write_text(new_content, encoding="utf-8")
            subprocess.run(["git", "add", rel_path], cwd=project_root, check=True, capture_output=True, env=env)
            subprocess.run(["git", "commit", "-m", f"refine(bp:{bp_id[:6]}): {op} via Flows"], cwd=project_root, check=True, capture_output=True, env=env)
            build_index = project_root / "scripts" / "build-index.py"
            if build_index.exists():
                subprocess.run(["python3", str(build_index)], cwd=project_root, capture_output=True)

        await loop.run_in_executor(None, _write_and_commit)
        return _json_response({"ok": True, "op": op, "path": rel_path})
    except HTTPException:
        raise
    except subprocess.CalledProcessError as exc:
        err = exc.stderr.decode() if exc.stderr else str(exc)
        raise HTTPException(status_code=500, detail=f"Git error: {err}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/preview")
async def serve_preview(
    workspace: str,
    path: str = Query(default=""),
    branch: str = Query(default=""),
):
    """Return a file preview as JSON.

    If *branch* is provided and the file does not exist on the local
    filesystem, the file is read from the git branch via ``git show``.
    """
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)

    if not path:
        raise HTTPException(status_code=400, detail="Missing path parameter")

    # Validate allowed file extensions (before any I/O)
    allowed = {
        ".json", ".md", ".txt", ".csv", ".py", ".java", ".xml", ".yaml", ".yml", ".html",
        ".sh", ".bash", ".zsh", ".fish",
        ".js", ".ts", ".jsx", ".tsx", ".css", ".scss", ".less",
        ".rb", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs",
        ".sql", ".graphql", ".gql",
        ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
        ".dockerfile", ".makefile",
        ".template", ".tmpl", ".j2", ".jinja", ".jinja2",
        ".tf", ".hcl",
        ".gradle", ".sbt", ".kt", ".kts", ".scala",
        ".r", ".lua", ".pl", ".pm",
        ".log", ".diff", ".patch",
    }
    allowed_names = {"dockerfile", "makefile", "gemfile", "rakefile", "procfile", "vagrantfile"}
    filename = path.split("/")[-1]
    suffix = ""
    if "." in filename:
        suffix = "." + filename.rsplit(".", 1)[-1].lower()
    if suffix:
        if suffix not in allowed:
            raise HTTPException(status_code=403, detail=f"Preview not allowed for {suffix}")
    elif filename.lower() not in allowed_names:
        raise HTTPException(status_code=403, detail=f"Preview not allowed for {filename}")

    # Containment: normalize both the (already contained) project root and the
    # user-supplied path with os.path.realpath and verify the target stays under
    # the root with a SINGLE DIRECT str.startswith check in the guard condition
    # — the exact barrier CodeQL models for py/path-injection (normalize, then
    # prefix-check the normalized value in the branch). The prior form used a
    # disjunction `full_real == root_resolved or full_real.startswith(...)`; the
    # `== root or …` arm makes the safe branch reachable without startswith, so
    # CodeQL did NOT recognise it as a barrier and every downstream sink stayed
    # flagged. The preview target is always a FILE strictly under the root (the
    # `if not path: raise 400` guard above rules out the empty/root case), so
    # the equality arm was dead and dropping it is behaviour-preserving. The
    # trailing-os.sep also rejects prefix-siblings such as "/root-evil" that a
    # bare startswith(root) accepts.
    root_resolved = os.path.realpath(project_root)
    full_real = os.path.realpath(project_root / path)
    if not full_real.startswith(root_resolved + os.sep):
        raise HTTPException(status_code=403, detail="Path outside project root")
    full = Path(full_real)

    # --- Try local filesystem first ---
    if full.exists() and full.is_file():
        size = full.stat().st_size
        max_size = 2 * 1024 * 1024
        try:
            def _read_file():
                content = full.read_text(encoding="utf-8")[:max_size]
                truncated = size > max_size
                return {
                    "path": path,
                    "filename": full.name,
                    "suffix": full.suffix.lower(),
                    "size": size,
                    "truncated": truncated,
                    "content": content,
                }
            data = await loop.run_in_executor(None, _read_file)
            return _json_response(data)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    # --- Fallback: read from git branch ---
    if branch:
        # Sanitise branch name (only allow alphanumeric, slashes, hyphens, dots)
        if not re.match(r'^[\w./-]+$', branch):
            raise HTTPException(status_code=400, detail="Invalid branch name")
        try:
            def _read_from_branch():
                content = git_show_file(project_root, branch, path)
                if content is None:
                    return None
                max_size = 2 * 1024 * 1024
                size = git_file_size(project_root, branch, path)
                truncated = len(content) > max_size
                return {
                    "path": path,
                    "filename": filename,
                    "suffix": suffix,
                    "size": size,
                    "truncated": truncated,
                    "content": content[:max_size],
                    "from_branch": branch,
                }
            data = await loop.run_in_executor(None, _read_from_branch)
            if data is not None:
                return _json_response(data)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    raise HTTPException(status_code=404, detail=f"File not found: {path}")


# --- Server status endpoint --------------------------------------------------


@app.get("/api/server-status")
async def server_status(request: Request):
    """Return server capabilities so the frontend can adapt gracefully."""
    return _json_response({
        "agent_available": getattr(request.app.state, "agent_available", False),
        "agent_unavailable_reason": getattr(
            request.app.state, "agent_unavailable_reason", None
        ),
    })


@app.get("/api/aee/status")
async def aee_status():
    aee = app.state.aee
    enabled = aee is not None
    available = False
    if enabled:
        try:
            available = await aee.is_available()
        except Exception:
            available = False
    return {
        "enabled": enabled,
        "available": available,
        "orchestratorUrl": os.environ.get("AEE_ORCHESTRATOR_URL"),
    }


# --- Agent SDK configuration endpoints --------------------------------------

# Environment variables the Agent SDK reads at runtime.
_AGENT_CONFIG_KEYS = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
]


@app.get("/api/agent-config")
async def get_agent_config():
    """Return which Agent SDK env vars are set (values masked for secrets)."""
    config: dict[str, str | bool | None] = {}
    for key in _AGENT_CONFIG_KEYS:
        val = os.environ.get(key)
        if val is None:
            config[key] = None
        elif "TOKEN" in key or "KEY" in key:
            # Mask secret values — only reveal that they are set
            config[key] = "*" * 8 if val else None
        else:
            config[key] = val
    return _json_response(config)


class AgentConfigRequest(BaseModel):
    """Request body for POST /api/agent-config."""
    ANTHROPIC_BASE_URL: str | None = None
    ANTHROPIC_AUTH_TOKEN: str | None = None
    ANTHROPIC_DEFAULT_SONNET_MODEL: str | None = None
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: str | None = None


@app.post("/api/agent-config")
async def set_agent_config(body: AgentConfigRequest, request: Request):
    """Set Agent SDK env vars at runtime and reinitialise the agent bridge."""
    updates: dict[str, str] = {}
    for key in _AGENT_CONFIG_KEYS:
        val = getattr(body, key, None)
        if val is not None:
            os.environ[key] = val
            updates[key] = key
    if not updates:
        raise HTTPException(status_code=400, detail="No configuration values provided.")

    # Reinitialise the agent bridge with the new environment
    try:
        from agent_bridge import AgentBridge

        bridge = AgentBridge(Path("."))
        bridge.check_prerequisites()
        request.app.state.agent_bridge = bridge
        request.app.state.agent_available = True
        request.app.state.agent_unavailable_reason = None
        logger.info("Agent bridge reinitialised after config update")
        return _json_response({
            "ok": True,
            "agent_available": True,
            "updated_keys": list(updates.keys()),
        })
    except Exception as exc:
        request.app.state.agent_bridge = None
        request.app.state.agent_available = False
        # Static, non-sensitive reason for clients; full detail is logged below.
        reason = "Agent bridge reinitialisation failed"
        request.app.state.agent_unavailable_reason = reason
        logger.warning("Agent bridge reinit failed after config update: %s", exc)
        return _json_response({
            "ok": False,
            "agent_available": False,
            "agent_unavailable_reason": reason,
            "updated_keys": list(updates.keys()),
        })


# --- Agent API endpoints (AC-2, AC-3, AC-5) --------------------------------

# Keepalive interval for SSE streams (seconds)
_SSE_KEEPALIVE_INTERVAL = 15


class InvokeRequest(BaseModel):
    """Request body for POST /api/agent/invoke (AC-2)."""
    prompt: str
    system_prompt: str | None = None
    session_id: str | None = None
    model: str | None = None


def _get_bridge(request: Request):
    """Return the agent bridge or raise 503 if unavailable."""
    bridge = getattr(request.app.state, "agent_bridge", None)
    if bridge is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Agent SDK is not available. Ensure claude-agent-sdk is installed "
                "(pip install 'claude-agent-sdk>=0.1.50,<0.2.0') and "
                "ANTHROPIC_AUTH_TOKEN is set."
            ),
        )
    return bridge


@app.post("/api/agent/invoke")
async def invoke_agent(body: InvokeRequest, request: Request):
    """Invoke a Claude agent and stream output as SSE (AC-2).

    Returns a ``text/event-stream`` response. Event types:
    ``assistant_text``, ``tool_use``, ``tool_result``, ``thinking``,
    ``result``, ``error``, ``rate_limit``, ``system``.

    A ``:keepalive`` comment is sent every 15 seconds to prevent
    proxy/browser timeouts.
    """
    bridge = _get_bridge(request)

    async def event_generator():
        """Yield SSE-formatted events with keepalive heartbeats."""
        try:
            # Wrap the bridge invoke in a task so we can race it
            # against a keepalive timer.
            event_iter = bridge.invoke(
                body.prompt,
                system_prompt=body.system_prompt,
                session_id=body.session_id,
                model=body.model,
            )

            # Use an asyncio.Queue to decouple the bridge iterator
            # from the SSE output, allowing interleaved keepalives.
            queue: asyncio.Queue = asyncio.Queue()
            done = asyncio.Event()

            async def _consume():
                try:
                    async for event in event_iter:
                        await queue.put(event.to_sse())
                except Exception:
                    logger.exception("SSE consumer error")
                    error_payload = json.dumps(
                        {
                            "type": "error",
                            "error": "unexpected",
                            "message": "Internal error while streaming events.",
                        },
                        ensure_ascii=False,
                    )
                    await queue.put(f"data: {error_payload}\n\n")
                finally:
                    done.set()

            consumer_task = asyncio.create_task(_consume())

            while True:
                try:
                    # Wait for next event or keepalive timeout
                    sse_data = await asyncio.wait_for(
                        queue.get(), timeout=_SSE_KEEPALIVE_INTERVAL
                    )
                    yield sse_data
                except asyncio.TimeoutError:
                    # No event within the keepalive interval — send heartbeat
                    yield ":keepalive\n\n"

                if done.is_set() and queue.empty():
                    break

            # Ensure the consumer task is cleaned up
            await consumer_task

        except Exception:
            logger.exception("SSE generator error")
            error_payload = json.dumps(
                {
                    "type": "error",
                    "error": "stream_error",
                    "message": "Internal error while streaming events.",
                },
                ensure_ascii=False,
            )
            yield f"data: {error_payload}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/agent/sessions")
async def list_agent_sessions(request: Request):
    """List all tracked agent sessions (AC-3)."""
    bridge = _get_bridge(request)
    return _json_response(bridge.list_sessions())


@app.delete("/api/agent/sessions/{session_id}")
async def cancel_agent_session(session_id: str, request: Request):
    """Cancel a running agent session (AC-3)."""
    bridge = _get_bridge(request)
    cancelled = await bridge.cancel(session_id)
    if not cancelled:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found or not active",
        )
    return _json_response({"session_id": session_id, "status": "cancelled"})


# --- Detached agent execution endpoints -----------------------------------

@app.post("/api/agent/start")
async def start_agent(body: InvokeRequest, request: Request):
    """Start an agent as a detached background task.

    Returns the session ID immediately. The agent runs independently of
    the HTTP connection — surviving browser disconnects. Use
    ``GET /api/agent/sessions/{id}/events`` to stream events.
    """
    bridge = _get_bridge(request)
    session_id = await bridge.start(
        body.prompt,
        system_prompt=body.system_prompt,
        session_id=body.session_id,
        model=body.model,
    )
    return _json_response({"session_id": session_id, "status": "active"})


@app.get("/api/agent/sessions/{session_id}")
async def get_agent_session(session_id: str, request: Request):
    """Get detailed status of a single agent session.

    Returns session metadata including ``event_count`` for reconnect offset.
    """
    bridge = _get_bridge(request)
    info = bridge.get_session(session_id)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return _json_response(info)


@app.get("/api/agent/sessions/{session_id}/events")
async def stream_agent_events(
    session_id: str, request: Request, offset: int = 0
):
    """Stream events from a detached agent session as SSE.

    Supports reconnect: pass ``?offset=N`` to skip already-received events.
    The stream sends keepalive comments every 15 seconds and terminates
    when the session completes, errors, or is cancelled.
    """
    bridge = _get_bridge(request)
    info = bridge.get_session(session_id)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    async def event_generator():
        event_iter = bridge.stream_events(session_id, offset=offset)
        queue: asyncio.Queue = asyncio.Queue()
        done = asyncio.Event()

        async def _consume():
            try:
                async for event in event_iter:
                    await queue.put(event.to_sse())
            except Exception:
                logger.exception("SSE consumer error")
                error_payload = json.dumps(
                    {
                        "type": "error",
                        "error": "stream_error",
                        "message": "Internal error while streaming events.",
                    },
                    ensure_ascii=False,
                )
                await queue.put(f"data: {error_payload}\n\n")
            finally:
                done.set()

        consumer_task = asyncio.create_task(_consume())

        try:
            while True:
                try:
                    sse_data = await asyncio.wait_for(
                        queue.get(), timeout=_SSE_KEEPALIVE_INTERVAL
                    )
                    yield sse_data
                except asyncio.TimeoutError:
                    yield ":keepalive\n\n"

                if done.is_set() and queue.empty():
                    break
        finally:
            await consumer_task

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- CRP Detection endpoint (AC-6) ----------------------------------------

@app.get("/api/crps")
async def list_all_crps(workspace: str):
    """Return all open CRP files as a JSON array.

    Scans ``artifacts/guidance/crp/`` for all ``.md`` files, parses their
    YAML frontmatter, and returns those with status ``open`` (or no status
    field, which defaults to open).
    """
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)

    def _scan_all_crps() -> list[dict]:
        crp_dir = project_root / "artifacts" / "guidance" / "crp"
        if not crp_dir.is_dir():
            return []

        results = []
        for crp_file in sorted(crp_dir.glob("*.md")):
            try:
                text = crp_file.read_text(encoding="utf-8")
                meta, body = parse_frontmatter(text)
                status = meta.get("status", "open")
                if status != "open":
                    continue
                rel_path = str(crp_file.relative_to(project_root))
                results.append({
                    "bp_id": meta.get("bp", ""),
                    "crp_id": meta.get("id", ""),
                    "path": rel_path,
                    "body": body,
                    "category": meta.get("category", ""),
                    "urgency": meta.get("urgency", ""),
                    "mode": meta.get("mode", ""),
                    "status": status,
                    "routed_to": meta.get("routed-to") or None,
                    "trigger": meta.get("trigger", ""),
                    "phase": meta.get("phase", ""),
                    "raised_by": meta.get("raised-by", ""),
                    "created": meta.get("created", ""),
                })
            except Exception:
                logger.debug("Failed to parse CRP file %s", crp_file)
                continue

        return results

    try:
        result = await loop.run_in_executor(None, _scan_all_crps)
        return _json_response(result, indent=2)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/crp/{bp_id}")
async def detect_crp(bp_id: str, workspace: str):
    """Check for CRP files associated with a BP (AC-6).

    Scans ``artifacts/guidance/crp/`` for files whose frontmatter
    references the given BP ID. Returns ``{exists, path?, body?}``.
    """
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)

    def _scan_crps() -> dict:
        crp_dir = project_root / "artifacts" / "guidance" / "crp"
        if not crp_dir.is_dir():
            return {"exists": False}

        # Scan all .md files in the CRP directory for matching BP references
        for crp_file in sorted(crp_dir.glob("*.md")):
            try:
                text = crp_file.read_text(encoding="utf-8")
                meta, body = parse_frontmatter(text)
                if meta.get("bp") == bp_id:
                    rel_path = str(crp_file.relative_to(project_root))
                    return {
                        "exists": True,
                        "path": rel_path,
                        "body": body,
                    }
            except Exception:
                logger.debug("Failed to parse CRP file %s", crp_file)
                continue

        return {"exists": False}

    try:
        result = await loop.run_in_executor(None, _scan_crps)
        return _json_response(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Agent activity log (git log for a BP)
# ---------------------------------------------------------------------------


@app.get("/api/agent-log/{bp_id}")
async def agent_log(bp_id: str, workspace: str):
    """Return recent git commits related to a BP, across all branches."""
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)
    bp_short = bp_id[:6] if len(bp_id) >= 6 else bp_id

    def _git_log() -> list[dict]:
        result = subprocess.run(
            [
                "git", "log", "--all",
                f"--grep=bp:{bp_short}",
                "--format=%H|%h|%s|%an|%aI",
                "-20",
            ],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=10,
        )
        entries = []
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|", 4)
                if len(parts) >= 5:
                    entries.append({
                        "hash": parts[0],
                        "short_hash": parts[1],
                        "message": parts[2],
                        "author": parts[3],
                        "date": parts[4],
                    })
        return entries

    try:
        result = await loop.run_in_executor(None, _git_log)
        return _json_response(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


def _parse_commit_action(message: str) -> str:
    """Extract action type from commit convention ``action(bp:...): ...``."""
    m = re.match(r"^(\w+)\(bp:", message)
    return m.group(1) if m else "work"


def _parse_agent_from_commit(message: str) -> str:
    """Extract agent-id from ``[agent:XXXXXXXX]`` tag in commit message."""
    m = re.search(r"\[agent:([0-9a-f]+)\]", message)
    return m.group(1) if m else ""


@app.get("/api/agent-telemetry/{bp_id}")
async def agent_telemetry(bp_id: str, workspace: str):
    """Return structured telemetry for a BP: parsed commits, health, CRPs, diff stats."""
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)
    bp_short = bp_id[:6] if len(bp_id) >= 6 else bp_id

    def _build_telemetry() -> dict:
        # --- git log with structured parsing ---
        log_result = subprocess.run(
            [
                "git", "log", "--all",
                f"--grep=bp:{bp_short}",
                "--format=%H|%h|%s|%an|%aI",
                "-30",
            ],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=10,
        )
        commits = []
        if log_result.returncode == 0:
            for line in log_result.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|", 4)
                if len(parts) >= 5:
                    msg = parts[2]
                    commits.append({
                        "hash": parts[0],
                        "short_hash": parts[1],
                        "message": msg,
                        "author": parts[3],
                        "date": parts[4],
                        "action": _parse_commit_action(msg),
                        "agent_id": _parse_agent_from_commit(msg),
                    })

        # --- diff stats (files changed, insertions, deletions) ---
        diff_stats: dict = {"files": 0, "insertions": 0, "deletions": 0}
        # Find the agent branch for this BP
        branch_result = subprocess.run(
            ["git", "branch", "-a", "--list", f"*/{bp_short}*"],
            capture_output=True, text=True,
            cwd=str(project_root), timeout=5,
        )
        agent_branch = ""
        if branch_result.returncode == 0:
            for bline in branch_result.stdout.strip().split("\n"):
                bline = bline.strip().lstrip("* ")
                if f"/{bp_short}" in bline and "remotes/" not in bline:
                    agent_branch = bline
                    break
            if not agent_branch:
                for bline in branch_result.stdout.strip().split("\n"):
                    bline = bline.strip().lstrip("* ")
                    if f"/{bp_short}" in bline:
                        agent_branch = bline.replace("remotes/origin/", "")
                        break

        if agent_branch:
            stat_result = subprocess.run(
                ["git", "diff", "--shortstat", f"main...{agent_branch}"],
                capture_output=True, text=True,
                cwd=str(project_root), timeout=10,
            )
            if stat_result.returncode == 0 and stat_result.stdout.strip():
                stat_line = stat_result.stdout.strip()
                m_files = re.search(r"(\d+) file", stat_line)
                m_ins = re.search(r"(\d+) insertion", stat_line)
                m_del = re.search(r"(\d+) deletion", stat_line)
                diff_stats = {
                    "files": int(m_files.group(1)) if m_files else 0,
                    "insertions": int(m_ins.group(1)) if m_ins else 0,
                    "deletions": int(m_del.group(1)) if m_del else 0,
                }

        # --- CRP scan for this BP ---
        crps: list[dict] = []
        crp_dir = project_root / "artifacts" / "guidance" / "crp"
        if crp_dir.is_dir():
            for crp_file in sorted(crp_dir.glob("*.md")):
                try:
                    text = crp_file.read_text(encoding="utf-8")
                    meta, _ = parse_frontmatter(text)
                    if meta.get("bp") == bp_id:
                        crps.append({
                            "crp_id": meta.get("id", ""),
                            "mode": meta.get("mode", ""),
                            "status": meta.get("status", "open"),
                            "trigger": meta.get("trigger", ""),
                            "category": meta.get("category", ""),
                            "created": meta.get("created", ""),
                        })
                except Exception:
                    continue

        return {
            "bp_id": bp_id,
            "commits": commits,
            "diff_stats": diff_stats,
            "crps": crps,
            "agent_branch": agent_branch,
        }

    try:
        result = await loop.run_in_executor(None, _build_telemetry)
        return _json_response(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Blueprint API
# ---------------------------------------------------------------------------


@app.get("/api/blueprints")
async def list_blueprints(workspace: str, level: str = None, tag: str = None):
    """List all Blueprints with optional filters."""
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)

    def _list() -> list[dict]:
        cmd = [
            sys.executable,
            str(project_root / "scripts" / "blueprint-engine.py"),
            "list",
            "--json",
        ]
        if level:
            cmd.extend(["--level", level])
        if tag:
            cmd.extend(["--tag", tag])
        result = subprocess.run(
            cmd, capture_output=True, text=True, cwd=str(project_root), timeout=30
        )
        if result.returncode != 0:
            return []
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return []

    try:
        result = await loop.run_in_executor(None, _list)
        return _json_response(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/blueprint/{bp_id}")
async def get_blueprint(bp_id: str, workspace: str):
    """Get full Blueprint details including body content."""
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)

    def _info() -> dict:
        result = subprocess.run(
            [
                sys.executable,
                str(project_root / "scripts" / "blueprint-engine.py"),
                "info",
                bp_id,
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=30,
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip()}
        try:
            info = json.loads(result.stdout)
        except json.JSONDecodeError:
            return {"error": "Failed to parse blueprint info"}

        # Also read the raw body
        blueprints_dir = project_root / "artifacts" / "blueprints"
        for bp_path in blueprints_dir.rglob("blueprint.md"):
            dir_name = bp_path.parent.name
            m = re.match(r"^([0-9a-f]{12})-(.+)$", dir_name)
            if m and m.group(1).startswith(bp_id):
                text = bp_path.read_text(encoding="utf-8")
                parts = text.split("---", 2)
                if len(parts) >= 3:
                    info["body"] = parts[2]
                break

        return info

    try:
        result = await loop.run_in_executor(None, _info)
        if "error" in result:
            raise HTTPException(status_code=404, detail=result["error"])
        return _json_response(result)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/blueprint/analyze")
async def analyze_for_blueprint(workspace: str, request: Request):
    """Run pre-analysis on a BP tree for Blueprint extraction."""
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)
    body = await request.json()
    bp_hash = body.get("bp_hash", "")

    def _analyze() -> dict:
        result = subprocess.run(
            [
                sys.executable,
                str(project_root / "scripts" / "blueprint-engine.py"),
                "analyze",
                bp_hash,
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=60,
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip()}
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return {"error": "Failed to parse analysis"}

    try:
        result = await loop.run_in_executor(None, _analyze)
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return _json_response(result)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/blueprint/instantiate")
async def instantiate_blueprint(workspace: str, request: Request):
    """Instantiate concrete BPs from a Blueprint with provided parameters."""
    loop = asyncio.get_running_loop()
    project_root = resolve_workspace(workspace)
    body = await request.json()
    blueprint_hash = body.get("blueprint_hash", "")
    params = body.get("parameters", {})
    rigor = body.get("rigor", "standard")

    def _instantiate() -> dict:
        result = subprocess.run(
            [
                sys.executable,
                str(project_root / "scripts" / "blueprint-engine.py"),
                "instantiate",
                blueprint_hash,
                "--params",
                json.dumps(params),
                "--rigor",
                rigor,
            ],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=60,
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip()}
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return {"error": "Failed to parse result"}

    try:
        result = await loop.run_in_executor(None, _instantiate)
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return _json_response(result)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="Briefing Pack Explorer Server")
    parser.add_argument("--port", type=int, default=8765, help="Port (default: 8765)")
    args = parser.parse_args()

    print(f"  Server: http://localhost:{args.port}")

    # Configure uvicorn with minimal access logging to match the original
    # quieter logging behaviour (the original server only printed request paths).
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=args.port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
