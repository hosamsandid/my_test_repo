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


class BuildHarvestHint(unittest.TestCase):
    fn = staticmethod(entrypoint.build_harvest_hint)

    def test_level_0_is_empty(self):
        self.assertEqual(self.fn(0), "")

    def test_negative_or_noninteger_is_empty(self):
        self.assertEqual(self.fn(-1), "")
        self.assertEqual(self.fn("1"), "")  # not an int -> today's behaviour
        self.assertEqual(self.fn(None), "")

    def test_level_1_mentions_knowledge_add(self):
        out = self.fn(1)
        self.assertIn("knowledge add", out)
        self.assertIn("knowledge search", out)

    def test_higher_levels_still_harvest(self):
        for lvl in (2, 3):
            self.assertIn("knowledge add", self.fn(lvl))


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


class ResultEventModelUsage(unittest.TestCase):
    """#654: the result-event wrapper must now also surface the raw per-model
    `modelUsage` map (previously dropped) so the usage-record emitter can build
    the per-model four-class split."""

    def test_model_usage_passed_through_raw(self):
        line = __import__("json").dumps({
            "type": "result",
            "usage": {"input_tokens": 10, "output_tokens": 42},
            "modelUsage": {"claude-sonnet-4-6": {"inputTokens": 8, "outputTokens": 40}},
        })
        ev = next(e for e in map_stream_json_line(line, "corr-1")
                  if e["type"] == "result")
        self.assertEqual(ev["modelUsage"],
                         {"claude-sonnet-4-6": {"inputTokens": 8, "outputTokens": 40}})

    def test_model_usage_none_when_absent(self):
        line = __import__("json").dumps({"type": "result", "usage": {}})
        ev = next(e for e in map_stream_json_line(line, "corr-1")
                  if e["type"] == "result")
        self.assertIsNone(ev["modelUsage"])


class BuildUsageRecord(unittest.TestCase):
    """Two-sided contract with admin-console/api/usage-summary.js: build_usage_record
    (emitter) is asserted against the SAME golden fixture the JS aggregator uses
    (admin-console/api/usage-summary.fixture.json), so the canonical usage-record
    schema cannot drift between the Python emitter and the JS aggregator."""

    @classmethod
    def setUpClass(cls):
        import json
        fixture_path = (Path(__file__).resolve().parents[2]
                        / "admin-console" / "api" / "usage-summary.fixture.json")
        cls.fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    def test_golden_records(self):
        for case in self.fixture["records"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    entrypoint.build_usage_record(case["input"]),
                    case["expected"],
                )

    def test_normalize_model_usage_ignores_non_dict_and_defaults(self):
        self.assertEqual(entrypoint._normalize_model_usage(None), {})
        self.assertEqual(entrypoint._normalize_model_usage({"m": "bad"}), {})
        self.assertEqual(
            entrypoint._normalize_model_usage({"m": {"inputTokens": 3}}),
            {"m": {"input": 3, "output": 0,
                   "cacheCreationInput": 0, "cacheReadInput": 0}},
        )


class MaintenanceModeGating(unittest.IsolatedAsyncioTestCase):
    """#504: cron/once triggers must not fire while Maintenance Mode (#501) is
    active, http/github-event pending entries must not be drained/processed
    while active, and a cron trigger whose fire fell inside the window gets
    exactly one catch-up run once it ends."""

    def setUp(self):
        # The once-fire path writes a durable in-flight marker (#506) via
        # _agent_workdir(), which reads os.environ["AGENT_ID"]. Point it at a
        # throwaway dir so the firing test is hermetic — same pattern as
        # InFlightMarkerReconciliation.
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        patcher = patch.object(entrypoint, "_agent_workdir",
                               return_value=Path(self._tmpdir.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _scheduler(self):
        client = AsyncMock()
        return entrypoint.TriggerScheduler(
            client=client, agent_id="agent-1", user_id="@agent-1:local",
            send_formatted=None, blueprint_id=None,
        )

    async def test_maintenance_active_true_when_orchestrator_reports_active(self):
        scheduler = self._scheduler()
        with patch.object(entrypoint.TriggerScheduler, "_orch_get",
                           return_value=(200, '{"ok": true, "active": true}')):
            self.assertTrue(await scheduler._maintenance_active())

    async def test_maintenance_active_false_when_orchestrator_reports_inactive(self):
        scheduler = self._scheduler()
        with patch.object(entrypoint.TriggerScheduler, "_orch_get",
                           return_value=(200, '{"ok": true, "active": false}')):
            self.assertFalse(await scheduler._maintenance_active())

    async def test_maintenance_active_false_when_orchestrator_unreachable(self):
        scheduler = self._scheduler()
        with patch.object(entrypoint.TriggerScheduler, "_orch_get",
                           return_value=(0, "connection refused")):
            self.assertFalse(await scheduler._maintenance_active())

    async def test_maintenance_active_false_on_malformed_body(self):
        scheduler = self._scheduler()
        with patch.object(entrypoint.TriggerScheduler, "_orch_get",
                           return_value=(200, "not json")):
            self.assertFalse(await scheduler._maintenance_active())

    async def test_once_trigger_not_fired_while_maintenance_active(self):
        scheduler = self._scheduler()
        past = (entrypoint.datetime.now(entrypoint._TRIGGER_TZ)
                - timedelta(minutes=1)).isoformat()
        trigger = {"id": "o1", "type": "once", "at": past, "enabled": True}
        with patch.object(entrypoint, "_load_triggers", return_value=[trigger]), \
             patch.object(entrypoint, "_save_triggers") as save_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=True)):
            await scheduler._sync()
        save_mock.assert_not_called()
        self.assertNotIn("o1", scheduler._fired_once)

    async def test_once_trigger_fires_when_maintenance_inactive(self):
        scheduler = self._scheduler()
        past = (entrypoint.datetime.now(entrypoint._TRIGGER_TZ)
                - timedelta(minutes=1)).isoformat()
        trigger = {"id": "o1", "type": "once", "at": past, "enabled": True}
        # _execute MUST be mocked (#606): the once-firing path calls the real
        # _execute via asyncio.create_task, which would spawn a real Claude run /
        # write the live session log when this suite is run inside a live agent
        # container. Patching it here is the correct unit boundary — firing the
        # once trigger means "call _execute once".
        with patch.object(entrypoint, "_load_triggers", return_value=[trigger]), \
             patch.object(entrypoint, "_save_triggers") as save_mock, \
             patch.object(scheduler, "_execute", AsyncMock()) as execute_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)):
            await scheduler._sync()
            # Let the create_task-scheduled coroutine run so no task is left
            # pending at teardown.
            await entrypoint.asyncio.sleep(0)
        execute_mock.assert_called_once()
        save_mock.assert_called_once()
        self.assertIn("o1", scheduler._fired_once)

    async def test_under_test_harness_suppresses_execute(self):
        # Defense in depth (#606): even if a test forgets to mock _execute, the
        # real _execute must be inert under a test harness — it must never spawn
        # a Claude run, post to Matrix, or write the live session log.
        self.assertTrue(entrypoint._under_test_harness())
        scheduler = self._scheduler()
        trigger = {"id": "o1", "type": "once", "at": "2020-01-01T00:00:00Z",
                   "enabled": True}
        with patch.object(entrypoint, "_load_dm_room_id",
                          return_value="!room:local") as room_mock, \
             patch.object(entrypoint, "_call_claude_once") as claude_mock, \
             patch.object(entrypoint, "_append_event") as append_mock:
            await scheduler._execute(trigger)
        claude_mock.assert_not_called()
        append_mock.assert_not_called()
        room_mock.assert_not_called()
        self.assertNotIn("o1", scheduler._running)

    async def test_pending_loop_skips_processing_during_maintenance(self):
        scheduler = self._scheduler()
        process_mock = AsyncMock()

        async def fake_maintenance_active():
            scheduler._shutdown_event.set()
            return True

        with patch.object(scheduler, "_process_pending", process_mock), \
             patch.object(scheduler, "_maintenance_active", fake_maintenance_active):
            await scheduler._pending_loop()
        process_mock.assert_not_called()

    async def test_pending_loop_processes_when_maintenance_inactive(self):
        scheduler = self._scheduler()

        async def fake_process_pending():
            scheduler._shutdown_event.set()

        maintenance_mock = AsyncMock(return_value=False)
        with patch.object(scheduler, "_process_pending", fake_process_pending), \
             patch.object(scheduler, "_maintenance_active", maintenance_mock):
            await scheduler._pending_loop()
        maintenance_mock.assert_called_once()

    async def test_cron_runner_skips_and_catches_up_exactly_once(self):
        scheduler = self._scheduler()

        async def fake_execute(_trigger):
            scheduler._shutdown_event.set()

        execute_mock = AsyncMock(side_effect=fake_execute)
        maintenance_calls = []

        async def fake_maintenance_active():
            maintenance_calls.append(None)
            # Active on the trigger's scheduled fire; inactive on the
            # follow-up check inside the wait-it-out loop (maintenance ended).
            return len(maintenance_calls) == 1

        with patch.object(scheduler, "_execute", execute_mock), \
             patch.object(scheduler, "_maintenance_active", fake_maintenance_active), \
             patch.object(entrypoint.asyncio, "sleep", AsyncMock(return_value=None)):
            await scheduler._cron_runner({"id": "c1", "type": "cron"}, "* * * * *")
        execute_mock.assert_called_once()
        self.assertEqual(len(maintenance_calls), 2)


