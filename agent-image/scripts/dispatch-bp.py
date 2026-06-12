#!/usr/bin/env python3
"""
Unified dispatch orchestrator for container-based AEE.

Replaces the 6-step LLM-orchestrated CLI flow and the 4-step subprocess
pipeline in server.py with a single deterministic script.

Phase A (all modes): validate BP, transition to dispatched, resolve info.
Phase B (mode-specific): create worktree or start container.

Usage:
    python3 scripts/dispatch-bp.py <bp-hash-prefix> --execution-mode worktree --push --json
    python3 scripts/dispatch-bp.py <bp-hash-prefix> --dry-run --json
    python3 scripts/dispatch-bp.py <bp-hash-prefix> --execution-mode container-bind --push --json

Exit codes:
    0  Dispatch succeeded
    1  Validation or transition failed
    2  BP not found or usage error
    3  Phase B failure (rollback attempted)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

EXECUTION_MODES = ("worktree", "container-bind", "container-clone", "container-image")

TIER_DEFAULTS = {
    "worktree":        {"cpus": None, "memory": None},
    "container-bind":  {"cpus": 2,    "memory": "4g"},
    "container-clone": {"cpus": 4,    "memory": "8g"},
    "container-image": {"cpus": 4,    "memory": "8g"},
}


@dataclass
class DispatchConfig:
    bp_prefix: str
    execution_mode: str = "worktree"
    push: bool = False
    image: str = "localhost/as-agent:latest"
    cpus: int | None = None
    memory: str | None = None
    timeout: int = 3600
    detach: bool = False
    json_mode: bool = False
    dry_run: bool = False


@dataclass
class DispatchResult:
    bp_hash: str = ""
    slug: str = ""
    agent_id: str = ""
    branch: str = ""
    execution_mode: str = "worktree"
    worktree_path: str | None = None
    container_id: str | None = None
    container_name: str | None = None
    resolved_loopscript: str | None = None
    loopscript_content: str = ""
    mentorscript_contents: dict = field(default_factory=dict)
    bp_content: str = ""
    rigor: str = "standard"
    exit_code: int = 0

    def to_dict(self) -> dict:
        d = {
            "bp_hash": self.bp_hash,
            "slug": self.slug,
            "agent_id": self.agent_id,
            "branch": self.branch,
            "execution_mode": self.execution_mode,
            "worktree_path": self.worktree_path,
            "container_id": self.container_id,
            "container_name": self.container_name,
            "resolved_loopscript": self.resolved_loopscript,
            "loopscript_content": self.loopscript_content,
            "mentorscript_contents": self.mentorscript_contents,
            "bp_content": self.bp_content,
            "rigor": self.rigor,
            "exit_code": self.exit_code,
        }
        return d


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------

def _git_env() -> dict[str, str]:
    """Build environment with git identity fallback."""
    env = os.environ.copy()
    r = subprocess.run(
        ["git", "config", "user.name"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if not r.stdout.strip():
        env["GIT_AUTHOR_NAME"] = "BP Explorer"
        env["GIT_AUTHOR_EMAIL"] = "bp-explorer@localhost"
        env["GIT_COMMITTER_NAME"] = "BP Explorer"
        env["GIT_COMMITTER_EMAIL"] = "bp-explorer@localhost"
    return env


def _run_script(
    script: str,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Run a Python script from scripts/ directory."""
    script_path = SCRIPTS_DIR / script
    if not script_path.exists():
        print(f"ERROR: {script} not found at {script_path}", file=sys.stderr)
        sys.exit(2)
    return subprocess.run(
        [sys.executable, str(script_path)] + args,
        capture_output=True, text=True,
        cwd=str(REPO_ROOT),
        env=env or _git_env(),
    )


def _log(msg: str, *, json_mode: bool = False) -> None:
    """Print to stderr (human-readable log), suppressed in json mode."""
    if not json_mode:
        print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# Phase A: Control plane (host-side, identical for all modes)
# ---------------------------------------------------------------------------

