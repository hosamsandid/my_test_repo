"""
Shared library for i-SASE scripts.

Centralizes frontmatter parsing, BP lookup, git operations, and common
utilities used across all scripts. Import from any script via:

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from sase_lib import parse_frontmatter, find_bp, git_run, ...
"""
from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIEFINGS_DIR = REPO_ROOT / "artifacts" / "briefings"
GUIDANCE_DIR = REPO_ROOT / "artifacts" / "guidance"
CRP_DIR = GUIDANCE_DIR / "crp"
MRP_DIR = GUIDANCE_DIR / "mrp"
VCR_DIR = GUIDANCE_DIR / "vcr"
INDEX_JSON = BRIEFINGS_DIR / ".index.json"

BLUEPRINTS_DIR = REPO_ROOT / "artifacts" / "blueprints"
BLUEPRINT_INDEX_JSON = BLUEPRINTS_DIR / ".index.json"

DIR_PATTERN = re.compile(r"^([0-9a-f]{12})-(.+)$")

LOOPSCRIPT_DIRS = [
    REPO_ROOT / "skills" / "ale" / "loops",
    REPO_ROOT / "skills" / "ale" / "templates",
]


def rel_path(p: Path) -> str:
    """Return path relative to REPO_ROOT, falling back to absolute path."""
    try:
        return str(p.relative_to(REPO_ROOT))
    except ValueError:
        return str(p)


# ---------------------------------------------------------------------------
# Frontmatter parsing — full version (handles structured lists, artifacts)
# ---------------------------------------------------------------------------

def parse_frontmatter(text: str) -> dict:
    """Parse YAML frontmatter between --- markers.

    Handles scalars, inline lists, multi-line lists, and structured list
    items (e.g. artifacts with nested key: value pairs).
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}

    fm_lines = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        fm_lines.append(line)
    else:
        return {}  # no closing --- found

    result = {}
    current_key = None
    current_list = None
    in_structured_list = False
    current_obj = None

    for line in fm_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # Structured list item: "  - key: value"
        if re.match(r"^  - \w+:", line):
            if current_key and current_list is not None:
                if not in_structured_list:
                    in_structured_list = True
                if current_obj is not None:
                    current_list.append(current_obj)
                current_obj = {}
                item_stripped = line.strip().lstrip("- ").strip()
                if ":" in item_stripped:
                    k = item_stripped[:item_stripped.index(":")].strip()
                    v = item_stripped[item_stripped.index(":") + 1:].strip().strip('"').strip("'")
                    current_obj[k] = v
            continue

        # Structured list field continuation: "    key: value"
        if in_structured_list and current_obj is not None and re.match(r"^    \w+:", line):
            item_stripped = line.strip()
            if ":" in item_stripped:
                k = item_stripped[:item_stripped.index(":")].strip()
                v = item_stripped[item_stripped.index(":") + 1:].strip().strip('"').strip("'")
                current_obj[k] = v
            continue

        # Close structured list if we hit a non-continuation line
        if in_structured_list:
            if current_obj is not None:
                current_list.append(current_obj)
                current_obj = None
            result[current_key] = current_list
            in_structured_list = False
            current_list = None

        # Simple list continuation: "  - item"
        if line.startswith("  - ") or line.startswith("  -\t") or line.startswith("    - "):
            if current_key and current_list is not None:
                item = line.strip().lstrip("- ").strip()
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

            if not value:
                current_key = key
                current_list = []
                result[key] = current_list
                continue

            if value.startswith("[") and value.endswith("]"):
                inner = value[1:-1].strip()
                items = [] if not inner else [
                    s.strip().strip('"').strip("'") for s in inner.split(",")
                ]
                result[key] = items
                current_key = key
                current_list = items
                continue

            value = value.strip('"').strip("'")
            result[key] = value
            current_key = key
            current_list = None

    if in_structured_list and current_obj is not None:
        current_list.append(current_obj)
        result[current_key] = current_list

    return result


def extract_frontmatter_bounds(text: str) -> tuple[int, int]:
    """Return (start, end) byte offsets of frontmatter content (between --- markers).

    Raises SystemExit if no valid frontmatter found.
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        print("ERROR: File does not start with --- frontmatter delimiter", file=sys.stderr)
        sys.exit(1)

    start = len(lines[0]) + 1
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            end = start + sum(len(lines[j]) + 1 for j in range(1, i))
            return start, end
    print("ERROR: No closing --- frontmatter delimiter found", file=sys.stderr)
    sys.exit(1)


