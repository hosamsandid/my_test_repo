#!/usr/bin/env python3
"""
Deterministic BP status transitions for i-SASE.

Replaces ad-hoc LLM edits with regex-based frontmatter mutations,
strict validation, and optional git commit/push.

Usage:
    python3 scripts/bp-transition.py approve      <bp-hash-prefix>
    python3 scripts/bp-transition.py dispatch     <bp-hash-prefix> [--push]
    python3 scripts/bp-transition.py claim        <bp-hash-prefix> --agent-id <id>
    python3 scripts/bp-transition.py heartbeat    <bp-hash-prefix> --phase <id> [--agent-id <id>]
    python3 scripts/bp-transition.py complete     <bp-hash-prefix>
    python3 scripts/bp-transition.py cancel       <bp-hash-prefix>
    python3 scripts/bp-transition.py release      <bp-hash-prefix> --reason "..."
    python3 scripts/bp-transition.py review       <bp-hash-prefix>
    python3 scripts/bp-transition.py unapprove   <bp-hash-prefix>
    python3 scripts/bp-transition.py reset        <bp-hash-prefix>
    python3 scripts/bp-transition.py revise       <bp-hash-prefix> --reason "..."
    python3 scripts/bp-transition.py confirm-valid <bp-hash-prefix> [--reason "..."]
    python3 scripts/bp-transition.py archive      <bp-hash-prefix> [--push]
    python3 scripts/bp-transition.py restore      <bp-hash-prefix> [--push]
    python3 scripts/bp-transition.py list-archive

Flags:
    --no-commit   Only modify the file, skip git operations
    --no-index    Skip index regeneration
    --push        Push after commit
    --agent-id    Agent ID for claim transition (or ownership check on heartbeat)
    --phase       Phase ID for heartbeat transition
    --reason      Reason string for release transition
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIEFINGS_DIR = REPO_ROOT / "artifacts" / "briefings"
INDEX_JSON = BRIEFINGS_DIR / ".index.json"
DIR_PATTERN = re.compile(r"^([0-9a-f]{12})-(.+)$")


# ---------------------------------------------------------------------------
# Transition definitions
# ---------------------------------------------------------------------------

TRANSITIONS: dict[str, dict] = {
    "approve": {
        "from": ["draft"],
        "to": "ready",
        "set_fields": {},
        "remove_fields": [],
        "commit_msg": "approve(bp:{hash}): quality criteria met",
    },
    "dispatch": {
        "from": ["ready"],
        "to": "dispatched",
        "set_fields": {"agent-id": "__generate__", "claimed": "__now__"},
        "remove_fields": [],
        "commit_msg": "dispatch(bp:{hash}): agent {agent-id} dispatched",
        "leaf_only": True,
        "check_deps": True,
    },
    "claim": {
        "from": ["dispatched"],
        "to": "claimed",
        "set_fields": {},
        "remove_fields": [],
        "commit_msg": "claim(bp:{hash}): {agent-id} starting [agent:{agent-id}]",
        "requires_agent_id": True,
    },
    "heartbeat": {
        "from": ["dispatched", "claimed", "in-progress"],
        "to": "in-progress",
        "set_fields": {"phase": "__phase__", "last-heartbeat": "__now__"},
        "remove_fields": [],
        "commit_msg": "heartbeat(bp:{hash}): phase {phase} [agent:{agent-id}]",
        "requires_phase": True,
        "ownership_check": True,
    },
    "complete": {
        "from": ["dispatched", "claimed", "in-progress"],
        "to": "completed",
        "set_fields": {"completed": "__now__"},
        "remove_fields": [],
        "commit_msg": "complete(bp:{hash}): all ACs met [agent:{agent-id}]",
    },
    "cancel": {
        "from": ["dispatched", "claimed", "in-progress"],
        "to": "ready",
        "set_fields": {},
        "remove_fields": ["agent-id", "claimed", "last-heartbeat", "phase"],
        "commit_msg": "cancel(bp:{hash}): cancelled, status reset to ready",
    },
    "release": {
        "from": ["dispatched", "claimed", "in-progress"],
        "to": "ready",
        "set_fields": {
            "abandoned-date": "__today__",
            "abandoned-reason": "__reason__",
        },
        "remove_fields": ["agent-id", "claimed", "last-heartbeat", "phase"],
        "commit_msg": "release(bp:{hash}): stale lock released",
        "requires_reason": True,
    },
    "review": {
        "from": ["completed"],
        "to": "reviewed",
        "set_fields": {},
        "remove_fields": [],
        "commit_msg": "merge(bp:{hash}): approved by reviewer",
    },
    "unapprove": {
        "from": ["ready"],
        "to": "draft",
        "set_fields": {},
        "remove_fields": [],
        "commit_msg": "revert(bp:{hash}): reverted approval, back to draft",
    },
    "reset": {
        "from": ["completed"],
        "to": "ready",
        "set_fields": {},
        "remove_fields": ["agent-id", "claimed", "completed", "last-heartbeat", "phase"],
        "commit_msg": "reset(bp:{hash}): reset to ready, agent work discarded",
    },
    "revise": {
        "from": ["completed", "reviewed", "stale"],
        "to": "ready",
        "set_fields": {},
        "remove_fields": ["agent-id", "claimed", "completed", "last-heartbeat", "phase", "stale-because"],
        "commit_msg": "revise(bp:{hash}): revision {revision} — {reason}",
        "requires_reason": True,
    },
    "confirm-valid": {
        "from": ["stale"],
        "to": "__previous_status__",
        "set_fields": {},
        "remove_fields": ["stale-because"],
        "commit_msg": "confirm-valid(bp:{hash}): inputs verified despite upstream revision",
    },
}


# ---------------------------------------------------------------------------
# BP lookup
# ---------------------------------------------------------------------------

def find_bp(prefix: str) -> tuple[Path, str, str]:
    """Find a BP by hash prefix. Returns (brief_path, full_hash, slug)."""
    matches = []
    for path in BRIEFINGS_DIR.rglob("brief.md"):
        parent = path.parent
        if ".archive" in parent.parts:
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
        print(f"ERROR: Ambiguous prefix '{prefix}'. Matches:", file=sys.stderr)
        for _, h, s in matches:
            print(f"  {h[:6]} ({s})", file=sys.stderr)
        sys.exit(1)

    return matches[0]


def has_children(bp_dir: Path) -> bool:
    """Check if a BP directory has child BP subdirectories."""
    for child in bp_dir.iterdir():
        if child.is_dir():
            m = DIR_PATTERN.match(child.name)
            if m and (child / "brief.md").exists():
                return True
    return False


# ---------------------------------------------------------------------------
# Frontmatter extraction & mutation
# ---------------------------------------------------------------------------

def extract_frontmatter_bounds(text: str) -> tuple[int, int]:
    """Return (start, end) byte offsets of the frontmatter content (between --- markers)."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        print("ERROR: File does not start with --- frontmatter delimiter", file=sys.stderr)
        sys.exit(1)

    start = len(lines[0]) + 1  # after first ---\n
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            end = start + sum(len(lines[j]) + 1 for j in range(1, i))
            return start, end
    print("ERROR: No closing --- frontmatter delimiter found", file=sys.stderr)
    sys.exit(1)