class LoopTriggerValidation(unittest.TestCase):
    """#932: a `loop` trigger must declare a positive-integer `maxIterations`
    (no unbounded loop may be authored); optional `until`/`minGapSeconds` are
    shape-checked."""

    def test_valid_loop_accepted(self):
        ok, reason = entrypoint._validate_loop_trigger({
            "id": "l", "type": "loop", "maxIterations": 10,
            "until": {"command": "npm test", "env": {"CI": "1"}},
            "minGapSeconds": 5,
        })
        self.assertTrue(ok, reason)

    def test_valid_loop_minimal(self):
        ok, _ = entrypoint._validate_loop_trigger({"maxIterations": 1})
        self.assertTrue(ok)

    def test_missing_maxIterations_rejected(self):
        ok, reason = entrypoint._validate_loop_trigger({"id": "l", "type": "loop"})
        self.assertFalse(ok)
        self.assertIn("maxIterations", reason)

    def test_zero_or_negative_maxIterations_rejected(self):
        self.assertFalse(entrypoint._validate_loop_trigger({"maxIterations": 0})[0])
        self.assertFalse(entrypoint._validate_loop_trigger({"maxIterations": -3})[0])

    def test_non_int_maxIterations_rejected(self):
        # bool is an int subclass in Python — must be rejected explicitly.
        self.assertFalse(entrypoint._validate_loop_trigger({"maxIterations": True})[0])
        self.assertFalse(entrypoint._validate_loop_trigger({"maxIterations": 2.5})[0])
        self.assertFalse(entrypoint._validate_loop_trigger({"maxIterations": "5"})[0])

    def test_bad_until_shape_rejected(self):
        self.assertFalse(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "until": "npm test"})[0])
        self.assertFalse(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "until": {"command": "  "}})[0])
        self.assertFalse(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "until": {"command": "x", "env": "CI=1"}})[0])

    def test_until_command_optional(self):
        # An `until` object with no command (env-only / empty) is allowed —
        # such a loop simply runs to `maxIterations`.
        self.assertTrue(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "until": {}})[0])

    def test_bad_minGapSeconds_rejected(self):
        self.assertFalse(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "minGapSeconds": -1})[0])
        self.assertFalse(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "minGapSeconds": "5"})[0])
        self.assertFalse(entrypoint._validate_loop_trigger(
            {"maxIterations": 5, "minGapSeconds": True})[0])


class LoopStopDecision(unittest.TestCase):
    """#932: the pure done-vs-exhausted decision evaluated after each iteration."""

    def test_until_exit_zero_is_done(self):
        self.assertEqual(entrypoint._loop_stop_decision(1, 25, 0), "done")

    def test_until_nonzero_continues_below_cap(self):
        self.assertIsNone(entrypoint._loop_stop_decision(1, 25, 1))

    def test_cap_reached_is_exhausted(self):
        self.assertEqual(entrypoint._loop_stop_decision(25, 25, 1), "exhausted")

    def test_no_until_command_runs_to_exhausted(self):
        # until_exit_code None (no until.command) → never "done".
        self.assertIsNone(entrypoint._loop_stop_decision(1, 3, None))
        self.assertEqual(entrypoint._loop_stop_decision(3, 3, None), "exhausted")

    def test_done_wins_over_exhausted_on_final_iteration(self):
        # Goal met on the last permitted iteration reports done, not exhausted.
        self.assertEqual(entrypoint._loop_stop_decision(25, 25, 0), "done")