def phase_a_validate(bp_prefix: str, *, json_mode: bool = False) -> tuple[str, str]:
    """Validate BP for dispatch. Returns (bp_hash, slug)."""
    _log(f"Phase A.1: Validating bp:{bp_prefix[:6]}...", json_mode=json_mode)

    r = _run_script("validate-bp.py", [bp_prefix, "--json"])

    if r.returncode == 2:
        msg = r.stderr.strip() or r.stdout.strip() or "BP not found"
        print(f"ERROR: {msg}", file=sys.stderr)
        sys.exit(2)

    if not r.stdout.strip().startswith("{"):
        print(f"ERROR: Unexpected validation output: {r.stdout[:200]}", file=sys.stderr)
        sys.exit(1)

    validation = json.loads(r.stdout)
    bp_hash = validation.get("bp_hash", bp_prefix)
    slug = validation.get("slug", "")

    if r.returncode != 0:
        failed = [c for c in validation.get("checks", []) if not c.get("passed")]
        detail = "; ".join(c.get("message", c.get("name", "?")) for c in failed)
        print(f"ERROR: Validation failed for bp:{bp_hash[:6]} ({slug})", file=sys.stderr)
        print(f"  {detail}", file=sys.stderr)
        sys.exit(1)

    _log(f"  VALID: bp:{bp_hash[:6]} ({slug})", json_mode=json_mode)
    return bp_hash, slug


def phase_a_transition(
    bp_hash: str,
    push: bool,
    *,
    json_mode: bool = False,
) -> str:
    """Transition BP to dispatched. Returns agent_id."""
    _log(f"Phase A.2: Transitioning bp:{bp_hash[:6]} to dispatched...", json_mode=json_mode)

    args = ["dispatch", bp_hash]
    if push:
        args.append("--push")

    r = _run_script("bp-transition.py", args)

    if r.returncode != 0:
        msg = r.stderr.strip() or r.stdout.strip() or "Transition failed"
        print(f"ERROR: {msg}", file=sys.stderr)
        sys.exit(1)

    # Parse agent-id from transition output
    agent_id = None
    for line in r.stdout.splitlines():
        line_lower = line.lower().strip()
        if "agent-id:" in line_lower or "agent_id:" in line_lower:
            agent_id = line.split(":", 1)[1].strip()
            break

    if not agent_id:
        print("ERROR: Could not parse agent-id from transition output", file=sys.stderr)
        print(f"  Output: {r.stdout[:500]}", file=sys.stderr)
        sys.exit(1)

    _log(f"  agent-id: {agent_id}", json_mode=json_mode)
    return agent_id


def phase_a_resolve(
    bp_hash: str,
    *,
    json_mode: bool = False,
) -> dict:
    """Resolve BP info (loopscript, mentorscripts, execution mode). Returns bp_info dict."""
    _log(f"Phase A.3: Resolving bp:{bp_hash[:6]} info...", json_mode=json_mode)

    r = _run_script("bp-info.py", [bp_hash])

    if r.returncode != 0:
        msg = r.stderr.strip() or r.stdout.strip() or "bp-info failed"
        print(f"ERROR: {msg}", file=sys.stderr)
        sys.exit(1)

    if not r.stdout.strip().startswith("{"):
        print(f"ERROR: Unexpected bp-info output: {r.stdout[:200]}", file=sys.stderr)
        sys.exit(1)

    bp_info = json.loads(r.stdout)
    _log(
        f"  loopscript: {bp_info.get('resolved_loopscript', 'N/A')}  "
        f"rigor: {bp_info.get('rigor', 'standard')}  "
        f"mode: {bp_info.get('execution_mode', 'standard')}",
        json_mode=json_mode,
    )
    return bp_info


# ---------------------------------------------------------------------------
# Phase B: Data plane (mode-specific)
# ---------------------------------------------------------------------------

