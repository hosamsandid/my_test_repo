#!/usr/bin/env python3
"""
Deterministic BP scaffolding for i-SASE.

Creates BP directories, generates hashes, derives slugs, and writes
brief.md from the template — replacing manual LLM-driven file creation.

Usage:
    python3 scripts/create-bp.py --mission "Add retry logic" [--rigor standard]
    python3 scripts/create-bp.py --mission "DB migration" --parent a3f7c2e1b9d4
    python3 scripts/create-bp.py --mission "Auth endpoints" --parent a3f7c2e1b9d4 --depends-on d7e8f9a1b2c3
    python3 scripts/create-bp.py --from-stdin             # Read full brief.md content from stdin

Outputs the created BP hash, slug, and file path as JSON.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import REPO_ROOT, BRIEFINGS_DIR, DIR_PATTERN, regenerate_index

TEMPLATE_PATH = REPO_ROOT / "skills" / "briefing-eng" / "templates" / "briefing-pack.md"


# ---------------------------------------------------------------------------
# Slug generation
# ---------------------------------------------------------------------------

def derive_slug(mission: str) -> str:
    """Derive a slug from mission title: lowercase, hyphens, max 4 words."""
    # Remove special characters, keep letters, numbers, spaces
    clean = re.sub(r"[^a-zA-Z0-9\s-]", "", mission)
    # Split into words, take first 4
    words = clean.lower().split()[:4]
    slug = "-".join(words)
    # Ensure no double hyphens or trailing hyphens
    slug = re.sub(r"-+", "-", slug).strip("-")
    # Schema pattern requires at least 2 chars: ^[a-z0-9][a-z0-9-]*[a-z0-9]$
    if len(slug) < 2:
        slug = slug + "-bp" if slug else "untitled"
    return slug


# ---------------------------------------------------------------------------
# Hash generation
# ---------------------------------------------------------------------------

def generate_hash() -> str:
    """Generate a 12-char hex hash via openssl."""
    result = subprocess.run(
        ["openssl", "rand", "-hex", "6"],
        capture_output=True, text=True,
    )
    return result.stdout.strip()


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------

def render_template(
    bp_hash: str,
    slug: str,
    mission: str,
    rigor: str = "standard",
    depends_on: list[str] | None = None,
    author: str | None = None,
    loopscript: str | None = None,
) -> str:
    """Render a brief.md from the template with filled-in values."""
    if TEMPLATE_PATH.exists():
        template = TEMPLATE_PATH.read_text(encoding="utf-8")
    else:
        # Fallback minimal template
        template = """---
schema: sase/briefing-pack/v3
id: "{{HASH-12}}"
slug: "{{SLUG}}"
mission: "{{MISSION-TITLE}}"
created: "{{YYYY-MM-DD}}"
author: ["{{AUTHOR}}"]
status: draft
rigor: "{{standard|high|critical}}"
depends-on: []
execution-order: []
loop-script: "skills/engineering/loops/standard.yaml"
mentor-scripts:
  - "mentorscripts/global.md"
reviewers: []
approver: ""
---

# Mission: {{TITLE}}

## Goal & Why

{{GOAL_DESCRIPTION}}

## Acceptance Criteria

- [ ] {{AC-1}}
- [ ] {{AC-2}}

## Context

- Files: {{FILE_PATHS}}

## Constraints

{{CONSTRAINTS_DESCRIPTION}}

## Approach

{{APPROACH_DESCRIPTION}}

## Gotchas

- {{GOTCHA-1}}

## Escalation Triggers

