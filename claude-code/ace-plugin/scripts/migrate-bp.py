#!/usr/bin/env python3
"""
Deterministic BP migration for i-SASE.

Applies schema migrations to existing BriefingPacks:
  - remove-tier: Remove deprecated 'tier' field from frontmatter
  - extract-artifacts: Extract input/output artifacts from ACs and context

Usage:
    python3 scripts/migrate-bp.py                        # Dry run (all migrations)
    python3 scripts/migrate-bp.py --apply                # Apply all migrations
    python3 scripts/migrate-bp.py --apply a3f7c2         # Apply to specific BP
    python3 scripts/migrate-bp.py --migration remove-tier  # Only run tier removal
    python3 scripts/migrate-bp.py --migration extract-artifacts  # Only extract artifacts

Exit codes:
    0  No changes needed (or applied successfully)
    1  Changes pending (dry run found candidates)
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    REPO_ROOT, BRIEFINGS_DIR, DIR_PATTERN,
    extract_frontmatter_bounds_safe as extract_frontmatter_bounds,
    get_field, has_field, remove_field as remove_field_line,
    has_children, extract_body, find_all_bps, regenerate_index,
)


# ---------------------------------------------------------------------------
# Migration: remove-tier
# ---------------------------------------------------------------------------

def migrate_remove_tier(
    bps: list[tuple[Path, str, str]],
    apply: bool = False,
) -> list[dict]:
    """Remove deprecated 'tier' field from BP frontmatter."""
    changes = []
    for path, bp_hash, slug in bps:
        text = path.read_text(encoding="utf-8")
        bounds = extract_frontmatter_bounds(text)
        if not bounds:
            continue
        fm_start, fm_end = bounds
        fm_text = text[fm_start:fm_end]

        if not has_field(fm_text, "tier"):
            continue

        tier_value = get_field(fm_text, "tier") or "unknown"
        change = {
            "bp_hash": bp_hash,
            "slug": slug,
            "migration": "remove-tier",
            "detail": f"Removing: tier: {tier_value}",
        }

        if apply:
            new_fm = remove_field_line(fm_text, "tier")
            new_text = text[:fm_start] + new_fm + text[fm_end:]
            path.write_text(new_text, encoding="utf-8")
            change["applied"] = True

        changes.append(change)

    return changes


# ---------------------------------------------------------------------------
# Migration: extract-artifacts
# ---------------------------------------------------------------------------

# Patterns for output references in ACs
OUTPUT_PATTERNS = [
    # "Output: `filename` in `directory/`"
    re.compile(r"Output:\s*`([^`]+)`\s+in\s+`([^`]+)`", re.IGNORECASE),
    # "produce `path/file`" / "generate `path/file`" / "create `path/file`"
    re.compile(r"(?:produce|generate|create|write|emit)\s+`([^`]+)`", re.IGNORECASE),
]

# Patterns for input references
INPUT_PATTERNS = [
    # "`path/file`" preceded by "read", "input", "source", "consume"
    re.compile(r"(?:read|input|source|consume|load|parse)\s+`([^`]+)`", re.IGNORECASE),
]

# General backtick path pattern (file-like references)
FILE_REF_PATTERN = re.compile(r"`([\w./-]+\.\w+)`")


def extract_artifacts_from_body(body: str) -> list[dict]:
    """Extract artifact declarations from BP body content."""
    artifacts = []
    seen_paths = set()

    # Parse sections
    sections = {}
    current_section = ""
    for line in body.split("\n"):
        heading_match = re.match(r"^##\s+(.+)$", line)
        if heading_match:
            current_section = heading_match.group(1).strip().lower()
            sections[current_section] = []
        elif current_section:
            sections.setdefault(current_section, []).append(line)

    # Extract outputs from Acceptance Criteria
    ac_section = ""
    for key in sections:
        if "acceptance" in key or key == "ac":
            ac_section = "\n".join(sections[key])
            break

    if ac_section:
        # Find individual ACs
        ac_items = re.split(r"(?=^\s*-\s*\[\s*[ xX]?\s*\])", ac_section, flags=re.MULTILINE)
        for ac_idx, ac_text in enumerate(ac_items):
            if not ac_text.strip():
                continue
            ac_num = ac_idx  # 0-based, adjusted below

            # Try output patterns
            for pattern in OUTPUT_PATTERNS:
                for match in pattern.finditer(ac_text):
                    groups = match.groups()
                    if len(groups) == 2:
                        # "Output: `file` in `dir/`"
                        filename, directory = groups
                        path = f"{directory.rstrip('/')}/{filename}"
                    else:
                        path = groups[0]

                    if path not in seen_paths:
                        seen_paths.add(path)
                        artifacts.append({
                            "path": path,
                            "direction": "output",
                            "ac": f"AC-{ac_num}",
                        })

    # Extract inputs from Context / Input Artifacts sections
    for key in sections:
        if "context" in key or "input" in key:
            section_text = "\n".join(sections[key])
            # Remove comments
            section_text = re.sub(r"<!--.*?-->", "", section_text, flags=re.DOTALL)

            for pattern in INPUT_PATTERNS:
                for match in pattern.finditer(section_text):
                    path = match.group(1)
                    if path not in seen_paths:
                        seen_paths.add(path)
                        artifacts.append({
                            "path": path,
                            "direction": "input",
                        })

    return artifacts


def migrate_extract_artifacts(
    bps: list[tuple[Path, str, str]],
    apply: bool = False,
) -> list[dict]:
    """Extract and add artifacts field to leaf BPs."""
    changes = []

    for path, bp_hash, slug in bps:
        bp_dir = path.parent

        # Skip parent BPs
        if has_children(bp_dir):
            continue

        text = path.read_text(encoding="utf-8")
        bounds = extract_frontmatter_bounds(text)
        if not bounds:
            continue
        fm_start, fm_end = bounds
        fm_text = text[fm_start:fm_end]

        # Skip if already has artifacts field
        if has_field(fm_text, "artifacts"):
            continue

        body = extract_body(text)
        artifacts = extract_artifacts_from_body(body)

        if not artifacts:
            changes.append({
                "bp_hash": bp_hash,
                "slug": slug,
                "migration": "extract-artifacts",
                "detail": "No artifacts detected — manual review recommended",
                "artifact_count": 0,
            })
            continue

        detail_lines = []
        for a in artifacts:
            ac_ref = f"  ({a['ac']})" if a.get("ac") else ""
            detail_lines.append(
                f"  {a['direction'].upper():6s}  {a['path']}{ac_ref}"
            )

        change = {
            "bp_hash": bp_hash,
            "slug": slug,
            "migration": "extract-artifacts",
            "detail": "\n".join(detail_lines),
            "artifact_count": len(artifacts),
        }

        if apply:
            # Build YAML artifacts block
            yaml_lines = ["artifacts:"]
            for a in artifacts:
                yaml_lines.append(f"  - path: \"{a['path']}\"")
                yaml_lines.append(f"    direction: {a['direction']}")
                if a.get("ac"):
                    yaml_lines.append(f"    ac: {a['ac']}")
            artifacts_yaml = "\n".join(yaml_lines) + "\n"

            # Insert before closing frontmatter
            new_fm = fm_text.rstrip("\n") + "\n" + artifacts_yaml
            new_text = text[:fm_start] + new_fm + text[fm_end:]
            path.write_text(new_text, encoding="utf-8")
            change["applied"] = True

        changes.append(change)

    return changes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

MIGRATIONS = {
    "remove-tier": migrate_remove_tier,
    "extract-artifacts": migrate_extract_artifacts,
}


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Deterministic BP migration for i-SASE",
    )
    parser.add_argument("bp_prefix", nargs="?", help="BP hash prefix (optional, for single-BP migration)")
    parser.add_argument("--apply", action="store_true", help="Apply migrations (default: dry run)")
    parser.add_argument("--migration", choices=list(MIGRATIONS.keys()),
                       help="Run only a specific migration")
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--extract-from-stdin", action="store_true",
                       help="Read brief.md content from stdin, extract artifacts, output JSON")

    args = parser.parse_args()

    # Standalone artifact extraction mode
    if args.extract_from_stdin:
        content = sys.stdin.read()
        body = extract_body(content)
        artifacts = extract_artifacts_from_body(body)
        print(json.dumps(artifacts, indent=2))
        sys.exit(0)

    # Find BPs
    bps = find_all_bps(args.bp_prefix)
    if not bps:
        if args.bp_prefix:
            print(f"No BPs found matching prefix '{args.bp_prefix}'", file=sys.stderr)
        else:
            print("No BPs found", file=sys.stderr)
        sys.exit(0)

    # Determine which migrations to run
    if args.migration:
        migrations_to_run = {args.migration: MIGRATIONS[args.migration]}
    else:
        migrations_to_run = MIGRATIONS

    all_changes = []
    for name, func in migrations_to_run.items():
        changes = func(bps, apply=args.apply)
        all_changes.extend(changes)

    if args.json:
        print(json.dumps({
            "mode": "apply" if args.apply else "dry-run",
            "total_bps_scanned": len(bps),
            "changes": all_changes,
            "changes_count": len([c for c in all_changes if c.get("artifact_count", 1) > 0]),
        }, indent=2))
    else:
        mode = "APPLY" if args.apply else "DRY RUN"
        print(f"BP Migration ({mode})")
        print(f"{'=' * (16 + len(mode))}")
        print(f"Scanned: {len(bps)} BPs")
        print()

        if not all_changes:
            print("All BPs are up to date. No migrations needed.")
        else:
            for change in all_changes:
                print(f"bp:{change['bp_hash'][:6]} ({change['slug']})")
                print(f"  [{change['migration']}] {change['detail']}")
                if change.get("applied"):
                    print(f"  -> Applied")
                print()

            applied = [c for c in all_changes if c.get("applied")]
            pending = [c for c in all_changes if not c.get("applied") and c.get("artifact_count", 1) > 0]

            if args.apply:
                print(f"Applied: {len(applied)} change(s)")
                # Regenerate index
                subprocess.run(
                    [sys.executable, str(REPO_ROOT / "scripts" / "build-index.py")],
                    cwd=str(REPO_ROOT), capture_output=True,
                )
                print("Index: regenerated")
                print("\nChanges are unstaged. Review with `git diff`, then commit when ready.")
            else:
                print(f"Pending: {len(pending)} change(s)")
                if pending:
                    print("\nRun with --apply to write changes.")

    has_pending = any(
        not c.get("applied") and c.get("artifact_count", 1) > 0
        for c in all_changes
    )
    sys.exit(1 if has_pending and not args.apply else 0)


if __name__ == "__main__":
    main()