def phase_b_worktree(
    config: DispatchConfig,
    agent_id: str,
    bp_hash: str,
    bp_info: dict,
    result: DispatchResult,
) -> DispatchResult:
    """Worktree mode: create worktree + branch (current behavior, unchanged)."""
    _log(
        f"Phase B: Creating worktree for agent {agent_id}...",
        json_mode=config.json_mode,
    )

    args = [
        "create",
        "--agent-id", agent_id,
        "--bp-hash", bp_hash,
        "--json",
    ]
    if config.push:
        args.append("--push")

    r = _run_script("worktree-ops.py", args)

    if r.returncode != 0:
        msg = r.stderr.strip() or r.stdout.strip() or "Worktree creation failed"
        raise RuntimeError(msg)

    worktree_info = {}
    if r.stdout.strip().startswith("{"):
        worktree_info = json.loads(r.stdout)

    result.worktree_path = worktree_info.get(
        "worktree", f".worktrees/{agent_id}-{bp_hash}"
    )
    result.branch = worktree_info.get(
        "branch", f"agent/{agent_id}/{bp_hash}"
    )

    _log(
        f"  worktree: {result.worktree_path}\n"
        f"  branch: {result.branch}",
        json_mode=config.json_mode,
    )
    return result


def phase_b_container_bind(
    config: DispatchConfig,
    agent_id: str,
    bp_hash: str,
    bp_info: dict,
    result: DispatchResult,
) -> DispatchResult:
    """Tier 1: Bind-mount hybrid. Create worktree, then start container."""
    # Step 1: Create worktree (same as worktree mode)
    result = phase_b_worktree(config, agent_id, bp_hash, bp_info, result)

    # Step 2: Start container with bind-mounted worktree
    _log(
        f"Phase B.2: Starting container (bind mode)...",
        json_mode=config.json_mode,
    )

    lifecycle_script = SCRIPTS_DIR / "container-lifecycle.py"
    if not lifecycle_script.exists():
        raise RuntimeError(
            "container-lifecycle.py not found. "
            "Complete Step 2 (Tier 1 Container-Bind) first."
        )

    args = [
        sys.executable, str(lifecycle_script),
        "create",
        "--agent-id", agent_id,
        "--bp-hash", bp_hash,
        "--mode", "bind",
        "--image", config.image,
        "--json",
    ]
    if config.cpus:
        args.extend(["--cpus", str(config.cpus)])
    if config.memory:
        args.extend(["--memory", config.memory])
    if config.timeout:
        args.extend(["--timeout", str(config.timeout)])

    r = subprocess.run(
        args, capture_output=True, text=True,
        cwd=str(REPO_ROOT), env=_git_env(),
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "Container creation failed")

    container_info = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {}
    result.container_id = container_info.get("container_id")
    result.container_name = container_info.get("container_name")

    _log(
        f"  container: {result.container_name} ({result.container_id})",
        json_mode=config.json_mode,
    )
    return result


def phase_b_container_clone(
    config: DispatchConfig,
    agent_id: str,
    bp_hash: str,
    bp_info: dict,
    result: DispatchResult,
) -> DispatchResult:
    """Tier 2: Fresh clone inside container. No host worktree."""
    _log(
        f"Phase B: Starting container (clone mode)...",
        json_mode=config.json_mode,
    )

    lifecycle_script = SCRIPTS_DIR / "container-lifecycle.py"
    if not lifecycle_script.exists():
        raise RuntimeError(
            "container-lifecycle.py not found. "
            "Complete Step 3 (Tier 2 Container-Clone) first."
        )

    # Get origin URL for clone
    r = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    repo_url = r.stdout.strip() if r.returncode == 0 else ""

    args = [
        sys.executable, str(lifecycle_script),
        "create",
        "--agent-id", agent_id,
        "--bp-hash", bp_hash,
        "--mode", "clone",
        "--image", config.image,
        "--json",
    ]
    if repo_url:
        args.extend(["--repo-url", repo_url])
    if config.cpus:
        args.extend(["--cpus", str(config.cpus)])
    if config.memory:
        args.extend(["--memory", config.memory])
    if config.timeout:
        args.extend(["--timeout", str(config.timeout)])

    r = subprocess.run(
        args, capture_output=True, text=True,
        cwd=str(REPO_ROOT), env=_git_env(),
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "Container creation failed")

    container_info = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {}
    result.worktree_path = None
    result.container_id = container_info.get("container_id")
    result.container_name = container_info.get("container_name")

    _log(
        f"  container: {result.container_name} ({result.container_id})",
        json_mode=config.json_mode,
    )
    return result


