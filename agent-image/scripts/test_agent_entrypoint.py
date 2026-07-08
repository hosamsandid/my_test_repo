#!/usr/bin/env python3
"""Unit tests for the pure helpers in agent-entrypoint.py.

The entrypoint has no heavy top-level imports (matrix-nio / markdown / croniter
are imported lazily inside functions), so the module loads with the standard
library alone. Run with:

    python3 -m unittest agent-image/scripts/test_agent_entrypoint.py

or directly:

    python3 agent-image/scripts/test_agent_entrypoint.py
"""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

_MODULE_PATH = Path(__file__).resolve().parent / "agent-entrypoint.py"
_spec = importlib.util.spec_from_file_location("agent_entrypoint", _MODULE_PATH)
entrypoint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(entrypoint)

fmt = entrypoint._format_ask_user_question
github_event_detail = entrypoint.TriggerScheduler._github_event_detail


class FormatAskUserQuestion(unittest.TestCase):
    def test_single_question_with_descriptions(self):
        out = fmt({
            "questions": [{
                "header": "Auth method",
                "question": "Which auth method should we use?",
                "options": [
                    {"label": "OAuth", "description": "Delegated login via provider"},
                    {"label": "API key", "description": "Static bearer token"},
                ],
            }],
        })
        self.assertIn("**Auth method**", out)
        self.assertIn("Which auth method should we use?", out)
        self.assertIn("- **OAuth** — Delegated login via provider", out)
        self.assertIn("- **API key** — Static bearer token", out)
        self.assertNotIn("{", out)  # human-readable, not raw JSON

    def test_multiple_questions_all_included(self):
        out = fmt({
            "questions": [
                {"header": "Q1", "question": "First?", "options": [{"label": "A"}]},
                {"header": "Q2", "question": "Second?", "options": [{"label": "B"}]},
            ],
        })
        for token in ("**Q1**", "First?", "**Q2**", "Second?", "- **A**", "- **B**"):
            self.assertIn(token, out)

    def test_option_without_description_omits_dash(self):
        out = fmt({"questions": [
            {"header": "H", "question": "Pick", "options": [{"label": "Only"}]},
        ]})
        self.assertIn("- **Only**", out)
        self.assertNotIn("- **Only** —", out)

    def test_multiselect_hint(self):
        out = fmt({"questions": [{
            "header": "H", "question": "Pick some", "multiSelect": True,
            "options": [{"label": "A"}, {"label": "B"}],
        }]})
        self.assertIn("pick more than one", out)

    def test_non_multiselect_omits_hint(self):
        out = fmt({"questions": [
            {"header": "H", "question": "Pick one", "options": [{"label": "A"}]},
        ]})
        self.assertNotIn("pick more than one", out)

    def test_answer_hint_present(self):
        out = fmt({"questions": [
            {"header": "H", "question": "Q", "options": [{"label": "A"}]},
        ]})
        self.assertIn("Reply here to answer", out)

    def test_invalid_inputs_return_none(self):
        for bad in (None, "nope", 42, {}, {"questions": []}, {"questions": "x"}):
            self.assertIsNone(fmt(bad))

    def test_all_empty_questions_return_none(self):
        self.assertIsNone(fmt({"questions": [{}, {"options": []}]}))

    def test_malformed_options_skipped(self):
        out = fmt({"questions": [{
            "header": "H", "question": "Q",
            "options": [None, "bad", {"description": "no label"}, {"label": "Good"}],
        }]})
        self.assertIn("- **Good**", out)
        self.assertNotIn("no label", out)