- When making security-relevant decisions -> create CRP
"""

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if not author:
        r = subprocess.run(
            ["git", "config", "user.name"],
            capture_output=True, text=True,
            cwd=str(REPO_ROOT),
        )
        author = r.stdout.strip() if r.returncode == 0 else "unknown"

    # Determine loopscript
    if not loopscript:
        loopscript = (
            "skills/engineering/loops/high-rigor.yaml"
            if rigor in ("high", "critical")
            else "skills/engineering/loops/standard.yaml"
        )

    # Apply substitutions
    result = template
    result = re.sub(r'\{\{HASH-12\}\}', bp_hash, result)
    result = re.sub(r'\{\{SLUG\}\}', slug, result)
    result = re.sub(r'\{\{MISSION-TITLE\}\}', mission, result)
    result = re.sub(r'\{\{TITLE\}\}', mission, result)
    result = re.sub(r'\{\{YYYY-MM-DD\}\}', today, result)
    result = re.sub(r'\{\{AUTHOR\}\}', author, result)
    result = re.sub(r'"?\{\{standard\|high\|critical\}\}"?', rigor, result)

    # Set loopscript
    result = re.sub(
        r'loop-script:.*',
        f'loop-script: "{loopscript}"',
        result,
    )

    # Set depends-on
    if depends_on:
        deps_yaml = "[" + ", ".join(f'"{d}"' for d in depends_on) + "]"
        result = re.sub(r'depends-on:.*', f'depends-on: {deps_yaml}', result)

    return result


# ---------------------------------------------------------------------------
# BP creation
# ---------------------------------------------------------------------------

def create_bp(
    mission: str,
    rigor: str = "standard",
    parent_prefix: str | None = None,
    depends_on: list[str] | None = None,
    content: str | None = None,
    no_commit: bool = False,
) -> dict:
    """Create a BP directory and brief.md. Returns result dict."""

    bp_hash = generate_hash()
    slug = derive_slug(mission)

    # Determine parent directory
    if parent_prefix:
        # Find parent BP directory
        parent_dir = None
        for path in BRIEFINGS_DIR.rglob("brief.md"):
            parent = path.parent
            if ".archive" in parent.parts:
                continue
            m = DIR_PATTERN.match(parent.name)
            if m and m.group(1).startswith(parent_prefix):
                parent_dir = parent
                break
        if not parent_dir:
            print(f"ERROR: Parent BP not found for prefix '{parent_prefix}'",
                  file=sys.stderr)
            sys.exit(2)
        base_dir = parent_dir
    else:
        base_dir = BRIEFINGS_DIR

    # Create directory
    bp_dir = base_dir / f"{bp_hash}-{slug}"
    bp_dir.mkdir(parents=True, exist_ok=True)
    brief_path = bp_dir / "brief.md"

    # Write content
    if content:
        brief_path.write_text(content, encoding="utf-8")
    else:
        rendered = render_template(
            bp_hash, slug, mission,
            rigor=rigor,
            depends_on=depends_on,
        )
        brief_path.write_text(rendered, encoding="utf-8")

    rel_path = str(brief_path.relative_to(REPO_ROOT))

    result = {
        "bp_hash": bp_hash,
        "slug": slug,
        "directory": str(bp_dir.relative_to(REPO_ROOT)),
        "brief_path": rel_path,
        "parent": parent_prefix,
    }

    # Git operations
    if not no_commit:
        subprocess.run(
            ["git", "add", rel_path],
            cwd=str(REPO_ROOT), capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", f"draft(bp:{bp_hash[:6]}): create briefing pack"],
            cwd=str(REPO_ROOT), capture_output=True,
        )
        result["committed"] = True

        # Regenerate index
        regenerate_index()

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Deterministic BP scaffolding for i-SASE",
    )
    parser.add_argument("--mission", help="Mission title")
    parser.add_argument("--rigor", default="standard",
                       choices=["standard", "high", "critical"])
    parser.add_argument("--parent", help="Parent BP hash prefix (for child BPs)")
    parser.add_argument("--depends-on", nargs="*", help="Dependency BP hashes")
    parser.add_argument("--from-stdin", action="store_true",
                       help="Read full brief.md content from stdin")
    parser.add_argument("--no-commit", action="store_true",
                       help="Skip git commit")

    args = parser.parse_args()

    if args.from_stdin:
        content = sys.stdin.read()
        # Extract mission from content frontmatter
        mission_match = re.search(r'^mission:\s*"?(.+?)"?\s*$', content, re.MULTILINE)
        title_match = re.search(r'^title:\s*"?(.+?)"?\s*$', content, re.MULTILINE)
        mission = (
            (mission_match.group(1) if mission_match else None)
            or (title_match.group(1) if title_match else None)
            or "untitled"
        )
        result = create_bp(
            mission=mission,
            rigor=args.rigor,
            parent_prefix=args.parent,
            depends_on=args.depends_on,
            content=content,
            no_commit=args.no_commit,
        )
    elif args.mission:
        result = create_bp(
            mission=args.mission,
            rigor=args.rigor,
            parent_prefix=args.parent,
            depends_on=args.depends_on,
            no_commit=args.no_commit,
        )
    else:
        parser.error("Either --mission or --from-stdin is required")
        return

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