def phase_b_container_image(
    config: DispatchConfig,
    agent_id: str,
    bp_hash: str,
    bp_info: dict,
    result: DispatchResult,
) -> DispatchResult:
    """Tier 3: Pre-built image with repo snapshot."""
    _log(
        f"Phase B: Starting container (image mode)...",
        json_mode=config.json_mode,
    )

    lifecycle_script = SCRIPTS_DIR / "container-lifecycle.py"
    if not lifecycle_script.exists():
        raise RuntimeError(
            "container-lifecycle.py not found. "
            "Complete Step 4 (Tier 3 Container-Image) first."
        )

    args = [
        sys.executable, str(lifecycle_script),
        "create",
        "--agent-id", agent_id,
        "--bp-hash", bp_hash,
        "--mode", "image",
        "--image", config.image,
        "--json",
    ]
    if config.cpus:
        args.extend(["--cpus", str(config.cpus)])
    if config.memory:
        args.extend(["--memory", config.memory])
    if config.timeout:
        args.extend(["--timeout", str(config.timeout)])

    r = subprocess.run(
        args, capture_output=True, text=True,
        cwd=str(REPO_ROOT), env=_git_env(),
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "Container creation failed")

    container_info = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {}
    result.worktree_path = None
    result.container_id = container_info.get("container_id")
    result.container_name = container_info.get("container_name")

    _log(
        f"  container: {result.container_name} ({result.container_id})",
        json_mode=config.json_mode,
    )
    return result


# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------

def _rollback_transition(bp_hash: str, *, json_mode: bool = False) -> None:
    """Cancel the dispatch transition on Phase B failure."""
    _log(f"Rolling back: cancelling dispatch for bp:{bp_hash[:6]}...", json_mode=json_mode)
    r = _run_script("bp-transition.py", ["cancel", bp_hash])
    if r.returncode == 0:
        _log("  Rollback succeeded: BP returned to ready.", json_mode=json_mode)
    else:
        _log(
            f"  WARNING: Rollback failed (exit {r.returncode}): {r.stderr.strip()}",
            json_mode=json_mode,
        )


# ---------------------------------------------------------------------------
# Content loading (for JSON output)
# ---------------------------------------------------------------------------

def _load_bp_content(bp_hash: str) -> str:
    """Read BP brief.md content."""
    briefings_dir = REPO_ROOT / "artifacts" / "briefings"
    for candidate in briefings_dir.rglob("*/brief.md"):
        if ".archive" in candidate.parts:
            continue
        if bp_hash in candidate.parent.name:
            return candidate.read_text(encoding="utf-8")
    return ""


def _load_loopscript_content(resolved: str | None) -> str:
    """Read resolved LoopScript content."""
    if not resolved:
        return ""
    # Try as relative path from repo root
    path = REPO_ROOT / resolved
    if path.exists():
        return path.read_text(encoding="utf-8")
    # Try as filename in loops dir
    path = REPO_ROOT / "skills" / "ale" / "loops" / resolved
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def _load_mentorscript_contents(bp_info: dict) -> dict[str, str]:
    """Read all mentorscript contents."""
    ms_list = bp_info.get("mentorscripts", [])
    if not ms_list:
        fm = bp_info.get("frontmatter", {})
        ms_list = fm.get("mentor-scripts", fm.get("mentorscripts", []))
    if not ms_list:
        ms_list = ["mentorscripts/global.md"]

    contents = {}
    for ms_ref in ms_list:
        ms_path = REPO_ROOT / ms_ref
        if ms_path.exists():
            contents[ms_ref] = ms_path.read_text(encoding="utf-8")
    return contents


# ---------------------------------------------------------------------------
# Main dispatch flow
# ---------------------------------------------------------------------------

PHASE_B_HANDLERS = {
    "worktree":        phase_b_worktree,
    "container-bind":  phase_b_container_bind,
    "container-clone": phase_b_container_clone,
    "container-image": phase_b_container_image,
}


