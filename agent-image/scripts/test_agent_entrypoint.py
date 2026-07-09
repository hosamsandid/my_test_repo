#!/usr/bin/env python3
"""Unit tests for the pure helpers in agent-entrypoint.py.

The entrypoint has no heavy top-level imports (matrix-nio / markdown / croniter
are imported lazily inside functions), so the module loads with the standard
library alone. Run with:

    python3 -m unittest agent-image/scripts/test_agent_entrypoint.py

or directly:

    python3 agent-image/scripts/test_agent_entrypoint.py
"""
import asyncio
import importlib.util
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

_MODULE_PATH = Path(__file__).resolve().parent / "agent-entrypoint.py"
_spec = importlib.util.spec_from_file_location("agent_entrypoint", _MODULE_PATH)
entrypoint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(entrypoint)

fmt = entrypoint._format_ask_user_question
github_event_detail = entrypoint.TriggerScheduler._github_event_detail
map_stream_json_line = entrypoint._map_stream_json_line


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


class DescribeInFlightMarker(unittest.TestCase):
    """#506: human-readable detail used in the crash-reconciliation notice."""

    def test_once_marker(self):
        self.assertEqual(
            entrypoint.TriggerScheduler._describe_in_flight_marker(
                {"kind": "once", "triggerId": "o1"}),
            "one-shot trigger `o1`",
        )

    def test_pending_http_marker(self):
        self.assertEqual(
            entrypoint.TriggerScheduler._describe_in_flight_marker(
                {"kind": "pending", "triggerId": "h1", "triggerType": "http"}),
            "http trigger `h1`",
        )

    def test_pending_github_event_marker(self):
        self.assertEqual(
            entrypoint.TriggerScheduler._describe_in_flight_marker({
                "kind": "pending", "triggerId": "t-gh", "triggerType": "github-event",
                "repo": "o/r", "event": "issues.labeled",
            }),
            "github-event trigger `t-gh` (`issues.labeled` on `o/r`)",
        )


