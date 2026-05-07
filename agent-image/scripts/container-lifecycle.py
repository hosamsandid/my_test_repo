#!/usr/bin/env python3
"""
Container lifecycle management for the Agent Execution Environment.

Host-side CRUD operations for Podman containers running AEE agents.
Called by dispatch-bp.py and Makefile targets.

Usage:
    python3 scripts/container-lifecycle.py create  --agent-id X --bp-hash Y --mode bind --image Z [--json]
    python3 scripts/container-lifecycle.py status  --agent-id X --bp-hash Y [--json]
    python3 scripts/container-lifecycle.py logs    --agent-id X --bp-hash Y [--follow] [--tail N]
    python3 scripts/container-lifecycle.py stop    --agent-id X --bp-hash Y
    python3 scripts/container-lifecycle.py cleanup --agent-id X --bp-hash Y
    python3 scripts/container-lifecycle.py list    [--json]

Exit codes:
    0  Success
    1  Operation failed
    2  Usage error or missing prerequisite
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"

# Resource defaults per tier (must match dispatch-bp.py TIER_DEFAULTS)
TIER_DEFAULTS = {
    "bind":  {"cpus": 2, "memory": "4g"},
    "clone": {"cpus": 4, "memory": "8g"},
    "image": {"cpus": 4, "memory": "8g"},
}

NETWORK = "ace-matrix"
ENV_FILE = REPO_ROOT / ".env"
STOP_TIMEOUT = 30
PIDS_LIMIT = 512


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _container_name(agent_id: str, bp_hash: str) -> str:
    """Derive container name: ace-agent-{agent-id}-{bp-hash[:6]}."""
    return f"ace-agent-{agent_id}-{bp_hash[:6]}"


def _podman(
    args: list[str],
    check: bool = True,
    capture: bool = True,
) -> subprocess.CompletedProcess:
    """Run a podman command."""
    cmd = ["podman"] + args
    return subprocess.run(
        cmd,
        capture_output=capture,
        text=True,
        check=check,
    )


def _check_env_file() -> bool:
    """Check if the .env file exists with required variables."""
    if not ENV_FILE.exists():
        return False
    text = ENV_FILE.read_text(encoding="utf-8")
    # Need at least one API key variant
    has_key = ("ANTHROPIC_API_KEY=" in text or "ANTHROPIC_FOUNDRY_API_KEY=" in text)
    return has_key


def _check_network() -> bool:
    """Check if the container network exists."""
    r = _podman(["network", "exists", NETWORK], check=False)
    return r.returncode == 0


# ---------------------------------------------------------------------------
# Subcommand: create
# ---------------------------------------------------------------------------

def cmd_create(args: argparse.Namespace) -> int:
    """Create and start an agent container."""
    name = _container_name(args.agent_id, args.bp_hash)

    # Pre-flight checks
    if not _check_env_file():
        print(
            f"ERROR: .env file not found or missing API key at {ENV_FILE}\n"
            f"Create .env with ANTHROPIC_API_KEY or ANTHROPIC_FOUNDRY_API_KEY.",
            file=sys.stderr,
        )
        return 2

    if not _check_network():
        print(
            f"ERROR: Network '{NETWORK}' not found.\n"
            f"Start the Matrix stack first: make matrix-start",
            file=sys.stderr,
        )
        return 2

    # Check image exists
    r = _podman(["image", "exists", args.image], check=False)
    if r.returncode != 0:
        print(
            f"ERROR: Image '{args.image}' not found.\n"
            f"Build it with: make aee-build",
            file=sys.stderr,
        )
        return 2

    # Check for existing container with the same name
    r = _podman(["container", "exists", name], check=False)
    if r.returncode == 0:
        print(
            f"ERROR: Container '{name}' already exists.\n"
            f"Stop and remove it first, or use 'cleanup'.",
            file=sys.stderr,
        )
        return 1

    # Resource limits
    cpus = args.cpus or TIER_DEFAULTS[args.mode]["cpus"]
    memory = args.memory or TIER_DEFAULTS[args.mode]["memory"]

    # Build podman run command
    cmd = [
        "run", "-d",
        "--init",
        "--name", name,
        "--cpus", str(cpus),
        "--memory", memory,
        "--pids-limit", str(PIDS_LIMIT),
        "--stop-timeout", str(STOP_TIMEOUT),
        "--network", NETWORK,
        "--env-file", str(ENV_FILE),
    ]

    # Bind mounts depend on mode
    if args.mode == "bind":
        # Worktree is already created by dispatch-bp.py phase_b_worktree()
        worktree_path = REPO_ROOT / ".worktrees" / f"{args.agent_id}-{args.bp_hash}"
        if not worktree_path.exists():
            print(
                f"ERROR: Worktree not found at {worktree_path}\n"
                f"The worktree should be created before container creation.",
                file=sys.stderr,
            )
            return 1

        abs_worktree = str(worktree_path.resolve())
        cmd.extend(["-v", f"{abs_worktree}:/repo:rw"])

        # Git worktrees use a .git file pointing to the parent repo's
        # .git/worktrees/<name> directory. Bind-mount the parent .git
        # so git operations work inside the container.
        #
        # SECURITY: This is a deliberate trade-off. The :rw mount gives the
        # container full write access to the host repo's git metadata
        # (refs, objects, hooks, config). Required because BP-dispatch
        # commits + pushes from inside the container, which writes to
        # .git/worktrees/<name>/ and the shared object database.
        # Acceptable for the dev/CI setup where the repo is cloned
        # specifically for agent runs; not appropriate if the host repo
        # holds untrusted upstream commits or sensitive hooks.
        host_git_dir = REPO_ROOT / ".git"
        if host_git_dir.is_dir():
            cmd.extend(["-v", f"{host_git_dir.resolve()}:{host_git_dir.resolve()}:rw"])

    # Bind-mount scripts, skills, mentorscripts as read-only overlays
    # (allows iteration without image rebuild)
    for mount_name, host_dir, container_dir in [
        ("scripts", SCRIPTS_DIR, "/opt/ace/scripts"),
        ("skills", REPO_ROOT / "skills", "/opt/ace/skills"),
        ("mentorscripts", REPO_ROOT / "mentorscripts", "/opt/ace/mentorscripts"),
    ]:
        if host_dir.exists():
            cmd.extend(["-v", f"{host_dir.resolve()}:{container_dir}:ro"])

    # Bind-mount CLAUDE.md
    claude_md = REPO_ROOT / "CLAUDE.md"
    if claude_md.exists():
        cmd.extend(["-v", f"{claude_md.resolve()}:/opt/ace/CLAUDE.md:ro"])

    # Image and entrypoint args
    cmd.append(args.image)
    cmd.extend([
        "--agent-id", args.agent_id,
        "--bp-hash", args.bp_hash,
        "--mode", args.mode,
        "--branch", f"agent/{args.agent_id}/{args.bp_hash}",
    ])

    if args.mode == "clone" and getattr(args, "repo_url", None):
        cmd.extend(["--repo-url", args.repo_url])

    r = _podman(cmd, check=False)
    if r.returncode != 0:
        print(f"ERROR: Container creation failed: {r.stderr.strip()}", file=sys.stderr)
        return 1

    container_id = r.stdout.strip()[:12]

    result = {
        "container_id": container_id,
        "container_name": name,
        "status": "running",
        "agent_id": args.agent_id,
        "bp_hash": args.bp_hash,
        "mode": args.mode,
        "cpus": cpus,
        "memory": memory,
    }

    if getattr(args, "json_mode", False):
        print(json.dumps(result, indent=2))
    else:
        print(f"Container created: {name} ({container_id})")

    return 0


# ---------------------------------------------------------------------------
# Subcommand: status
# ---------------------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> int:
    """Show container status."""
    name = _container_name(args.agent_id, args.bp_hash)

    r = _podman(
        ["inspect", "--format", "json", name],
        check=False,
    )
    if r.returncode != 0:
        if getattr(args, "json_mode", False):
            print(json.dumps({"container_name": name, "status": "not_found"}))
        else:
            print(f"Container '{name}' not found.")
        return 1

    info = json.loads(r.stdout)
    if isinstance(info, list):
        info = info[0] if info else {}

    state = info.get("State", {})
    result = {
        "container_name": name,
        "container_id": info.get("Id", "")[:12],
        "status": state.get("Status", "unknown"),
        "running": state.get("Running", False),
        "started_at": state.get("StartedAt", ""),
        "finished_at": state.get("FinishedAt", ""),
        "exit_code": state.get("ExitCode", -1),
    }

    if getattr(args, "json_mode", False):
        print(json.dumps(result, indent=2))
    else:
        print(f"Container: {name}")
        print(f"  Status: {result['status']}")
        print(f"  Running: {result['running']}")
        if result["started_at"]:
            print(f"  Started: {result['started_at']}")

    return 0


# ---------------------------------------------------------------------------
# Subcommand: logs
# ---------------------------------------------------------------------------

def cmd_logs(args: argparse.Namespace) -> int:
    """Show container logs."""
    name = _container_name(args.agent_id, args.bp_hash)

    cmd = ["logs"]
    if getattr(args, "follow", False):
        cmd.append("--follow")
    if getattr(args, "tail", None):
        cmd.extend(["--tail", str(args.tail)])
    cmd.append(name)

    # Stream logs directly to stdout (don't capture)
    r = _podman(cmd, check=False, capture=False)
    return r.returncode


# ---------------------------------------------------------------------------
# Subcommand: stop
# ---------------------------------------------------------------------------

def cmd_stop(args: argparse.Namespace) -> int:
    """Stop an agent container gracefully."""
    name = _container_name(args.agent_id, args.bp_hash)

    r = _podman(["stop", "--time", str(STOP_TIMEOUT), name], check=False)
    if r.returncode != 0:
        print(f"ERROR: Failed to stop '{name}': {r.stderr.strip()}", file=sys.stderr)
        return 1

    print(f"Container stopped: {name}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: cleanup
# ---------------------------------------------------------------------------

def cmd_cleanup(args: argparse.Namespace) -> int:
    """Remove a stopped container."""
    name = _container_name(args.agent_id, args.bp_hash)

    # Stop if running
    _podman(["stop", "--time", str(STOP_TIMEOUT), name], check=False)

    # Remove container
    r = _podman(["rm", "-f", name], check=False)
    if r.returncode != 0:
        print(f"ERROR: Failed to remove '{name}': {r.stderr.strip()}", file=sys.stderr)
        return 1

    print(f"Container removed: {name}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: list
# ---------------------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> int:
    """List all agent containers."""
    r = _podman(
        ["ps", "-a", "--filter", "name=ace-agent-", "--format", "json"],
        check=False,
    )
    if r.returncode != 0:
        print(f"ERROR: Failed to list containers: {r.stderr.strip()}", file=sys.stderr)
        return 1

    containers = json.loads(r.stdout) if r.stdout.strip() else []
    if not isinstance(containers, list):
        containers = [containers] if containers else []

    results = []
    for c in containers:
        names = c.get("Names", [])
        container_name = names[0] if isinstance(names, list) and names else str(names)
        results.append({
            "container_name": container_name,
            "container_id": c.get("Id", "")[:12],
            "status": c.get("State", "unknown"),
            "created": c.get("Created", ""),
            "image": c.get("Image", ""),
        })

    if getattr(args, "json_mode", False):
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print("No agent containers found.")
        else:
            print(f"{'NAME':<45} {'STATUS':<12} {'ID':<14}")
            print("-" * 71)
            for c in results:
                print(f"{c['container_name']:<45} {c['status']:<12} {c['container_id']:<14}")

    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Container lifecycle management for AEE",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # -- create --
    p_create = subparsers.add_parser("create", help="Create and start an agent container")
    p_create.add_argument("--agent-id", required=True, help="Agent ID")
    p_create.add_argument("--bp-hash", required=True, help="BP hash")
    p_create.add_argument(
        "--mode", choices=("bind", "clone", "image"), required=True,
        help="Execution tier",
    )
    p_create.add_argument(
        "--image", default="localhost/ace-agent:latest",
        help="Podman image (default: localhost/ace-agent:latest)",
    )
    p_create.add_argument("--cpus", type=int, default=None, help="CPU limit")
    p_create.add_argument("--memory", default=None, help="Memory limit (e.g. 4g)")
    p_create.add_argument("--timeout", type=int, default=3600, help="Max runtime in seconds")
    p_create.add_argument("--repo-url", default=None, help="Git remote URL (clone mode)")
    p_create.add_argument("--json", dest="json_mode", action="store_true",
                         help="JSON output")

    # -- status --
    p_status = subparsers.add_parser("status", help="Show container status")
    p_status.add_argument("--agent-id", required=True)
    p_status.add_argument("--bp-hash", required=True)
    p_status.add_argument("--json", dest="json_mode", action="store_true")

    # -- logs --
    p_logs = subparsers.add_parser("logs", help="Show container logs")
    p_logs.add_argument("--agent-id", required=True)
    p_logs.add_argument("--bp-hash", required=True)
    p_logs.add_argument("--follow", "-f", action="store_true")
    p_logs.add_argument("--tail", type=int, default=None)

    # -- stop --
    p_stop = subparsers.add_parser("stop", help="Stop an agent container")
    p_stop.add_argument("--agent-id", required=True)
    p_stop.add_argument("--bp-hash", required=True)

    # -- cleanup --
    p_cleanup = subparsers.add_parser("cleanup", help="Remove a stopped container")
    p_cleanup.add_argument("--agent-id", required=True)
    p_cleanup.add_argument("--bp-hash", required=True)

    # -- list --
    p_list = subparsers.add_parser("list", help="List agent containers")
    p_list.add_argument("--json", dest="json_mode", action="store_true")

    args = parser.parse_args()

    handlers = {
        "create": cmd_create,
        "status": cmd_status,
        "logs": cmd_logs,
        "stop": cmd_stop,
        "cleanup": cmd_cleanup,
        "list": cmd_list,
    }

    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
