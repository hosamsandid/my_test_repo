"""Tests for the FastAPI-based BP Explorer server.

Verifies all endpoints return correct status codes, content types, headers,
and JSON structure. Uses the FastAPI test client (httpx-based) so no real
server process is needed.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from server import (
    _first_paragraph,
    _parse_acceptance_criteria,
    app,
    discover_agent_branches,
    fetch_agent_refs_throttled,
    find_project_root,
    parse_frontmatter,
)
import server as server_module


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _set_project_root():
    """Discover the project root and store it in app.state before each test."""
    try:
        root = find_project_root(Path(__file__).parent)
    except FileNotFoundError:
        pytest.skip("No artifacts/briefings/ directory found; skipping integration tests")
    app.state.project_root = root
    yield


@pytest.fixture
def client():
    """Return a synchronous FastAPI TestClient."""
    return TestClient(app)


# ---------------------------------------------------------------------------
# Unit tests for business logic (unchanged functions)
# ---------------------------------------------------------------------------


class TestParseFrontmatter:
    """parse_frontmatter must remain byte-identical to the original."""

    def test_basic_key_value(self):
        text = "---\nid: abc123\ntitle: Hello\n---\nBody text"
        meta, body = parse_frontmatter(text)
        assert meta["id"] == "abc123"
        assert meta["title"] == "Hello"
        assert body == "Body text"

    def test_quoted_value(self):
        text = '---\ntitle: "Quoted Title"\n---\n'
        meta, _ = parse_frontmatter(text)
        assert meta["title"] == "Quoted Title"

    def test_empty_list(self):
        text = "---\nchildren: []\n---\n"
        meta, _ = parse_frontmatter(text)
        assert meta["children"] == []

    def test_string_list(self):
        text = "---\nitems:\n  - alpha\n  - beta\n---\n"
        meta, _ = parse_frontmatter(text)
        assert meta["items"] == ["alpha", "beta"]

    def test_object_list(self):
        text = "---\nartifacts:\n  - path: a.py\n    direction: output\n  - path: b.py\n    direction: input\n---\n"
        meta, _ = parse_frontmatter(text)
        assert len(meta["artifacts"]) == 2
        assert meta["artifacts"][0]["path"] == "a.py"
        assert meta["artifacts"][1]["direction"] == "input"

    def test_no_frontmatter(self):
        text = "Just plain text"
        meta, body = parse_frontmatter(text)
        assert meta == {}
        assert body == text


class TestFirstParagraph:
    def test_skips_headings(self):
        assert _first_paragraph("# Title\nParagraph") == "Paragraph"

    def test_skips_blockquotes(self):
        assert _first_paragraph("> Quote\nParagraph") == "Paragraph"

    def test_empty(self):
        assert _first_paragraph("") == ""


class TestParseAcceptanceCriteria:
    def test_parses_ac_lines(self):
        body = "- [ ] AC-1: **Title One** — Description one\n- [x] AC-2: **Title Two** — Description two"
        criteria = _parse_acceptance_criteria(body)
        assert len(criteria) == 2
        assert criteria[0]["code"] == "AC-1"
        assert criteria[0]["title"] == "Title One"
        assert criteria[1]["code"] == "AC-2"


# ---------------------------------------------------------------------------
# Integration tests for API endpoints
# ---------------------------------------------------------------------------


class TestIndexEndpoint:
    """GET / and /index.html must serve the HTML frontend."""

    def test_root_returns_html(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]

    def test_index_html_returns_html(self, client):
        resp = client.get("/index.html")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]

    def test_html_contains_expected_content(self, client):
        resp = client.get("/")
        assert b"<html" in resp.content or b"<!DOCTYPE" in resp.content.upper()


class TestBriefingsEndpoint:
    """GET /api/briefings must return JSON with indent=2 and correct headers."""

    def test_returns_json_list(self, client):
        resp = client.get("/api/briefings")
        assert resp.status_code == 200
        assert "application/json" in resp.headers["content-type"]
        data = resp.json()
        assert isinstance(data, list)

    def test_cache_control_header(self, client):
        resp = client.get("/api/briefings")
        assert resp.headers.get("cache-control") == "no-cache"

    def test_json_is_indented(self, client):
        resp = client.get("/api/briefings")
        # indent=2 means lines with leading spaces
        lines = resp.text.split("\n")
        assert any(line.startswith("  ") for line in lines), "JSON should be indented with 2 spaces"

    def test_briefing_has_expected_fields(self, client):
        resp = client.get("/api/briefings")
        data = resp.json()
        if data:
            bp = data[0]
            for field in ("id", "slug", "title", "status", "body"):
                assert field in bp, f"Missing field: {field}"


class TestPhasesEndpoint:
    """GET /api/phases must return JSON phase groups."""

    def test_returns_json_list(self, client):
        resp = client.get("/api/phases")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_cache_control_header(self, client):
        resp = client.get("/api/phases")
        assert resp.headers.get("cache-control") == "no-cache"

    def test_json_is_indented(self, client):
        resp = client.get("/api/phases")
        lines = resp.text.split("\n")
        assert any(line.startswith("  ") for line in lines)


class TestMrpEndpoint:
    """GET /api/mrp/{bp_id} must return 404 for unknown IDs."""

    def test_unknown_id_returns_404(self, client):
        resp = client.get("/api/mrp/nonexistent")
        assert resp.status_code == 404

    def test_404_response_is_json(self, client):
        resp = client.get("/api/mrp/nonexistent")
        assert "application/json" in resp.headers["content-type"]


class TestPreviewEndpoint:
    """GET /api/preview must validate paths and return file contents."""

    def test_missing_path_returns_400(self, client):
        resp = client.get("/api/preview?path=")
        assert resp.status_code == 400

    def test_missing_path_param_returns_400(self, client):
        resp = client.get("/api/preview")
        assert resp.status_code == 400

    def test_path_traversal_returns_403(self, client):
        resp = client.get("/api/preview?path=../../../etc/passwd")
        assert resp.status_code == 403

    def test_valid_file_returns_200(self, client):
        resp = client.get("/api/preview?path=CLAUDE.md")
        assert resp.status_code == 200
        data = resp.json()
        assert data["filename"] == "CLAUDE.md"
        assert data["suffix"] == ".md"
        assert isinstance(data["size"], int)
        assert isinstance(data["truncated"], bool)
        assert isinstance(data["content"], str)

    def test_preview_not_indented(self, client):
        """Preview JSON should be compact (no indent), matching original."""
        resp = client.get("/api/preview?path=CLAUDE.md")
        # Compact JSON is a single line (or at least doesn't have indented keys)
        assert not resp.text.startswith("{\n  ")

    def test_nonexistent_file_returns_404(self, client):
        resp = client.get("/api/preview?path=nonexistent.md")
        assert resp.status_code == 404

    def test_disallowed_extension_returns_403(self, client):
        resp = client.get("/api/preview?path=scripts/bp-explorer/server.pyc")
        # Either 403 (disallowed ext) or 404 (file not found) is acceptable
        assert resp.status_code in (403, 404)


class TestCorsHeaders:
    """CORS middleware must allow all origins."""

    def test_cors_origin_reflected(self, client):
        resp = client.get(
            "/api/briefings",
            headers={"Origin": "http://example.com"},
        )
        assert resp.headers.get("access-control-allow-origin") == "http://example.com"

    def test_cors_preflight(self, client):
        resp = client.options(
            "/api/briefings",
            headers={
                "Origin": "http://example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert "access-control-allow-origin" in resp.headers


class TestNotFound:
    """Unknown paths should return 404."""

    def test_unknown_path(self, client):
        resp = client.get("/nonexistent")
        assert resp.status_code == 404


class TestAsyncHandlers:
    """All route handlers must be declared async."""

    def test_all_handlers_are_async(self):
        import inspect

        for route in app.routes:
            if hasattr(route, "endpoint"):
                name = getattr(route.endpoint, "__name__", "unknown")
                # Skip internal FastAPI routes (openapi, docs, etc.)
                if name in ("openapi", "swagger_ui_html", "swagger_ui_redirect", "redoc_html"):
                    continue
                assert inspect.iscoroutinefunction(route.endpoint), (
                    f"Route handler {name} at {getattr(route, 'path', '?')} is not async"
                )


# ---------------------------------------------------------------------------
# Agent endpoint tests (AC-2, AC-3, AC-5, AC-6)
# ---------------------------------------------------------------------------


class TestAgentInvokeEndpoint:
    """POST /api/agent/invoke endpoint tests."""

    def test_no_bridge_returns_503(self, client):
        """When agent_bridge is None, return 503 (AC-5)."""
        app.state.agent_bridge = None
        resp = client.post(
            "/api/agent/invoke",
            json={"prompt": "hello"},
        )
        assert resp.status_code == 503
        assert "Agent SDK" in resp.json()["detail"]

    def test_missing_prompt_returns_422(self, client):
        """Missing required field returns 422 validation error."""
        app.state.agent_bridge = MagicMock()
        resp = client.post("/api/agent/invoke", json={})
        assert resp.status_code == 422

    def test_invoke_returns_event_stream(self, client):
        """Successful invoke returns text/event-stream (AC-2)."""
        pytest.importorskip("claude_agent_sdk", reason="claude-agent-sdk not installed")
        from agent_bridge import AgentEvent

        async def mock_invoke(prompt, **kwargs):
            yield AgentEvent(type="assistant_text", data={"text": "Hello"})
            yield AgentEvent(type="result", data={"session_id": "s1"})

        mock_bridge = MagicMock()
        mock_bridge.invoke = mock_invoke
        app.state.agent_bridge = mock_bridge

        resp = client.post(
            "/api/agent/invoke",
            json={"prompt": "test"},
        )
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]

        # Parse SSE events from the response body
        lines = resp.text.strip().split("\n\n")
        data_lines = [l for l in lines if l.startswith("data: ")]
        assert len(data_lines) >= 1

        # Verify first event is assistant_text
        first_payload = json.loads(data_lines[0][len("data: "):])
        assert first_payload["type"] == "assistant_text"


class TestAgentSessionsEndpoint:
    """GET /api/agent/sessions and DELETE /api/agent/sessions/{id}."""

    def test_list_sessions_no_bridge(self, client):
        """503 when bridge is unavailable (AC-5)."""
        app.state.agent_bridge = None
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 503

    def test_list_sessions_empty(self, client):
        """Empty list when no sessions exist (AC-3)."""
        mock_bridge = MagicMock()
        mock_bridge.list_sessions.return_value = []
        app.state.agent_bridge = mock_bridge
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_sessions_with_data(self, client):
        """Returns session data (AC-3)."""
        mock_bridge = MagicMock()
        mock_bridge.list_sessions.return_value = [
            {"session_id": "s1", "status": "active", "created_at": 1.0, "prompt": "test"},
        ]
        app.state.agent_bridge = mock_bridge
        resp = client.get("/api/agent/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["session_id"] == "s1"

    def test_cancel_session_no_bridge(self, client):
        """503 when bridge is unavailable (AC-5)."""
        app.state.agent_bridge = None
        resp = client.delete("/api/agent/sessions/s1")
        assert resp.status_code == 503

    def test_cancel_nonexistent_session(self, client):
        """404 when session not found (AC-3)."""
        mock_bridge = MagicMock()
        mock_bridge.cancel = AsyncMock(return_value=False)
        app.state.agent_bridge = mock_bridge
        resp = client.delete("/api/agent/sessions/nonexistent")
        assert resp.status_code == 404

    def test_cancel_active_session(self, client):
        """Successful cancel returns 200 (AC-3)."""
        mock_bridge = MagicMock()
        mock_bridge.cancel = AsyncMock(return_value=True)
        app.state.agent_bridge = mock_bridge
        resp = client.delete("/api/agent/sessions/s1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "cancelled"


class TestCrpDetectionEndpoint:
    """GET /api/crp/{bp_id} tests (AC-6)."""

    def test_no_crp_dir(self, client):
        """Returns exists=False when no CRP directory (AC-6)."""
        resp = client.get("/api/crp/nonexistent_bp")
        assert resp.status_code == 200
        data = resp.json()
        assert data["exists"] is False

    def test_crp_found(self, client, tmp_path):
        """Returns CRP data when found (AC-6)."""
        # Create a temporary CRP file
        crp_dir = app.state.project_root / "artifacts" / "guidance" / "crp"
        crp_dir.mkdir(parents=True, exist_ok=True)
        crp_file = crp_dir / "test123crp456.md"
        crp_file.write_text(
            "---\nbp: test_bp_id\nmode: blocking\n---\n\nCRP body content",
            encoding="utf-8",
        )

        try:
            resp = client.get("/api/crp/test_bp_id")
            assert resp.status_code == 200
            data = resp.json()
            assert data["exists"] is True
            assert "path" in data
            assert "CRP body content" in data["body"]
        finally:
            crp_file.unlink(missing_ok=True)

    def test_crp_not_matching(self, client):
        """Returns exists=False when no matching CRP (AC-6)."""
        crp_dir = app.state.project_root / "artifacts" / "guidance" / "crp"
        crp_dir.mkdir(parents=True, exist_ok=True)
        crp_file = crp_dir / "other_crp.md"
        crp_file.write_text(
            "---\nbp: other_bp\nmode: blocking\n---\n\nUnrelated CRP",
            encoding="utf-8",
        )

        try:
            resp = client.get("/api/crp/my_bp_id")
            assert resp.status_code == 200
            data = resp.json()
            assert data["exists"] is False
        finally:
            crp_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Agent branch discovery tests
# ---------------------------------------------------------------------------


class TestDiscoverAgentBranches:
    """discover_agent_branches must find both local and remote branches."""

    def test_parses_remote_branch(self):
        """Remote branch origin/agent/{8hex}/{12hex} is discovered."""
        git_output = "origin/agent/a1b2c3d4/e5f6a7b8c9d0\n"
        with patch("server.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout=git_output
            )
            branches = discover_agent_branches(Path("/fake"))
        assert "e5f6a7b8c9d0" in branches
        assert branches["e5f6a7b8c9d0"]["agent_id"] == "a1b2c3d4"
        assert branches["e5f6a7b8c9d0"]["source"] == "remote"

    def test_parses_local_branch(self):
        """Local branch agent/{8hex}/{12hex} is discovered."""
        # First call (local refs) returns a branch, second call (remote) returns empty
        def side_effect(cmd, **kwargs):
            if "refs/heads/agent/" in cmd:
                return MagicMock(returncode=0, stdout="agent/a1b2c3d4/e5f6a7b8c9d0\n")
            return MagicMock(returncode=0, stdout="")
        with patch("server.subprocess.run", side_effect=side_effect):
            branches = discover_agent_branches(Path("/fake"))
        assert "e5f6a7b8c9d0" in branches
        assert branches["e5f6a7b8c9d0"]["source"] == "local"

    def test_local_takes_precedence(self):
        """When same BP exists on both local and remote, local wins."""
        def side_effect(cmd, **kwargs):
            if "refs/heads/agent/" in cmd:
                return MagicMock(
                    returncode=0,
                    stdout="agent/aaaaaaaa/e5f6a7b8c9d0\n",
                )
            return MagicMock(
                returncode=0,
                stdout="origin/agent/bbbbbbbb/e5f6a7b8c9d0\n",
            )
        with patch("server.subprocess.run", side_effect=side_effect):
            branches = discover_agent_branches(Path("/fake"))
        assert branches["e5f6a7b8c9d0"]["source"] == "local"
        assert branches["e5f6a7b8c9d0"]["agent_id"] == "aaaaaaaa"

    def test_empty_output(self):
        """No branches returns empty dict."""
        with patch("server.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="")
            branches = discover_agent_branches(Path("/fake"))
        assert branches == {}

    def test_git_failure_returns_empty(self):
        """Git command failure returns empty dict gracefully."""
        with patch("server.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            branches = discover_agent_branches(Path("/fake"))
        assert branches == {}

    def test_subprocess_exception_returns_empty(self):
        """Exception during subprocess returns empty dict."""
        with patch("server.subprocess.run", side_effect=OSError("fail")):
            branches = discover_agent_branches(Path("/fake"))
        assert branches == {}

    def test_multiple_branches(self):
        """Multiple agent branches across local and remote are all found."""
        def side_effect(cmd, **kwargs):
            if "refs/heads/agent/" in cmd:
                return MagicMock(
                    returncode=0,
                    stdout="agent/11111111/aaaaaaaaaaaa\nagent/22222222/bbbbbbbbbbbb\n",
                )
            return MagicMock(
                returncode=0,
                stdout="origin/agent/33333333/cccccccccccc\n",
            )
        with patch("server.subprocess.run", side_effect=side_effect):
            branches = discover_agent_branches(Path("/fake"))
        assert len(branches) == 3
        assert "aaaaaaaaaaaa" in branches
        assert "bbbbbbbbbbbb" in branches
        assert "cccccccccccc" in branches


class TestFetchAgentRefsThrottled:
    """fetch_agent_refs_throttled must respect the throttle interval."""

    def setup_method(self):
        """Reset throttle state before each test."""
        server_module._last_fetch_time = 0.0

    def test_first_call_fetches(self):
        """First call should always fetch."""
        with patch("server.fetch_agent_refs") as mock_fetch:
            fetch_agent_refs_throttled(Path("/fake"))
            mock_fetch.assert_called_once()

    def test_rapid_second_call_skipped(self):
        """Second call within throttle window is skipped."""
        with patch("server.fetch_agent_refs") as mock_fetch:
            fetch_agent_refs_throttled(Path("/fake"))
            fetch_agent_refs_throttled(Path("/fake"))
            assert mock_fetch.call_count == 1

    def test_call_after_throttle_expires(self):
        """Call after throttle window expires should fetch again."""
        with patch("server.fetch_agent_refs") as mock_fetch:
            fetch_agent_refs_throttled(Path("/fake"))
            # Simulate time passing beyond throttle
            server_module._last_fetch_time -= server_module._FETCH_THROTTLE_SECONDS + 1
            fetch_agent_refs_throttled(Path("/fake"))
            assert mock_fetch.call_count == 2


class TestBriefingsEndpointFetch:
    """GET /api/briefings should trigger throttled agent ref fetch."""

    def test_briefings_calls_throttled_fetch(self, client):
        """Briefings endpoint should call fetch_agent_refs_throttled."""
        server_module._last_fetch_time = 0.0
        with patch("server.fetch_agent_refs_throttled") as mock_fetch:
            client.get("/api/briefings")
            mock_fetch.assert_called_once()
