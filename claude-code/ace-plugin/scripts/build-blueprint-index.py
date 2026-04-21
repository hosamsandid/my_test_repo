#!/usr/bin/env python3
"""
Build the Blueprint index for i-SASE.

Scans artifacts/blueprints/ and produces:
  - artifacts/blueprints/.index.json  (machine-readable flat dict)

Uses only stdlib. No external dependencies.

Usage:
    python3 scripts/build-blueprint-index.py
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
BLUEPRINTS_DIR = REPO_ROOT / "artifacts" / "blueprints"
INDEX_JSON = BLUEPRINTS_DIR / ".index.json"

DIR_PATTERN = re.compile(r"^([0-9a-f]{12})-(.+)$")

# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import parse_frontmatter


# ---------------------------------------------------------------------------
# Scanner
# ---------------------------------------------------------------------------


def find_blueprint_dirs(root: Path) -> list[Path]:
    """Find all directories containing blueprint.md."""
    bp_dirs = []
    if not root.exists():
        return bp_dirs
    for path in root.rglob("blueprint.md"):
        parent = path.parent
        if DIR_PATTERN.match(parent.name):
            bp_dirs.append(parent)
    return sorted(bp_dirs)


def determine_parent(bp_dir: Path, blueprints_root: Path) -> str | None:
    """Determine parent Blueprint hash from directory nesting."""
    parent_dir = bp_dir.parent
    if parent_dir == blueprints_root:
        return None
    m = DIR_PATTERN.match(parent_dir.name)
    if m:
        return m.group(1)
    return None


def determine_children(bp_dir: Path) -> list[str]:
    """Find child Blueprint hashes from immediate subdirectories."""
    children = []
    if not bp_dir.is_dir():
        return children
    for child in sorted(bp_dir.iterdir()):
        if child.is_dir():
            m = DIR_PATTERN.match(child.name)
            if m and (child / "blueprint.md").exists():
                children.append(m.group(1))
    return children


# ---------------------------------------------------------------------------
# Index builder
# ---------------------------------------------------------------------------


def build_index() -> dict:
    """Build the full Blueprint index dict."""
    if not BLUEPRINTS_DIR.exists():
        return {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "blueprints": {},
        }

    bp_dirs = find_blueprint_dirs(BLUEPRINTS_DIR)
    blueprints = {}

    for bp_dir in bp_dirs:
        m = DIR_PATTERN.match(bp_dir.name)
        if not m:
            continue
        bp_hash, slug = m.group(1), m.group(2)

        blueprint_file = bp_dir / "blueprint.md"
        if not blueprint_file.exists():
            continue

        text = blueprint_file.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)

        rel_path = str(bp_dir.relative_to(BLUEPRINTS_DIR))

        # Parse parameters — may be structured list or simple list
        parameters = fm.get("parameters", [])
        param_summary = []
        if isinstance(parameters, list):
            for p in parameters:
                if isinstance(p, dict):
                    param_summary.append(
                        {
                            "name": p.get("name", ""),
                            "type": p.get("type", "string"),
                            "required": p.get("required", "true"),
                        }
                    )

        entry = {
            "slug": slug,
            "title": fm.get("title", ""),
            "version": fm.get("version", "1.0.0"),
            "abstraction-level": fm.get("abstraction-level", ""),
            "description": fm.get("description", ""),
            "tags": fm.get("tags", []),
            "parameters": param_summary,
            "parent": determine_parent(bp_dir, BLUEPRINTS_DIR),
            "children": determine_children(bp_dir),
            "execution-order": fm.get("execution-order", []),
            "provenance": fm.get("provenance", {}),
            "instantiation-count": int(fm.get("instantiation-count", "0")),
            "created": fm.get("created", ""),
            "author": fm.get("author", []),
            "path": rel_path,
        }

        blueprints[bp_hash] = entry

    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "blueprints": blueprints,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    index = build_index()
    blueprints = index["blueprints"]

    BLUEPRINTS_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_JSON.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"Indexed {len(blueprints)} blueprint(s)")


if __name__ == "__main__":
    main()