def get_field(fm_text: str, field: str) -> str | None:
    """Extract a scalar field value from frontmatter text."""
    pattern = re.compile(rf"^{re.escape(field)}:\s*(.+)$", re.MULTILINE)
    m = pattern.search(fm_text)
    if m:
        return m.group(1).strip().strip('"').strip("'")
    return None


def set_field(fm_text: str, field: str, value: str) -> str:
    """Set a scalar field in frontmatter. Adds it if missing, replaces if present."""
    # Quote values that contain spaces or special chars
    if " " in value or ":" in value or '"' in value:
        escaped = value.replace('"', '\\"')
        quoted = f'"{escaped}"'
    else:
        quoted = value

    pattern = re.compile(rf"^{re.escape(field)}:.*$", re.MULTILINE)
    if pattern.search(fm_text):
        return pattern.sub(f"{field}: {quoted}", fm_text)
    else:
        # Add before the last line (which will be empty or content)
        return fm_text.rstrip("\n") + f"\n{field}: {quoted}\n"


def remove_field(fm_text: str, field: str) -> str:
    """Remove a field and any indented continuation lines from frontmatter."""
    pattern = re.compile(rf"^{re.escape(field)}:[^\n]*\n?(?:[ \t]+[^\n]*\n?)*", re.MULTILINE)
    return pattern.sub("", fm_text)


def get_depends_on(fm_text: str) -> list[str]:
    """Extract depends-on list from frontmatter."""
    # Inline format: depends-on: [hash1, hash2]
    inline = re.search(r"^depends-on:\s*\[([^\]]*)\]", fm_text, re.MULTILINE)
    if inline:
        inner = inline.group(1).strip()
        if not inner:
            return []
        return [s.strip().strip('"').strip("'") for s in inner.split(",")]

    # Multi-line format
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