class LoopRunner(unittest.IsolatedAsyncioTestCase):
    """#932: `_loop_runner` chains iterations through `_execute` and stops on the
    stop contract, posting exactly one terminal outcome DM."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        patcher = patch.object(entrypoint, "_agent_workdir",
                               return_value=Path(self._tmpdir.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _scheduler(self):
        client = AsyncMock()
        return entrypoint.TriggerScheduler(
            client=client, agent_id="agent-1", user_id="@agent-1:local",
            send_formatted=AsyncMock(), blueprint_id=None,
        )

    def _loop_trigger(self, **kw):
        t = {"id": "lp", "type": "loop", "enabled": True, "roomId": "!room:local",
             "maxIterations": 10, "prompt": "do it"}
        t.update(kw)
        return t

    async def test_loop_runs_iterations_until_until_done(self):
        scheduler = self._scheduler()
        trigger = self._loop_trigger(
            until={"command": "npm test"}, maxIterations=10)
        precheck = patch.object(
            entrypoint, "_run_pre_check",
            side_effect=[(1, ""), (1, ""), (0, "all green")])
        with patch.object(scheduler, "_execute", AsyncMock()) as execute_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)), \
             precheck:
            await scheduler._loop_runner(trigger)
        self.assertEqual(execute_mock.await_count, 3)
        scheduler._send_formatted.assert_awaited_once()
        body = scheduler._send_formatted.await_args.args[1]
        self.assertIn("done", body)
        self.assertIn("all green", body)
        self.assertIn("lp", scheduler._loop_done)

    async def test_loop_exhausted_without_until(self):
        scheduler = self._scheduler()
        trigger = self._loop_trigger(maxIterations=3)  # no `until` → runs to cap
        with patch.object(scheduler, "_execute", AsyncMock()) as execute_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)):
            await scheduler._loop_runner(trigger)
        self.assertEqual(execute_mock.await_count, 3)
        scheduler._send_formatted.assert_awaited_once()
        body = scheduler._send_formatted.await_args.args[1]
        self.assertIn("exhausted", body)
        self.assertIn("3 / 3", body)
        self.assertIn("lp", scheduler._loop_done)

    async def test_loop_exhausted_when_until_never_passes(self):
        scheduler = self._scheduler()
        trigger = self._loop_trigger(until={"command": "false"}, maxIterations=2)
        with patch.object(scheduler, "_execute", AsyncMock()) as execute_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)), \
             patch.object(entrypoint, "_run_pre_check", return_value=(1, "still failing")):
            await scheduler._loop_runner(trigger)
        self.assertEqual(execute_mock.await_count, 2)
        scheduler._send_formatted.assert_awaited_once()
        self.assertIn("exhausted", scheduler._send_formatted.await_args.args[1])

    async def test_loop_pauses_for_maintenance_then_resumes(self):
        scheduler = self._scheduler()
        trigger = self._loop_trigger(until={"command": "npm test"}, maxIterations=5)
        maintenance_calls = []

        async def fake_maintenance_active():
            maintenance_calls.append(None)
            # Active on the first check (pause), inactive afterwards (resume).
            return len(maintenance_calls) == 1

        with patch.object(scheduler, "_execute", AsyncMock()) as execute_mock, \
             patch.object(scheduler, "_maintenance_active", fake_maintenance_active), \
             patch.object(entrypoint.asyncio, "sleep", AsyncMock(return_value=None)), \
             patch.object(entrypoint, "_run_pre_check", return_value=(0, "ok")):
            await scheduler._loop_runner(trigger)
        execute_mock.assert_awaited_once()  # one catch-up iteration, then done
        self.assertGreaterEqual(len(maintenance_calls), 2)
        self.assertIn("lp", scheduler._loop_done)

    async def test_loop_shutdown_before_iteration_posts_no_dm(self):
        scheduler = self._scheduler()
        scheduler._shutdown_event.set()
        trigger = self._loop_trigger(maxIterations=5)
        with patch.object(scheduler, "_execute", AsyncMock()) as execute_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)):
            await scheduler._loop_runner(trigger)
        execute_mock.assert_not_awaited()
        scheduler._send_formatted.assert_not_awaited()
        self.assertNotIn("lp", scheduler._loop_done)


class LoopSyncScheduling(unittest.IsolatedAsyncioTestCase):
    """#932: `_sync` schedules a valid loop once, rejects an invalid one, and
    never re-arms a loop that already reached a terminal state."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        patcher = patch.object(entrypoint, "_agent_workdir",
                               return_value=Path(self._tmpdir.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _scheduler(self):
        return entrypoint.TriggerScheduler(
            client=AsyncMock(), agent_id="agent-1", user_id="@agent-1:local",
            send_formatted=AsyncMock(), blueprint_id=None,
        )

    async def test_sync_schedules_valid_loop(self):
        scheduler = self._scheduler()
        trigger = {"id": "lp", "type": "loop", "enabled": True,
                   "maxIterations": 5, "prompt": "x"}
        with patch.object(entrypoint, "_load_triggers", return_value=[trigger]), \
             patch.object(scheduler, "_loop_runner", AsyncMock()) as runner_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)):
            await scheduler._sync()
            await entrypoint.asyncio.sleep(0)
        runner_mock.assert_called_once()
        self.assertIn("lp", scheduler._loop_tasks)

    async def test_sync_rejects_loop_without_maxIterations(self):
        scheduler = self._scheduler()
        trigger = {"id": "lp", "type": "loop", "enabled": True, "prompt": "x"}
        with patch.object(entrypoint, "_load_triggers", return_value=[trigger]), \
             patch.object(scheduler, "_loop_runner", AsyncMock()) as runner_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)):
            await scheduler._sync()
        runner_mock.assert_not_called()
        self.assertNotIn("lp", scheduler._loop_tasks)

    async def test_sync_does_not_rearm_terminated_loop(self):
        scheduler = self._scheduler()
        scheduler._loop_done.add("lp")
        trigger = {"id": "lp", "type": "loop", "enabled": True,
                   "maxIterations": 5, "prompt": "x"}
        with patch.object(entrypoint, "_load_triggers", return_value=[trigger]), \
             patch.object(scheduler, "_loop_runner", AsyncMock()) as runner_mock, \
             patch.object(scheduler, "_maintenance_active", AsyncMock(return_value=False)):
            await scheduler._sync()
        runner_mock.assert_not_called()
        self.assertNotIn("lp", scheduler._loop_tasks)


class TriggerBackstopUnit(unittest.TestCase):
    """#611: the pure per-agent backstop that caps concurrent + per-window
    triggered Claude spawns so a self-triggering loop can't fan out unbounded."""

    def _clock(self):
        # A mutable, injectable monotonic clock.
        state = {"t": 1000.0}
        return state, (lambda: state["t"])

    def test_concurrency_ceiling_denies_when_full(self):
        b = entrypoint.TriggerBackstop(
            max_concurrent=2, max_per_window=0, window_sec=0)
        self.assertTrue(b.try_acquire().allowed)
        self.assertTrue(b.try_acquire().allowed)
        d = b.try_acquire()
        self.assertFalse(d.allowed)
        self.assertEqual(d.reason, "concurrency")
        self.assertEqual(d.active, 2)

    def test_release_frees_a_slot(self):
        b = entrypoint.TriggerBackstop(
            max_concurrent=1, max_per_window=0, window_sec=0)
        self.assertTrue(b.try_acquire().allowed)
        self.assertFalse(b.try_acquire().allowed)
        b.release()
        self.assertTrue(b.try_acquire().allowed)

    def test_release_never_goes_negative(self):
        b = entrypoint.TriggerBackstop(
            max_concurrent=1, max_per_window=0, window_sec=0)
        b.release()
        b.release()
        self.assertEqual(b.snapshot()["active"], 0)
        self.assertTrue(b.try_acquire().allowed)

    def test_rate_limit_denies_after_window_full(self):
        state, clock = self._clock()
        b = entrypoint.TriggerBackstop(
            max_concurrent=0, max_per_window=3, window_sec=300, clock=clock)
        # Three spawns fit in the window; the fourth is dropped.
        for _ in range(3):
            self.assertTrue(b.try_acquire().allowed)
            b.release()  # concurrency disabled, but release keeps active honest
        d = b.try_acquire()
        self.assertFalse(d.allowed)
        self.assertEqual(d.reason, "rate")

    def test_rate_limit_recovers_after_window_slides(self):
        state, clock = self._clock()
        b = entrypoint.TriggerBackstop(
            max_concurrent=0, max_per_window=2, window_sec=300, clock=clock)
        self.assertTrue(b.try_acquire().allowed)
        self.assertTrue(b.try_acquire().allowed)
        self.assertFalse(b.try_acquire().allowed)
        # Advance past the window — the old spawns age out.
        state["t"] += 301
        self.assertTrue(b.try_acquire().allowed)

    def test_zero_limits_disable_the_backstop(self):
        b = entrypoint.TriggerBackstop(
            max_concurrent=0, max_per_window=0, window_sec=0)
        for _ in range(50):
            self.assertTrue(b.try_acquire().allowed)

    def test_warn_fires_once_per_episode_then_resets_on_success(self):
        b = entrypoint.TriggerBackstop(
            max_concurrent=1, max_per_window=0, window_sec=0)
        self.assertTrue(b.try_acquire().allowed)  # at ceiling
        first = b.try_acquire()
        self.assertFalse(first.allowed)
        self.assertTrue(first.warn)            # first drop warns
        second = b.try_acquire()
        self.assertFalse(second.allowed)
        self.assertFalse(second.warn)          # subsequent drops stay silent
        b.release()
        self.assertTrue(b.try_acquire().allowed)  # pressure eased → episode ends
        b.release()
        b.try_acquire()  # back to ceiling
        self.assertTrue(b.try_acquire().warn)  # a fresh episode warns again