def extract_frontmatter_bounds_safe(text: str) -> tuple[int, int] | None:
    """Like extract_frontmatter_bounds but returns None instead of exiting."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None
    start = len(lines[0]) + 1
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            end = start + sum(len(lines[j]) + 1 for j in range(1, i))
            return start, end
    return None


def get_field(fm_text: str, field: str) -> str | None:
    """Extract a scalar field value from frontmatter text."""
    pattern = re.compile(rf"^{re.escape(field)}:\s*(.+)$", re.MULTILINE)
    m = pattern.search(fm_text)
    if m:
        return m.group(1).strip().strip('"').strip("'")
    return None


def set_field(fm_text: str, field: str, value: str) -> str:
    """Set a scalar field in frontmatter. Adds if missing, replaces if present."""
    if " " in value or ":" in value or '"' in value:
        escaped = value.replace('"', '\\"')
        quoted = f'"{escaped}"'
    else:
        quoted = value

    pattern = re.compile(rf"^{re.escape(field)}:.*$", re.MULTILINE)
    if pattern.search(fm_text):
        return pattern.sub(f"{field}: {quoted}", fm_text)
    else:
        return fm_text.rstrip("\n") + f"\n{field}: {quoted}\n"


def remove_field(fm_text: str, field: str) -> str:
    """Remove a scalar field line from frontmatter."""
    pattern = re.compile(rf"^{re.escape(field)}:.*\n?", re.MULTILINE)
    return pattern.sub("", fm_text)


def has_field(fm_text: str, field: str) -> bool:
    """Check if a field exists in frontmatter text."""
    pattern = re.compile(rf"^{re.escape(field)}:", re.MULTILINE)
    return bool(pattern.search(fm_text))


def extract_body(text: str) -> str:
    """Extract markdown body (everything after the second ---)."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return text
    fence_count = 0
    for i, line in enumerate(lines):
        if line.strip() == "---":
            fence_count += 1
            if fence_count == 2:
                return "\n".join(lines[i + 1:])
    return ""


def get_depends_on(fm_text: str) -> list[str]:
    """Extract depends-on list from frontmatter."""
    inline = re.search(r"^depends-on:\s*\[([^\]]*)\]", fm_text, re.MULTILINE)
    if inline:
        inner = inline.group(1).strip()
        if not inner:
            return []
        return [s.strip().strip('"').strip("'") for s in inner.split(",")]

    result = []
    in_list = False
    for line in fm_text.split("\n"):
        if re.match(r"^depends-on:\s*$", line):
            in_list = True
            continue
        if in_list:
            if re.match(r"^\s+-\s+", line):
                val = line.strip().lstrip("- ").strip().strip('"').strip("'")
                result.append(val)
            else:
                break
    return result


# ---------------------------------------------------------------------------
# BP lookup
# ---------------------------------------------------------------------------

