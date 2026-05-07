#!/usr/bin/env python3
"""
Agent Execution Environment entrypoint.

Runs inside a Podman container. Two modes:

1. **Matrix DM listener (default, P4)** — invoked with no CLI args by the
   orchestrator's `spawnContainer`. Connects to Matrix as the agent's user,
   listens for direct messages, and replies via the Claude Code CLI with
   per-room session continuity. Required env vars: AGENT_ID,
   MATRIX_ACCESS_TOKEN, MATRIX_BOT_USER_ID, MATRIX_HOMESERVER.

2. **BriefingPack dispatch (legacy, P2)** — invoked with `--bp-hash <hash>`
   by `dispatch-bp.py`. Loads dispatch context (brief.md, LoopScript,
   MentorScripts), builds the agent prompt, and invokes Claude once.

Exit codes:
    0    Agent completed successfully (BP mode) / DM listener stopped cleanly
    1    Setup or execution error
    124  Graceful SIGTERM shutdown (BP mode: partial work committed)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
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
    """SIGTERM handler.

    BP-dispatch mode: commit partial work + exit 124.
    DM listener mode: signal the asyncio loop to wind down + exit 0
    (no bp_hash means there's no bound /repo to commit to).
    """
    print("\n[agent] SIGTERM received", file=sys.stderr)
    _shutdown.set()

    if getattr(_args, "bp_hash", None):
        print("[agent] Committing partial work...", file=sys.stderr)
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
    # DM listener mode: setting _shutdown is enough; main loop exits cleanly.
    # If we're not yet inside the async loop, exit directly.
    if not _DM_LOOP_RUNNING:
        sys.exit(0)


# ---------------------------------------------------------------------------
# Matrix DM listener (P4)
# ---------------------------------------------------------------------------
#
# Ports orchestrator/agent-runner.js (Node, matrix-bot-sdk) to Python
# (matrix-nio). Behavior must remain compatible with the Admin Console's
# session viewer, which reads /workspace/agents/<id>/sessions/<roomId>.jsonl
# and the per-room session pointer at <roomId>.current.json.

CLAUDE_TIMEOUT_SEC = 3600
MEMBER_CACHE_TTL_SEC = 30

# Module-level state shared with the SIGUSR1 handler.
_active_claude_proc: subprocess.Popen | None = None
_user_stop_requested = False


def _agent_workdir() -> Path:
    return Path("/workspace/agents") / os.environ["AGENT_ID"]


def _load_dm_agent_config() -> dict:
    p = _agent_workdir() / "config.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[Runner] config.json parse failed: {exc}", file=sys.stderr)
        return {}


# ---- per-room session pointer (drop-in compat with agent-runner.js) ----

def _session_pointer_file(room_id: str) -> Path:
    return _agent_workdir() / "sessions" / f"{room_id}.current.json"


def _read_session_pointer(room_id: str) -> str | None:
    p = _session_pointer_file(room_id)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        sid = data.get("sessionId")
        return sid if isinstance(sid, str) and sid else None
    except Exception as exc:
        print(f"[Runner] readSessionPointer {room_id}: {exc}", file=sys.stderr)
        return None


def _write_session_pointer(room_id: str, session_id: str) -> None:
    if not session_id:
        return
    p = _session_pointer_file(room_id)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(
                {"sessionId": session_id,
                 "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())},
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as exc:
        print(f"[Runner] writeSessionPointer: {exc}", file=sys.stderr)


def _clear_session_pointer(room_id: str) -> None:
    try:
        _session_pointer_file(room_id).unlink(missing_ok=True)
    except Exception:
        pass


# ---- JSONL session log (schema must match orchestrator/session-log.js) ----

def _session_log_file(room_id: str) -> Path:
    return _agent_workdir() / "sessions" / f"{room_id}.jsonl"


def _append_event(room_id: str, event: dict) -> None:
    try:
        f = _session_log_file(room_id)
        f.parent.mkdir(parents=True, exist_ok=True)
        ev = {"ts": event.get("ts") or time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
              **event}
        with f.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev) + "\n")
    except Exception as exc:
        # Logging never crashes the runner.
        print(f"[Runner] session-log append failed: {exc}", file=sys.stderr)


def _map_stream_json_line(line: str, correlation_id: str) -> list[dict]:
    """Translate one NDJSON line from `claude --output-format stream-json --verbose`
    into normalized event objects. Mirrors session-log.js mapStreamJsonLine.
    """
    try:
        parsed = json.loads(line)
    except Exception as exc:
        return [{
            "type": "error",
            "stage": "stream-parse",
            "message": str(exc),
            "correlationId": correlation_id,
            "raw": line[:200],
        }]
    if not isinstance(parsed, dict):
        return [{"type": "unknown", "raw": parsed, "correlationId": correlation_id}]

    events: list[dict] = []
    ptype = parsed.get("type")

    if ptype == "system":
        sub = parsed.get("subtype")
        if sub == "init":
            events.append({
                "type": "system_init",
                "sessionId": parsed.get("session_id"),
                "model": parsed.get("model"),
                "correlationId": correlation_id,
            })
        elif sub == "task_progress":
            pass  # noisy heartbeat
        else:
            events.append({"type": "system_event", "subtype": sub or "unknown",
                           "raw": parsed, "correlationId": correlation_id})

    elif ptype == "assistant":
        msg = parsed.get("message") or {}
        for block in (msg.get("content") or []):
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                events.append({"type": "assistant_text", "text": block.get("text"),
                               "correlationId": correlation_id})
            elif btype == "tool_use":
                events.append({"type": "tool_use", "tool": block.get("name"),
                               "toolId": block.get("id"), "input": block.get("input"),
                               "correlationId": correlation_id})
            elif btype == "thinking":
                events.append({"type": "thinking", "text": block.get("thinking"),
                               "correlationId": correlation_id})
            else:
                events.append({"type": "unknown", "raw": block, "correlationId": correlation_id})

    elif ptype == "user":
        msg = parsed.get("message") or {}
        for block in (msg.get("content") or []):
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                content = block.get("content")
                if isinstance(content, str):
                    content_str = content
                else:
                    try:
                        content_str = json.dumps(content)
                    except Exception:
                        content_str = str(content)
                events.append({
                    "type": "tool_result",
                    "toolId": block.get("tool_use_id"),
                    "ok": not block.get("is_error"),
                    "content": content_str,
                    "correlationId": correlation_id,
                })
            else:
                events.append({"type": "unknown", "raw": block, "correlationId": correlation_id})

    elif ptype == "result":
        usage = parsed.get("usage") or {}
        events.append({
            "type": "result",
            "durationMs": parsed.get("duration_ms"),
            "tokens": {"input": usage.get("input_tokens"),
                       "output": usage.get("output_tokens")},
            "costUsd": parsed.get("total_cost_usd"),
            "sessionId": parsed.get("session_id"),
            "result": parsed.get("result"),
            "correlationId": correlation_id,
        })

    else:
        events.append({"type": "unknown", "raw": parsed, "correlationId": correlation_id})

    return events


# ---- status.json ----

def _write_status(state: str) -> None:
    try:
        p = _agent_workdir() / "status.json"
        prev: dict = {}
        if p.exists():
            try:
                prev = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                prev = {}
        data = {"state": state,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}
        if prev.get("lastResponseAt"):
            data["lastResponseAt"] = prev["lastResponseAt"]
        p.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass  # best-effort


def _write_last_response_at() -> None:
    try:
        p = _agent_workdir() / "status.json"
        prev: dict = {}
        if p.exists():
            try:
                prev = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                prev = {}
        prev["lastResponseAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        p.write_text(json.dumps(prev), encoding="utf-8")
    except Exception:
        pass


# ---- Sync token persistence ----

def _state_file() -> Path:
    return _agent_workdir() / ".agent-state.json"


def _load_next_batch() -> str | None:
    p = _state_file()
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        v = data.get("nextBatch")
        return v if isinstance(v, str) and v else None
    except Exception:
        return None


def _save_next_batch(token: str) -> None:
    if not token:
        return
    try:
        p = _state_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"nextBatch": token}), encoding="utf-8")
    except Exception:
        pass


# ---- Memory hint (port from agent-runner.js) ----

def _build_memory_hint(blueprint_id: str | None) -> str:
    if blueprint_id:
        return (
            f"This agent is an instance of blueprint '{blueprint_id}'. "
            f"Memory is SHARED across all instances of this blueprint. "
            f"WORKFLOW — follow this exactly: "
            f"(1) PULL shared memory at conversation start: "
            f"curl -sf http://localhost:4002/internal/blueprints/{blueprint_id}/memory/context.md > memory/context.md || true; "
            f"curl -sf http://localhost:4002/internal/blueprints/{blueprint_id}/memory/log.md > memory/log.md || true. "
            f"Then read both files. "
            f"(2) Update memory/context.md and memory/log.md locally during the conversation. "
            f"(3) PUSH at end (wrap-up or remember request): "
            f"curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @memory/context.md http://localhost:4002/internal/blueprints/{blueprint_id}/memory/context.md; "
            f"curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @memory/log.md http://localhost:4002/internal/blueprints/{blueprint_id}/memory/log.md. "
            f"IMPORTANT: Your workspace root is the current working directory."
        )
    return (
        "Read memory/context.md and memory/log.md first (if they exist) before responding. "
        "If the user asks you to remember something: update the memory files. "
        "IMPORTANT: Your workspace root is the current working directory. "
        "Memory entries may reference absolute paths like /workspace/... from a different context. "
        "Translate these to relative paths in your current directory (e.g. /workspace/314092_foo/ becomes ./314092_foo/)."
    )


# ---- Claude invocation (stream-json + session resumption) ----

def _resolve_model_arg() -> str | None:
    cfg = _load_dm_agent_config()
    if isinstance(cfg.get("modelOverride"), str) and cfg["modelOverride"]:
        return cfg["modelOverride"]
    env_model = os.environ.get("AGENT_DEFAULT_MODEL")
    return env_model if env_model else None


def _base_claude_args(prompt: str, memory_hint: str, model_arg: str | None) -> list[str]:
    args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--append-system-prompt", memory_hint,
    ]
    if model_arg:
        args.extend(["--model", model_arg])
    for tool in ("Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
                 "Glob(*)", "Grep(*)", "Task(*)", "WebFetch(*)", "WebSearch(*)"):
        args.extend(["--allowedTools", tool])
    return args


def _call_claude_once(prompt: str, room_id: str, correlation_id: str,
                      resume_id: str | None, blueprint_id: str | None,
                      timeout_sec: int) -> tuple[str, str | None]:
    """Run claude once. Returns (final_text, observed_session_id).

    Raises CalledProcessError on non-zero exit. Sets module-level
    _active_claude_proc so SIGUSR1 can terminate the subprocess.

    Uses blocking line-by-line reads (clean and reliable) plus a daemon
    thread that drains stderr in parallel. SIGUSR1 calls proc.terminate(),
    which causes stdout to hit EOF and the readline loop to exit.
    """
    global _active_claude_proc, _user_stop_requested

    args = _base_claude_args(prompt, _build_memory_hint(blueprint_id), _resolve_model_arg())
    if resume_id:
        args = ["--resume", resume_id, *args]

    # HOME is the persistent agent workdir so claude's session files (under
    # $HOME/.claude/projects/...) survive container restarts. The default
    # /root path is wiped every time podman recreates the container.
    env = {**os.environ, "HOME": str(_agent_workdir())}
    proc = subprocess.Popen(
        ["claude", *args],
        cwd=str(_agent_workdir()),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    _active_claude_proc = proc

    final_result: str | None = None
    observed_session: str | None = None
    assistant_chunks: list[str] = []
    stderr_chunks: list[str] = []

    def handle_line(line: str) -> None:
        nonlocal final_result, observed_session
        for ev in _map_stream_json_line(line, correlation_id):
            _append_event(room_id, ev)
            if ev.get("type") == "system_init" and isinstance(ev.get("sessionId"), str):
                observed_session = ev["sessionId"]
            elif ev.get("type") == "result":
                if isinstance(ev.get("sessionId"), str):
                    observed_session = ev["sessionId"]
                if isinstance(ev.get("result"), str):
                    final_result = ev["result"]
            elif ev.get("type") == "assistant_text" and isinstance(ev.get("text"), str):
                assistant_chunks.append(ev["text"])

    def drain_stderr():
        try:
            for chunk in iter(proc.stderr.readline, ""):
                stderr_chunks.append(chunk)
        except Exception:
            pass

    # Watchdog: force-kill claude if it runs past the deadline.
    def watchdog():
        try:
            proc.wait(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass

    threading.Thread(target=drain_stderr, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()

    try:
        for line in iter(proc.stdout.readline, ""):
            stripped = line.rstrip("\n")
            if stripped.strip():
                handle_line(stripped)
        proc.wait()
    finally:
        if _active_claude_proc is proc:
            _active_claude_proc = None

    rc = proc.returncode
    stderr_blob = "".join(stderr_chunks)

    if rc != 0:
        was_user_stop = _user_stop_requested
        _user_stop_requested = False
        err = subprocess.CalledProcessError(rc, "claude", output=None, stderr=stderr_blob)
        err.user_aborted = was_user_stop  # type: ignore[attr-defined]
        raise err

    final_text = final_result if final_result is not None else "".join(assistant_chunks)
    return final_text, observed_session


def _call_claude(prompt: str, room_id: str, correlation_id: str,
                 blueprint_id: str | None, timeout_sec: int = CLAUDE_TIMEOUT_SEC) -> str:
    """Drive _call_claude_once with --resume retry-on-stale-session logic."""
    resume_id = _read_session_pointer(room_id)
    if resume_id:
        try:
            text, observed = _call_claude_once(
                prompt, room_id, correlation_id, resume_id, blueprint_id, timeout_sec
            )
            if observed:
                _write_session_pointer(room_id, observed)
            return text
        except subprocess.CalledProcessError as err:
            if getattr(err, "user_aborted", False):
                raise
            blob = (str(err.stderr or "") + " " + str(err)).lower()
            if "session" in blob or "resume" in blob or "not found" in blob:
                print(
                    f"[Runner] --resume {resume_id} failed; retrying without resume",
                    file=sys.stderr,
                )
                _clear_session_pointer(room_id)
                text, observed = _call_claude_once(
                    prompt, room_id, correlation_id, None, blueprint_id, timeout_sec
                )
                if observed:
                    _write_session_pointer(room_id, observed)
                return text
            raise

    text, observed = _call_claude_once(
        prompt, room_id, correlation_id, None, blueprint_id, timeout_sec
    )
    if observed:
        _write_session_pointer(room_id, observed)
    return text


# ---- SIGUSR1 stop-session handler ----

def _handle_stop_session(signum: int, frame) -> None:
    global _user_stop_requested
    if _active_claude_proc is not None:
        print("[Runner] SIGUSR1 stop-session — terminating Claude process", file=sys.stderr)
        _user_stop_requested = True
        try:
            _active_claude_proc.terminate()
        except Exception as exc:
            print(f"[Runner] stop-session terminate failed: {exc}", file=sys.stderr)
    else:
        print("[Runner] SIGUSR1 stop-session — no active invocation", file=sys.stderr)


# ---- The async DM listener itself ----

async def run_dm_listener() -> None:
    global _DM_LOOP_RUNNING

    # Required env vars (fail fast if any missing).
    required = ("AGENT_ID", "MATRIX_ACCESS_TOKEN", "MATRIX_BOT_USER_ID", "MATRIX_HOMESERVER")
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"ERROR: missing required env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    agent_id = os.environ["AGENT_ID"]
    user_id = os.environ["MATRIX_BOT_USER_ID"]
    token = os.environ["MATRIX_ACCESS_TOKEN"]
    homeserver = os.environ["MATRIX_HOMESERVER"]

    workdir = _agent_workdir()
    workdir.mkdir(parents=True, exist_ok=True)
    _write_status("idle")

    # Install SIGUSR1 (SIGTERM is already installed in main()).
    signal.signal(signal.SIGUSR1, _handle_stop_session)

    cfg = _load_dm_agent_config()
    display_name = cfg.get("displayName", agent_id)
    role = cfg.get("role", "expert")
    blueprint_id = cfg.get("blueprintId")
    if blueprint_id:
        print(f"[Runner:{agent_id}] Blueprint instance: {blueprint_id}", file=sys.stderr)
    if role in ("autonomous", "orchestrator"):
        print(
            f"[Runner:{agent_id}] role={role}: trigger scheduler / claim loop "
            f"are not yet ported to Python (P5/P6). DM listener active.",
            file=sys.stderr,
        )

    # Lazy import — keeps BP-dispatch mode working even on hosts without nio.
    from nio import (  # type: ignore
        AsyncClient, AsyncClientConfig,
        InviteMemberEvent, RoomMessageText, SyncResponse,
    )
    import markdown as md_lib  # type: ignore

    client_cfg = AsyncClientConfig(
        max_limit_exceeded=0,
        max_timeouts=0,
        store_sync_tokens=False,  # we manage next_batch ourselves
        encryption_enabled=False,
    )
    client = AsyncClient(homeserver, user_id, config=client_cfg)
    client.access_token = token
    client.user_id = user_id
    client.device_id = "AEE"

    saved_next_batch = _load_next_batch()
    if saved_next_batch:
        client.next_batch = saved_next_batch
        client.loaded_sync_token = saved_next_batch

    start_time_ms = int(time.time() * 1000)

    # Member cache for DM detection.
    member_cache: dict[str, tuple[list[str], float]] = {}
    processing = {"flag": False}  # mutable closure

    async def joined_members(room_id: str) -> list[str]:
        cached = member_cache.get(room_id)
        if cached and cached[1] > time.time():
            return cached[0]
        resp = await client.joined_members(room_id)
        members = []
        if hasattr(resp, "members"):
            members = [m.user_id for m in resp.members]
        member_cache[room_id] = (members, time.time() + MEMBER_CACHE_TTL_SEC)
        return members

    async def is_dm_from_human(room_id: str, sender: str) -> bool:
        if sender == user_id:
            return False
        try:
            members = await joined_members(room_id)
        except Exception as exc:
            print(f"[Runner:{agent_id}] joined_members({room_id}) failed: {exc}",
                  file=sys.stderr)
            return False
        if len(members) != 2:
            return False
        return user_id in members and sender in members

    async def send_formatted(room_id: str, text: str) -> str:
        try:
            html_body = md_lib.markdown(text)
        except Exception:
            html_body = text
        resp = await client.room_send(
            room_id=room_id,
            message_type="m.room.message",
            content={
                "msgtype": "m.text",
                "body": text,
                "format": "org.matrix.custom.html",
                "formatted_body": html_body,
            },
        )
        return getattr(resp, "event_id", "")

    async def on_invite(room, event):
        try:
            target = getattr(event, "state_key", None) or getattr(event, "membership", None)
            if event.state_key != user_id:
                return
        except Exception:
            pass
        room_id = getattr(room, "room_id", None) or getattr(event, "room_id", None)
        if not room_id:
            return
        try:
            await client.join(room_id)
            print(f"[Runner:{agent_id}] Auto-joined {room_id}", file=sys.stderr)
        except Exception as exc:
            print(f"[Runner:{agent_id}] join({room_id}) failed: {exc}", file=sys.stderr)

    async def on_message(room, event):
        room_id = getattr(room, "room_id", None)
        if not room_id:
            return
        sender = getattr(event, "sender", None)
        body = getattr(event, "body", None)
        ts = getattr(event, "server_timestamp", 0)
        if not sender or not body:
            return
        if sender == user_id:
            return
        if ts < start_time_ms:
            return
        if not await is_dm_from_human(room_id, sender):
            return

        if processing["flag"]:
            print(f"[Runner:{agent_id}] Busy — dropping direct message", file=sys.stderr)
            return
        processing["flag"] = True

        correlation_id = getattr(event, "event_id", None) or str(uuid.uuid4())
        print(f"[Runner:{agent_id}] Direct message ({len(body)} chars)...", file=sys.stderr)

        try:
            _append_event(room_id, {
                "type": "message.received",
                "correlationId": correlation_id,
                "from": sender,
                "body": body[:4000],
            })
            _append_event(room_id, {
                "type": "claude.invoke",
                "correlationId": correlation_id,
                "promptChars": len(body),
            })

            _write_status("busy")
            try:
                # claude invocation is blocking — run it off the event loop so
                # matrix-nio can keep syncing (otherwise no follow-on messages
                # arrive while a turn is in flight).
                result = await asyncio.to_thread(
                    _call_claude, body, room_id, correlation_id, blueprint_id,
                )
            finally:
                _write_status("idle")

            try:
                event_id = await send_formatted(room_id, result)
            except Exception as exc:
                _append_event(room_id, {
                    "type": "error", "correlationId": correlation_id,
                    "stage": "matrix", "message": str(exc),
                })
                raise

            _write_last_response_at()
            _append_event(room_id, {
                "type": "message.posted",
                "correlationId": correlation_id,
                "eventId": event_id,
            })
            print(f"[Runner:{agent_id}] Posted direct response ({len(result)} chars)",
                  file=sys.stderr)

        except subprocess.CalledProcessError as err:
            if getattr(err, "user_aborted", False):
                print(f"[Runner:{agent_id}] Session stopped by user", file=sys.stderr)
                try:
                    await send_formatted(room_id, "_(Execution aborted.)_")
                except Exception as post_exc:
                    print(f"[Runner:{agent_id}] Could not post abort notice: {post_exc}",
                          file=sys.stderr)
            else:
                _append_event(room_id, {
                    "type": "error", "correlationId": correlation_id,
                    "stage": "claude", "message": str(err),
                })
                print(f"[Runner:{agent_id}] Error: {err}", file=sys.stderr)
                try:
                    await send_formatted(
                        room_id,
                        f"⚠️ **Agent error**\n\n```\n{str(err)[:800]}\n```",
                    )
                except Exception:
                    pass
        except Exception as err:
            _append_event(room_id, {
                "type": "error", "correlationId": correlation_id,
                "stage": "claude", "message": str(err),
            })
            print(f"[Runner:{agent_id}] Error: {err}", file=sys.stderr)
            try:
                await send_formatted(
                    room_id,
                    f"⚠️ **Agent error**\n\n```\n{str(err)[:800]}\n```",
                )
            except Exception:
                pass
        finally:
            processing["flag"] = False

    async def save_token_callback(response):
        if isinstance(response, SyncResponse) and response.next_batch:
            _save_next_batch(response.next_batch)

    client.add_event_callback(on_message, RoomMessageText)
    client.add_event_callback(on_invite, InviteMemberEvent)
    client.add_response_callback(save_token_callback, SyncResponse)

    print(
        f"[Runner:{agent_id}] Started as {user_id} ({display_name}, {role})",
        file=sys.stderr,
    )
    print(f"[Runner:{agent_id}] Listening for direct messages", file=sys.stderr)

    _DM_LOOP_RUNNING = True
    try:
        while not _shutdown.is_set():
            try:
                await client.sync(timeout=30000, full_state=False,
                                  since=client.next_batch)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[Runner:{agent_id}] sync error: {exc}", file=sys.stderr)
                await asyncio.sleep(2)
    finally:
        _DM_LOOP_RUNNING = False
        try:
            await client.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

_args = argparse.Namespace()  # populated in main(), used by signal handler
_DM_LOOP_RUNNING = False      # set True while the async DM loop is alive


def _run_bp_dispatch(args) -> None:
    """Legacy P2 flow: load BP, build prompt, invoke claude once, commit+push."""
    if not args.branch:
        args.branch = f"agent/{args.agent_id}/{args.bp_hash}"

    print(f"[agent] BP dispatch: agent={args.agent_id} bp={args.bp_hash[:6]} mode={args.mode}",
          file=sys.stderr)

    verify_workspace(args.mode)

    if args.mode == "clone" and args.repo_url:
        print(f"[agent] Cloning {args.repo_url} branch {args.branch}...", file=sys.stderr)
        subprocess.run(
            ["git", "clone", "--depth=1", "--branch", args.branch,
             args.repo_url, str(REPO_DIR)],
            check=True,
        )

    configure_git_identity(args.agent_id)

    context = load_context(args.bp_hash)
    print(f"[agent] Loaded context: mission={context['mission'][:80]}",
          file=sys.stderr)

    system_prompt, user_prompt = build_agent_prompt(context, args.agent_id, args.bp_hash)

    print(f"[agent] Invoking Claude Code CLI...", file=sys.stderr)
    exit_code = run_agent(system_prompt, user_prompt)

    _shutdown.set()

    with _git_lock:
        _git_run(["add", "-A"], check=False)
        _git_run(
            ["commit", "-m",
             f"agent-complete(bp:{args.bp_hash[:6]}): exit={exit_code} "
             f"[agent:{args.agent_id}]"],
            check=False,
        )
        _git_run(["push", "origin", "HEAD"], check=False)

    print(f"[agent] Done: exit_code={exit_code}", file=sys.stderr)
    sys.exit(exit_code)


def main() -> None:
    global _args

    parser = argparse.ArgumentParser(
        description="Agent Execution Environment entrypoint",
    )
    # All optional: present-with-bp-hash → BP dispatch; absent → DM listener.
    parser.add_argument("--agent-id", default=None, help="8-char hex agent ID (BP mode)")
    parser.add_argument("--bp-hash", default=None, help="12-char hex BP hash (BP mode)")
    parser.add_argument(
        "--mode", choices=("bind", "clone", "image"), default="bind",
        help="Execution tier (default: bind)",
    )
    parser.add_argument("--repo-url", default=None, help="Git remote URL (clone mode)")
    parser.add_argument("--branch", default=None, help="Git branch name")

    _args = parser.parse_args()
    args = _args

    # Install SIGTERM handler shared by both modes.
    signal.signal(signal.SIGTERM, _handle_sigterm)

    if args.bp_hash:
        if not args.agent_id:
            print("ERROR: --agent-id is required when --bp-hash is given.", file=sys.stderr)
            sys.exit(1)
        _run_bp_dispatch(args)
        return

    # DM listener mode (P4 default).
    asyncio.run(run_dm_listener())


if __name__ == "__main__":
    main()
