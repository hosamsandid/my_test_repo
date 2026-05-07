#!/usr/bin/env python3
"""
Agent Execution Environment entrypoint.

Runs inside a Podman container. Loads dispatch context (brief.md,
LoopScript, MentorScripts), builds the agent prompt, and invokes the
Claude Code CLI.

Usage (called by container ENTRYPOINT, not directly):
    python3 agent-entrypoint.py --agent-id <id> --bp-hash <hash> --mode bind

Exit codes:
    0    Agent completed successfully
    1    Setup or execution error
    124  Graceful SIGTERM shutdown (partial work committed)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
from pathlib import Path

# ---------------------------------------------------------------------------
# Path constants (inside container)
# ---------------------------------------------------------------------------

REPO_DIR = Path("/repo")
ACE_DIR = Path("/opt/ace")
SCRIPTS_DIR = ACE_DIR / "scripts"
SKILLS_DIR = ACE_DIR / "skills"
MENTORSCRIPTS_DIR = ACE_DIR / "mentorscripts"
CLAUDE_MD = ACE_DIR / "CLAUDE.md"

# Import sase_lib from container scripts path
sys.path.insert(0, str(SCRIPTS_DIR))

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_shutdown = threading.Event()
_git_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Workspace verification
# ---------------------------------------------------------------------------

def verify_workspace(mode: str) -> None:
    """Verify the workspace is ready for the given execution mode."""
    if mode == "bind":
        if not REPO_DIR.exists():
            print("ERROR: /repo not found. Bind-mount the worktree.", file=sys.stderr)
            sys.exit(1)
        git_marker = REPO_DIR / ".git"
        # In a worktree, .git is a file (not a directory) containing a gitdir pointer
        if not git_marker.exists():
            print("ERROR: /repo is not a git repository.", file=sys.stderr)
            sys.exit(1)
    elif mode == "clone":
        # Clone mode: workspace is set up by git clone (handled separately)
        pass
    elif mode == "image":
        # Image mode: repo is baked into the image, just verify
        if not REPO_DIR.exists():
            print("ERROR: /repo not found in image.", file=sys.stderr)
            sys.exit(1)


def configure_git_identity(agent_id: str) -> None:
    """Set git user.name and user.email inside the container.

    Uses --global because worktree .git is a file pointing to the parent
    repo's worktree metadata, which may not be accessible inside the container.
    """
    subprocess.run(
        ["git", "config", "--global", "user.name", f"agent-{agent_id}"],
        check=True, capture_output=True, text=True,
    )
    subprocess.run(
        ["git", "config", "--global", "user.email", f"agent-{agent_id}@ace.local"],
        check=True, capture_output=True, text=True,
    )


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def _git_run(
    args: list[str],
    check: bool = True,
    cwd: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a git command in the repo directory."""
    return subprocess.run(
        ["git"] + args,
        capture_output=True, text=True,
        cwd=cwd or str(REPO_DIR),
        check=check,
    )


# ---------------------------------------------------------------------------
# Context loading
# ---------------------------------------------------------------------------

DIR_PATTERN = re.compile(r"^([0-9a-f]{12})-(.+)$")


def _find_brief(bp_hash: str) -> Path | None:
    """Find brief.md by BP hash in the repo's artifacts/briefings tree."""
    briefings_dir = REPO_DIR / "artifacts" / "briefings"
    if not briefings_dir.exists():
        return None
    for candidate in briefings_dir.rglob("*/brief.md"):
        if ".archive" in candidate.parts:
            continue
        if bp_hash in candidate.parent.name:
            return candidate
    return None


