"""Agent Bridge — wraps the Claude Agent SDK for session-based invocations.

Provides an ``AgentBridge`` class that manages Claude Agent SDK sessions,
streams structured events via async generators, and supports session
lifecycle operations (invoke, cancel, list).

Supports two execution modes:
- **Synchronous** (``invoke``): Agent runs within the HTTP request lifecycle.
- **Detached** (``start`` + ``stream_events``): Agent runs as a background
  asyncio task, surviving browser disconnects. Events are buffered in-memory
  and can be replayed from any offset for reconnect.

The bridge is designed to be used by FastAPI SSE endpoints in ``server.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, AsyncIterator

from claude_agent_sdk import (
    AssistantMessage,
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ProcessError,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

class SessionStatus(str, Enum):
    """Lifecycle states for an agent session."""
    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"


class SessionEventBuffer:
    """Thread-safe event buffer with async notification for new events.

    Stores all events in an in-memory list. Consumers can read from any
    offset and wait for new events via an ``asyncio.Condition``.
    """

    MAX_EVENTS = 50_000

    def __init__(self) -> None:
        self._events: list[AgentEvent] = []
        self._condition = asyncio.Condition()
        self._done = False

    async def append(self, event: AgentEvent) -> None:
        """Append an event and notify all waiting consumers."""
        async with self._condition:
            self._events.append(event)
            # Trim if over limit (keep recent half)
            if len(self._events) > self.MAX_EVENTS:
                self._events = self._events[self.MAX_EVENTS // 2:]
            self._condition.notify_all()

    async def mark_done(self) -> None:
        """Signal that no more events will be appended."""
        async with self._condition:
            self._done = True
            self._condition.notify_all()

    @property
    def is_done(self) -> bool:
        return self._done

    def __len__(self) -> int:
        return len(self._events)

    async def stream(self, offset: int = 0) -> AsyncIterator[AgentEvent]:
        """Yield events starting from *offset*, waiting for new ones.

        Terminates when the buffer is marked done and all events have
        been yielded.  Events are snapshot-copied inside the lock and
        yielded outside it so the producer is never blocked by a slow
        consumer.
        """
        idx = max(0, offset)
        while True:
            async with self._condition:
                # Wait until there are new events or the stream is done
                while idx >= len(self._events) and not self._done:
                    await self._condition.wait()

                # Snapshot new events and release the lock
                batch = self._events[idx:]
                idx = len(self._events)
                done = self._done

            # Yield outside the lock so append() is never blocked
            for event in batch:
                yield event

            if done:
                return


@dataclass
class SessionInfo:
    """Metadata about a tracked agent session."""
    session_id: str
    status: SessionStatus
    created_at: float
    prompt: str
    sdk_session_id: str | None = None
    client: ClaudeSDKClient | None = field(default=None, repr=False)
    task: asyncio.Task | None = field(default=None, repr=False)
    event_buffer: SessionEventBuffer = field(default_factory=SessionEventBuffer)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable summary (excludes internal objects)."""
        return {
            "session_id": self.session_id,
            "status": self.status.value,
            "created_at": self.created_at,
            "prompt": self.prompt[:120],
            "sdk_session_id": self.sdk_session_id,
            "event_count": len(self.event_buffer),
        }


@dataclass
class AgentEvent:
    """A structured event yielded by the agent bridge to the SSE layer."""
    type: str
    data: dict[str, Any]

    def to_sse(self) -> str:
        """Format as an SSE ``data:`` line."""
        payload = json.dumps({"type": self.type, **self.data}, ensure_ascii=False)
        return f"data: {payload}\n\n"


# ---------------------------------------------------------------------------
# AgentBridge
# ---------------------------------------------------------------------------

