#!/usr/bin/env python3
"""
Deterministic operations on guidance artifacts (CRP, MRP, VCR).

Replaces LLM-driven frontmatter edits and file creation with
deterministic script operations.

Usage:
    python3 scripts/guidance-ops.py resolve-crp <crp-hash> --vcr-hash <hash> [--resolved-date YYYY-MM-DD]
    python3 scripts/guidance-ops.py update-mrp  <mrp-hash> --status approved|rejected|revision-requested
    python3 scripts/guidance-ops.py create-vcr  --type <type> --resolves <hash> --decision <text> --rationale <text> [--bp <hash>]
    python3 scripts/guidance-ops.py find-crp    <crp-hash-prefix>
    python3 scripts/guidance-ops.py find-mrp    <mrp-hash-prefix>

Flags:
    --no-commit   Skip git operations
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    REPO_ROOT, GUIDANCE_DIR, CRP_DIR, MRP_DIR, VCR_DIR,
    extract_frontmatter_bounds, extract_frontmatter_bounds_safe,
    get_field, set_field,
    parse_frontmatter, git_run, git_user, today_iso, rel_path,
)


# ---------------------------------------------------------------------------
# Artifact lookup
# ---------------------------------------------------------------------------

def _list_search_roots() -> list[Path]:
    """Return repo roots to search for artifacts.

    Includes the main repo (REPO_ROOT) and every active worktree under
    `.worktrees/`. Worktrees come first so that artifacts committed on an
    agent branch but not yet merged to main take precedence over any older
    copy that may exist on the current branch.
    """
    roots: list[Path] = []
    main_root: Path | None = None
    main_resolved = REPO_ROOT.resolve()

    r = git_run(["worktree", "list", "--porcelain"], check=False)
    if r.returncode == 0:
        for line in r.stdout.splitlines():
            if not line.startswith("worktree "):
                continue
            wt = Path(line[len("worktree "):])
            try:
                wt_resolved = wt.resolve()
            except OSError:
                wt_resolved = wt
            if wt_resolved == main_resolved:
                main_root = wt
            else:
                roots.append(wt)

    # Worktrees first (in-flight agent branches), then main (already-merged).
    roots.append(main_root if main_root is not None else REPO_ROOT)
    return roots


def _scan_dir_for_prefix(search_dir: Path, prefix: str) -> list[tuple[Path, str]]:
    """Return all (path, artifact_id) matches for a prefix in one directory."""
    if not search_dir.exists():
        return []

    matches: list[tuple[Path, str]] = []
    seen_paths: set[Path] = set()

    def _try_add(path: Path, fallback_id: str) -> None:
        if path in seen_paths:
            return
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return
        bounds = extract_frontmatter_bounds_safe(text)
        if bounds is None:
            return
        fm_text = text[bounds[0]:bounds[1]]
        artifact_id = get_field(fm_text, "id") or fallback_id
        if artifact_id.startswith(prefix):
            seen_paths.add(path)
            matches.append((path, artifact_id))

    # Frontmatter-based scan (handles both flat files and {hash}-{slug}/foo.md).
    for path in search_dir.rglob("*.md"):
        _try_add(path, "")

    # Filename-based: {prefix}*.md
    for path in search_dir.glob(f"{prefix}*.md"):
        _try_add(path, path.stem)

    # Directory-name based: {prefix}*/*.md
    for path in search_dir.glob(f"{prefix}*/*.md"):
        _try_add(path, path.parent.name.split("-")[0])

    return matches


def find_artifact(directory: Path, prefix: str) -> tuple[Path, str]:
    """Find an artifact file by ID prefix across all worktrees.

    Returns (path, full_id). Searches the supplied *directory* (which lives
    under REPO_ROOT) and the equivalent path inside every active worktree.
    When the same artifact id is visible in more than one worktree, the
    worktree copy is preferred over main (see `_list_search_roots`); this
    matches the agent-branch lifecycle, where a guidance artifact lives on
    the agent branch until the BP is merged to main.
    """
    try:
        rel_dir = directory.relative_to(REPO_ROOT)
    except ValueError:
        rel_dir = None

    matches: list[tuple[Path, str]] = []
    seen_ids: set[str] = set()

    if rel_dir is None:
        search_roots = [None]
    else:
        search_roots = _list_search_roots()

    for root in search_roots:
        if root is None:
            search_dir = directory
        else:
            search_dir = root / rel_dir
        for path, artifact_id in _scan_dir_for_prefix(search_dir, prefix):
            # Worktrees are searched first; first writer wins on duplicates.
            if artifact_id and artifact_id in seen_ids:
                continue
            if artifact_id:
                seen_ids.add(artifact_id)
            matches.append((path, artifact_id))

    if not matches:
        location_hint = (
            f"{directory.name}/ (across {len(search_roots)} worktree(s))"
            if rel_dir is not None and len(search_roots) > 1
            else f"{directory.name}/"
        )
        print(f"ERROR: No artifact found matching prefix '{prefix}' in {location_hint}",
              file=sys.stderr)
        sys.exit(2)
    if len(matches) > 1:
        print(f"ERROR: Ambiguous prefix '{prefix}'. Matches:", file=sys.stderr)
        for p, i in matches:
            display = i or p.name
            try:
                rel = p.relative_to(REPO_ROOT)
            except ValueError:
                rel = p
            print(f"  {display} ({rel})", file=sys.stderr)
        sys.exit(2)

    return matches[0]


def _git_root_for(path: Path) -> Path:
    """Return the worktree/repo root that contains *path*.

    Used so that git operations (`add`, `commit`) run from the same worktree
    the artifact lives in — important when the artifact is on an agent branch
    under `.worktrees/` rather than on the current branch in main.
    """
    try:
        path_resolved = path.resolve()
    except OSError:
        path_resolved = path
    for root in _list_search_roots():
        try:
            root_resolved = root.resolve()
        except OSError:
            root_resolved = root
        try:
            path_resolved.relative_to(root_resolved)
            return root
        except ValueError:
            continue
    return REPO_ROOT


# ---------------------------------------------------------------------------
# resolve-crp: Update CRP status to resolved
# ---------------------------------------------------------------------------

def resolve_crp(
    crp_prefix: str,
    vcr_hash: str,
    resolved_date: str | None = None,
    no_commit: bool = False,
) -> None:
    """Set CRP status to resolved with VCR reference."""
    path, crp_id = find_artifact(CRP_DIR, crp_prefix)
    text = path.read_text(encoding="utf-8")
    fm_start, fm_end = extract_frontmatter_bounds(text)
    fm_text = text[fm_start:fm_end]

    current_status = get_field(fm_text, "status")
    if current_status == "resolved":
        print(f"CRP {crp_id} is already resolved", file=sys.stderr)
        sys.exit(1)

    date = resolved_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    new_fm = fm_text
    new_fm = set_field(new_fm, "status", "resolved")
    new_fm = set_field(new_fm, "resolved-by", vcr_hash)
    new_fm = set_field(new_fm, "resolved-date", date)

    new_text = text[:fm_start] + new_fm + text[fm_end:]
    path.write_text(new_text, encoding="utf-8")

    print(f"CRP {crp_id[:12]}: {current_status} -> resolved")
    print(f"  resolved-by: {vcr_hash}")
    print(f"  resolved-date: {date}")

    if not no_commit:
        cwd = _git_root_for(path)
        rel = str(path.relative_to(cwd))
        git_run(["add", rel], cwd=str(cwd))
        git_run(
            ["commit", "-m", f"resolve-crp({crp_id[:6]}): resolved via VCR {vcr_hash[:6]}"],
            cwd=str(cwd),
        )
        print(f"  committed")


def defer_crp(
    crp_prefix: str,
    no_commit: bool = False,
) -> None:
    """Set CRP status to deferred-to-mrp (defer further for MRP review)."""
    path, crp_id = find_artifact(CRP_DIR, crp_prefix)
    text = path.read_text(encoding="utf-8")
    fm_start, fm_end = extract_frontmatter_bounds(text)
    fm_text = text[fm_start:fm_end]

    current_status = get_field(fm_text, "status") or "open"
    if current_status == "resolved":
        print(f"CRP {crp_id} is already resolved — cannot defer", file=sys.stderr)
        sys.exit(1)

    new_fm = set_field(fm_text, "status", "deferred-to-mrp")
    new_text = text[:fm_start] + new_fm + text[fm_end:]
    path.write_text(new_text, encoding="utf-8")

    print(f"CRP {crp_id[:12]}: {current_status} -> deferred-to-mrp")
    print(f"  Will surface during MRP review.")

    if not no_commit:
        cwd = _git_root_for(path)
        rel = str(path.relative_to(cwd))
        git_run(["add", rel], cwd=str(cwd))
        git_run(
            ["commit", "-m", f"defer-crp({crp_id[:6]}): deferred to MRP review"],
            cwd=str(cwd),
        )
        print(f"  committed")


# ---------------------------------------------------------------------------
# update-mrp: Update MRP status
# ---------------------------------------------------------------------------

def update_mrp(
    mrp_prefix: str,
    status: str,
    no_commit: bool = False,
) -> None:
    """Update MRP status field."""
    path, mrp_id = find_artifact(MRP_DIR, mrp_prefix)
    text = path.read_text(encoding="utf-8")
    fm_start, fm_end = extract_frontmatter_bounds(text)
    fm_text = text[fm_start:fm_end]

    current_status = get_field(fm_text, "status") or "pending"

    new_fm = set_field(fm_text, "status", status)
    new_text = text[:fm_start] + new_fm + text[fm_end:]
    path.write_text(new_text, encoding="utf-8")

    print(f"MRP {mrp_id[:12]}: {current_status} -> {status}")

    if not no_commit:
        cwd = _git_root_for(path)
        rel = str(path.relative_to(cwd))
        git_run(["add", rel], cwd=str(cwd))
        git_run(
            ["commit", "-m", f"review-mrp({mrp_id[:6]}): {status}"],
            cwd=str(cwd),
        )
        print(f"  committed")


# ---------------------------------------------------------------------------
# create-vcr: Generate VCR hash and write VCR file
# ---------------------------------------------------------------------------

def create_vcr(
    vcr_type: str,
    resolves: str,
    decision: str,
    rationale: str,
    bp_hash: str | None = None,
    criteria: dict | None = None,
    no_commit: bool = False,
) -> str:
    """Create a VCR file. Returns the generated VCR hash."""
    VCR_DIR.mkdir(parents=True, exist_ok=True)

    # Generate hash
    result = subprocess.run(
        ["openssl", "rand", "-hex", "6"],
        capture_output=True, text=True,
    )
    vcr_hash = result.stdout.strip()

    author = git_user()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Build frontmatter
    fm_lines = [
        "---",
        "schema: sase/vcr/v1",
        f'id: "{vcr_hash}"',
        f'type: "{vcr_type}"',
        f'created: "{today}"',
        f'author: "{author}"',
        f'resolves: "{resolves}"',
    ]

    if bp_hash:
        fm_lines.append(f'briefing-pack: "{bp_hash}"')

    fm_lines.append("---")

    # Build body
    body_lines = [
        "",
        f"# VCR: {vcr_hash[:6]} — {vcr_type.replace('-', ' ').title()}",
        "",
        "## Decision",
        "",
        decision,
        "",
        "## Rationale",
        "",
        rationale,
    ]

    # Add criteria assessment for MRP reviews
    if criteria:
        body_lines.extend([
            "",
            "## Criteria Assessment",
            "",
        ])
        for criterion, result_val in criteria.items():
            body_lines.append(f"- {criterion}: {result_val}")

    content = "\n".join(fm_lines) + "\n" + "\n".join(body_lines) + "\n"

    vcr_path = VCR_DIR / f"{vcr_hash}.md"
    vcr_path.write_text(content, encoding="utf-8")

    print(f"VCR {vcr_hash[:6]} created")
    print(f"  type: {vcr_type}")
    print(f"  resolves: {resolves[:12]}")
    print(f"  author: {author}")
    print(f"  path: {vcr_path.relative_to(REPO_ROOT)}")

    if not no_commit:
        rel_path = str(vcr_path.relative_to(REPO_ROOT))
        git_run(["add", rel_path])
        # Don't commit alone — caller typically bundles with CRP/MRP update
        print(f"  staged (not committed — bundle with related updates)")

    return vcr_hash


# ---------------------------------------------------------------------------
# find-crp / find-mrp: Locate and display artifact info
# ---------------------------------------------------------------------------

def find_and_display(directory: Path, prefix: str, artifact_type: str) -> None:
    """Find an artifact by prefix and display its key fields."""
    path, artifact_id = find_artifact(directory, prefix)
    text = path.read_text(encoding="utf-8")
    fm_start, fm_end = extract_frontmatter_bounds(text)
    fm_text = text[fm_start:fm_end]

    fields = {}
    for field_name in ["id", "status", "bp", "briefing-pack", "mode", "urgency",
                       "raised-by", "produced-by", "routed-to", "phase",
                       "trigger", "created", "auto-score"]:
        val = get_field(fm_text, field_name)
        if val:
            fields[field_name] = val

    print(f"{artifact_type.upper()}: {artifact_id}")
    print(f"  path: {path.relative_to(REPO_ROOT)}")
    for k, v in fields.items():
        if k != "id":
            print(f"  {k}: {v}")


# ---------------------------------------------------------------------------
# list-crps: Scan and filter CRPs
# ---------------------------------------------------------------------------

URGENCY_ORDER = {"blocking": 0, "high": 1, "medium": 2, "low": 3}


def _parse_fm(path: Path) -> dict | None:
    """Parse frontmatter from a guidance artifact file."""
    text = path.read_text(encoding="utf-8")
    try:
        fm_start, fm_end = extract_frontmatter_bounds(text)
    except SystemExit:
        return None
    fm_text = text[fm_start:fm_end]

    fields = {}
    for name in ["id", "status", "bp", "briefing-pack", "mode", "urgency",
                  "raised-by", "produced-by", "routed-to", "phase",
                  "trigger", "created", "auto-score", "resolves", "type"]:
        val = get_field(fm_text, name)
        if val:
            fields[name] = val
    fields["_path"] = str(path.relative_to(REPO_ROOT))

    # Extract title/question from body
    body = text[fm_end:]
    for line in body.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            fields["_title"] = line.lstrip("# ").strip()
            break
    return fields


def list_crps(
    status_filter: str | None = None,
    mode_filter: str | None = None,
    bp_filter: str | None = None,
    json_mode: bool = False,
) -> list[dict]:
    """List CRPs, optionally filtered by status, mode, and/or BP hash."""
    if not CRP_DIR.exists():
        if json_mode:
            print("[]")
        else:
            print("No CRPs found.")
        return []

    results = []
    for path in sorted(CRP_DIR.glob("*.md")):
        fm = _parse_fm(path)
        if not fm:
            continue
        # Default status to "open" if not set (per CRP spec)
        if "status" not in fm:
            fm["status"] = "open"
        # Default urgency to "medium" if not set
        if "urgency" not in fm:
            fm["urgency"] = "medium"
        if status_filter and fm.get("status") != status_filter:
            continue
        if mode_filter and fm.get("mode") != mode_filter:
            continue
        if bp_filter:
            bp = fm.get("bp") or fm.get("briefing-pack", "")
            if not bp.startswith(bp_filter):
                continue
        results.append(fm)

    # Sort: mode=blocking first, then urgency, then oldest first
    results.sort(key=lambda c: (
        0 if c.get("mode") == "blocking" else 1,
        URGENCY_ORDER.get(c.get("urgency", "medium"), 99),
        c.get("created", ""),
    ))

    if json_mode:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print(f"No CRPs found{' with status=' + status_filter if status_filter else ''}.")
        else:
            print(f"CRPs ({len(results)}):")
            print(f"{'ID':<14} {'Status':<10} {'Mode':<10} {'Urgency':<8} {'BP':<14} {'Created':<12} Title")
            print("-" * 90)
            for c in results:
                crp_id = c.get("id", "?")[:12]
                status = c.get("status", "?")
                mode = c.get("mode", "?")
                urgency = c.get("urgency", "?")
                bp = (c.get("bp") or c.get("briefing-pack", "?"))[:12]
                created = c.get("created", "?")
                title = c.get("_title", "")[:40]
                print(f"{crp_id:<14} {status:<10} {mode:<10} {urgency:<8} {bp:<14} {created:<12} {title}")

    return results


# ---------------------------------------------------------------------------
# list-mrps: Scan and filter MRPs, check for VCRs
# ---------------------------------------------------------------------------

def list_mrps(
    pending_only: bool = False,
    bp_filter: str | None = None,
    json_mode: bool = False,
) -> list[dict]:
    """List MRPs, optionally filtered to pending (no VCR) only."""
    if not MRP_DIR.exists():
        if json_mode:
            print("[]")
        else:
            print("No MRPs found.")
        return []

    # Build VCR lookup: which MRP/CRP IDs have been resolved
    resolved_ids = set()
    if VCR_DIR.exists():
        for path in VCR_DIR.glob("*.md"):
            fm = _parse_fm(path)
            if fm:
                resolves = fm.get("resolves", "")
                if resolves:
                    resolved_ids.add(resolves)

    results = []
    # Search both flat files and subdirectory-based layouts (e.g. {hash}-{slug}/mrp.md)
    for path in sorted(MRP_DIR.rglob("*.md")):
        fm = _parse_fm(path)
        if not fm:
            continue
        if bp_filter:
            bp = fm.get("bp") or fm.get("briefing-pack", "")
            if not bp.startswith(bp_filter):
                continue

        mrp_id = fm.get("id", "")
        has_vcr = mrp_id in resolved_ids
        fm["has_vcr"] = has_vcr
        fm["pending"] = not has_vcr and fm.get("status") not in ("approved", "rejected")

        if pending_only and not fm["pending"]:
            continue
        results.append(fm)

    # Sort: oldest first
    results.sort(key=lambda m: m.get("created", ""))

    if json_mode:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            label = "pending MRPs" if pending_only else "MRPs"
            print(f"No {label} found.")
        else:
            print(f"MRPs ({len(results)}):")
            print(f"{'ID':<14} {'Status':<10} {'Pending':<8} {'BP':<14} {'Agent':<10} {'Created':<12} Title")
            print("-" * 90)
            for m in results:
                mrp_id = m.get("id", "?")[:12]
                status = m.get("status", "?")
                pending = "YES" if m.get("pending") else "no"
                bp = (m.get("bp") or m.get("briefing-pack", "?"))[:12]
                agent = m.get("produced-by", "?")[:8]
                created = m.get("created", "?")
                title = m.get("_title", "")[:40]
                print(f"{mrp_id:<14} {status:<10} {pending:<8} {bp:<14} {agent:<10} {created:<12} {title}")

    return results


# ---------------------------------------------------------------------------
# log-outcome / log-tier1: Append-only audit logs
# ---------------------------------------------------------------------------

LOG_DIR = REPO_ROOT / "artifacts" / "log"


def append_log(log_file: str, entry: str) -> None:
    """Append a timestamped entry to an audit log file."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = LOG_DIR / log_file
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{timestamp}] {entry}\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
    print(f"Logged to {rel_path(path)}: {entry[:80]}")