class TriggerBackstopExecuteIntegration(unittest.IsolatedAsyncioTestCase):
    """#611: `_execute` — the single chokepoint for triggered work — consults
    the backstop before spawning, drops over-limit runs without calling
    `_execute_inner`, and pairs every allowed spawn with a release."""

    def _scheduler(self):
        return entrypoint.TriggerScheduler(
            client=AsyncMock(), agent_id="agent-1", user_id="@agent-1:local",
            send_formatted=None, blueprint_id=None,
        )

    async def test_execute_dropped_when_backstop_denies(self):
        scheduler = self._scheduler()
        scheduler._backstop = entrypoint.TriggerBackstop(
            max_concurrent=1, max_per_window=0, window_sec=0)
        scheduler._backstop.try_acquire()  # fill to ceiling
        inner = AsyncMock()
        warn = AsyncMock()
        trigger = {"id": "t1", "type": "cron"}
        with patch.object(entrypoint, "_under_test_harness", return_value=False), \
             patch.object(scheduler, "_execute_inner", inner), \
             patch.object(scheduler, "_post_backstop_warning", warn):
            await scheduler._execute(trigger)
        inner.assert_not_called()
        warn.assert_called_once()
        self.assertNotIn("t1", scheduler._running)

    async def test_execute_allowed_then_released(self):
        scheduler = self._scheduler()
        inner = AsyncMock()
        trigger = {"id": "t1", "type": "cron"}
        with patch.object(entrypoint, "_under_test_harness", return_value=False), \
             patch.object(scheduler, "_execute_inner", inner):
            await scheduler._execute(trigger)
        inner.assert_called_once()
        # Released after completion, so the slot is free again.
        self.assertEqual(scheduler._backstop.snapshot()["active"], 0)
        self.assertNotIn("t1", scheduler._running)

    async def test_execute_releases_even_when_inner_raises(self):
        scheduler = self._scheduler()
        inner = AsyncMock(side_effect=RuntimeError("boom"))
        trigger = {"id": "t1", "type": "cron"}
        with patch.object(entrypoint, "_under_test_harness", return_value=False), \
             patch.object(scheduler, "_execute_inner", inner):
            await scheduler._execute(trigger)  # error is swallowed + logged
        self.assertEqual(scheduler._backstop.snapshot()["active"], 0)

    async def test_only_first_drop_posts_a_warning(self):
        scheduler = self._scheduler()
        scheduler._backstop = entrypoint.TriggerBackstop(
            max_concurrent=1, max_per_window=0, window_sec=0)
        scheduler._backstop.try_acquire()  # fill to ceiling
        trigger = {"id": "t1", "type": "cron"}
        with patch.object(entrypoint, "_under_test_harness", return_value=False), \
             patch.object(scheduler, "_execute_inner", AsyncMock()), \
             patch.object(scheduler, "_post_backstop_warning", AsyncMock()) as warn:
            await scheduler._execute(trigger)
            await scheduler._execute(trigger)
            await scheduler._execute(trigger)
        warn.assert_called_once()