def get_first_stale_because_previous_status(fm_text: str) -> str | None:
    """Return the previous-status field of the first stale-because entry, if any.

    The first entry records the status the BP was in before it was first flagged
    stale. This is the status to restore on confirm-valid.
    """
    # Locate the stale-because: block
    m = re.search(r"^stale-because:\s*$", fm_text, re.MULTILINE)
    if not m:
        return None
    # Walk lines after the marker; first "  - " starts an entry
    after = fm_text[m.end():]
    in_first_entry = False
    for line in after.split("\n"):
        if re.match(r"^  - ", line):
            if in_first_entry:
                # Reached the second entry without finding previous-status
                return None
            in_first_entry = True
            # The first entry might inline the field on the same line
            inline = re.match(r"^  - previous-status:\s*(.+)$", line)
            if inline:
                return inline.group(1).strip().strip('"').strip("'")
            continue
        if not in_first_entry:
            # We haven't entered the first entry yet but hit a non-entry line: bail
            if line.strip() and not line.startswith(" "):
                return None
            continue
        # Inside the first entry — look for previous-status field
        if re.match(r"^    previous-status:\s*", line):
            val = line.split(":", 1)[1].strip().strip('"').strip("'")
            return val
        # Continuation line of first entry must keep 4-space indent
        if line and not line.startswith("    ") and not line.startswith("  - "):
            return None
    return None


def find_direct_dependents(bp_hash: str) -> list[tuple[Path, str, str, str]]:
    """Find all BPs whose depends-on contains bp_hash.

    Scans all active brief.md files (skipping .archive/). Returns a list of
    tuples (brief_path, dep_hash, dep_slug, dep_status).
    """
    results: list[tuple[Path, str, str, str]] = []
    for path in BRIEFINGS_DIR.rglob("brief.md"):
        parent = path.parent
        if ".archive" in parent.parts:
            continue
        m = DIR_PATTERN.match(parent.name)
        if not m:
            continue
        dep_hash, dep_slug = m.group(1), m.group(2)
        if dep_hash == bp_hash:
            continue
        try:
            text = path.read_text(encoding="utf-8")
            fm_start, fm_end = extract_frontmatter_bounds(text)
        except SystemExit:
            continue
        except Exception:
            continue
        fm_text = text[fm_start:fm_end]
        if bp_hash in get_depends_on(fm_text):
            status = get_field(fm_text, "status") or ""
            results.append((path, dep_hash, dep_slug, status))
    return results


def flag_dependent_stale(
    dep_path: Path,
    *,
    source_bp: str,
    source_revision: int,
    revision_reason: str,
    flagged_at: str,
) -> str:
    """Mark a dependent BP as stale and append a stale-because entry.

    If the dependent is already 'stale', its status is left unchanged but a
    new entry is appended (preserving the original previous-status from the
    first existing entry).

    Returns the previous-status that was recorded for this entry — useful for
    reporting (e.g. "B was reviewed -> stale").
    """
    text = dep_path.read_text(encoding="utf-8")
    fm_start, fm_end = extract_frontmatter_bounds(text)
    fm_text = text[fm_start:fm_end]

    current_status = get_field(fm_text, "status") or ""

    if current_status == "stale":
        # Preserve the original previous-status from the first existing entry.
        # Fail fast if it cannot be recovered — silently writing "" would
        # violate the schema enum and break confirm-valid restoration later.
        prev_for_entry = get_first_stale_because_previous_status(fm_text)
        if prev_for_entry not in ("completed", "reviewed"):
            print(
                f"ERROR: Cannot append stale-because entry to bp at {dep_path}\n"
                f"  BP is already 'stale' but previous-status could not be recovered "
                f"from stale-because[0] (got: {prev_for_entry!r}).\n"
                f"  Expected one of: 'completed', 'reviewed'.\n"
                f"  Manual repair of the existing stale-because[0].previous-status field is required.",
                file=sys.stderr,
            )
            sys.exit(1)
    else:
        prev_for_entry = current_status
        fm_text = set_field(fm_text, "status", "stale")

    # Escape double quotes in revision-reason for safe YAML embedding
    safe_reason = revision_reason.replace('"', '\\"')

    entry_block = (
        f"  - source-bp: \"{source_bp}\"\n"
        f"    source-revision: {source_revision}\n"
        f"    revision-reason: \"{safe_reason}\"\n"
        f"    flagged-at: \"{flagged_at}\"\n"
        f"    previous-status: \"{prev_for_entry}\"\n"
    )

    if re.search(r"^stale-because:", fm_text, re.MULTILINE):
        # Append to existing stale-because block
        fm_text = re.sub(
            r"(^stale-because:.*\n(?:[ \t]+[^\n]*\n)*)",
            lambda m: m.group(1) + entry_block,
            fm_text,
            count=1,
            flags=re.MULTILINE,
        )
    else:
        fm_text = fm_text.rstrip("\n") + f"\nstale-because:\n{entry_block}"

    new_text = text[:fm_start] + fm_text + text[fm_end:]
    dep_path.write_text(new_text, encoding="utf-8")
    return prev_for_entry


# ---------------------------------------------------------------------------
# Dependency checking
# ---------------------------------------------------------------------------