def dispatch(config: DispatchConfig) -> DispatchResult:
    """Execute the full dispatch flow."""

    # ── Phase A: Control plane (host-side, identical for all modes) ──

    bp_hash, slug = phase_a_validate(config.bp_prefix, json_mode=config.json_mode)

    result = DispatchResult(
        bp_hash=bp_hash,
        slug=slug,
        execution_mode=config.execution_mode,
    )

    if config.dry_run:
        # Dry run: resolve info without transitioning
        bp_info = phase_a_resolve(bp_hash, json_mode=config.json_mode)
        result.resolved_loopscript = bp_info.get("resolved_loopscript")
        result.rigor = bp_info.get("rigor", "standard")
        result.bp_content = _load_bp_content(bp_hash)
        result.loopscript_content = _load_loopscript_content(result.resolved_loopscript)
        result.mentorscript_contents = _load_mentorscript_contents(bp_info)
        _log("\nDry run complete. No transition or Phase B executed.", json_mode=config.json_mode)
        return result

    agent_id = phase_a_transition(bp_hash, config.push, json_mode=config.json_mode)
    result.agent_id = agent_id
    result.branch = f"agent/{agent_id}/{bp_hash}"

    bp_info = phase_a_resolve(bp_hash, json_mode=config.json_mode)
    result.resolved_loopscript = bp_info.get("resolved_loopscript")
    result.rigor = bp_info.get("rigor", "standard")

    # Load content for JSON output
    result.bp_content = _load_bp_content(bp_hash)
    result.loopscript_content = _load_loopscript_content(result.resolved_loopscript)
    result.mentorscript_contents = _load_mentorscript_contents(bp_info)

    # ── Phase B: Data plane (mode-specific) ──

    handler = PHASE_B_HANDLERS[config.execution_mode]

    try:
        result = handler(config, agent_id, bp_hash, bp_info, result)
    except Exception as exc:
        print(f"ERROR: Phase B failed: {exc}", file=sys.stderr)
        _rollback_transition(bp_hash, json_mode=config.json_mode)
        result.exit_code = 3
        return result

    _log(
        f"\nDispatch complete: bp:{bp_hash[:6]} ({slug}) "
        f"agent:{agent_id} mode:{config.execution_mode}",
        json_mode=config.json_mode,
    )
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Unified dispatch orchestrator for container-based AEE",
    )
    parser.add_argument(
        "bp_prefix",
        help="BP hash or unique prefix",
    )
    parser.add_argument(
        "--execution-mode",
        choices=EXECUTION_MODES,
        default="worktree",
        help="Execution tier (default: worktree)",
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="Push git changes to remote",
    )
    parser.add_argument(
        "--image",
        default="localhost/as-agent:latest",
        help="Podman image for container modes",
    )
    parser.add_argument(
        "--cpus",
        type=int,
        default=None,
        help="CPU limit (container modes)",
    )
    parser.add_argument(
        "--memory",
        default=None,
        help="Memory limit (container modes)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=3600,
        help="Container timeout in seconds (default: 3600)",
    )
    parser.add_argument(
        "--detach",
        action="store_true",
        help="Return immediately after container start",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_mode",
        help="JSON output",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Phase A only (validate + resolve), skip transition and Phase B",
    )

    args = parser.parse_args()

    # Apply tier defaults for cpus/memory if not explicitly set
    tier_defaults = TIER_DEFAULTS.get(args.execution_mode, {})
    if args.cpus is None:
        args.cpus = tier_defaults.get("cpus")
    if args.memory is None:
        args.memory = tier_defaults.get("memory")

    config = DispatchConfig(
        bp_prefix=args.bp_prefix,
        execution_mode=args.execution_mode,
        push=args.push,
        image=args.image,
        cpus=args.cpus,
        memory=args.memory,
        timeout=args.timeout,
        detach=args.detach,
        json_mode=args.json_mode,
        dry_run=args.dry_run,
    )

    result = dispatch(config)

    if args.json_mode:
        print(json.dumps(result.to_dict(), indent=2))
    elif result.exit_code == 0 and not args.dry_run:
        # Human-readable summary (non-JSON, non-dry-run)
        print(f"\nbp:{result.bp_hash[:6]} ({result.slug})")
        print(f"  agent-id: {result.agent_id}")
        print(f"  mode: {result.execution_mode}")
        if result.worktree_path:
            print(f"  worktree: {result.worktree_path}")
        print(f"  branch: {result.branch}")
        if result.container_name:
            print(f"  container: {result.container_name}")
        print(f"  loopscript: {result.resolved_loopscript}")
        print(f"  rigor: {result.rigor}")

    sys.exit(result.exit_code)


if __name__ == "__main__":
    main()
