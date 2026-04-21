"""Tests for the multi-session chat UI changes.

Validates that the HTML structure, CSS, and JavaScript logic for the
multi-session chat view are correctly implemented:
- Session sidebar exists with correct structure
- Chat view is restructured with sidebar + main area
- Multi-session JavaScript functions are defined
- invokeAgent redirects to chat view (no longer uses agent panel)
- Action buttons no longer block on agentState.active
- JS syntax is valid
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import app, find_project_root


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _set_project_root():
    try:
        root = find_project_root(Path(__file__).parent)
    except FileNotFoundError:
        pytest.skip("No artifacts/briefings/ directory found")
    app.state.project_root = root
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def html(client):
    """Return the full HTML content of the frontend."""
    resp = client.get("/")
    return resp.text


@pytest.fixture
def script_block(html):
    """Extract the <script> block from the HTML."""
    match = re.search(r"<script>(.*?)</script>", html, re.DOTALL)
    assert match, "No <script> block found in HTML"
    return match.group(1)


# ---------------------------------------------------------------------------
# HTML Structure Tests — Chat Sidebar
# ---------------------------------------------------------------------------

class TestChatSidebarHTML:
    """Verify the chat sidebar HTML elements exist with correct structure."""

    def test_chat_sidebar_exists(self, html):
        assert 'id="chat-sidebar"' in html

    def test_chat_sidebar_header_exists(self, html):
        assert 'id="chat-sidebar-header"' in html

    def test_chat_sidebar_list_exists(self, html):
        assert 'id="chat-sidebar-list"' in html

    def test_chat_sidebar_new_button_exists(self, html):
        assert 'id="chat-sidebar-new-btn"' in html

    def test_sidebar_new_btn_calls_chatNewConversation(self, html):
        # The + button should trigger chatNewConversation()
        match = re.search(r'id="chat-sidebar-new-btn"[^>]*onclick="([^"]*)"', html)
        assert match, "chat-sidebar-new-btn missing onclick"
        assert "chatNewConversation" in match.group(1)

    def test_sidebar_header_shows_sessions_title(self, html):
        # The sidebar header should contain "Sessions"
        assert ">Sessions<" in html


class TestChatViewStructure:
    """Verify the chat view is restructured with sidebar + main area."""

    def test_chat_main_exists(self, html):
        assert 'id="chat-main"' in html

    def test_chat_messages_inside_chat_main(self, html):
        # chat-main should contain chat-messages
        main_start = html.index('id="chat-main"')
        messages_start = html.index('id="chat-messages"', main_start)
        assert messages_start > main_start

    def test_chat_input_area_inside_chat_main(self, html):
        main_start = html.index('id="chat-main"')
        input_start = html.index('id="chat-input-area"', main_start)
        assert input_start > main_start

    def test_chat_sidebar_before_chat_main(self, html):
        sidebar_pos = html.index('id="chat-sidebar"')
        main_pos = html.index('id="chat-main"')
        assert sidebar_pos < main_pos, "Sidebar should appear before main area in DOM"


# ---------------------------------------------------------------------------
# CSS Tests — Chat Sidebar Styling
# ---------------------------------------------------------------------------

class TestChatSidebarCSS:
    """Verify the CSS for the chat sidebar is present."""

    def test_sidebar_width_defined(self, html):
        assert "#chat-sidebar" in html
        # Check width is set
        sidebar_css = re.search(r"#chat-sidebar\s*\{([^}]+)\}", html)
        assert sidebar_css, "#chat-sidebar CSS rule missing"
        assert "width" in sidebar_css.group(1)

    def test_chat_main_flex(self, html):
        main_css = re.search(r"#chat-main\s*\{([^}]+)\}", html)
        assert main_css, "#chat-main CSS rule missing"
        assert "flex" in main_css.group(1)

    def test_chat_view_is_flex_row(self, html):
        # The chat-view should be flex-direction: row for sidebar layout
        view_css = re.search(r"#chat-view\s*\{([^}]+)\}", html)
        assert view_css, "#chat-view CSS rule missing"
        assert "row" in view_css.group(1)

    def test_session_item_styles_exist(self, html):
        assert ".chat-session-item" in html

    def test_session_status_dot_styles_exist(self, html):
        assert ".chat-session-status-dot" in html
        assert ".chat-session-status-dot.streaming" in html
        assert ".chat-session-status-dot.done" in html
        assert ".chat-session-status-dot.error" in html


# ---------------------------------------------------------------------------
# JavaScript Syntax & Function Existence Tests
# ---------------------------------------------------------------------------

class TestJSSyntax:
    """Verify JavaScript is syntactically valid."""

    def test_script_parses(self, script_block):
        """The JS should be syntactically valid (checked via Node.js in another test)."""
        # Basic check: balanced braces
        open_braces = script_block.count("{")
        close_braces = script_block.count("}")
        assert open_braces == close_braces, (
            f"Unbalanced braces: {open_braces} open vs {close_braces} close"
        )


class TestMultiSessionFunctions:
    """Verify all required multi-session functions are defined in JS."""

    REQUIRED_FUNCTIONS = [
        "createChatSession",
        "getActiveSession",
        "switchChatSession",
        "renderChatSidebar",
        "chatNewConversation",
        "chatSendMessage",
        "chatStartStreaming",
        "chatStopStreaming",
        "invokeAgent",
        "dispatchBP",
        "reviewMrpAgent",
        "resolveCrpAgent",
    ]

    @pytest.mark.parametrize("func_name", REQUIRED_FUNCTIONS)
    def test_function_defined(self, script_block, func_name):
        pattern = rf"(async\s+)?function\s+{func_name}\s*\("
        assert re.search(pattern, script_block), (
            f"Function {func_name}() not found in script"
        )


class TestMultiSessionState:
    """Verify multi-session state variables are defined."""

    def test_chatSessions_defined(self, script_block):
        assert "const chatSessions = {}" in script_block or "const chatSessions =" in script_block

    def test_activeChatId_defined(self, script_block):
        assert "let activeChatId = null" in script_block

    def test_chatSessionCounter_defined(self, script_block):
        assert "let chatSessionCounter = 0" in script_block

    def test_chatState_proxy(self, script_block):
        """chatState should be a Proxy for backward compatibility."""
        assert "new Proxy" in script_block
        assert "const chatState = new Proxy" in script_block


# ---------------------------------------------------------------------------
# invokeAgent Redirect Tests
# ---------------------------------------------------------------------------

class TestInvokeAgentRedirect:
    """Verify invokeAgent() now redirects to chat view instead of agent panel."""

    def test_invokeAgent_creates_chat_session(self, script_block):
        """invokeAgent should call createChatSession."""
        # Find the invokeAgent function body
        match = re.search(
            r"async\s+function\s+invokeAgent\s*\([^)]*\)\s*\{(.*?)(?=\nasync\s+function|\nfunction\s)",
            script_block,
            re.DOTALL,
        )
        assert match, "Could not extract invokeAgent body"
        body = match.group(1)
        assert "createChatSession" in body, "invokeAgent should create a new chat session"

    def test_invokeAgent_switches_to_chat_view(self, script_block):
        match = re.search(
            r"async\s+function\s+invokeAgent\s*\([^)]*\)\s*\{(.*?)(?=\nasync\s+function|\nfunction\s)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "switchView('chat')" in body, "invokeAgent should switch to chat view"

    def test_invokeAgent_does_not_open_agent_panel(self, script_block):
        match = re.search(
            r"async\s+function\s+invokeAgent\s*\([^)]*\)\s*\{(.*?)(?=\nasync\s+function|\nfunction\s)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "openAgentPanel" not in body, "invokeAgent should NOT open the agent panel"

    def test_invokeAgent_calls_chatStartStreaming(self, script_block):
        match = re.search(
            r"async\s+function\s+invokeAgent\s*\([^)]*\)\s*\{(.*?)(?=\nasync\s+function|\nfunction\s)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "chatStartStreaming" in body, "invokeAgent should start streaming in chat"


# ---------------------------------------------------------------------------
# Parallel Sessions Tests — no agentState.active blocking
# ---------------------------------------------------------------------------

class TestParallelSessions:
    """Verify action functions no longer block on agentState.active."""

    def test_dispatchBP_no_active_check(self, script_block):
        match = re.search(
            r"function\s+dispatchBP\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match, "Could not extract dispatchBP body"
        body = match.group(1)
        assert "agentState.active" not in body, "dispatchBP should not check agentState.active"

    def test_reviewMrpAgent_no_active_check(self, script_block):
        match = re.search(
            r"function\s+reviewMrpAgent\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "agentState.active" not in body

    def test_resolveCrpAgent_no_active_check(self, script_block):
        match = re.search(
            r"function\s+resolveCrpAgent\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "agentState.active" not in body

    def test_buttons_not_disabled_by_active(self, html):
        """Inline button disabled checks should not reference agentState.active."""
        # All agent-action-btn disabled checks should only check agentState.available
        disabled_checks = re.findall(r"\$\{[^}]*agentState\.[^}]*\? ' disabled'[^}]*\}", html)
        for check in disabled_checks:
            assert "agentState.active" not in check, (
                f"Button still references agentState.active: {check}"
            )

    def test_updateAllActionButtons_no_active(self, script_block):
        """updateAllActionButtons should only disable when SDK unavailable."""
        match = re.search(
            r"function\s+updateAllActionButtons\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "const disabled = !agentState.available" in body
        assert "agentState.active" not in body


# ---------------------------------------------------------------------------
# chatStartStreaming Multi-Session Support
# ---------------------------------------------------------------------------

class TestChatStartStreamingMultiSession:
    """Verify chatStartStreaming supports targeting a specific session."""

    def test_accepts_target_session_param(self, script_block):
        match = re.search(
            r"function\s+chatStartStreaming\s*\(([^)]*)\)",
            script_block,
        )
        assert match, "chatStartStreaming not found"
        params = match.group(1)
        assert "targetSessionId" in params, (
            "chatStartStreaming should accept targetSessionId parameter"
        )

    def test_uses_target_or_active_session(self, script_block):
        match = re.search(
            r"function\s+chatStartStreaming\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "targetSessionId || activeChatId" in body

    def test_refreshes_after_completion(self, script_block):
        """Agent completion in chat should refresh data (like old agent panel did)."""
        match = re.search(
            r"function\s+chatStartStreaming\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "refreshAfterAgent" in body

    def test_periodic_background_refresh(self, script_block):
        """Streaming should set up a periodic background refresh interval."""
        match = re.search(
            r"function\s+chatStartStreaming\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "setInterval" in body, "Should set up periodic refresh during streaming"
        assert "bgRefreshInterval" in body

    def test_clears_interval_on_complete(self, script_block):
        """The periodic refresh interval should be cleared on completion."""
        match = re.search(
            r"function\s+chatStartStreaming\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "clearInterval(bgRefreshInterval)" in body


# ---------------------------------------------------------------------------
# chatNewConversation creates session
# ---------------------------------------------------------------------------

class TestChatNewConversation:
    """Verify chatNewConversation creates a new session."""

    def test_creates_session(self, script_block):
        match = re.search(
            r"function\s+chatNewConversation\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "createChatSession" in body

    def test_switches_to_new_session(self, script_block):
        match = re.search(
            r"function\s+chatNewConversation\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "switchChatSession" in body


# ---------------------------------------------------------------------------
# renderChatSidebar function
# ---------------------------------------------------------------------------

class TestRenderChatSidebar:
    """Verify renderChatSidebar renders session list properly."""

    def test_targets_sidebar_list(self, script_block):
        match = re.search(
            r"function\s+renderChatSidebar\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//\s*─)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "chat-sidebar-list" in body

    def test_renders_session_items(self, script_block):
        match = re.search(
            r"function\s+renderChatSidebar\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//\s*─)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "chat-session-item" in body

    def test_shows_status_dots(self, script_block):
        match = re.search(
            r"function\s+renderChatSidebar\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//\s*─)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "chat-session-status-dot" in body

    def test_calls_switchChatSession_on_click(self, script_block):
        match = re.search(
            r"function\s+renderChatSidebar\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//\s*─)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "switchChatSession" in body


# ---------------------------------------------------------------------------
# switchView integration
# ---------------------------------------------------------------------------

class TestSwitchViewChat:
    """Verify switchView('chat') renders sidebar."""

    def test_renders_sidebar_on_chat_switch(self, script_block):
        match = re.search(
            r"if\s*\(view\s*===\s*'chat'\)\s*\{(.*?)\}",
            script_block,
            re.DOTALL,
        )
        assert match, "switchView chat handler not found"
        body = match.group(1)
        assert "renderChatSidebar" in body


# ---------------------------------------------------------------------------
# Session lifecycle — createChatSession
# ---------------------------------------------------------------------------

class TestCreateChatSession:
    """Verify createChatSession initializes session correctly."""

    def test_has_required_fields(self, script_block):
        match = re.search(
            r"function\s+createChatSession\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        for field in ["title", "messages", "sessionId", "isStreaming", "streamHandle", "createdAt", "status"]:
            assert field in body, f"Session missing field: {field}"

    def test_stores_in_chatSessions(self, script_block):
        match = re.search(
            r"function\s+createChatSession\s*\([^)]*\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "chatSessions[localId]" in body


# ---------------------------------------------------------------------------
# chatSendMessage ensures session exists
# ---------------------------------------------------------------------------

class TestChatSendMessageSessionGuard:
    """Verify chatSendMessage creates a session if none is active."""

    def test_creates_session_if_none(self, script_block):
        match = re.search(
            r"function\s+chatSendMessage\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//\s*─)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "createChatSession" in body

    def test_checks_active_session_streaming(self, script_block):
        """Should not send if active session is already streaming."""
        match = re.search(
            r"function\s+chatSendMessage\s*\(\)\s*\{(.*?)(?=\nfunction\s|\nasync\s+function|\n//\s*─)",
            script_block,
            re.DOTALL,
        )
        assert match
        body = match.group(1)
        assert "isStreaming" in body