def _is_archived(dep_hash: str) -> bool:
    """Check if a BP exists in .archive/ (archived BPs are by definition completed/reviewed)."""
    archive_dir = BRIEFINGS_DIR / ".archive"
    if not archive_dir.exists():
        return False
    for child in archive_dir.iterdir():
        if child.is_dir():
            m = DIR_PATTERN.match(child.name)
            if m and m.group(1) == dep_hash:
                return True
            # Also check nested children inside archived trees
            for sub in child.rglob("brief.md"):
                sm = DIR_PATTERN.match(sub.parent.name)
                if sm and sm.group(1) == dep_hash:
                    return True
    return False


def check_dependencies(depends_on: list[str]) -> list[str]:
    """Check that all dependencies are completed or reviewed. Returns list of errors.

    Archived BPs (in .archive/) are always considered satisfied —
    archiving requires completed/reviewed status as a precondition.
    """
    if not depends_on:
        return []

    # Load index for fast lookup
    index = {}
    if INDEX_JSON.exists():
        try:
            data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
            index = data.get("briefings", {})
        except Exception:
            pass

    errors = []
    for dep_hash in depends_on:
        dep = index.get(dep_hash)
        if not dep:
            # Not in active index — check if it's archived (satisfied by definition)
            if _is_archived(dep_hash):
                continue
            errors.append(f"  Dependency bp:{dep_hash[:6]} not found in index or archive")
            continue
        dep_status = dep.get("status", "")
        if dep_status not in ("completed", "reviewed"):
            slug = dep.get("slug", "?")
            errors.append(
                f"  Dependency bp:{dep_hash[:6]} ({slug}) is '{dep_status}' (need completed/reviewed)"
            )
    return errors


# ---------------------------------------------------------------------------
# Git operations
# ---------------------------------------------------------------------------