def _parse_frontmatter(text: str) -> dict:
    """Minimal frontmatter parser (scalar fields only, sufficient for context loading)."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}
    result = {}
    current_key = None
    current_list = None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # List item
        if stripped.startswith("- ") and current_key:
            if current_list is None:
                current_list = []
            current_list.append(stripped[2:].strip())
            result[current_key] = current_list
            continue
        # Key: value
        m = re.match(r"^(\S[\w-]*)\s*:\s*(.*)", line)
        if m:
            if current_key and current_list is not None:
                result[current_key] = current_list
            current_key = m.group(1)
            val = m.group(2).strip().strip('"').strip("'")
            current_list = None
            if val:
                result[current_key] = val
            else:
                current_list = []
    if current_key and current_list is not None:
        result[current_key] = current_list
    return result


def load_context(bp_hash: str) -> dict:
    """Load dispatch context: brief.md, LoopScript, MentorScripts.

    Returns dict with keys: brief_path, brief_text, frontmatter,
    loopscript_content, mentorscript_contents, mission.
    """
    brief_path = _find_brief(bp_hash)
    if not brief_path:
        print(f"ERROR: brief.md not found for bp:{bp_hash[:6]}", file=sys.stderr)
        sys.exit(1)

    brief_text = brief_path.read_text(encoding="utf-8")
    fm = _parse_frontmatter(brief_text)

    # Resolve LoopScript
    loopscript_content = ""
    ls_ref = fm.get("loop-script") or fm.get("loopscript")
    rigor = fm.get("rigor", "standard")
    ls_path = _resolve_loopscript(ls_ref, rigor)
    if ls_path and ls_path.exists():
        loopscript_content = ls_path.read_text(encoding="utf-8")

    # Resolve MentorScripts
    ms_refs = fm.get("mentor-scripts") or fm.get("mentorscripts") or []
    if isinstance(ms_refs, str):
        ms_refs = [ms_refs]
    if not ms_refs:
        ms_refs = ["mentorscripts/global.md"]

    mentorscript_contents = {}
    for ref in ms_refs:
        # Check bind-mounted mentorscripts, then repo path
        for base in [MENTORSCRIPTS_DIR, REPO_DIR]:
            path = base / ref if not ref.startswith("/") else Path(ref)
            if path.exists():
                mentorscript_contents[ref] = path.read_text(encoding="utf-8")
                break

    return {
        "brief_path": str(brief_path),
        "brief_text": brief_text,
        "frontmatter": fm,
        "loopscript_content": loopscript_content,
        "mentorscript_contents": mentorscript_contents,
        "mission": fm.get("mission") or fm.get("title", ""),
    }


def _resolve_loopscript(value: str | None, rigor: str | None) -> Path | None:
    """Resolve LoopScript path. Checks skills dir, then repo."""
    if not value:
        filename = (
            "high-rigor.yaml" if rigor in ("high", "critical")
            else "standard.yaml"
        )
    else:
        # Try as relative path from repo
        full = REPO_DIR / value
        if full.exists():
            return full
        filename = value

    # Search: bind-mounted skills, then repo-local
    search_dirs = [
        SKILLS_DIR / "ale" / "loops",
        REPO_DIR / "skills" / "ale" / "loops",
    ]
    for d in search_dirs:
        candidate = d / filename
        if candidate.exists():
            return candidate
    return None


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

def build_agent_prompt(context: dict, agent_id: str, bp_hash: str) -> tuple[str, str]:
    """Build system prompt and user prompt from loaded context.

    Returns (system_prompt, user_prompt).
    """
    system_parts: list[str] = []

    # CLAUDE.md
    if CLAUDE_MD.exists():
        system_parts.append(
            f"# Project Instructions (CLAUDE.md)\n\n"
            f"{CLAUDE_MD.read_text(encoding='utf-8')}"
        )

    # LoopScript
    if context["loopscript_content"]:
        system_parts.append(
            f"# LoopScript (execution protocol)\n\n"
            f"{context['loopscript_content']}"
        )

    # MentorScripts
    for ref, content in context["mentorscript_contents"].items():
        system_parts.append(
            f"# MentorScript: {ref}\n\n{content}"
        )

    system_prompt = "\n\n---\n\n".join(system_parts) if system_parts else ""

    # User prompt: the briefing content
    user_prompt = (
        f"You are agent {agent_id} dispatched to work on bp:{bp_hash[:6]}.\n\n"
        f"## Briefing\n\n{context['brief_text']}\n\n"
        f"Begin working on this briefing pack. Follow the LoopScript phases "
        f"and commit your work regularly."
    )

    return system_prompt, user_prompt


# ---------------------------------------------------------------------------
# Agent execution
# ---------------------------------------------------------------------------

def run_agent(system_prompt: str, user_prompt: str) -> int:
    """Invoke Claude Code CLI and return its exit code."""
    # Write system prompt to a temp file (avoids shell quoting issues)
    sys_prompt_path = REPO_DIR / ".agent-system-prompt.md"
    sys_prompt_path.write_text(system_prompt, encoding="utf-8")

    cmd = [
        "claude",
        "--print",
        "--system-prompt", str(sys_prompt_path),
        "--allowedTools",
        "Bash(*) Write(*) Edit(*) Read(*) Glob(*) Grep(*) Agent(*)",
    ]

    # Pass API key check (supports both direct API key and Azure Foundry)
    has_key = (
        os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("ANTHROPIC_FOUNDRY_API_KEY")
    )
    if not has_key:
        print("ERROR: No API key set. Need ANTHROPIC_API_KEY or ANTHROPIC_FOUNDRY_API_KEY.",
              file=sys.stderr)
        sys.exit(1)

    proc = subprocess.run(
        cmd,
        input=user_prompt,
        text=True,
        cwd=str(REPO_DIR),
        timeout=None,  # Podman --stop-timeout handles the deadline
    )

    # Clean up temp file
    sys_prompt_path.unlink(missing_ok=True)

    return proc.returncode


# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------

def _handle_sigterm(signum: int, frame) -> None:
    """SIGTERM handler: commit partial work and exit."""
    print("\n[agent] SIGTERM received, committing partial work...", file=sys.stderr)
    _shutdown.set()

    with _git_lock:
        try:
            _git_run(["add", "-A"])
            _git_run(
                ["commit", "-m",
                 f"interrupted(bp:{_args.bp_hash[:6]}): SIGTERM "
                 f"[agent:{_args.agent_id}]"],
                check=False,
            )
            _git_run(["push", "origin", "HEAD"], check=False)
        except Exception as exc:
            print(f"[agent] shutdown commit failed: {exc}", file=sys.stderr)

    sys.exit(124)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

_args = argparse.Namespace()  # populated in main(), used by signal handler


def main() -> None:
    global _args

    parser = argparse.ArgumentParser(
        description="Agent Execution Environment entrypoint",
    )
    parser.add_argument("--agent-id", required=True, help="8-char hex agent ID")
    parser.add_argument("--bp-hash", required=True, help="12-char hex BP hash")
    parser.add_argument(
        "--mode", choices=("bind", "clone", "image"), default="bind",
        help="Execution tier (default: bind)",
    )
    parser.add_argument("--repo-url", default=None, help="Git remote URL (clone mode)")
    parser.add_argument("--branch", default=None, help="Git branch name")

    _args = parser.parse_args()
    args = _args

    if not args.branch:
        args.branch = f"agent/{args.agent_id}/{args.bp_hash}"

    # Install signal handler
    signal.signal(signal.SIGTERM, _handle_sigterm)

    print(f"[agent] Starting: agent={args.agent_id} bp={args.bp_hash[:6]} mode={args.mode}",
          file=sys.stderr)

    # Step 1: Verify workspace
    verify_workspace(args.mode)

    if args.mode == "clone" and args.repo_url:
        print(f"[agent] Cloning {args.repo_url} branch {args.branch}...", file=sys.stderr)
        subprocess.run(
            ["git", "clone", "--depth=1", "--branch", args.branch,
             args.repo_url, str(REPO_DIR)],
            check=True,
        )

    # Step 2: Configure git identity
    configure_git_identity(args.agent_id)

    # Step 3: Load context
    context = load_context(args.bp_hash)
    print(f"[agent] Loaded context: mission={context['mission'][:80]}",
          file=sys.stderr)

    # Step 4: Build prompt
    system_prompt, user_prompt = build_agent_prompt(context, args.agent_id, args.bp_hash)

    # Step 5: Run agent
    print(f"[agent] Invoking Claude Code CLI...", file=sys.stderr)
    exit_code = run_agent(system_prompt, user_prompt)

    # Step 6: Final commit and push
    _shutdown.set()

    with _git_lock:
        _git_run(["add", "-A"], check=False)
        r = _git_run(
            ["commit", "-m",
             f"agent-complete(bp:{args.bp_hash[:6]}): exit={exit_code} "
             f"[agent:{args.agent_id}]"],
            check=False,
        )
        _git_run(["push", "origin", "HEAD"], check=False)

    print(f"[agent] Done: exit_code={exit_code}", file=sys.stderr)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