class ResultEventContextTokens(unittest.TestCase):
    """#509: `result.usage` is a turn-wide aggregate across every internal
    API round-trip in the agentic tool-call loop (confirmed against a live
    `claude --output-format stream-json` invocation of this repo's pinned CLI
    version, matching anthropics/claude-code #6805) — it can be a large
    multiple of the model's actual context size once a turn makes several
    tool calls. `result.contextTokens` must instead reflect only the *last*
    individual assistant-message's usage, threaded via the `usage_sink`
    argument shared across every line of one `claude` invocation."""

    def _assistant_line(self, usage):
        import json
        return json.dumps({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}],
                        "usage": usage},
        })

    def _result_line(self, usage):
        import json
        return json.dumps({"type": "result", "usage": usage})

    def test_context_tokens_reflects_last_assistant_call_not_the_sum(self):
        sink = {}
        # Three internal round-trips within one turn, each reporting a growing
        # cache-read count (as prompt caching would for a stable, resumed
        # session) — the turn-wide `result.usage` sums all of them, but
        # `contextTokens` must land on only the last one.
        map_stream_json_line(self._assistant_line({
            "input_tokens": 10, "output_tokens": 5,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 50_000,
        }), "corr-1", sink)
        map_stream_json_line(self._assistant_line({
            "input_tokens": 10, "output_tokens": 5,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 60_000,
        }), "corr-1", sink)
        map_stream_json_line(self._assistant_line({
            "input_tokens": 10, "output_tokens": 5,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 70_000,
        }), "corr-1", sink)
        events = map_stream_json_line(self._result_line({
            # Simulates the CLI's turn-wide aggregate: ~3x a single call.
            "input_tokens": 30, "output_tokens": 15,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 180_000,
        }), "corr-1", sink)
        result = next(e for e in events if e["type"] == "result")
        self.assertEqual(result["tokens"]["cacheReadInput"], 180_000)  # aggregate, unchanged
        self.assertEqual(result["contextTokens"], {
            "input": 10, "output": 5, "cacheCreationInput": 0, "cacheReadInput": 70_000,
        })

    def test_context_tokens_none_when_no_sink_provided(self):
        events = map_stream_json_line(self._result_line({"input_tokens": 10, "output_tokens": 5}), "corr-1")
        result = next(e for e in events if e["type"] == "result")
        self.assertIsNone(result["contextTokens"])

    def test_context_tokens_none_when_no_assistant_message_seen(self):
        sink = {}
        events = map_stream_json_line(self._result_line({"input_tokens": 10, "output_tokens": 5}), "corr-1", sink)
        result = next(e for e in events if e["type"] == "result")
        self.assertIsNone(result["contextTokens"])

    def test_assistant_message_without_usage_does_not_touch_sink(self):
        import json
        sink = {"input": 1, "output": 1, "cacheCreationInput": 0, "cacheReadInput": 1}
        line = json.dumps({"type": "assistant",
                            "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}})
        map_stream_json_line(line, "corr-1", sink)
        self.assertEqual(sink, {"input": 1, "output": 1, "cacheCreationInput": 0, "cacheReadInput": 1})


class BuildMemoryHint(unittest.TestCase):
    """Variant selection of the two-sided memory-hint contract (unification
    Phase 2). Byte-identity with buildMemoryHint() in prompt-assembly.js is
    guarded from the JS side (source-scan on the literals); here we pin the
    gating behaviour: unified drops the fact/entity write instructions AND the
    separate harvest hint (absorbed into the text), legacy stays byte-stable."""

    def setUp(self):
        self._orig_unified = entrypoint._memory_model_unified
        self._orig_level = entrypoint._knowledge_autonomy_level

    def tearDown(self):
        entrypoint._memory_model_unified = self._orig_unified
        entrypoint._knowledge_autonomy_level = self._orig_level

    def test_unified_hint_routes_semantic_learning_to_the_kb(self):
        entrypoint._memory_model_unified = lambda: True
        entrypoint._knowledge_autonomy_level = lambda: 2
        hint = entrypoint._build_memory_hint(None)
        self.assertIn("episodic memory files: memory/context.md and memory/log.md", hint)
        self.assertIn("knowledge-digest.md", hint)
        self.assertIn("knowledge add fact|entity|convention", hint)
        # No fact/entity write targets, and no duplicated harvest sentence.
        self.assertNotIn("memory/facts.md", hint)
        self.assertNotIn("memory/entities.md", hint)
        self.assertNotIn("In addition to your memory files", hint)

    def test_legacy_hint_unchanged_with_harvest(self):
        entrypoint._memory_model_unified = lambda: False
        entrypoint._knowledge_autonomy_level = lambda: 1
        hint = entrypoint._build_memory_hint(None)
        self.assertIn("memory/facts.md, memory/entities.md and memory/users.md", hint)
        self.assertIn("In addition to your memory files", hint)  # harvest hint appended
        self.assertNotIn("knowledge-digest.md", hint)

    def test_legacy_hint_autonomy0_is_todays_text(self):
        entrypoint._memory_model_unified = lambda: False
        entrypoint._knowledge_autonomy_level = lambda: 0
        hint = entrypoint._build_memory_hint(None)
        self.assertIn("memory/facts.md, memory/entities.md and memory/users.md", hint)
        self.assertNotIn("In addition to your memory files", hint)

    def test_blueprint_hint_ignores_unified(self):
        entrypoint._memory_model_unified = lambda: True
        entrypoint._knowledge_autonomy_level = lambda: 2
        hint = entrypoint._build_memory_hint("bp-x")
        self.assertIn("instance of blueprint 'bp-x'", hint)
        self.assertNotIn("knowledge-digest.md", hint)


class BuildKnowledgeDigest(unittest.TestCase):
    """Two-sided contract with orchestrator/knowledge-digest.js: both test
    suites assert byte-identical markdown against the SAME golden fixture
    (orchestrator/knowledge-digest.fixture.json), so the JS builder (post-KB-
    change fan-out) and this port (pre-invocation rebuild) cannot drift."""

    @classmethod
    def setUpClass(cls):
        import json
        fixture_path = (Path(__file__).resolve().parents[2]
                        / "orchestrator" / "knowledge-digest.fixture.json")
        cls.fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    def test_golden_fixture_cases(self):
        for case in self.fixture["cases"]:
            with self.subTest(case=case["name"]):
                kwargs = {
                    "team_id": case["teamId"],
                    "generated_at": case["generatedAt"],
                    "entries": self.fixture["entries"] if case["useEntries"] else [],
                }
                if case["budgetTokens"] is not None:
                    kwargs["budget_tokens"] = case["budgetTokens"]
                res = entrypoint.build_knowledge_digest(**kwargs)
                self.assertEqual(res["markdown"], case["expectedMarkdown"])
                self.assertEqual(res["includedCount"], case["expectedIncluded"])
                self.assertEqual(res["totalCount"], case["expectedTotal"])
                self.assertEqual(res["omittedCount"], case["expectedOmitted"])
                self.assertEqual(res["tokensUsed"], case["expectedTokensUsed"])

    def test_fold_last_writer_wins_and_hides_statuses(self):
        folded = entrypoint.fold_visible_entries(self.fixture["entries"])
        self.assertEqual(
            [e["id"] for e in folded],
            ["ddd000000004", "aaa000000001", "bbb000000002", "ccc000000003"],
        )
        conv = next(e for e in folded if e["id"] == "aaa000000001")
        self.assertEqual(entrypoint._digest_convergence_count(conv), 3)

    def test_included_ids_render_order(self):
        res = entrypoint.build_knowledge_digest(
            team_id="demo-team", generated_at="2026-07-13T09:00:00Z",
            entries=self.fixture["entries"],
        )
        self.assertEqual(res["includedIds"], [
            "aaa000000001", "bbb000000002", "ccc000000003", "ddd000000004",
        ])

    def test_multiline_text_flattened(self):
        res = entrypoint.build_knowledge_digest(
            team_id="t", generated_at="2026-07-13T09:00:00Z",
            entries=[{"id": "abc000000001", "kind": "fact", "text": "line one\nline two",
                      "createdAt": "2026-07-01T00:00:00Z", "convergence": ["a"],
                      "status": "active"}],
        )
        self.assertIn("- fact: line one line two (2026-07-01)", res["markdown"])


class HarvestBlock(unittest.TestCase):
    """Two-sided contract with orchestrator/harvest-block.js: both test suites
    assert identical entries + stripped text against the SAME golden fixture
    (orchestrator/harvest-block.fixture.json), so the JS anchor and this Python
    runtime (the only side that harvests at run end) cannot drift (issue #602)."""

    @classmethod
    def setUpClass(cls):
        import json
        fixture_path = (Path(__file__).resolve().parents[2]
                        / "orchestrator" / "harvest-block.fixture.json")
        cls.fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    def test_golden_fixture_cases(self):
        for case in self.fixture["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    entrypoint.parse_harvest_block(case["input"]),
                    case["expectedEntries"],
                )
                self.assertEqual(
                    entrypoint.strip_harvest_block(case["input"]),
                    case["expectedStripped"],
                )

    def test_malformed_input_never_raises(self):
        for bad in (None, 42, {}, [], True):
            self.assertEqual(entrypoint.parse_harvest_block(bad), [])
        # strip returns non-str as "" and a plain string unchanged.
        self.assertEqual(entrypoint.strip_harvest_block(None), "")
        self.assertEqual(entrypoint.strip_harvest_block(42), "")
        self.assertEqual(entrypoint.strip_harvest_block("plain text"), "plain text")

    def test_unknown_kind_dropped_valid_sibling_kept(self):
        text = "\n".join([
            "ok",
            "```knowledge",
            '{"kind":"story","text":"nope"}',
            '{"kind":"fact","text":"yes"}',
            "```",
        ])
        self.assertEqual(entrypoint.parse_harvest_block(text),
                         [{"kind": "fact", "text": "yes"}])


class BuildHarvestBlockHint(unittest.TestCase):
    fn = staticmethod(entrypoint.build_harvest_block_hint)

    def test_level_0_is_empty(self):
        self.assertEqual(self.fn(0), "")
        self.assertEqual(self.fn(-1), "")
        self.assertEqual(self.fn("1"), "")

    def test_level_1_plus_asks_for_block(self):
        for lvl in (1, 2, 3):
            out = self.fn(lvl)
            self.assertIn("```knowledge", out)
            self.assertIn("fact|convention|entity", out)
            self.assertIn("do NOT run the knowledge CLI", out)


class KnowledgeTeamId(unittest.TestCase):
    """_knowledge_team_id mirrors the `knowledge` CLI / orchestrator precedence so
    the runtime digest is scoped to the same team even without the spawn-time env
    var (issue #538): KNOWLEDGE_TEAM_ID → parentTeamId → id (role team) → teamId →
    default."""

    def test_env_override_wins(self):
        with patch.dict(entrypoint.os.environ, {"KNOWLEDGE_TEAM_ID": "explicit"}), \
             patch.object(entrypoint, "_load_dm_agent_config",
                          return_value={"parentTeamId": "agent-studio"}):
            self.assertEqual(entrypoint._knowledge_team_id(), "explicit")

    def test_config_fallback_precedence(self):
        cases = [
            ({"parentTeamId": "agent-studio", "teamId": "default"}, "agent-studio"),
            ({"role": "team", "id": "squad-a", "teamId": "default"}, "squad-a"),
            ({"role": "team-member", "id": "acme-dev-1", "teamId": "acme"}, "acme"),
            ({"teamId": "acme"}, "acme"),
            ({}, "default"),
        ]
        env = dict(entrypoint.os.environ)
        env.pop("KNOWLEDGE_TEAM_ID", None)
        for cfg, expected in cases:
            with patch.dict(entrypoint.os.environ, env, clear=True), \
                 patch.object(entrypoint, "_load_dm_agent_config", return_value=cfg):
                self.assertEqual(entrypoint._knowledge_team_id(), expected)


class NewSession(unittest.TestCase):
    """The running-session descriptor must carry the correlationId so the admin
    console can scope one session's log even when sessions share a room (#543)."""

    def test_correlation_id_recorded(self):
        s = entrypoint._new_session("trigger", room_id="!r:local", label="t1",
                                    trigger_type="github-event", trigger_id="t1",
                                    correlation_id="trigger:t1:gh:42")
        self.assertEqual(s["correlationId"], "trigger:t1:gh:42")
        self.assertEqual(s["type"], "trigger")
        self.assertEqual(s["roomId"], "!r:local")
        self.assertIn("id", s)
        self.assertIn("startedAt", s)

    def test_correlation_id_defaults_to_none(self):
        s = entrypoint._new_session("dm", room_id="!r:local")
        self.assertIsNone(s["correlationId"])


class SessionPointerResumeFlag(unittest.TestCase):
    """The one-shot resumeRequested flag (#574) round-trips through the pointer
    and is cleared by a normal run-end write, so ordinary DM continuity is
    unaffected."""

    def _run(self, body):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            ptr = Path(d) / "!room:local.current.json"
            with patch.object(entrypoint, "_session_pointer_file", return_value=ptr), \
                 patch.object(entrypoint, "_get_push_client", return_value=None):
                return body(ptr)

    def test_normal_write_has_no_flag_and_reads_false(self):
        def body(ptr):
            entrypoint._write_session_pointer("!room:local", "sess-A")
            sid, requested = entrypoint._read_session_pointer_full("!room:local")
            self.assertEqual(sid, "sess-A")
            self.assertFalse(requested)
        self._run(body)

    def test_resume_write_sets_flag_and_reads_true(self):
        def body(ptr):
            entrypoint._write_session_pointer("!room:local", "sess-A", resume_requested=True)
            sid, requested = entrypoint._read_session_pointer_full("!room:local")
            self.assertEqual(sid, "sess-A")
            self.assertTrue(requested)
        self._run(body)

    def test_run_end_write_clears_a_prior_resume_flag(self):
        def body(ptr):
            entrypoint._write_session_pointer("!room:local", "sess-A", resume_requested=True)
            # A successful resume writes the observed id with the default flag.
            entrypoint._write_session_pointer("!room:local", "sess-A")
            _, requested = entrypoint._read_session_pointer_full("!room:local")
            self.assertFalse(requested)
        self._run(body)

    def test_missing_pointer_reads_none_false(self):
        def body(ptr):
            sid, requested = entrypoint._read_session_pointer_full("!room:local")
            self.assertIsNone(sid)
            self.assertFalse(requested)
        self._run(body)

    def test_simple_reader_still_returns_session_id(self):
        def body(ptr):
            entrypoint._write_session_pointer("!room:local", "sess-A", resume_requested=True)
            self.assertEqual(entrypoint._read_session_pointer("!room:local"), "sess-A")
        self._run(body)


class FakeClaudeShim(unittest.TestCase):
    """Two-sided contract for the E2E fake `claude` shim (#666): the shim
    (agent-image/e2e/claude) is the PRODUCER, _map_stream_json_line is the
    CONSUMER, and agent-image/e2e/fake-claude.fixture.json is the shared golden.
    Each case runs the shim as a subprocess, feeds its stdout line-by-line
    through the real parser (threading one usage_sink like the runtime's
    handle_line does), and asserts the normalized events. Guarantees the shim's
    stream-json can never silently drift from what the runtime accepts."""

    @classmethod
    def setUpClass(cls):
        import json
        cls.shim = Path(__file__).resolve().parents[1] / "e2e" / "claude"
        fixture_path = (Path(__file__).resolve().parents[1]
                        / "e2e" / "fake-claude.fixture.json")
        cls.fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    def _run_shim(self, argv, extra_env=None):
        import os
        import subprocess
        env = dict(os.environ)
        env["AEE_FAKE_CLAUDE_SESSION_ID"] = self.fixture["sessionId"]
        if extra_env:
            env.update(extra_env)
        proc = subprocess.run(
            ["python3", str(self.shim), *argv],
            capture_output=True, text=True, env=env, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        return proc.stdout

    def _parse(self, stdout):
        """Mirror the runtime's handle_line: one usage_sink across the whole
        invocation so the result event's contextTokens is populated."""
        usage_sink: dict = {}
        events = []
        for line in stdout.splitlines():
            if not line.strip():
                continue
            events.extend(map_stream_json_line(
                line, self.fixture["correlationId"], usage_sink))
        return events

    def test_golden_fixture_cases(self):
        for case in self.fixture["cases"]:
            with self.subTest(case=case["name"]):
                stdout = self._run_shim(case["argv"])
                events = self._parse(stdout)
                self.assertEqual(events, case["expectedEvents"])

    def test_fixtures_rule_match_overrides_default(self):
        import json
        import tempfile
        rules = [{"match": "COBOL", "reply": "Converted the COBOL program."}]
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8") as fh:
            json.dump(rules, fh)
            rules_path = fh.name
        stdout = self._run_shim(
            ["-p", "please migrate this COBOL job", "--output-format", "stream-json"],
            extra_env={"AEE_FAKE_CLAUDE_FIXTURES": rules_path})
        events = self._parse(stdout)
        text = next(e for e in events if e["type"] == "assistant_text")["text"]
        self.assertEqual(text, "Converted the COBOL program.")

    def test_playbook_runs_before_reply_and_keeps_stdout_clean(self):
        """A fixtures rule may name a `playbook` (#711, §6.2): the shim executes
        it (with the matched prompt in $AEE_FAKE_CLAUDE_PROMPT) BEFORE emitting,
        routes the script's stdout to stderr so the stream-json stays clean, and
        still emits the canned reply."""
        import json
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            pb_dir = os.path.join(d, "playbooks")
            os.makedirs(pb_dir)
            sentinel = os.path.join(d, "ran.txt")
            script = os.path.join(pb_dir, "developer-implement.sh")
            with open(script, "w", encoding="utf-8") as fh:
                fh.write('#!/bin/bash\n'
                         'echo "noise on stdout"\n'
                         f'printf "%s" "$AEE_FAKE_CLAUDE_PROMPT" > {sentinel}\n')
            os.chmod(script, 0o755)
            rules = [{"match": "labelled `ready`", "reply": "Opened PR #7.",
                      "playbook": "developer-implement.sh"}]
            rules_path = os.path.join(d, "fixtures.json")
            with open(rules_path, "w", encoding="utf-8") as fh:
                json.dump(rules, fh)
            prompt = "An issue was labelled `ready` — go build it."
            stdout = self._run_shim(
                ["-p", prompt, "--output-format", "stream-json"],
                extra_env={"AEE_FAKE_CLAUDE_FIXTURES": rules_path,
                           "AEE_FAKE_CLAUDE_PLAYBOOKS": pb_dir})
            # stdout is still parseable stream-json carrying the canned reply —
            # the playbook's own stdout ("noise on stdout") never leaked in.
            events = self._parse(stdout)
            text = next(e for e in events if e["type"] == "assistant_text")["text"]
            self.assertEqual(text, "Opened PR #7.")
            self.assertNotIn("noise on stdout", stdout)
            # The playbook actually ran, with the matched prompt handed to it.
            self.assertTrue(os.path.isfile(sentinel), "playbook did not run")
            with open(sentinel, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), prompt)

    def test_playbook_named_but_dir_unset_is_safe_noop(self):
        """With AEE_FAKE_CLAUDE_PLAYBOOKS unset, a rule's `playbook` is ignored —
        the shim still emits its reply and exits 0 (never fatal)."""
        import json
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            rules = [{"match": "COBOL", "reply": "Done.",
                      "playbook": "nonexistent.sh"}]
            rules_path = os.path.join(d, "fixtures.json")
            with open(rules_path, "w", encoding="utf-8") as fh:
                json.dump(rules, fh)
            env = {k: v for k, v in os.environ.items()
                   if k != "AEE_FAKE_CLAUDE_PLAYBOOKS"}
            env["AEE_FAKE_CLAUDE_FIXTURES"] = rules_path
            # _run_shim asserts returncode == 0; a missing playbook dir must not
            # break that.
            stdout = self._run_shim(
                ["-p", "migrate the COBOL job", "--output-format", "stream-json"],
                extra_env={"AEE_FAKE_CLAUDE_FIXTURES": rules_path})
            events = self._parse(stdout)
            text = next(e for e in events if e["type"] == "assistant_text")["text"]
            self.assertEqual(text, "Done.")

    def test_resume_id_used_as_session_when_no_env_override(self):
        import os
        import subprocess
        env = {k: v for k, v in os.environ.items()
               if k != "AEE_FAKE_CLAUDE_SESSION_ID"}
        proc = subprocess.run(
            ["python3", str(self.shim), "-p", "hi", "--resume", "resumed-sess",
             "--output-format", "stream-json"],
            capture_output=True, text=True, env=env, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        events = self._parse(proc.stdout)
        init = next(e for e in events if e["type"] == "system_init")
        self.assertEqual(init["sessionId"], "resumed-sess")


class MaybeEnableFakeClaude(unittest.TestCase):
    """The PATH seam (#666) must be a strict no-op unless AEE_FAKE_CLAUDE=1, so
    a production container (flag unset) never resolves `claude` to the shim."""

    def _run(self, env_flag, shim_dir=None):
        # Point FAKE_CLAUDE_DIR at a caller-supplied dir so the positive path is
        # exercised deterministically (the baked-in /opt/ace/e2e path doesn't
        # exist in a repo checkout). Default: the real dir, i.e. the guard path.
        import os
        path_before = "/usr/local/bin:/usr/bin"
        with patch.dict(os.environ, {"PATH": path_before}, clear=False):
            if env_flag is None:
                os.environ.pop("AEE_FAKE_CLAUDE", None)
            else:
                os.environ["AEE_FAKE_CLAUDE"] = env_flag
            if shim_dir is not None:
                with patch.object(entrypoint, "FAKE_CLAUDE_DIR", shim_dir):
                    entrypoint._maybe_enable_fake_claude()
            else:
                entrypoint._maybe_enable_fake_claude()
            return os.environ["PATH"]

    def test_flag_unset_leaves_path_untouched(self):
        self.assertNotIn(str(entrypoint.FAKE_CLAUDE_DIR), self._run(None))

    def test_flag_not_one_leaves_path_untouched(self):
        self.assertNotIn(str(entrypoint.FAKE_CLAUDE_DIR), self._run("0"))

    def test_flag_one_prepends_existing_shim_dir(self):
        # Positive path: flag set AND a shim present -> the dir is prepended.
        import os, tempfile
        with tempfile.TemporaryDirectory() as d:
            shim_dir = Path(d)
            (shim_dir / "claude").write_text("#!/bin/sh\n")
            result = self._run("1", shim_dir=shim_dir)
            self.assertTrue(
                result.startswith(str(shim_dir) + os.pathsep),
                f"expected {shim_dir} prepended to PATH, got {result!r}",
            )

    def test_flag_one_missing_shim_is_noop(self):
        # Flag set but no shim on disk -> log and leave PATH untouched.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            shim_dir = Path(d)  # empty: no `claude` file
            result = self._run("1", shim_dir=shim_dir)
            self.assertNotIn(str(shim_dir), result)


class SessionRotation(unittest.TestCase):
    """Pure session-log rotation helpers (#673) — must stay behaviour-compatible
    with orchestrator/session-rotation.js."""

    ROOM = "!abc:host.name"

    def test_archive_name(self):
        self.assertEqual(entrypoint._archive_name(self.ROOM, 1), "!abc:host.name.1.jsonl")
        self.assertEqual(entrypoint._archive_name("!r:local", 42), "!r:local.42.jsonl")

    def test_parse_archive_seq_matches_only_real_archives(self):
        p = entrypoint._parse_archive_seq
        self.assertEqual(p("!abc:host.name.1.jsonl", self.ROOM), 1)
        self.assertEqual(p("!abc:host.name.12.jsonl", self.ROOM), 12)
        self.assertIsNone(p("!abc:host.name.jsonl", self.ROOM))         # live file
        self.assertIsNone(p("!abc:host.name.current.json", self.ROOM))  # pointer
        self.assertIsNone(p("!other:host.name.1.jsonl", self.ROOM))     # other room
        self.assertIsNone(p("!abc:host.name.0.jsonl", self.ROOM))       # seq 0
        self.assertIsNone(p("!abc:host.name.01.jsonl", self.ROOM))      # leading zero

    def test_parse_archive_seq_numeric_homeserver_tail(self):
        room = "!r:1.2.3"
        self.assertEqual(entrypoint._parse_archive_seq("!r:1.2.3.5.jsonl", room), 5)
        self.assertIsNone(entrypoint._parse_archive_seq("!r:1.2.3.jsonl", room))
        self.assertIsNone(entrypoint._parse_archive_seq("!r:9.9.9.5.jsonl", room))

    def test_list_and_next_archive_seq(self):
        names = [
            "!abc:host.name.jsonl", "!abc:host.name.3.jsonl",
            "!abc:host.name.1.jsonl", "!abc:host.name.10.jsonl",
            "unrelated.jsonl", "!abc:host.name.current.json",
        ]
        self.assertEqual([s for s, _ in entrypoint._list_archives(names, self.ROOM)],
                         [1, 3, 10])
        self.assertEqual(entrypoint._next_archive_seq(names, self.ROOM), 11)
        self.assertEqual(entrypoint._next_archive_seq([], self.ROOM), 1)
        self.assertEqual(entrypoint._next_archive_seq(["!abc:host.name.jsonl"], self.ROOM), 1)

    def test_should_rotate(self):
        self.assertFalse(entrypoint._should_rotate(7_999_999, 8_000_000))
        self.assertTrue(entrypoint._should_rotate(8_000_000, 8_000_000))
        self.assertTrue(entrypoint._should_rotate(9_000_000, 8_000_000))
        self.assertFalse(entrypoint._should_rotate(9_000_000, 0))

    def test_plan_prune_by_count(self):
        archives = [(s, entrypoint._archive_name(self.ROOM, s), 1000 + s) for s in range(1, 7)]
        doomed = entrypoint._plan_prune(archives, 3, 0, 10_000)
        self.assertEqual(doomed, [entrypoint._archive_name(self.ROOM, s) for s in (1, 2, 3)])

    def test_plan_prune_by_age(self):
        now = 1_000_000
        day = 24 * 60 * 60 * 1000
        archives = [
            (1, entrypoint._archive_name(self.ROOM, 1), now - 40 * day),
            (2, entrypoint._archive_name(self.ROOM, 2), now - 10 * day),
        ]
        doomed = entrypoint._plan_prune(archives, 0, 30 * day, now)
        self.assertEqual(doomed, [entrypoint._archive_name(self.ROOM, 1)])

    def test_plan_prune_union_no_duplicates(self):
        now = 1_000_000
        day = 24 * 60 * 60 * 1000
        archives = [
            (1, entrypoint._archive_name(self.ROOM, 1), now - 40 * day),  # old + overflow
            (2, entrypoint._archive_name(self.ROOM, 2), now - 1 * day),   # overflow
            (3, entrypoint._archive_name(self.ROOM, 3), now - 1 * day),   # kept
        ]
        doomed = sorted(entrypoint._plan_prune(archives, 1, 30 * day, now))
        self.assertEqual(doomed, sorted([entrypoint._archive_name(self.ROOM, 1),
                                         entrypoint._archive_name(self.ROOM, 2)]))

    def test_plan_prune_both_axes_disabled_keeps_all(self):
        archives = [(s, entrypoint._archive_name(self.ROOM, s), 1) for s in (1, 2, 3)]
        self.assertEqual(entrypoint._plan_prune(archives, 0, 0, 9), [])

    def test_rotation_config_defaults_and_overrides(self):
        with patch.dict("os.environ", {}, clear=False):
            for k in ("AEE_SESSION_ROTATE_BYTES", "AEE_SESSION_ROTATE_KEEP",
                      "AEE_SESSION_ROTATE_MAX_AGE_DAYS"):
                entrypoint.os.environ.pop(k, None)
            self.assertEqual(entrypoint._session_rotation_config(),
                             {"maxBytes": 8_000_000, "maxCount": 5, "maxAgeDays": 30})
        with patch.dict("os.environ", {
            "AEE_SESSION_ROTATE_BYTES": "16000000",
            "AEE_SESSION_ROTATE_KEEP": "3",
            "AEE_SESSION_ROTATE_MAX_AGE_DAYS": "7",
        }):
            self.assertEqual(entrypoint._session_rotation_config(),
                             {"maxBytes": 16_000_000, "maxCount": 3, "maxAgeDays": 7})

    def test_rotation_config_refuses_nonpositive_size(self):
        for bad in ("0", "-5", "nonsense"):
            with patch.dict("os.environ", {"AEE_SESSION_ROTATE_BYTES": bad}):
                self.assertEqual(entrypoint._session_rotation_config()["maxBytes"], 8_000_000)


class ThinkingTokenThrottleTests(unittest.TestCase):
    """The #870 write-layer coalescing of thinking_tokens ticks."""

    class _FakeClock:
        def __init__(self):
            self.t = 0.0
        def __call__(self):
            return self.t

    @staticmethod
    def _tick(n):
        return {"type": "system_event", "subtype": "thinking_tokens",
                "raw": {"type": "system", "subtype": "thinking_tokens",
                        "estimated_tokens": n, "estimated_tokens_delta": 1}}

    def _throttle(self, clock, **kw):
        return entrypoint._ThinkingTokenThrottle(clock=clock, **kw)

    def test_first_tick_emits_immediately(self):
        clk = self._FakeClock()
        thr = self._throttle(clk)
        self.assertIsNotNone(thr.offer(self._tick(10)))

    def test_suppresses_within_interval_and_below_delta(self):
        clk = self._FakeClock()
        thr = self._throttle(clk, min_interval_s=2.0, min_delta=200)
        self.assertIsNotNone(thr.offer(self._tick(10)))   # first → emit
        clk.t = 0.5
        self.assertIsNone(thr.offer(self._tick(11)))       # too soon, tiny delta

    def test_emits_after_interval_elapses(self):
        clk = self._FakeClock()
        thr = self._throttle(clk, min_interval_s=2.0, min_delta=1000)
        thr.offer(self._tick(10))
        clk.t = 2.5
        self.assertIsNotNone(thr.offer(self._tick(12)))    # interval crossed

    def test_emits_when_token_delta_exceeds_threshold(self):
        clk = self._FakeClock()
        thr = self._throttle(clk, min_interval_s=1000.0, min_delta=200)
        thr.offer(self._tick(10))
        clk.t = 0.1
        self.assertIsNotNone(thr.offer(self._tick(250)))   # +240 ≥ 200

    def test_flush_returns_last_suppressed_final_total(self):
        """AC2: the run's final total is recorded even after a burst is dropped."""
        clk = self._FakeClock()
        thr = self._throttle(clk, min_interval_s=2.0, min_delta=1000)
        thr.offer(self._tick(10))                          # emitted
        clk.t = 0.2
        self.assertIsNone(thr.offer(self._tick(50)))
        clk.t = 0.3
        self.assertIsNone(thr.offer(self._tick(90)))       # latest suppressed
        tail = thr.flush()
        self.assertIsNotNone(tail)
        self.assertEqual(tail["raw"]["estimated_tokens"], 90)

    def test_flush_none_when_nothing_pending(self):
        clk = self._FakeClock()
        thr = self._throttle(clk)
        thr.offer(self._tick(10))                          # emitted, nothing pending
        self.assertIsNone(thr.flush())

    def test_flush_is_idempotent(self):
        clk = self._FakeClock()
        thr = self._throttle(clk, min_interval_s=2.0, min_delta=1000)
        thr.offer(self._tick(10))
        clk.t = 0.1
        thr.offer(self._tick(20))                          # suppressed
        self.assertIsNotNone(thr.flush())
        self.assertIsNone(thr.flush())                     # second call → None

    def test_non_numeric_tokens_do_not_crash(self):
        clk = self._FakeClock()
        thr = self._throttle(clk, min_interval_s=1000.0, min_delta=200)
        thr.offer({"type": "system_event", "subtype": "thinking_tokens",
                   "raw": {"estimated_tokens": None}})
        clk.t = 0.1
        # No usable delta and interval not crossed → suppressed, no exception.
        self.assertIsNone(thr.offer({"type": "system_event",
                                     "subtype": "thinking_tokens", "raw": {}}))
        self.assertIsNotNone(thr.flush())


if __name__ == "__main__":
    unittest.main()