def log_outcome(
    bp_hash: str,
    agent_id: str,
    decision: str,
    score: str = "N/A",
) -> None:
    """Append an MRP outcome entry to outcomes.log."""
    reviewer = git_user()
    entry = (
        f"BP: {bp_hash} | AGENT: {agent_id} | "
        f"DECISION: {decision} | SCORE: {score} | REVIEWER: {reviewer}"
    )
    append_log("outcomes.log", entry)


def log_tier1(
    goal: str,
    files: str,
    outcome: str = "done",
    agent_id: str = "interactive",
) -> None:
    """Append a Tier 1 task entry to tier1.log."""
    entry = (
        f"AGENT: {agent_id} | GOAL: {goal} | "
        f"FILES: {files} | OUTCOME: {outcome}"
    )
    append_log("tier1.log", entry)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Deterministic guidance artifact operations for i-SASE",
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # resolve-crp
    p_resolve = sub.add_parser("resolve-crp", help="Update CRP status to resolved")
    p_resolve.add_argument("crp_prefix", help="CRP hash or prefix")
    p_resolve.add_argument("--vcr-hash", required=True, help="VCR hash that resolves this CRP")
    p_resolve.add_argument("--resolved-date", help="Resolution date (default: today)")
    p_resolve.add_argument("--no-commit", action="store_true")

    # defer-crp
    p_defer = sub.add_parser("defer-crp", help="Set CRP status to deferred-to-mrp")
    p_defer.add_argument("crp_prefix", help="CRP hash or prefix")
    p_defer.add_argument("--no-commit", action="store_true")

    # update-mrp
    p_mrp = sub.add_parser("update-mrp", help="Update MRP status")
    p_mrp.add_argument("mrp_prefix", help="MRP hash or prefix")
    p_mrp.add_argument("--status", required=True,
                       choices=["approved", "rejected", "revision-requested"])
    p_mrp.add_argument("--no-commit", action="store_true")

    # create-vcr
    p_vcr = sub.add_parser("create-vcr", help="Create a VCR file")
    p_vcr.add_argument("--type", required=True, dest="vcr_type",
                       choices=["crp-response", "mrp-approval", "mrp-rejection", "mrp-revision"])
    p_vcr.add_argument("--resolves", required=True, help="CRP or MRP hash being resolved")
    p_vcr.add_argument("--decision", required=True, help="Decision text")
    p_vcr.add_argument("--rationale", required=True, help="Rationale text")
    p_vcr.add_argument("--bp", help="Associated BP hash")
    p_vcr.add_argument("--no-commit", action="store_true")

    # find-crp
    p_fcrp = sub.add_parser("find-crp", help="Find and display CRP info")
    p_fcrp.add_argument("crp_prefix", help="CRP hash or prefix")

    # find-mrp
    p_fmrp = sub.add_parser("find-mrp", help="Find and display MRP info")
    p_fmrp.add_argument("mrp_prefix", help="MRP hash or prefix")

    # list-crps
    p_lcrps = sub.add_parser("list-crps", help="List CRPs (filtered)")
    p_lcrps.add_argument("--status", help="Filter by status (e.g. open, resolved, deferred-to-mrp)")
    p_lcrps.add_argument("--mode", help="Filter by mode (e.g. blocking, deferred)")
    p_lcrps.add_argument("--bp", help="Filter by BP hash prefix")
    p_lcrps.add_argument("--json", action="store_true", help="JSON output")

    # list-mrps
    p_lmrps = sub.add_parser("list-mrps", help="List MRPs (filtered)")
    p_lmrps.add_argument("--pending", action="store_true", help="Only pending (no VCR)")
    p_lmrps.add_argument("--bp", help="Filter by BP hash prefix")
    p_lmrps.add_argument("--json", action="store_true", help="JSON output")

    # log-outcome
    p_logout = sub.add_parser("log-outcome", help="Append MRP outcome to outcomes.log")
    p_logout.add_argument("--bp", required=True, help="BP hash")
    p_logout.add_argument("--agent", required=True, help="Agent ID")
    p_logout.add_argument("--decision", required=True,
                         choices=["approved", "rejected", "revision-requested"])
    p_logout.add_argument("--score", default="N/A", help="Auto-score (default: N/A)")

    # log-tier1
    p_logt1 = sub.add_parser("log-tier1", help="Append Tier 1 task entry to tier1.log")
    p_logt1.add_argument("--goal", required=True, help="Task goal description")
    p_logt1.add_argument("--files", required=True, help="Files changed (comma-separated)")
    p_logt1.add_argument("--outcome", default="done",
                        choices=["done", "failed", "upgraded"])
    p_logt1.add_argument("--agent", default="interactive", help="Agent ID")

    args = parser.parse_args()

    if args.action == "resolve-crp":
        resolve_crp(
            args.crp_prefix,
            args.vcr_hash,
            resolved_date=args.resolved_date,
            no_commit=args.no_commit,
        )
    elif args.action == "defer-crp":
        defer_crp(
            args.crp_prefix,
            no_commit=args.no_commit,
        )
    elif args.action == "update-mrp":
        update_mrp(
            args.mrp_prefix,
            args.status,
            no_commit=args.no_commit,
        )
    elif args.action == "create-vcr":
        create_vcr(
            args.vcr_type,
            args.resolves,
            args.decision,
            args.rationale,
            bp_hash=args.bp,
            no_commit=args.no_commit,
        )
    elif args.action == "find-crp":
        find_and_display(CRP_DIR, args.crp_prefix, "CRP")
    elif args.action == "find-mrp":
        find_and_display(MRP_DIR, args.mrp_prefix, "MRP")
    elif args.action == "list-crps":
        list_crps(
            status_filter=args.status,
            mode_filter=args.mode,
            bp_filter=args.bp,
            json_mode=args.json,
        )
    elif args.action == "list-mrps":
        list_mrps(
            pending_only=args.pending,
            bp_filter=args.bp,
            json_mode=args.json,
        )
    elif args.action == "log-outcome":
        log_outcome(args.bp, args.agent, args.decision, args.score)
    elif args.action == "log-tier1":
        log_tier1(args.goal, args.files, args.outcome, args.agent)


if __name__ == "__main__":
    main()