class GithubEventDetail(unittest.TestCase):
    def test_issues_event_includes_number_title_url(self):
        detail = github_event_detail("issues.labeled", {
            "issue": {"number": 470, "title": "Fix login bug",
                       "html_url": "https://github.com/o/r/issues/470"},
        })
        self.assertEqual(
            detail, "Issue #470: Fix login bug — https://github.com/o/r/issues/470")

    def test_pull_request_event_includes_number_title_url(self):
        detail = github_event_detail("pull_request.opened", {
            "pull_request": {"number": 12, "title": "Add feature",
                              "html_url": "https://github.com/o/r/pull/12"},
        })
        self.assertEqual(
            detail, "PR #12: Add feature — https://github.com/o/r/pull/12")

    def test_pull_request_review_event_uses_pull_request_key(self):
        detail = github_event_detail("pull_request_review.submitted", {
            "pull_request": {"number": 12, "title": "Add feature",
                              "html_url": "https://github.com/o/r/pull/12"},
        })
        self.assertEqual(
            detail, "PR #12: Add feature — https://github.com/o/r/pull/12")

    def test_push_event_includes_branch(self):
        detail = github_event_detail("push", {"ref": "refs/heads/main"})
        self.assertEqual(detail, "branch `main`")

    def test_push_event_includes_short_sha_when_present(self):
        detail = github_event_detail("push", {
            "ref": "refs/heads/main", "head": "abcdef1234567890",
        })
        self.assertEqual(detail, "branch `main` @ `abcdef1`")

    def test_unrecognized_event_returns_none(self):
        self.assertIsNone(github_event_detail("release.published", {"release": {}}))

    def test_missing_fields_returns_none(self):
        self.assertIsNone(github_event_detail("issues.labeled", {"issue": {"number": 1}}))
        self.assertIsNone(github_event_detail("pull_request.opened", {}))
        self.assertIsNone(github_event_detail("push", {}))

    def test_non_dict_payload_does_not_raise(self):
        self.assertIsNone(github_event_detail("issues.labeled", {"issue": "not-a-dict"}))


class PostTriggerNotice(unittest.IsolatedAsyncioTestCase):
    def _scheduler(self):
        client = AsyncMock()
        return entrypoint.TriggerScheduler(
            client=client, agent_id="agent-1", user_id="@agent-1:local",
            send_formatted=None, blueprint_id=None,
        ), client

    async def test_issues_event_body_includes_detail_and_description(self):
        scheduler, client = self._scheduler()
        trigger = {"id": "t1", "type": "github-event", "description": "BA marked ready"}
        ctx = {"github": {
            "event": "issues.labeled",
            "repo": "o/r",
            "payload": {"issue": {"number": 470, "title": "Fix login bug",
                                   "html_url": "https://github.com/o/r/issues/470"}},
        }}
        await scheduler._post_trigger_notice(trigger, ctx, "!room:local")
        body = client.room_send.call_args.kwargs["content"]["body"]
        self.assertIn("Issue #470: Fix login bug", body)
        self.assertIn("https://github.com/o/r/issues/470", body)
        self.assertIn("BA marked ready", body)

    async def test_push_event_body_includes_branch(self):
        scheduler, client = self._scheduler()
        trigger = {"id": "t1", "type": "github-event"}
        ctx = {"github": {"event": "push", "repo": "o/r",
                           "payload": {"ref": "refs/heads/feature/x"}}}
        await scheduler._post_trigger_notice(trigger, ctx, "!room:local")
        body = client.room_send.call_args.kwargs["content"]["body"]
        self.assertIn("branch `feature/x`", body)

    async def test_missing_payload_falls_back_to_legacy_body(self):
        scheduler, client = self._scheduler()
        trigger = {"id": "t1", "type": "github-event", "description": "desc"}
        ctx = {"github": {"event": "release.published", "repo": "o/r"}}
        await scheduler._post_trigger_notice(trigger, ctx, "!room:local")
        body = client.room_send.call_args.kwargs["content"]["body"]
        self.assertEqual(
            body, "⚡ Trigger fired (GitHub: `release.published` on `o/r`) — desc — starting work…")

    async def test_cron_and_http_notices_unchanged(self):
        scheduler, client = self._scheduler()
        await scheduler._post_trigger_notice(
            {"id": "c1", "type": "cron", "description": "nightly"}, None, "!room:local")
        cron_body = client.room_send.call_args.kwargs["content"]["body"]
        self.assertEqual(cron_body, "⚡ Trigger fired (cron: `c1`) — nightly — starting work…")

        await scheduler._post_trigger_notice(
            {"id": "h1", "type": "http", "description": "hook"}, None, "!room:local")
        http_body = client.room_send.call_args.kwargs["content"]["body"]
        self.assertEqual(http_body, "⚡ Trigger fired (HTTP: `h1`) — hook — starting work…")

    async def test_io_aee_trigger_content_unchanged(self):
        scheduler, client = self._scheduler()
        ctx = {"github": {"event": "issues.opened", "repo": "o/r",
                           "payload": {"issue": {"number": 1, "title": "T",
                                                  "html_url": "https://x/1"}}}}
        await scheduler._post_trigger_notice(
            {"id": "g1", "type": "github-event"}, ctx, "!room:local")
        content = client.room_send.call_args.kwargs["content"]
        self.assertEqual(content["io.aee.trigger"],
                          {"triggerId": "g1", "triggerType": "github-event",
                           "event": "issues.opened"})


if __name__ == "__main__":
    unittest.main()