class AgentBridge:
    """High-level wrapper around the Claude Agent SDK.

    Manages sessions, streams structured events, and handles errors.

    Parameters
    ----------
    project_root:
        Absolute path to the project root. Passed as ``cwd`` to the SDK.
    default_model:
        Model to use when no override is provided.  Defaults to
        ``claude-sonnet-4-6`` (cost-efficient for interactive use).
    """

    DEFAULT_MODEL = "claude-sonnet-4-6"
    PERMISSION_MODE = "acceptEdits"

    def __init__(
        self,
        project_root: Path,
        *,
        default_model: str = DEFAULT_MODEL,
    ) -> None:
        self._project_root = project_root
        self._default_model = default_model
        self._sessions: dict[str, SessionInfo] = {}
        self._system_prompt: str | None = None

    # -- public interface ---------------------------------------------------

    def check_prerequisites(self) -> None:
        """Validate that the runtime environment is ready.

        Raises
        ------
        EnvironmentError
            If ``ANTHROPIC_API_KEY`` is not set.
        CLINotFoundError
            If the Claude Code CLI cannot be located.
        """
        has_api_key = (
            os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("ANTHROPIC_FOUNDRY_API_KEY")
        )
        if not has_api_key:
            raise EnvironmentError(
                "No Anthropic API key found. Set ANTHROPIC_API_KEY or "
                "ANTHROPIC_FOUNDRY_API_KEY before starting the server."
            )

    def _build_system_prompt(self) -> str:
        """Build a system prompt with project context."""
        if self._system_prompt is not None:
            return self._system_prompt

        parts: list[str] = []

        # Load CLAUDE.md if available
        claude_md = self._project_root / "CLAUDE.md"
        if claude_md.exists():
            content = claude_md.read_text(encoding="utf-8")
            parts.append(f"# Project Instructions (CLAUDE.md)\n\n{content}")

        # Add briefings directory location
        briefings_dir = self._project_root / "artifacts" / "briefings"
        if briefings_dir.is_dir():
            parts.append(
                f"# Project Structure\n\n"
                f"Briefing packs are located at: {briefings_dir}\n"
                f"Project root: {self._project_root}\n"
            )

        self._system_prompt = "\n\n---\n\n".join(parts) if parts else ""
        return self._system_prompt

    def _build_options(
        self,
        *,
        system_prompt: str | None = None,
        model: str | None = None,
        session_id: str | None = None,
    ) -> ClaudeAgentOptions:
        """Build ``ClaudeAgentOptions`` with project context injection (AC-4)."""
        effective_system = system_prompt or self._build_system_prompt()
        return ClaudeAgentOptions(
            cwd=str(self._project_root),
            system_prompt=effective_system,
            model=model or self._default_model,
            permission_mode=self.PERMISSION_MODE,
            **({"resume": session_id} if session_id else {}),
        )

    # -- detached execution -------------------------------------------------

    async def start(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        session_id: str | None = None,
        model: str | None = None,
    ) -> str:
        """Start an agent as a detached background task.

        Returns the session ID immediately. The agent runs independently
        of any HTTP connection. Use ``stream_events()`` to consume events.
        """
        internal_id = session_id or str(uuid.uuid4())

        # For follow-ups, resolve the SDK session ID for resume
        sdk_resume_id = None
        if session_id:
            prev = self._sessions.get(session_id)
            if prev and prev.sdk_session_id:
                sdk_resume_id = prev.sdk_session_id

        options = self._build_options(
            system_prompt=system_prompt,
            model=model,
            session_id=sdk_resume_id,
        )

        info = SessionInfo(
            session_id=internal_id,
            status=SessionStatus.ACTIVE,
            created_at=time.time(),
            prompt=prompt,
        )
        self._sessions[internal_id] = info

        async def _run() -> None:
            """Background coroutine that drives the agent and buffers events."""
            try:
                async with ClaudeSDKClient(options=options) as client:
                    info.client = client
                    await client.query(prompt)

                    async for message in client.receive_response():
                        async for event in self._dispatch_message(message, internal_id):
                            await info.event_buffer.append(event)

                info.status = SessionStatus.COMPLETED

            except CLINotFoundError as exc:
                info.status = SessionStatus.ERROR
                logger.error("Claude CLI not found: %s", exc)
                await info.event_buffer.append(AgentEvent(
                    type="error",
                    data={"error": "cli_not_found", "message": str(exc)},
                ))

            except CLIConnectionError as exc:
                info.status = SessionStatus.ERROR
                logger.error("CLI connection error: %s", exc)
                await info.event_buffer.append(AgentEvent(
                    type="error",
                    data={"error": "connection_error", "message": str(exc)},
                ))

            except ProcessError as exc:
                info.status = SessionStatus.ERROR
                logger.error("Process error (exit=%s): %s", exc.exit_code, exc.stderr)
                await info.event_buffer.append(AgentEvent(
                    type="error",
                    data={"error": "process_error", "message": str(exc),
                          "exit_code": exc.exit_code, "stderr": exc.stderr},
                ))

            except CLIJSONDecodeError as exc:
                info.status = SessionStatus.ERROR
                logger.error("JSON decode error on line %r: %s", exc.line, exc.original_error)
                await info.event_buffer.append(AgentEvent(
                    type="error",
                    data={"error": "json_decode_error", "message": str(exc), "line": exc.line},
                ))

            except asyncio.CancelledError:
                info.status = SessionStatus.CANCELLED
                logger.info("Session %s cancelled", internal_id)
                await info.event_buffer.append(AgentEvent(
                    type="error",
                    data={"error": "cancelled", "message": "Session was cancelled"},
                ))

            except Exception as exc:
                info.status = SessionStatus.ERROR
                logger.exception("Unexpected error in session %s", internal_id)
                await info.event_buffer.append(AgentEvent(
                    type="error",
                    data={"error": "unexpected", "message": str(exc)},
                ))

            finally:
                info.client = None
                await info.event_buffer.mark_done()

        info.task = asyncio.create_task(_run())
        logger.info("Started detached session %s", internal_id)
        return internal_id

    async def stream_events(
        self, session_id: str, *, offset: int = 0
    ) -> AsyncIterator[AgentEvent]:
        """Stream events from a detached session's buffer.

        Supports reconnect: pass *offset* to skip already-received events.
        Yields events as they arrive and terminates when the session completes.
        """
        info = self._sessions.get(session_id)
        if info is None:
            yield AgentEvent(
                type="error",
                data={"error": "not_found", "message": f"Session {session_id} not found"},
            )
            return

        async for event in info.event_buffer.stream(offset):
            yield event

    # -- synchronous invoke (kept for chat follow-ups) ----------------------

    async def invoke(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        session_id: str | None = None,
        model: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Invoke a Claude agent and yield structured events.

        This is an async generator designed to be consumed by an SSE endpoint.
        It handles the full lifecycle: connect, stream, finalize, error.

        Parameters
        ----------
        prompt:
            The user prompt to send to the agent.
        system_prompt:
            Optional override for the default project-context system prompt.
        session_id:
            If provided, resumes an existing session for multi-turn.
        model:
            Optional model override (default: ``claude-sonnet-4-6``).

        Yields
        ------
        AgentEvent
            Structured events with types: ``assistant_text``, ``tool_use``,
            ``tool_result``, ``thinking``, ``result``, ``error``,
            ``rate_limit``, ``system``.
        """
        internal_id = session_id or str(uuid.uuid4())

        # For follow-ups, resolve the SDK session ID for resume
        sdk_resume_id = None
        if session_id:
            prev = self._sessions.get(session_id)
            if prev and prev.sdk_session_id:
                sdk_resume_id = prev.sdk_session_id

        options = self._build_options(
            system_prompt=system_prompt,
            model=model,
            session_id=sdk_resume_id,
        )

        session_info = SessionInfo(
            session_id=internal_id,
            status=SessionStatus.ACTIVE,
            created_at=time.time(),
            prompt=prompt,
        )
        self._sessions[internal_id] = session_info

        try:
            async with ClaudeSDKClient(options=options) as client:
                session_info.client = client
                await client.query(prompt)

                async for message in client.receive_response():
                    async for event in self._dispatch_message(message, internal_id):
                        yield event

            session_info.status = SessionStatus.COMPLETED

        except CLINotFoundError as exc:
            session_info.status = SessionStatus.ERROR
            logger.error("Claude CLI not found: %s", exc)
            yield AgentEvent(
                type="error",
                data={
                    "error": "cli_not_found",
                    "message": (
                        "Claude Code CLI is not installed. "
                        "Install with: pip install claude-agent-sdk"
                    ),
                },
            )

        except CLIConnectionError as exc:
            session_info.status = SessionStatus.ERROR
            logger.error("CLI connection error: %s", exc)
            yield AgentEvent(
                type="error",
                data={
                    "error": "connection_error",
                    "message": str(exc),
                },
            )

        except ProcessError as exc:
            session_info.status = SessionStatus.ERROR
            logger.error(
                "Process error (exit=%s): %s", exc.exit_code, exc.stderr
            )
            yield AgentEvent(
                type="error",
                data={
                    "error": "process_error",
                    "message": str(exc),
                    "exit_code": exc.exit_code,
                    "stderr": exc.stderr,
                },
            )

        except CLIJSONDecodeError as exc:
            session_info.status = SessionStatus.ERROR
            logger.error("JSON decode error on line %r: %s", exc.line, exc.original_error)
            yield AgentEvent(
                type="error",
                data={
                    "error": "json_decode_error",
                    "message": str(exc),
                    "line": exc.line,
                },
            )

        except asyncio.CancelledError:
            session_info.status = SessionStatus.CANCELLED
            logger.info("Session %s cancelled", internal_id)
            yield AgentEvent(
                type="error",
                data={
                    "error": "cancelled",
                    "message": "Session was cancelled",
                },
            )

        except Exception as exc:
            session_info.status = SessionStatus.ERROR
            logger.exception("Unexpected error in session %s", internal_id)
            yield AgentEvent(
                type="error",
                data={
                    "error": "unexpected",
                    "message": str(exc),
                },
            )

        finally:
            session_info.client = None

    async def cancel(self, session_id: str) -> bool:
        """Cancel a running agent session.

        Attempts ``ClaudeSDKClient.interrupt()`` first, then falls back to
        ``asyncio.Task.cancel()``.

        Returns
        -------
        bool
            True if the session was found and cancellation was initiated.
        """
        info = self._sessions.get(session_id)
        if info is None:
            return False

        if info.status != SessionStatus.ACTIVE:
            return False

        # Try SDK interrupt first
        if info.client is not None:
            try:
                await info.client.interrupt()
                info.status = SessionStatus.CANCELLED
                return True
            except Exception:
                logger.warning(
                    "interrupt() failed for session %s, trying task cancel",
                    session_id,
                )

        # Fallback: cancel the asyncio task
        if info.task is not None:
            info.task.cancel()
            info.status = SessionStatus.CANCELLED
            return True

        return False

    def list_sessions(self) -> list[dict[str, Any]]:
        """Return metadata for all tracked sessions."""
        return [info.to_dict() for info in self._sessions.values()]

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Return metadata for a single session, or None if not found."""
        info = self._sessions.get(session_id)
        return info.to_dict() if info else None

    # -- internal dispatch --------------------------------------------------

    async def _dispatch_message(
        self, message: Any, session_id: str
    ) -> AsyncIterator[AgentEvent]:
        """Map an SDK ``Message`` to one or more ``AgentEvent`` objects.

        Uses ``isinstance`` checks over the Message union type and content
        block types as specified in AC-1.
        """
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    yield AgentEvent(
                        type="assistant_text",
                        data={"text": block.text},
                    )
                elif isinstance(block, ToolUseBlock):
                    yield AgentEvent(
                        type="tool_use",
                        data={
                            "tool_name": block.name,
                            "tool_id": block.id,
                            "input": block.input,
                        },
                    )
                elif isinstance(block, ToolResultBlock):
                    yield AgentEvent(
                        type="tool_result",
                        data={
                            "tool_id": block.tool_use_id,
                            "content": block.content,
                        },
                    )
                elif isinstance(block, ThinkingBlock):
                    yield AgentEvent(
                        type="thinking",
                        data={"text": block.thinking},
                    )
                else:
                    logger.debug(
                        "Unknown content block type: %s", type(block).__name__
                    )

        elif isinstance(message, ResultMessage):
            # Capture SDK session ID for resume-based multi-turn
            info = self._sessions.get(session_id)
            if info is not None and hasattr(message, "session_id"):
                info.sdk_session_id = message.session_id

            yield AgentEvent(
                type="result",
                data={
                    "session_id": session_id,
                    "sdk_session_id": getattr(message, "session_id", None),
                    "text": getattr(message, "text", ""),
                },
            )

        elif isinstance(message, SystemMessage):
            yield AgentEvent(
                type="system",
                data={"text": getattr(message, "text", str(message))},
            )

        elif isinstance(message, StreamEvent):
            # Partial streaming tokens
            yield AgentEvent(
                type="assistant_text",
                data={"text": getattr(message, "text", ""), "streaming": True},
            )

        elif isinstance(message, UserMessage):
            # Forward any tool results embedded in user messages (the Claude
            # API convention puts ToolResultBlocks in user-role messages).
            for block in getattr(message, "content", []):
                if isinstance(block, ToolResultBlock):
                    yield AgentEvent(
                        type="tool_result",
                        data={
                            "tool_id": block.tool_use_id,
                            "content": block.content,
                        },
                    )
            logger.debug("UserMessage in session %s: %s", session_id, message)

        elif isinstance(message, RateLimitEvent):
            yield AgentEvent(
                type="rate_limit",
                data={
                    "message": str(message),
                    "retry_after": getattr(message, "retry_after", None),
                },
            )

        else:
            logger.warning("Unknown message type: %s", type(message).__name__)