def find_bp(
    prefix: str,
    include_archive: bool = False,
) -> tuple[Path, str, str]:
    """Find a BP by hash prefix. Returns (brief_path, full_hash, slug).

    Exits with code 1 if not found, code 2 if ambiguous.
    """
    matches = []
    for path in BRIEFINGS_DIR.rglob("brief.md"):
        parent = path.parent
        if not include_archive and ".archive" in parent.parts:
            continue
        m = DIR_PATTERN.match(parent.name)
        if m:
            bp_hash, slug = m.group(1), m.group(2)
            if bp_hash.startswith(prefix):
                matches.append((path, bp_hash, slug))

    if not matches:
        print(f"ERROR: No BP found matching prefix '{prefix}'", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        # Deduplicate by hash
        seen = set()
        unique = []
        for p, h, s in matches:
            if h not in seen:
                seen.add(h)
                unique.append((p, h, s))
        matches = unique
        if len(matches) > 1:
            print(f"ERROR: Ambiguous prefix '{prefix}'. Matches:", file=sys.stderr)
            for _, h, s in matches:
                print(f"  {h[:6]} ({s})", file=sys.stderr)
            sys.exit(2)

    return matches[0]


def has_children(bp_dir: Path) -> bool:
    """Check if a BP directory has child BP subdirectories."""
    for child in bp_dir.iterdir():
        if child.is_dir():
            m = DIR_PATTERN.match(child.name)
            if m and (child / "brief.md").exists():
                return True
    return False


def find_all_bps(prefix: str | None = None) -> list[tuple[Path, str, str]]:
    """Find all BPs, optionally filtered by hash prefix. Excludes archive."""
    results = []
    for path in BRIEFINGS_DIR.rglob("brief.md"):
        parent = path.parent
        if ".archive" in parent.parts:
            continue
        m = DIR_PATTERN.match(parent.name)
        if m:
            bp_hash, slug = m.group(1), m.group(2)
            if prefix and not bp_hash.startswith(prefix):
                continue
            results.append((path, bp_hash, slug))
    return sorted(results, key=lambda x: x[1])


# ---------------------------------------------------------------------------
# Blueprint lookup
# ---------------------------------------------------------------------------


def find_blueprint(prefix: str) -> tuple[Path, str, str]:
    """Find a Blueprint by hash prefix. Returns (blueprint_path, full_hash, slug).

    Exits with code 1 if not found, code 2 if ambiguous.
    """
    matches = []
    for path in BLUEPRINTS_DIR.rglob("blueprint.md"):
        parent = path.parent
        m = DIR_PATTERN.match(parent.name)
        if m:
            bp_hash, slug = m.group(1), m.group(2)
            if bp_hash.startswith(prefix):
                matches.append((path, bp_hash, slug))

    if not matches:
        print(f"ERROR: No Blueprint found matching prefix '{prefix}'", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        seen = set()
        unique = []
        for p, h, s in matches:
            if h not in seen:
                seen.add(h)
                unique.append((p, h, s))
        matches = unique
        if len(matches) > 1:
            print(f"ERROR: Ambiguous prefix '{prefix}'. Matches:", file=sys.stderr)
            for _, h, s in matches:
                print(f"  {h[:6]} ({s})", file=sys.stderr)
            sys.exit(2)

    return matches[0]


def find_all_blueprints(
    prefix: str | None = None,
) -> list[tuple[Path, str, str]]:
    """Find all Blueprints, optionally filtered by hash prefix."""
    results = []
    if not BLUEPRINTS_DIR.exists():
        return results
    for path in BLUEPRINTS_DIR.rglob("blueprint.md"):
        parent = path.parent
        m = DIR_PATTERN.match(parent.name)
        if m:
            bp_hash, slug = m.group(1), m.group(2)
            if prefix and not bp_hash.startswith(prefix):
                continue
            results.append((path, bp_hash, slug))
    return sorted(results, key=lambda x: x[1])


# ---------------------------------------------------------------------------
# Git operations
# ---------------------------------------------------------------------------

def git_run(
    args: list[str],
    check: bool = True,
    cwd: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a git command from repo root (or specified cwd)."""
    return subprocess.run(
        ["git"] + args,
        capture_output=True, text=True,
        cwd=cwd or str(REPO_ROOT),
        check=check,
    )


def git_user() -> str:
    """Get git user.name."""
    r = git_run(["config", "user.name"], check=False)
    return r.stdout.strip() if r.returncode == 0 else "unknown"


# ---------------------------------------------------------------------------
# Agent naming conventions
# ---------------------------------------------------------------------------

def agent_branch_name(agent_id: str, bp_hash: str) -> str:
    """Construct agent branch name: agent/{agent-id}/{bp-hash}."""
    return f"agent/{agent_id}/{bp_hash}"


def agent_worktree_path(agent_id: str, bp_hash: str) -> Path:
    """Construct agent worktree path: .worktrees/{agent-id}-{bp-hash}."""
    return REPO_ROOT / ".worktrees" / f"{agent_id}-{bp_hash}"


# ---------------------------------------------------------------------------
# LoopScript resolution
# ---------------------------------------------------------------------------

def resolve_loopscript(value: str | None, rigor: str | None) -> str | None:
    """Resolve loopscript path based on value and rigor. Returns path or None."""
    if not value:
        filename = (
            "high-rigor.yaml" if rigor in ("high", "critical")
            else "standard.yaml"
        )
    else:
        full_path = REPO_ROOT / value
        if full_path.exists():
            return str(value)
        filename = value

    for search_dir in LOOPSCRIPT_DIRS:
        candidate = search_dir / filename
        if candidate.exists():
            return rel_path(candidate)
    return None


# ---------------------------------------------------------------------------
# Time utilities
# ---------------------------------------------------------------------------

def parse_iso_datetime(s: str | None) -> datetime | None:
    """Parse an ISO 8601 datetime string."""
    if not s:
        return None
    try:
        s = s.strip().strip('"').strip("'")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def minutes_ago(dt: datetime | None) -> float | None:
    """Calculate minutes since a given datetime."""
    if not dt:
        return None
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = now - dt
    return delta.total_seconds() / 60


def format_age(dt: datetime | None) -> str:
    """Format a datetime as a human-readable age string."""
    mins = minutes_ago(dt)
    if mins is None:
        return "unknown"
    if mins < 60:
        return f"{int(mins)}m ago"
    hours = mins / 60
    if hours < 24:
        return f"{int(hours)}h {int(mins % 60)}m ago"
    days = hours / 24
    return f"{int(days)}d ago"


def now_iso() -> str:
    """Current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today_iso() -> str:
    """Current UTC date as ISO 8601 string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Index operations
# ---------------------------------------------------------------------------

def regenerate_index() -> None:
    """Run build-index.py to regenerate .index.json."""
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "build-index.py")],
        cwd=str(REPO_ROOT),
        capture_output=True,
    )


def _index_is_stale() -> bool:
    """Check if any brief.md is newer than .index.json."""
    if not INDEX_JSON.exists():
        return True
    index_mtime = INDEX_JSON.stat().st_mtime
    for brief in BRIEFINGS_DIR.rglob("brief.md"):
        if ".archive" in brief.parts:
            continue
        if brief.stat().st_mtime > index_mtime:
            return True
    return False


def load_index(auto_rebuild: bool = True) -> dict:
    """Load the BP index from .index.json.

    When *auto_rebuild* is True (default), regenerates the index first
    if any brief.md file is newer than .index.json.
    """
    if auto_rebuild and _index_is_stale():
        regenerate_index()
    if not INDEX_JSON.exists():
        return {}
    try:
        import json
        data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
        return data.get("briefings", {})
    except Exception:
        return {}
