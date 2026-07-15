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
from datetime import timedelta
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


class MaintenanceModeGating(unittest.IsolatedAsyncioTestCase):
    """#504: cron/once triggers must not fire while Maintenance Mode (#501) is
    active, http/github-event pending entries must not be drained/processed
    while active, and a cron trigger whose fire fell inside the window gets
    exactly one catch-up run once it ends."""

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


if __name__ == "__main__":
    unittest.main()
