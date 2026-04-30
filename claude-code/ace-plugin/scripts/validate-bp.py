#!/usr/bin/env python3
"""
Deterministic BP validation for dispatch readiness.

Replaces LLM-interpreted validation checks with a deterministic script.
Validates all dispatch prerequisites from dispatch.md Step 2.

Usage:
    python3 scripts/validate-bp.py <bp-hash-prefix>
    python3 scripts/validate-bp.py <bp-hash-prefix> --json

Exit codes:
    0  All checks pass
    1  One or more checks failed
    2  BP not found or usage error
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    REPO_ROOT, BRIEFINGS_DIR, INDEX_JSON, DIR_PATTERN, LOOPSCRIPT_DIRS,
    parse_frontmatter, extract_body, find_bp, has_children,
    resolve_loopscript as _resolve_loopscript_base, rel_path,
)


def count_acceptance_criteria(body: str) -> int:
    """Count acceptance criteria lines (- [ ] patterns)."""
    # Match lines like "- [ ] AC-1: ..." or "- [ ] Description"
    pattern = re.compile(r"^\s*-\s*\[\s*[ xX]?\s*\]\s*\S", re.MULTILINE)
    return len(pattern.findall(body))


def has_goal_content(body: str) -> bool:
    """Check if the Goal & Why section has actual content (not just template placeholders)."""
    # Find the Goal section
    goal_pattern = re.compile(
        r"^##\s+Goal(?:\s+&\s+Why)?.*$",
        re.MULTILINE | re.IGNORECASE,
    )
    match = goal_pattern.search(body)
    if not match:
        return False

    # Get text between this heading and the next heading
    start = match.end()
    next_heading = re.search(r"^##\s+", body[start:], re.MULTILINE)
    section = body[start:start + next_heading.start()] if next_heading else body[start:]

    # Remove comments and whitespace
    section = re.sub(r"<!--.*?-->", "", section, flags=re.DOTALL)
    content = section.strip()

    # Check for template placeholders
    if not content or content.startswith("{{"):
        return False
    return True


def has_context_references(body: str) -> bool:
    """Check if the Context section has at least one concrete file or module reference."""
    # Find the Context section
    ctx_pattern = re.compile(r"^##\s+Context.*$", re.MULTILINE | re.IGNORECASE)
    match = ctx_pattern.search(body)
    if not match:
        return False

    start = match.end()
    next_heading = re.search(r"^##\s+", body[start:], re.MULTILINE)
    section = body[start:start + next_heading.start()] if next_heading else body[start:]

    # Remove comments
    section = re.sub(r"<!--.*?-->", "", section, flags=re.DOTALL)
    content = section.strip()

    if not content or content.startswith("{{"):
        return False

    # Check for file-like references (paths with / or .)
    has_path = bool(re.search(r"[\w/]+\.\w+|[\w/]+/[\w/]+", content))
    return has_path


# ---------------------------------------------------------------------------
# LoopScript resolution (wrapper with validation output)
# ---------------------------------------------------------------------------

def resolve_loopscript(value: str | None, rigor: str | None) -> tuple[bool, str]:
    """Resolve a loop-script reference. Returns (exists, resolved_path_or_error)."""
    resolved = _resolve_loopscript_base(value, rigor)
    if resolved:
        return True, resolved
    # If no explicit value was set, default to standard/high-rigor based on rigor level.
    # The file may not exist yet (e.g. fresh init) — treat as a non-blocking default.
    filename = value or ("high-rigor.yaml" if rigor in ("high", "critical") else "standard.yaml")
    if not value:
        default_path = f"skills/engineering/loops/{filename}"
        return True, f"{default_path} (auto-resolved, not yet on disk)"
    return False, f"LoopScript '{filename}' not found in {[rel_path(d) for d in LOOPSCRIPT_DIRS]}"


# ---------------------------------------------------------------------------
# Dependency checking
# ---------------------------------------------------------------------------

def check_dependencies(depends_on: list[str]) -> list[str]:
    """Check that all dependencies are completed or reviewed. Returns list of errors."""
    if not depends_on:
        return []

    index = {}
    if INDEX_JSON.exists():
        try:
            data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
            index = data.get("briefings", {})
        except Exception:
            pass

    archive_dir = BRIEFINGS_DIR / ".archive"

    def is_archived(dep_hash: str) -> bool:
        if not archive_dir.exists():
            return False
        for child in archive_dir.iterdir():
            if child.is_dir():
                m = DIR_PATTERN.match(child.name)
                if m and m.group(1) == dep_hash:
                    return True
                for sub in child.rglob("brief.md"):
                    sm = DIR_PATTERN.match(sub.parent.name)
                    if sm and sm.group(1) == dep_hash:
                        return True
        return False

    errors = []
    for dep_hash in depends_on:
        dep = index.get(dep_hash)
        if not dep:
            if is_archived(dep_hash):
                continue
            errors.append(f"Dependency bp:{dep_hash[:6]} not found in index or archive")
            continue
        dep_status = dep.get("status", "")
        if dep_status not in ("completed", "reviewed"):
            slug = dep.get("slug", "?")
            errors.append(
                f"Dependency bp:{dep_hash[:6]} ({slug}) is '{dep_status}' "
                f"(need completed/reviewed)"
            )
    return errors


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_bp(bp_prefix: str) -> dict:
    """Validate a BP for dispatch readiness. Returns structured result."""
    brief_path, bp_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent

    text = brief_path.read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    body = extract_body(text)

    checks = []
    warnings = []

    def check(name: str, passed: bool, msg: str):
        checks.append({"name": name, "passed": passed, "message": msg})

    # 1. Leaf check
    is_leaf = not has_children(bp_dir)
    check(
        "leaf-only",
        is_leaf,
        "BP is a leaf (no child subdirectories)"
        if is_leaf
        else "Cannot dispatch parent BP — dispatch leaf children individually",
    )

    # 2. Status check
    status = fm.get("status", "")
    check(
        "status-ready",
        status == "ready",
        f"Status is '{status}'" + (" (expected: ready)" if status != "ready" else ""),
    )

    # 3. ID format
    bp_id = fm.get("id", "")
    id_valid = bool(re.match(r"^[0-9a-f]{12}$", bp_id))
    check(
        "id-format",
        id_valid,
        f"ID '{bp_id}' is valid 12-char hex" if id_valid else f"ID '{bp_id}' is not a valid 12-char hex string",
    )

    # 4. Mission non-empty (check both 'mission' and 'title' fields)
    mission = fm.get("mission") or fm.get("title") or ""
    check(
        "mission-present",
        bool(mission.strip()),
        f"Mission: \"{mission}\"" if mission.strip() else "Mission/title field is empty",
    )

    # 5. LoopScript resolution (supports both 'loop-script' and 'loopscript')
    # If no explicit value is set, auto-resolve based on rigor (always passes).
    # Only fail if an explicit reference points to a missing file.
    ls_value = fm.get("loop-script") or fm.get("loopscript")
    rigor = fm.get("rigor", "standard")
    ls_exists, ls_msg = resolve_loopscript(ls_value, rigor)
    check(
        "loop-script",
        ls_exists,
        f"LoopScript resolved: {ls_msg}" if ls_exists else ls_msg,
    )

    # 6. MentorScripts (supports both 'mentor-scripts' and 'mentorscripts')
    # Default to global.md if none defined (per CLAUDE.md: @import mentorscripts/global.md)
    ms_list = fm.get("mentor-scripts") or fm.get("mentorscripts") or []
    if isinstance(ms_list, str):
        ms_list = [ms_list]
    if not ms_list:
        default_ms = "mentorscripts/global.md"
        if (REPO_ROOT / default_ms).exists():
            ms_list = [default_ms]
            check("mentor-scripts", True, f"No mentor-scripts defined — defaulting to {default_ms}")
        else:
            check("mentor-scripts", False, "No mentor-scripts defined and default mentorscripts/global.md not found")
    else:
        ms_all_exist = all((REPO_ROOT / ms).exists() for ms in ms_list)
        missing_ms = [ms for ms in ms_list if not (REPO_ROOT / ms).exists()]
        if not ms_all_exist:
            check("mentor-scripts", False, f"Missing mentor-scripts: {missing_ms}")
        else:
            check("mentor-scripts", True, f"All {len(ms_list)} mentor-script(s) exist")

    # 7. AC count >= 1
    ac_count = count_acceptance_criteria(body)
    check(
        "ac-count",
        ac_count >= 1,
        f"{ac_count} acceptance criteria found"
        + ("" if ac_count >= 1 else " (minimum 1 required)"),
    )

    # 8. Goal & Why section
    has_goal = has_goal_content(body)
    check(
        "goal-section",
        has_goal,
        "Goal & Why section has content" if has_goal else "Goal & Why section is empty or missing",
    )

    # 9. Context references
    has_ctx = has_context_references(body)
    check(
        "context-references",
        has_ctx,
        "Context section has file/module references"
        if has_ctx
        else "Context section has no concrete file or module references",
    )
    if not has_ctx:
        # Downgrade to warning — context might be inherited from parent
        checks[-1]["severity"] = "warning"
        warnings.append("Context references missing — may be inherited from parent BP")

    # 10. Dependency check
    depends_on = fm.get("depends-on", [])
    if isinstance(depends_on, str):
        depends_on = [depends_on] if depends_on else []
    dep_errors = check_dependencies(depends_on)
    check(
        "dependencies",
        len(dep_errors) == 0,
        "All dependencies satisfied"
        if not dep_errors
        else "Unmet dependencies:\n    " + "\n    ".join(dep_errors),
    )

    # Summary
    failed = [c for c in checks if not c["passed"] and c.get("severity") != "warning"]
    all_pass = len(failed) == 0

    result = {
        "bp_hash": bp_hash,
        "slug": slug,
        "valid": all_pass,
        "checks": checks,
        "warnings": warnings,
        "summary": {
            "total": len(checks),
            "passed": sum(1 for c in checks if c["passed"]),
            "failed": len(failed),
        },
        "resolved_loopscript": ls_msg if ls_exists else None,
    }
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Validate a BP for dispatch readiness (all 10 checks)",
    )
    parser.add_argument("bp_prefix", help="BP hash or unique prefix")
    parser.add_argument("--json", action="store_true", dest="json_mode",
                       help="JSON output")
    args = parser.parse_args()

    bp_prefix = args.bp_prefix
    json_mode = args.json_mode

    result = validate_bp(bp_prefix)

    if json_mode:
        print(json.dumps(result, indent=2))
    else:
        # Human-readable output
        header = f"Validating bp:{result['bp_hash'][:6]} ({result['slug']})"
        print(header)
        print("-" * len(header))
        for c in result["checks"]:
            icon = "PASS" if c["passed"] else ("WARN" if c.get("severity") == "warning" else "FAIL")
            print(f"  [{icon}] {c['name']}: {c['message']}")
        print()
        if result["valid"]:
            print(f"Result: VALID ({result['summary']['passed']}/{result['summary']['total']} checks passed)")
        else:
            print(f"Result: INVALID ({result['summary']['failed']} check(s) failed)")
        if result["warnings"]:
            print(f"Warnings: {'; '.join(result['warnings'])}")

    sys.exit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
