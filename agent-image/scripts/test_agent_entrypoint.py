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

    def test_multiline_text_flattened(self):
        res = entrypoint.build_knowledge_digest(
            team_id="t", generated_at="2026-07-13T09:00:00Z",
            entries=[{"id": "abc000000001", "kind": "fact", "text": "line one\nline two",
                      "createdAt": "2026-07-01T00:00:00Z", "convergence": ["a"],
                      "status": "active"}],
        )
        self.assertIn("- fact: line one line two (2026-07-01)", res["markdown"])


if __name__ == "__main__":
    unittest.main()