def _git_identity_args() -> list[str]:
    """Return git -c args to ensure author identity is set.

    In containers (Docker) git often runs as root with no user config.
    These -c flags override for a single invocation without needing
    a persistent .gitconfig.
    """
    r = subprocess.run(
        ["git", "config", "user.name"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if r.stdout.strip():
        return []  # identity already configured
    return ["-c", "user.name=BP Explorer", "-c", "user.email=bp-explorer@localhost"]


def git_run(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    """Run a git command from repo root."""
    return subprocess.run(
        ["git"] + _git_identity_args() + args,
        capture_output=True, text=True,
        cwd=str(REPO_ROOT),
        check=check,
    )


def git_user() -> str:
    """Get git user.name."""
    r = git_run(["config", "user.name"], check=False)
    return r.stdout.strip() if r.returncode == 0 else "unknown"


# ---------------------------------------------------------------------------
# Index regeneration
# ---------------------------------------------------------------------------

def regenerate_index() -> None:
    """Run build-index.py to regenerate .index.json and INDEX.md."""
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "build-index.py")],
        cwd=str(REPO_ROOT),
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# Main transition logic
# ---------------------------------------------------------------------------

def execute_transition(
    action: str,
    bp_prefix: str,
    *,
    agent_id: str | None = None,
    reason: str | None = None,
    phase: str | None = None,
    no_commit: bool = False,
    no_index: bool = False,
    push: bool = False,
) -> None:
    tdef = TRANSITIONS[action]

    # 1. Find BP
    brief_path, bp_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent

    # 2. Read file
    text = brief_path.read_text(encoding="utf-8")
    fm_start, fm_end = extract_frontmatter_bounds(text)
    fm_text = text[fm_start:fm_end]

    # 3. Validate current status
    current_status = get_field(fm_text, "status")
    if current_status not in tdef["from"]:
        expected = " or ".join(tdef["from"])
        print(
            f"ERROR: Cannot {action} bp:{bp_hash[:6]} ({slug})\n"
            f"  Current status: {current_status} (expected: {expected})",
            file=sys.stderr,
        )
        sys.exit(1)

    # 4. Leaf-only check
    if tdef.get("leaf_only") and has_children(bp_dir):
        print(
            f"ERROR: Cannot dispatch bp:{bp_hash[:6]} ({slug})\n"
            f"  This is a parent BP with children. Dispatch its leaf children individually.",
            file=sys.stderr,
        )
        sys.exit(1)

    # 5. Dependency check
    if tdef.get("check_deps"):
        depends_on = get_depends_on(fm_text)
        dep_errors = check_dependencies(depends_on)
        if dep_errors:
            print(
                f"ERROR: Cannot dispatch bp:{bp_hash[:6]} ({slug})\n"
                f"  Unmet dependencies:\n" + "\n".join(dep_errors),
                file=sys.stderr,
            )
            sys.exit(1)

    # 6. Requires agent-id
    if tdef.get("requires_agent_id") and not agent_id:
        print(f"ERROR: --agent-id is required for '{action}'", file=sys.stderr)
        sys.exit(1)

    # 6b. Requires phase
    if tdef.get("requires_phase") and not phase:
        print(f"ERROR: --phase is required for '{action}'", file=sys.stderr)
        sys.exit(1)

    # 6c. Ownership check (heartbeat: refuse if --agent-id mismatches stored owner)
    if tdef.get("ownership_check") and agent_id:
        stored = get_field(fm_text, "agent-id")
        if stored and stored != agent_id:
            print(
                f"ERROR: Cannot {action} bp:{bp_hash[:6]} ({slug})\n"
                f"  Ownership mismatch: BP is owned by agent {stored}, "
                f"but --agent-id is {agent_id}",
                file=sys.stderr,
            )
            sys.exit(1)

    # 7. Requires reason
    if tdef.get("requires_reason") and not reason:
        reason = f"released by {git_user()}"

    # 8. Generate values
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    today_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if action == "dispatch" and not agent_id:
        result = subprocess.run(
            ["openssl", "rand", "-hex", "4"],
            capture_output=True, text=True,
        )
        agent_id = result.stdout.strip()

    # For complete/review, read existing agent-id from frontmatter
    existing_agent_id = get_field(fm_text, "agent-id")
    if not agent_id and existing_agent_id:
        agent_id = existing_agent_id

    # 9. Apply mutations
    new_fm = fm_text

    # Resolve target status (may be a sentinel for confirm-valid)
    target_status = tdef["to"]
    if target_status == "__previous_status__":
        resolved = get_first_stale_because_previous_status(fm_text)
        if not resolved or resolved not in ("completed", "reviewed"):
            print(
                f"ERROR: Cannot {action} bp:{bp_hash[:6]} ({slug})\n"
                f"  stale-because[0].previous-status is missing or invalid: '{resolved}'",
                file=sys.stderr,
            )
            sys.exit(1)
        target_status = resolved

    # Set status
    new_fm = set_field(new_fm, "status", target_status)

    # Set additional fields
    for field, value in tdef["set_fields"].items():
        if value == "__generate__":
            new_fm = set_field(new_fm, field, agent_id)
        elif value == "__now__":
            new_fm = set_field(new_fm, field, now_iso)
        elif value == "__today__":
            new_fm = set_field(new_fm, field, today_iso)
        elif value == "__reason__":
            new_fm = set_field(new_fm, field, reason)
        elif value == "__phase__":
            new_fm = set_field(new_fm, field, phase)
        else:
            new_fm = set_field(new_fm, field, value)

    # Remove fields
    for field in tdef["remove_fields"]:
        new_fm = remove_field(new_fm, field)

    # --- Custom post-processing for 'revise' transition ---
    if action == "revise":
        # Read current revision (default to 1 if absent)
        current_revision_str = get_field(fm_text, "revision")
        current_revision = int(current_revision_str) if current_revision_str else 1

        safe_reason = (reason or "").replace('"', '\\"')

        # Append revision-log entry capturing the prior cycle
        log_line = (
            f"  - rev: {current_revision}\n"
            f"    date: \"{today_iso}\"\n"
            f"    agent-id: \"{existing_agent_id or ''}\"\n"
            f"    mrp: \"\"\n"
            f"    vcr: \"\"\n"
            f"    outcome: \"revised\"\n"
            f"    revision-reason: \"{safe_reason}\"\n"
        )

        if re.search(r"^revision-log:", new_fm, re.MULTILINE):
            new_fm = re.sub(
                r"(^revision-log:.*\n(?:[ \t]+[^\n]*\n)*)",
                lambda m: m.group(1) + log_line,
                new_fm,
                flags=re.MULTILINE,
            )
        else:
            new_fm = new_fm.rstrip("\n") + f"\nrevision-log:\n{log_line}"

        # Increment revision
        new_revision = current_revision + 1
        new_fm = set_field(new_fm, "revision", str(new_revision))

    # --- Custom post-processing for 'confirm-valid' transition ---
    elif action == "confirm-valid":
        current_revision_str = get_field(fm_text, "revision")
        current_revision = int(current_revision_str) if current_revision_str else 1
        safe_note = (reason or "").replace('"', '\\"')

        log_line = (
            f"  - rev: {current_revision}\n"
            f"    date: \"{today_iso}\"\n"
            f"    agent-id: \"{existing_agent_id or ''}\"\n"
            f"    mrp: \"\"\n"
            f"    vcr: \"\"\n"
            f"    outcome: \"confirmed-valid\"\n"
            f"    revision-reason: \"{safe_note}\"\n"
        )

        if re.search(r"^revision-log:", new_fm, re.MULTILINE):
            new_fm = re.sub(
                r"(^revision-log:.*\n(?:[ \t]+[^\n]*\n)*)",
                lambda m: m.group(1) + log_line,
                new_fm,
                flags=re.MULTILINE,
            )
        else:
            new_fm = new_fm.rstrip("\n") + f"\nrevision-log:\n{log_line}"

    # 10. Write back
    new_text = text[:fm_start] + new_fm + text[fm_end:]
    brief_path.write_text(new_text, encoding="utf-8")

    # --- Cascade flagging: on revise, mark direct dependents as stale ---
    # Always initialised so commit staging works for non-revise actions.
    flagged_dependents: list[tuple[Path, str, str, str]] = []
    if action == "revise":
        # Re-derive new_revision (already incremented in fm above, but we want the value)
        pre_revision_str = get_field(fm_text, "revision")
        pre_revision = int(pre_revision_str) if pre_revision_str else 1
        upstream_revision = pre_revision + 1

        for dep_path, dep_hash, dep_slug, dep_status in find_direct_dependents(bp_hash):
            # Only flag dependents whose work could be invalidated by the upstream change.
            # draft/ready/dispatched/claimed/in-progress are out of scope (deferred per design).
            if dep_status not in ("completed", "reviewed", "stale"):
                continue
            prev_recorded = flag_dependent_stale(
                dep_path,
                source_bp=bp_hash,
                source_revision=upstream_revision,
                revision_reason=reason or "",
                flagged_at=now_iso,
            )
            flagged_dependents.append((dep_path, dep_hash, dep_slug, prev_recorded))

    # 11. Output
    print(f"bp:{bp_hash[:6]} ({slug}): {current_status} -> {target_status}")
    if agent_id and "agent-id" in tdef["set_fields"]:
        print(f"  agent-id: {agent_id}")
    if "claimed" in tdef["set_fields"]:
        print(f"  claimed: {now_iso}")
    if "completed" in tdef["set_fields"]:
        print(f"  completed: {now_iso}")
    if reason and "abandoned-reason" in tdef["set_fields"]:
        print(f"  reason: {reason}")
    if agent_id and "agent-id" in tdef["remove_fields"]:
        print(f"  removed-agent-id: {agent_id}")
    if action == "revise":
        current_revision_str = get_field(fm_text, "revision")
        old_rev = int(current_revision_str) if current_revision_str else 1
        print(f"  revision: {old_rev} -> {old_rev + 1}")
        print(f"  reason: {reason}")
        if flagged_dependents:
            print(f"  cascade: flagged {len(flagged_dependents)} direct dependent(s) as stale:")
            for _, dh, ds, prev in flagged_dependents:
                arrow = f"{prev} -> stale" if prev else "stale (already)"
                print(f"    bp:{dh[:6]} ({ds})  {arrow}")
        else:
            print("  cascade: no direct dependents in completed/reviewed/stale to flag")
    if action == "confirm-valid":
        print(f"  restored: status -> {target_status}")
        print(f"  cleared: stale-because")
    if action == "heartbeat":
        print(f"  phase: {phase}")
        print(f"  last-heartbeat: {now_iso}")

    # 12. Index regeneration
    if not no_index:
        regenerate_index()
        print("  index: regenerated")

    # 13. Git operations
    if not no_commit:
        # Build commit message
        format_kwargs: dict[str, str] = {
            "hash": bp_hash[:6],
            "agent-id": agent_id or "",
        }
        # Add revise-specific placeholders
        if action == "revise":
            current_revision_str = get_field(fm_text, "revision")
            format_kwargs["revision"] = str(
                (int(current_revision_str) if current_revision_str else 1) + 1
            )
            format_kwargs["reason"] = reason or ""
        if action == "heartbeat":
            format_kwargs["phase"] = phase or ""
        commit_msg = tdef["commit_msg"].format(**format_kwargs)

        # Stage files
        rel_brief = str(brief_path.relative_to(REPO_ROOT))
        git_run(["add", rel_brief])

        # Stage cascade-flagged dependent brief.md files (revise only)
        for dep_path, _, _, _ in flagged_dependents:
            rel_dep = str(dep_path.relative_to(REPO_ROOT))
            git_run(["add", rel_dep])

        if not no_index:
            git_run(["add", str(INDEX_JSON.relative_to(REPO_ROOT))])

        git_run(["commit", "-m", commit_msg])
        print(f"  committed: {commit_msg}")

        if push:
            r = git_run(["push"], check=False)
            if r.returncode == 0:
                print("  pushed: yes")
            else:
                stderr = r.stderr.strip()
                if "No configured push destination" in stderr or "does not appear to be a git repository" in stderr or "Could not read from remote" in stderr:
                    print(f"  WARNING: no remote repository configured, skipping push")
                else:
                    print(f"  WARNING: push failed (exit {r.returncode}): {stderr}")


# ---------------------------------------------------------------------------
# Archive (separate from TRANSITIONS — filesystem move, not frontmatter edit)
# ---------------------------------------------------------------------------

def _collect_all_bps(bp_dir: Path) -> list[tuple[Path, str, str]]:
    """Collect the BP and all child BPs recursively under bp_dir.

    bp_dir itself must match DIR_PATTERN (it's the root BP directory).
    All brief.md files found under bp_dir are included.
    """
    results = []
    for path in bp_dir.rglob("brief.md"):
        parent = path.parent
        # For the root BP, parent == bp_dir; for children, parent is a sub-dir.
        # In both cases the directory name matches DIR_PATTERN.
        m = DIR_PATTERN.match(parent.name)
        if m:
            results.append((path, m.group(1), m.group(2)))
    return results


def execute_archive(
    bp_prefix: str,
    *,
    no_commit: bool = False,
    no_index: bool = False,
    push: bool = False,
) -> None:
    """Archive a reviewed/completed BP tree by moving it to .archive/."""
    # 1. Find BP
    brief_path, bp_hash, slug = find_bp(bp_prefix)
    bp_dir = brief_path.parent

    # 2. Walk up to the root BP if this is a child
    # (archiving always operates on the topmost BP in the tree)
    root_dir = bp_dir
    while True:
        parent_dir = root_dir.parent
        if parent_dir == BRIEFINGS_DIR:
            break
        m = DIR_PATTERN.match(parent_dir.name)
        if m and (parent_dir / "brief.md").exists():
            root_dir = parent_dir
        else:
            break

    root_match = DIR_PATTERN.match(root_dir.name)
    if not root_match:
        print(f"ERROR: Cannot determine root BP directory for bp:{bp_hash[:6]}", file=sys.stderr)
        sys.exit(1)
    root_hash, root_slug = root_match.group(1), root_match.group(2)

    # 3. Validate: all BPs in tree must be reviewed or completed
    incomplete = []
    all_bps = _collect_all_bps(root_dir)
    if not all_bps:
        # At minimum the root BP itself
        all_bps = [(root_dir / "brief.md", root_hash, root_slug)]

    for bp_path, h, s in all_bps:
        text = bp_path.read_text(encoding="utf-8")
        fm_start, fm_end = extract_frontmatter_bounds(text)
        fm_text = text[fm_start:fm_end]
        status = get_field(fm_text, "status")
        # Parent BPs may not have an explicit status (derived) — skip them
        if has_children(bp_path.parent):
            continue
        if status not in ("completed", "reviewed"):
            incomplete.append((h, s, status))

    if incomplete:
        print(f"ERROR: Cannot archive bp:{root_hash[:6]} ({root_slug})", file=sys.stderr)
        print("  The following leaf BPs are not completed/reviewed:", file=sys.stderr)
        for h, s, st in incomplete:
            print(f"    bp:{h[:6]} ({s}): {st}", file=sys.stderr)
        sys.exit(1)

    # 4. Move to .archive/
    archive_dir = BRIEFINGS_DIR / ".archive"
    archive_dir.mkdir(exist_ok=True)
    dest = archive_dir / root_dir.name
    if dest.exists():
        print(f"ERROR: Archive destination already exists: {dest.relative_to(REPO_ROOT)}", file=sys.stderr)
        sys.exit(1)

    shutil.move(str(root_dir), str(dest))
    bp_count = len(all_bps)
    print(f"Archived bp:{root_hash[:6]} ({root_slug}). {bp_count} BP(s) moved to .archive/.")

    # 5. Index regeneration
    if not no_index:
        regenerate_index()
        print("  index: regenerated")

    # 6. Git operations
    if not no_commit:
        commit_msg = f"archive(bp:{root_hash[:6]}): archived completed tree"

        # Stage the removal from briefings/ and addition to .archive/
        git_run(["add", "-A", str(BRIEFINGS_DIR.relative_to(REPO_ROOT))])
        git_run(["commit", "-m", commit_msg])
        print(f"  committed: {commit_msg}")

        if push:
            r = git_run(["push"], check=False)
            if r.returncode == 0:
                print("  pushed: yes")
            else:
                stderr = r.stderr.strip()
                if "No configured push destination" in stderr or "does not appear to be a git repository" in stderr or "Could not read from remote" in stderr:
                    print(f"  WARNING: no remote repository configured, skipping push")
                else:
                    print(f"  WARNING: push failed (exit {r.returncode}): {stderr}")


def execute_restore(
    bp_prefix: str,
    *,
    no_commit: bool = False,
    no_index: bool = False,
    push: bool = False,
) -> None:
    """Restore a BP tree from .archive/ back to active briefings."""
    archive_dir = BRIEFINGS_DIR / ".archive"
    if not archive_dir.exists():
        print("ERROR: No .archive/ directory found", file=sys.stderr)
        sys.exit(1)

    # Find BP in archive
    matches = []
    for child in archive_dir.iterdir():
        if not child.is_dir():
            continue
        m = DIR_PATTERN.match(child.name)
        if m and m.group(1).startswith(bp_prefix):
            matches.append((child, m.group(1), m.group(2)))

    if not matches:
        print(f"ERROR: No archived BP found matching prefix '{bp_prefix}'", file=sys.stderr)
        sys.exit(1)
    if len(matches) > 1:
        print(f"ERROR: Ambiguous prefix '{bp_prefix}'. Matches:", file=sys.stderr)
        for _, h, s in matches:
            print(f"  {h[:6]} ({s})", file=sys.stderr)
        sys.exit(1)

    src_dir, bp_hash, slug = matches[0]
    dest = BRIEFINGS_DIR / src_dir.name
    if dest.exists():
        print(f"ERROR: Destination already exists: {dest.relative_to(REPO_ROOT)}", file=sys.stderr)
        sys.exit(1)

    shutil.move(str(src_dir), str(dest))
    print(f"Restored bp:{bp_hash[:6]} ({slug}) from .archive/ to active briefings.")

    # Index regeneration
    if not no_index:
        regenerate_index()
        print("  index: regenerated")

    # Git operations
    if not no_commit:
        commit_msg = f"restore(bp:{bp_hash[:6]}): restored from archive"
        git_run(["add", "-A", str(BRIEFINGS_DIR.relative_to(REPO_ROOT))])
        git_run(["commit", "-m", commit_msg])
        print(f"  committed: {commit_msg}")

        if push:
            r = git_run(["push"], check=False)
            if r.returncode == 0:
                print("  pushed: yes")
            else:
                stderr = r.stderr.strip()
                if "No configured push destination" in stderr or "does not appear to be a git repository" in stderr or "Could not read from remote" in stderr:
                    print(f"  WARNING: no remote repository configured, skipping push")
                else:
                    print(f"  WARNING: push failed (exit {r.returncode}): {stderr}")


def execute_list_archive() -> None:
    """List all archived BP trees."""
    archive_dir = BRIEFINGS_DIR / ".archive"
    if not archive_dir.exists() or not any(archive_dir.iterdir()):
        print("No archived BPs found.")
        return

    print("ARCHIVED BPs")
    print("------------")
    for child in sorted(archive_dir.iterdir()):
        if not child.is_dir():
            continue
        m = DIR_PATTERN.match(child.name)
        if not m:
            continue
        bp_hash, slug = m.group(1), m.group(2)
        # Try to read title from brief.md
        brief = child / "brief.md"
        title = ""
        if brief.exists():
            text = brief.read_text(encoding="utf-8")
            lines = text.split("\n")
            if lines and lines[0].strip() == "---":
                try:
                    fm_start, fm_end = extract_frontmatter_bounds(text)
                    title = get_field(text[fm_start:fm_end], "mission") or ""
                except SystemExit:
                    print(f"  WARN: malformed frontmatter in {brief}", file=sys.stderr)
        # Count children
        child_count = sum(
            1 for p in child.rglob("brief.md") if p != brief
        )
        parts = [f"bp:{bp_hash[:6]} ({slug})"]
        if title:
            parts.append(f'"{title}"')
        if child_count:
            parts.append(f"[{child_count} children]")
        print("  " + "  ".join(parts))
        print(f"    -> /archive --restore {bp_hash[:6]}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    all_actions = list(TRANSITIONS.keys()) + ["archive", "restore", "list-archive"]

    parser = argparse.ArgumentParser(
        description="Deterministic BP status transitions for i-SASE",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "action",
        choices=all_actions,
        help="Transition to execute",
    )
    parser.add_argument(
        "bp_prefix",
        nargs="?",
        default="",
        help="BP hash or unique prefix (not required for list-archive)",
    )
    parser.add_argument("--agent-id", help="Agent ID (required for claim; ownership check on heartbeat)")
    parser.add_argument("--phase", help="Phase ID (required for heartbeat)")
    parser.add_argument("--reason", help="Reason string (for release)")
    parser.add_argument("--no-commit", action="store_true", help="Skip git commit")
    parser.add_argument("--no-index", action="store_true", help="Skip index regeneration")
    parser.add_argument("--push", action="store_true", help="Push after commit")

    args = parser.parse_args()

    if args.action == "list-archive":
        execute_list_archive()
    elif args.action == "archive":
        if not args.bp_prefix:
            parser.error("bp_prefix is required for archive")
        execute_archive(
            args.bp_prefix,
            no_commit=args.no_commit,
            no_index=args.no_index,
            push=args.push,
        )
    elif args.action == "restore":
        if not args.bp_prefix:
            parser.error("bp_prefix is required for restore")
        execute_restore(
            args.bp_prefix,
            no_commit=args.no_commit,
            no_index=args.no_index,
            push=args.push,
        )
    else:
        if not args.bp_prefix:
            parser.error("bp_prefix is required")
        execute_transition(
            args.action,
            args.bp_prefix,
            agent_id=args.agent_id,
            reason=args.reason,
            phase=args.phase,
            no_commit=args.no_commit,
            no_index=args.no_index,
            push=args.push,
        )


if __name__ == "__main__":
    main()
