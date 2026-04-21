"""Tests for the Agent Bridge module.

Validates the AgentBridge class, event formatting, message dispatch,
session management, error handling, and project context injection.
All SDK interactions are mocked -- no real Claude CLI calls are made.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_bridge import (
    AgentBridge,
    AgentEvent,
    SessionInfo,
    SessionStatus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class AsyncIterHelper:
    """Wrap a list as an async iterator for mocking receive_response()."""

    def __init__(self, items):
        self._items = iter(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._items)
        except StopIteration:
            raise StopAsyncIteration


# Create fake SDK types that are actual subclasses of the imported SDK types,
# so isinstance() works correctly in the bridge code.  We import the type
# references used by the bridge module itself.

from agent_bridge import (
    AssistantMessage,
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
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


def _make_assistant_msg(blocks):
    """Create a fake AssistantMessage with the given content blocks."""
    msg = MagicMock(spec=AssistantMessage)
    msg.content = blocks
    # Make isinstance checks work
    msg.__class__ = AssistantMessage
    return msg


def _make_text_block(text):
    block = MagicMock(spec=TextBlock)
    block.text = text
    block.__class__ = TextBlock
    return block


def _make_tool_use_block(name, tool_id, input_data):
    block = MagicMock(spec=ToolUseBlock)
    block.name = name
    block.id = tool_id
    block.input = input_data
    block.__class__ = ToolUseBlock
    return block


def _make_tool_result_block(tool_use_id, content):
    block = MagicMock(spec=ToolResultBlock)
    block.tool_use_id = tool_use_id
    block.content = content
    block.__class__ = ToolResultBlock
    return block


def _make_thinking_block(thinking):
    block = MagicMock(spec=ThinkingBlock)
    block.thinking = thinking
    block.__class__ = ThinkingBlock
    return block


def _make_result_msg(session_id="sdk-sess", text="Done"):
    msg = MagicMock(spec=ResultMessage)
    msg.session_id = session_id
    msg.text = text
    msg.__class__ = ResultMessage
    return msg


def _make_system_msg(text="System info"):
    msg = MagicMock(spec=SystemMessage)
    msg.text = text
    msg.__class__ = SystemMessage
    return msg


def _make_stream_event(text="partial"):
    msg = MagicMock(spec=StreamEvent)
    msg.text = text
    msg.__class__ = StreamEvent
    return msg


def _make_user_msg():
    msg = MagicMock(spec=UserMessage)
    msg.__class__ = UserMessage
    return msg


def _make_rate_limit_event(retry_after=5):
    msg = MagicMock(spec=RateLimitEvent)
    msg.retry_after = retry_after
    msg.__class__ = RateLimitEvent
    return msg


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_project(tmp_path):
    """Create a minimal project structure for testing."""
    (tmp_path / "artifacts" / "briefings").mkdir(parents=True)
    (tmp_path / "CLAUDE.md").write_text(
        "# Test Project\n\nInstructions here.", encoding="utf-8"
    )
    return tmp_path


@pytest.fixture
def bridge(tmp_project):
    """Return an AgentBridge instance with mocked prerequisites."""
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key-123"}):
        b = AgentBridge(tmp_project)
        return b


# ---------------------------------------------------------------------------
# AgentEvent
# ---------------------------------------------------------------------------

class TestAgentEvent:
    def test_to_sse_format(self):
        event = AgentEvent(type="assistant_text", data={"text": "hello"})
        sse = event.to_sse()
        assert sse.startswith("data: ")
        assert sse.endswith("\n\n")
        payload = json.loads(sse[len("data: "):-2])
        assert payload["type"] == "assistant_text"
        assert payload["text"] == "hello"

    def test_to_sse_unicode(self):
        event = AgentEvent(type="assistant_text", data={"text": "Umlaute: aou"})
        sse = event.to_sse()
        assert "Umlaute" in sse

    def test_to_sse_special_chars(self):
        event = AgentEvent(
            type="error",
            data={"message": 'contains "quotes" & <brackets>'},
        )
        sse = event.to_sse()
        payload = json.loads(sse[len("data: "):-2])
        assert payload["message"] == 'contains "quotes" & <brackets>'


# ---------------------------------------------------------------------------
# SessionInfo
# ---------------------------------------------------------------------------

class TestSessionInfo:
    def test_to_dict(self):
        info = SessionInfo(
            session_id="abc123",
            status=SessionStatus.ACTIVE,
            created_at=1000.0,
            prompt="test prompt" * 20,
        )
        d = info.to_dict()
        assert d["session_id"] == "abc123"
        assert d["status"] == "active"
        assert len(d["prompt"]) <= 120

    def test_to_dict_excludes_internal(self):
        info = SessionInfo(
            session_id="abc",
            status=SessionStatus.COMPLETED,
            created_at=1.0,
            prompt="p",
        )
        d = info.to_dict()
        assert "client" not in d
        assert "task" not in d


# ---------------------------------------------------------------------------
# AgentBridge.check_prerequisites (AC-5)
# ---------------------------------------------------------------------------

class TestCheckPrerequisites:
    def test_missing_api_key(self, tmp_project):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            b = AgentBridge(tmp_project)
            with pytest.raises(EnvironmentError, match="ANTHROPIC_API_KEY"):
                b.check_prerequisites()

    def test_api_key_present(self, tmp_project):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-test"}):
            b = AgentBridge(tmp_project)
            # Should not raise
            b.check_prerequisites()


# ---------------------------------------------------------------------------
# AgentBridge._build_system_prompt (AC-4)
# ---------------------------------------------------------------------------

class TestBuildSystemPrompt:
    def test_includes_claude_md(self, bridge):
        prompt = bridge._build_system_prompt()
        assert "Test Project" in prompt
        assert "Instructions here" in prompt

    def test_includes_briefings_dir(self, bridge):
        prompt = bridge._build_system_prompt()
        assert "briefings" in prompt

    def test_caches_result(self, bridge):
        p1 = bridge._build_system_prompt()
        p2 = bridge._build_system_prompt()
        assert p1 is p2

    def test_no_claude_md(self, tmp_path):
        (tmp_path / "artifacts" / "briefings").mkdir(parents=True)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "key"}):
            b = AgentBridge(tmp_path)
            prompt = b._build_system_prompt()
            assert "briefings" in prompt


# ---------------------------------------------------------------------------
# AgentBridge._build_options (AC-4)
# ---------------------------------------------------------------------------

class TestBuildOptions:
    @patch("agent_bridge.ClaudeAgentOptions")
    def test_default_options(self, mock_opts, bridge):
        bridge._build_options()
        mock_opts.assert_called_once()
        call_kwargs = mock_opts.call_args.kwargs
        assert call_kwargs["model"] == "claude-sonnet-4-6"
        assert call_kwargs["permission_mode"] == "acceptEdits"

    @patch("agent_bridge.ClaudeAgentOptions")
    def test_model_override(self, mock_opts, bridge):
        bridge._build_options(model="claude-opus-4")
        call_kwargs = mock_opts.call_args.kwargs
        assert call_kwargs["model"] == "claude-opus-4"

    @patch("agent_bridge.ClaudeAgentOptions")
    def test_session_resume(self, mock_opts, bridge):
        bridge._build_options(session_id="sess-123")
        call_kwargs = mock_opts.call_args.kwargs
        assert call_kwargs["resume"] == "sess-123"

    @patch("agent_bridge.ClaudeAgentOptions")
    def test_no_resume_without_session(self, mock_opts, bridge):
        bridge._build_options()
        call_kwargs = mock_opts.call_args.kwargs
        assert "resume" not in call_kwargs

    @patch("agent_bridge.ClaudeAgentOptions")
    def test_custom_system_prompt(self, mock_opts, bridge):
        bridge._build_options(system_prompt="Custom instructions")
        call_kwargs = mock_opts.call_args.kwargs
        assert call_kwargs["system_prompt"] == "Custom instructions"

    @patch("agent_bridge.ClaudeAgentOptions")
    def test_cwd_is_project_root(self, mock_opts, bridge):
        bridge._build_options()
        call_kwargs = mock_opts.call_args.kwargs
        assert call_kwargs["cwd"] == str(bridge._project_root)


# ---------------------------------------------------------------------------
# AgentBridge._dispatch_message (AC-1)
# ---------------------------------------------------------------------------

class TestDispatchMessage:
    """Verify isinstance-based dispatch over the Message union and block types."""

    @pytest.mark.asyncio
    async def test_assistant_text_block(self, bridge):
        """AssistantMessage with TextBlock -> assistant_text event."""
        block = _make_text_block("Hello world")
        msg = _make_assistant_msg([block])

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "assistant_text"
        assert events[0].data["text"] == "Hello world"

    @pytest.mark.asyncio
    async def test_assistant_tool_use_block(self, bridge):
        """AssistantMessage with ToolUseBlock -> tool_use event."""
        block = _make_tool_use_block("read_file", "tu-1", {"path": "/a.py"})
        msg = _make_assistant_msg([block])

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "tool_use"
        assert events[0].data["tool_name"] == "read_file"
        assert events[0].data["tool_id"] == "tu-1"

    @pytest.mark.asyncio
    async def test_assistant_tool_result_block(self, bridge):
        """AssistantMessage with ToolResultBlock -> tool_result event."""
        block = _make_tool_result_block("tu-1", "file contents")
        msg = _make_assistant_msg([block])

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "tool_result"
        assert events[0].data["tool_id"] == "tu-1"

    @pytest.mark.asyncio
    async def test_assistant_thinking_block(self, bridge):
        """AssistantMessage with ThinkingBlock -> thinking event."""
        block = _make_thinking_block("Let me consider...")
        msg = _make_assistant_msg([block])

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "thinking"
        assert events[0].data["text"] == "Let me consider..."

    @pytest.mark.asyncio
    async def test_assistant_multiple_blocks(self, bridge):
        """AssistantMessage with multiple blocks yields multiple events."""
        blocks = [
            _make_text_block("Step 1"),
            _make_tool_use_block("bash", "tu-2", {"cmd": "ls"}),
            _make_text_block("Step 2"),
        ]
        msg = _make_assistant_msg(blocks)

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 3
        assert events[0].type == "assistant_text"
        assert events[1].type == "tool_use"
        assert events[2].type == "assistant_text"

    @pytest.mark.asyncio
    async def test_result_message(self, bridge):
        """ResultMessage -> result event with session IDs."""
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.ACTIVE,
            created_at=time.time(),
            prompt="test",
        )
        msg = _make_result_msg(session_id="sdk-sess-1", text="Final")

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "result"
        assert events[0].data["session_id"] == "s1"
        assert events[0].data["sdk_session_id"] == "sdk-sess-1"
        # Verify SDK session ID was captured on session info
        assert bridge._sessions["s1"].sdk_session_id == "sdk-sess-1"

    @pytest.mark.asyncio
    async def test_system_message(self, bridge):
        """SystemMessage -> system event."""
        msg = _make_system_msg("Init complete")

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "system"

    @pytest.mark.asyncio
    async def test_stream_event(self, bridge):
        """StreamEvent -> assistant_text with streaming=True."""
        msg = _make_stream_event("part")

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "assistant_text"
        assert events[0].data.get("streaming") is True

    @pytest.mark.asyncio
    async def test_user_message_yields_nothing(self, bridge):
        """UserMessage is logged but not forwarded to SSE."""
        msg = _make_user_msg()

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_rate_limit_event(self, bridge):
        """RateLimitEvent -> rate_limit event."""
        msg = _make_rate_limit_event(retry_after=10)

        events = []
        async for e in bridge._dispatch_message(msg, "s1"):
            events.append(e)

        assert len(events) == 1
        assert events[0].type == "rate_limit"
        assert events[0].data["retry_after"] == 10


# ---------------------------------------------------------------------------
# AgentBridge.invoke (AC-1, AC-5)
# ---------------------------------------------------------------------------

class TestInvoke:
    @pytest.mark.asyncio
    async def test_invoke_cli_not_found(self, bridge):
        """CLINotFoundError -> error event with cli_not_found type (AC-5)."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.query = AsyncMock(side_effect=CLINotFoundError("not found"))

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            events = []
            async for e in bridge.invoke("test"):
                events.append(e)

        error_events = [e for e in events if e.type == "error"]
        assert len(error_events) >= 1
        assert error_events[0].data["error"] == "cli_not_found"

    @pytest.mark.asyncio
    async def test_invoke_process_error(self, bridge):
        """ProcessError -> error event with process_error type (AC-5)."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        err = ProcessError("failed")
        err.exit_code = 1
        err.stderr = "something went wrong"
        mock_client.query = AsyncMock(side_effect=err)

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            events = []
            async for e in bridge.invoke("test"):
                events.append(e)

        error_events = [e for e in events if e.type == "error"]
        assert len(error_events) >= 1
        assert error_events[0].data["error"] == "process_error"
        assert error_events[0].data["exit_code"] == 1

    @pytest.mark.asyncio
    async def test_invoke_json_decode_error(self, bridge):
        """CLIJSONDecodeError -> error event with json_decode_error type (AC-5)."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        err = CLIJSONDecodeError("bad json")
        err.line = "not-json-data"
        err.original_error = ValueError("bad")
        mock_client.query = AsyncMock(side_effect=err)

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            events = []
            async for e in bridge.invoke("test"):
                events.append(e)

        error_events = [e for e in events if e.type == "error"]
        assert len(error_events) >= 1
        assert error_events[0].data["error"] == "json_decode_error"

    @pytest.mark.asyncio
    async def test_invoke_connection_error(self, bridge):
        """CLIConnectionError -> error event with connection_error type (AC-5)."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.query = AsyncMock(
            side_effect=CLIConnectionError("conn failed")
        )

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            events = []
            async for e in bridge.invoke("test"):
                events.append(e)

        error_events = [e for e in events if e.type == "error"]
        assert len(error_events) >= 1
        assert error_events[0].data["error"] == "connection_error"

    @pytest.mark.asyncio
    async def test_invoke_tracks_session(self, bridge):
        """Invoke should track the session and mark completed on success."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.query = AsyncMock()
        mock_client.receive_response = MagicMock(
            return_value=AsyncIterHelper([])
        )

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            async for _ in bridge.invoke("test", session_id="my-session"):
                pass

        assert "my-session" in bridge._sessions
        assert bridge._sessions["my-session"].status == SessionStatus.COMPLETED

    @pytest.mark.asyncio
    async def test_invoke_unexpected_error(self, bridge):
        """Unexpected exception -> error event with unexpected type."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.query = AsyncMock(side_effect=RuntimeError("boom"))

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            events = []
            async for e in bridge.invoke("test"):
                events.append(e)

        error_events = [e for e in events if e.type == "error"]
        assert len(error_events) >= 1
        assert error_events[0].data["error"] == "unexpected"
        assert "boom" in error_events[0].data["message"]

    @pytest.mark.asyncio
    async def test_invoke_clears_client_ref(self, bridge):
        """After invoke completes, client reference is cleared (no leaks)."""
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.query = AsyncMock()
        mock_client.receive_response = MagicMock(
            return_value=AsyncIterHelper([])
        )

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            async for _ in bridge.invoke("test", session_id="cleanup-test"):
                pass

        assert bridge._sessions["cleanup-test"].client is None

    @pytest.mark.asyncio
    async def test_invoke_streams_messages(self, bridge):
        """Full integration: invoke streams text and result events."""
        text_block = _make_text_block("Hello!")
        assistant_msg = _make_assistant_msg([text_block])
        result_msg = _make_result_msg(session_id="sdk-1", text="Done")

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.query = AsyncMock()
        mock_client.receive_response = MagicMock(
            return_value=AsyncIterHelper([assistant_msg, result_msg])
        )

        with patch("agent_bridge.ClaudeSDKClient", return_value=mock_client):
            events = []
            async for e in bridge.invoke("test", session_id="stream-test"):
                events.append(e)

        types = [e.type for e in events]
        assert "assistant_text" in types
        assert "result" in types


# ---------------------------------------------------------------------------
# AgentBridge.cancel (AC-3)
# ---------------------------------------------------------------------------

class TestCancel:
    @pytest.mark.asyncio
    async def test_cancel_nonexistent(self, bridge):
        result = await bridge.cancel("nonexistent")
        assert result is False

    @pytest.mark.asyncio
    async def test_cancel_active_with_client(self, bridge):
        mock_client = AsyncMock()
        mock_client.interrupt = AsyncMock()
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.ACTIVE,
            created_at=time.time(),
            prompt="test",
            client=mock_client,
        )
        result = await bridge.cancel("s1")
        assert result is True
        mock_client.interrupt.assert_awaited_once()
        assert bridge._sessions["s1"].status == SessionStatus.CANCELLED

    @pytest.mark.asyncio
    async def test_cancel_completed_session(self, bridge):
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.COMPLETED,
            created_at=time.time(),
            prompt="test",
        )
        result = await bridge.cancel("s1")
        assert result is False

    @pytest.mark.asyncio
    async def test_cancel_fallback_to_task(self, bridge):
        mock_task = MagicMock()
        mock_task.cancel = MagicMock()
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.ACTIVE,
            created_at=time.time(),
            prompt="test",
            task=mock_task,
        )
        result = await bridge.cancel("s1")
        assert result is True
        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_cancel_interrupt_failure_fallback(self, bridge):
        """When interrupt() fails, falls back to task.cancel()."""
        mock_client = AsyncMock()
        mock_client.interrupt = AsyncMock(side_effect=RuntimeError("fail"))
        mock_task = MagicMock()
        mock_task.cancel = MagicMock()
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.ACTIVE,
            created_at=time.time(),
            prompt="test",
            client=mock_client,
            task=mock_task,
        )
        result = await bridge.cancel("s1")
        assert result is True
        mock_task.cancel.assert_called_once()


# ---------------------------------------------------------------------------
# AgentBridge.list_sessions / get_session (AC-3)
# ---------------------------------------------------------------------------

class TestListSessions:
    def test_empty(self, bridge):
        assert bridge.list_sessions() == []

    def test_with_sessions(self, bridge):
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.ACTIVE,
            created_at=1.0,
            prompt="test",
        )
        bridge._sessions["s2"] = SessionInfo(
            session_id="s2",
            status=SessionStatus.COMPLETED,
            created_at=2.0,
            prompt="test2",
        )
        sessions = bridge.list_sessions()
        assert len(sessions) == 2
        ids = {s["session_id"] for s in sessions}
        assert ids == {"s1", "s2"}

    def test_get_session_found(self, bridge):
        bridge._sessions["s1"] = SessionInfo(
            session_id="s1",
            status=SessionStatus.ACTIVE,
            created_at=1.0,
            prompt="test",
        )
        result = bridge.get_session("s1")
        assert result is not None
        assert result["session_id"] == "s1"

    def test_get_session_not_found(self, bridge):
        result = bridge.get_session("nonexistent")
        assert result is None
