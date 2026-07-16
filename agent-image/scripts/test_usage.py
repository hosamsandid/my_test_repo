#!/usr/bin/env python3
"""Unit tests for the pure core of the `usage` CLI (#679).

The CLI has no `.py` extension (it lives on PATH as `usage`), so it is loaded
via SourceFileLoader — the same trick test_knowledge.py uses. Only the PURE core
is tested (URL assembly + rendering + the no-money guarantee); the network IO in
the cmd_* wrappers is verified manually per repo convention (concept §8). Run:

    python3 -m unittest agent-image/scripts/test_usage.py
"""
import importlib.util
import re
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from urllib.parse import urlparse, parse_qs

_CLI_PATH = Path(__file__).resolve().parent / "usage"
_loader = SourceFileLoader("usage_cli", str(_CLI_PATH))
_spec = importlib.util.spec_from_loader("usage_cli", _loader)
uu = importlib.util.module_from_spec(_spec)
_loader.exec_module(uu)


class BuildUrl(unittest.TestCase):
    def test_defaults_to_self_scope_only(self):
        url = uu.build_summary_url("http://orchestrator:4002", "dev-1")
        parsed = urlparse(url)
        self.assertEqual(parsed.path, "/internal/agents/dev-1/usage/summary")
        self.assertEqual(parse_qs(parsed.query), {"scope": ["self"]})

    def test_all_params_threaded(self):
        url = uu.build_summary_url(
            "http://orchestrator:4002/", "dev-1",
            scope="team", since="2026-07-01", until="2026-07-16", group_by="day",
        )
        q = parse_qs(urlparse(url).query)
        self.assertEqual(q["scope"], ["team"])
        self.assertEqual(q["since"], ["2026-07-01"])
        self.assertEqual(q["until"], ["2026-07-16"])
        self.assertEqual(q["groupBy"], ["day"])

    def test_bad_scope_falls_closed_to_self(self):
        url = uu.build_summary_url("http://o:4002", "dev-1", scope="all")
        self.assertEqual(parse_qs(urlparse(url).query)["scope"], ["self"])

    def test_agent_id_is_path_quoted(self):
        url = uu.build_summary_url("http://o:4002", "team/../etc")
        self.assertIn("team%2F..%2Fetc", url)
        self.assertNotIn("team/../etc", url)

    def test_omitted_params_are_absent(self):
        q = parse_qs(urlparse(uu.build_summary_url("http://o:4002", "a")).query)
        self.assertNotIn("since", q)
        self.assertNotIn("until", q)
        self.assertNotIn("groupBy", q)


_SAMPLE = {
    "scope": "self",
    "agentId": "dev-1",
    "teamId": None,
    "since": "2026-07-01",
    "until": None,
    "groupBy": "agent",
    "tokenClasses": list(uu.TOKEN_CLASSES),
    "tokensOnly": True,
    "totals": {
        "input": 30, "output": 9, "cacheCreationInput": 1,
        "cacheReadInput": 2, "total": 42, "invocations": 2,
    },
    "groups": [
        {"key": "dev-1", "tokens": {
            "input": 30, "output": 9, "cacheCreationInput": 1,
            "cacheReadInput": 2, "total": 42,
        }},
    ],
}


class FormatSummary(unittest.TestCase):
    def test_renders_four_classes_total_and_invocations(self):
        out = uu.format_summary(_SAMPLE)
        for label in ("Input", "Output", "Cache write", "Cache read", "Total", "Invocations"):
            self.assertIn(label, out)
        self.assertIn("42", out)  # total
        self.assertIn("dev-1", out)  # group key

    def test_zeroed_result_renders_without_error(self):
        out = uu.format_summary({"scope": "self", "totals": {}, "groups": []})
        self.assertIn("Total", out)
        self.assertIn("0", out)

    def test_malformed_result_is_zeroed_not_raised(self):
        self.assertIn("Total", uu.format_summary(None))
        self.assertIn("Total", uu.format_summary("nonsense"))

    def test_no_money_figures_ever(self):
        # AC4: even if the endpoint smuggled a cost field, the renderer only reads
        # the four token classes + total + invocations, so no money can leak.
        dirty = dict(_SAMPLE)
        dirty["totals"] = dict(_SAMPLE["totals"], costUsd=1.23, totalCostUsd=4.56)
        dirty["groups"] = [dict(g, costUsd=9.9) for g in _SAMPLE["groups"]]
        out = uu.format_summary(dirty).lower()
        self.assertIsNone(re.search(r"cost|usd|dollar|price|\$", out))

    def test_team_scope_names_the_team(self):
        out = uu.format_summary(dict(_SAMPLE, scope="team", teamId="team-a"))
        self.assertIn("team team-a", out)


if __name__ == "__main__":
    unittest.main()