class InFlightMarkerReconciliation(unittest.IsolatedAsyncioTestCase):
    """#506: crash reconciliation for the pending-queue-drain race (Race 1)
    and the once-trigger-removal race (Race 2) — durable markers must be
    written before the risky mutation, cleared once execution genuinely
    completes, and surfaced as a visible notice if still present at the next
    scheduler startup."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.workdir = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)
        patcher = patch.object(entrypoint, "_agent_workdir", return_value=self.workdir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _scheduler(self):
        client = AsyncMock()
        send_formatted = AsyncMock(return_value="$evt")
        scheduler = entrypoint.TriggerScheduler(
            client=client, agent_id="agent-1", user_id="@agent-1:local",
            send_formatted=send_formatted, blueprint_id=None,
        )
        return scheduler, client, send_formatted

    def _write_dm_room(self):
        entrypoint._atomic_write_json(self.workdir / "dm-room.json", {"roomId": "!room:local"})

    async def _drain_all_tasks(self):
        for t in [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]:
            await t

    # -- Race 1: pending-queue drain -----------------------------------------

    def test_attach_pending_markers_marks_http_and_github_event_entries_only(self):
        entries = [
            {"triggerId": "t-http"},
            {"triggerId": "t-gh", "github": {"event": "issues.labeled", "repo": "o/r", "eventId": 1}},
            {"kind": "handover-dm", "roomId": "!x", "body": "hi"},
            {"kind": "session-reset", "roomId": "!x"},
        ]
        entrypoint.TriggerScheduler._attach_pending_markers(entries)

        self.assertIn("_inFlightMarkerId", entries[0])
        self.assertIn("_inFlightMarkerId", entries[1])
        self.assertNotIn("_inFlightMarkerId", entries[2])
        self.assertNotIn("_inFlightMarkerId", entries[3])

        markers = entrypoint._load_in_flight()
        self.assertEqual(len(markers), 2)
        gh_marker = next(m for m in markers if m["triggerId"] == "t-gh")
        self.assertEqual(gh_marker["triggerType"], "github-event")
        self.assertEqual(gh_marker["repo"], "o/r")
        self.assertEqual(gh_marker["event"], "issues.labeled")
        http_marker = next(m for m in markers if m["triggerId"] == "t-http")
        self.assertEqual(http_marker["triggerType"], "http")

    async def test_process_pending_clears_marker_on_normal_completion(self):
        scheduler, _client, _send = self._scheduler()
        entrypoint._save_triggers([
            {"id": "t-gh", "type": "github-event", "enabled": True, "prompt": "p"},
        ])
        entrypoint._atomic_write_json(self.workdir / entrypoint._PENDING_FILENAME, [
            {"triggerId": "t-gh", "github": {"event": "issues.labeled", "repo": "o/r", "eventId": 1}},
        ])
        scheduler._execute = AsyncMock()

        await scheduler._process_pending()

        scheduler._execute.assert_awaited_once()
        self.assertEqual(entrypoint._load_in_flight(), [])

    async def test_process_pending_clears_marker_even_when_trigger_not_found(self):
        scheduler, _client, _send = self._scheduler()
        entrypoint._save_triggers([])  # no matching trigger — a legitimate, non-crash outcome
        entrypoint._atomic_write_json(self.workdir / entrypoint._PENDING_FILENAME, [
            {"triggerId": "missing"},
        ])

        await scheduler._process_pending()

        self.assertEqual(entrypoint._load_in_flight(), [])

    async def test_process_pending_never_marks_control_kind_entries(self):
        scheduler, _client, _send = self._scheduler()
        entrypoint._atomic_write_json(self.workdir / entrypoint._PENDING_FILENAME, [
            {"kind": "handover-dm", "roomId": "!room:local", "body": "hand-off"},
        ])
        scheduler._execute_handover_dm = AsyncMock()

        await scheduler._process_pending()

        scheduler._execute_handover_dm.assert_awaited_once()
        self.assertEqual(entrypoint._load_in_flight(), [])

    # -- Race 2: once-trigger removal -----------------------------------------

    async def test_sync_marks_once_trigger_before_removal_then_clears_after_execution(self):
        scheduler, _client, _send = self._scheduler()
        past = (datetime.now(tz=entrypoint._TRIGGER_TZ) - timedelta(minutes=1)).isoformat()
        entrypoint._save_triggers([
            {"id": "o1", "type": "once", "at": past, "prompt": "p", "roomId": "!room:local"},
        ])
        scheduler._execute = AsyncMock()

        await scheduler._sync()

        # By the time _sync() returns, the trigger has already been removed
        # from triggers.json and its marker persisted — both happen before
        # the spawned execution task is even scheduled to run.
        self.assertEqual(entrypoint._load_triggers(), [])
        in_flight = entrypoint._load_in_flight()
        self.assertEqual(len(in_flight), 1)
        self.assertEqual(in_flight[0]["kind"], "once")
        self.assertEqual(in_flight[0]["triggerId"], "o1")

        await self._drain_all_tasks()

        scheduler._execute.assert_awaited_once()
        self.assertEqual(entrypoint._load_in_flight(), [])

    # -- startup reconciliation (AC1/AC2/AC3) ---------------------------------

    async def test_reconcile_in_flight_posts_notice_for_each_orphaned_marker(self):
        scheduler, _client, send_formatted = self._scheduler()
        self._write_dm_room()
        entrypoint._save_in_flight([
            {"id": "once:o1:1", "kind": "once", "triggerId": "o1"},
            {"id": "pending:t-gh:1:0", "kind": "pending", "triggerId": "t-gh",
             "triggerType": "github-event", "repo": "o/r", "event": "issues.labeled"},
        ])

        await scheduler._reconcile_in_flight()

        self.assertEqual(entrypoint._load_in_flight(), [])  # AC3: cleared, no re-fire
        self.assertEqual(send_formatted.await_count, 2)
        bodies = [call.args[1] for call in send_formatted.await_args_list]
        self.assertTrue(any("one-shot trigger `o1`" in b for b in bodies))
        self.assertTrue(any(
            "github-event trigger `t-gh`" in b and "issues.labeled" in b and "o/r" in b
            for b in bodies
        ))
        self.assertTrue(all("automatic re-run" in b for b in bodies))  # AC3: informational only

    async def test_reconcile_in_flight_noop_when_nothing_orphaned(self):
        scheduler, _client, send_formatted = self._scheduler()
        self._write_dm_room()

        await scheduler._reconcile_in_flight()  # AC4: no false positives

        send_formatted.assert_not_awaited()

    async def test_reconcile_in_flight_skips_notice_without_dm_room_but_still_clears(self):
        scheduler, _client, send_formatted = self._scheduler()
        entrypoint._save_in_flight([{"id": "once:o1:1", "kind": "once", "triggerId": "o1"}])

        await scheduler._reconcile_in_flight()

        send_formatted.assert_not_awaited()
        self.assertEqual(entrypoint._load_in_flight(), [])


class ResultEventTokens(unittest.TestCase):
    """#490: the result-event wrapper must surface cache tokens alongside
    input/output so the admin console can count them into the context-window
    fill (prompt caching means input_tokens alone understates it)."""

    def _tokens(self, usage):
        line = __import__("json").dumps({"type": "result", "usage": usage})
        events = map_stream_json_line(line, "corr-1")
        return next(e for e in events if e["type"] == "result")["tokens"]

    def test_cache_tokens_included_when_present(self):
        tokens = self._tokens({
            "input_tokens": 100, "output_tokens": 50,
            "cache_creation_input_tokens": 20, "cache_read_input_tokens": 3000,
        })
        self.assertEqual(tokens, {
            "input": 100, "output": 50,
            "cacheCreationInput": 20, "cacheReadInput": 3000,
        })

    def test_cache_tokens_default_to_zero_when_absent(self):
        tokens = self._tokens({"input_tokens": 100, "output_tokens": 50})
        self.assertEqual(tokens["cacheCreationInput"], 0)
        self.assertEqual(tokens["cacheReadInput"], 0)

    def test_cache_tokens_default_to_zero_when_null(self):
        tokens = self._tokens({
            "input_tokens": 100, "output_tokens": 50,
            "cache_creation_input_tokens": None, "cache_read_input_tokens": None,
        })
        self.assertEqual(tokens["cacheCreationInput"], 0)
        self.assertEqual(tokens["cacheReadInput"], 0)


if __name__ == "__main__":
    unittest.main()
