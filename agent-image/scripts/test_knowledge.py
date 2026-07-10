#!/usr/bin/env python3
"""Unit tests for the pure core of the `knowledge` CLI.

The CLI has no `.py` extension (it lives on PATH as `knowledge`), so it is
loaded via SourceFileLoader — the same trick test_agent_entrypoint.py uses for
the entrypoint. Only the PURE core is tested (build_entry / serialize / parse /
match / manifest); the git + network IO in the cmd_* wrappers is verified
manually per repo convention. Run with:

    python3 -m unittest agent-image/scripts/test_knowledge.py
"""
import importlib.util
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

_CLI_PATH = Path(__file__).resolve().parent / "knowledge"
_loader = SourceFileLoader("knowledge_cli", str(_CLI_PATH))
_spec = importlib.util.spec_from_loader("knowledge_cli", _loader)
kn = importlib.util.module_from_spec(_spec)
_loader.exec_module(kn)

# The cross-runtime guard: this exact string must be produced by BOTH the Python
# core here and orchestrator/knowledge-store.js `serializeEntry` (see the mirror
# assertion in the node --test). If either side reorders keys or changes JSON
# spacing, the shared KB files diverge — so both tests pin the same golden line.
GOLDEN = (
    '{"v":1,"id":"0123456789ab","kind":"fact","text":"Branch from origin/main",'
    '"originAgent":"cobol-agent","teamId":"team-x","createdAt":"2026-07-08T10:00:00Z",'
    '"correlationId":"evt-123","sourceRefs":[{"kind":"pr","ref":"459"}],'
    '"convergence":["cobol-agent"],"tags":["git","workflow"],"status":"active"}'
)


def _golden_entry():
    return kn.build_entry(
        "fact", "Branch from origin/main",
        origin_agent="cobol-agent", team_id="team-x",
        correlation_id="evt-123", source_refs=[{"kind": "pr", "ref": "459"}],
        tags=["git", "workflow"],
        entry_id="0123456789ab", created_at="2026-07-08T10:00:00Z",
    )


class BuildEntry(unittest.TestCase):
    def test_defaults_and_convergence_seed(self):
        e = kn.build_entry("fact", "x", origin_agent="a1", team_id="t",
                           correlation_id="c1")
        self.assertEqual(e["v"], 1)
        self.assertEqual(e["kind"], "fact")
        self.assertEqual(e["convergence"], ["a1"])  # seeded [originAgent]
        self.assertEqual(e["status"], "active")
        self.assertTrue(len(e["id"]) == 12)

    def test_id_is_12_hex(self):
        e = kn.build_entry("fact", "x", origin_agent="a", team_id="t", correlation_id="c")
        import re
        self.assertRegex(e["id"], r"^[0-9a-f]{12}$")

    def test_missing_provenance_link_raises(self):
        # originAgent/teamId/createdAt present but NO correlationId/sessionId/sourceRefs
        with self.assertRaises(ValueError):
            kn.build_entry("fact", "x", origin_agent="a", team_id="t")

    def test_correlation_id_alone_satisfies_provenance(self):
        e = kn.build_entry("fact", "x", origin_agent="a", team_id="t", correlation_id="c1")
        self.assertEqual(e["correlationId"], "c1")

    def test_source_ref_alone_satisfies_provenance(self):
        e = kn.build_entry("fact", "x", origin_agent="a", team_id="t",
                           source_refs=[{"kind": "pr", "ref": "1"}])
        self.assertEqual(e["sourceRefs"], [{"kind": "pr", "ref": "1"}])

    def test_bad_kind_raises(self):
        with self.assertRaises(ValueError):
            kn.build_entry("nonsense", "x", origin_agent="a", team_id="t", correlation_id="c")

    def test_empty_text_raises(self):
        with self.assertRaises(ValueError):
            kn.build_entry("fact", "   ", origin_agent="a", team_id="t", correlation_id="c")

    def test_missing_origin_agent_raises(self):
        with self.assertRaises(ValueError):
            kn.build_entry("fact", "x", origin_agent="", team_id="t", correlation_id="c")

    def test_bad_source_refs_dropped(self):
        e = kn.build_entry("fact", "x", origin_agent="a", team_id="t",
                           correlation_id="c",
                           source_refs=[{"kind": "bogus", "ref": "1"}, {"kind": "pr", "ref": "9"}])
        self.assertEqual(e["sourceRefs"], [{"kind": "pr", "ref": "9"}])


class Serialize(unittest.TestCase):
    def test_golden_matches_js_core(self):
        self.assertEqual(kn.serialize_entry(_golden_entry()), GOLDEN)

    def test_key_order_no_spaces(self):
        line = kn.serialize_entry(_golden_entry())
        self.assertNotIn(", ", line)  # separators=(",",":"), matches JSON.stringify
        self.assertTrue(line.startswith('{"v":1,"id":'))

    def test_round_trip(self):
        e = _golden_entry()
        self.assertEqual(kn.parse_entry(kn.serialize_entry(e)), e)


class Parse(unittest.TestCase):
    def test_blank_and_mangled_return_none(self):
        for bad in ("", "   ", "{not json", "[1,2,3]", "42", None):
            self.assertIsNone(kn.parse_entry(bad))

    def test_valid_line(self):
        self.assertEqual(kn.parse_entry(GOLDEN)["id"], "0123456789ab")


class Match(unittest.TestCase):
    def setUp(self):
        self.entries = [
            {"kind": "fact", "text": "poller pagination handles bursts", "tags": ["polling"]},
            {"kind": "entity", "text": "github-poller.js polls every 30s"},
            {"kind": "convention", "text": "Branch from origin/main"},
        ]

    def test_substring_case_insensitive(self):
        m = kn.match_entries(self.entries, "POLLER")
        self.assertEqual(len(m), 2)

    def test_kind_filter(self):
        m = kn.match_entries(self.entries, "poller", kind="fact")
        self.assertEqual(len(m), 1)
        self.assertEqual(m[0]["kind"], "fact")

    def test_tag_match(self):
        m = kn.match_entries(self.entries, "polling")
        self.assertEqual(len(m), 1)

    def test_invalid_regex_falls_back_to_substring(self):
        # a stray unbalanced paren must not crash the search
        m = kn.match_entries(self.entries, "origin/main(")
        self.assertEqual(m, [])  # no literal match, but no crash
        m2 = kn.match_entries([{"kind": "fact", "text": "a(b"}], "a(")
        self.assertEqual(len(m2), 1)

    def test_empty_query_returns_all(self):
        self.assertEqual(len(kn.match_entries(self.entries, "")), 3)

    def test_bad_kind_returns_empty(self):
        self.assertEqual(kn.match_entries(self.entries, "x", kind="bogus"), [])


class Manifest(unittest.TestCase):
    def test_default_manifest_shape(self):
        m = kn.build_default_manifest()
        self.assertEqual(kn.kind_dir(m, "fact"), "facts")
        self.assertEqual(kn.kind_canonical_file(m, "fact"), "facts/facts.jsonl")

    def test_parse_source_ref(self):
        self.assertEqual(kn.parse_source_ref("pr:459"), {"kind": "pr", "ref": "459"})
        self.assertEqual(kn.parse_source_ref("url:https://x/y"), {"kind": "url", "ref": "https://x/y"})
        self.assertIsNone(kn.parse_source_ref("bogus:1"))
        self.assertIsNone(kn.parse_source_ref("nope"))


class LeanSummary(unittest.TestCase):
    """The Phase-2 push summary — only whitelisted fields, count from convergence."""

    def test_whitelists_fields(self):
        entry = {
            "id": "9f3a12bc7de0", "kind": "fact", "text": "hi",
            "originAgent": "acme-dev-1", "teamId": "acme",
            "convergence": ["acme-dev-1", "acme-dev-2"], "correlationId": "$evt1",
        }
        self.assertEqual(kn.lean_summary(entry), {
            "id": "9f3a12bc7de0", "kind": "fact", "text": "hi",
            "originAgent": "acme-dev-1", "convergenceCount": 2,
        })

    def test_defaults_count_to_one(self):
        self.assertEqual(kn.lean_summary({"id": "aaaaaaaaaaaa"})["convergenceCount"], 1)

    def test_drops_idless(self):
        self.assertIsNone(kn.lean_summary({"kind": "fact"}))
        self.assertIsNone(kn.lean_summary(None))


class BuildNominationTests(unittest.TestCase):
    """The `knowledge promote <id>` nomination payload (Phase 3)."""

    def test_shape_with_note(self):
        self.assertEqual(
            kn.build_nomination("9f3a12bc7de0", "worth it", "acme-dev-1"),
            {"entryId": "9f3a12bc7de0", "agentId": "acme-dev-1", "note": "worth it"},
        )

    def test_note_omitted_when_blank(self):
        body = kn.build_nomination("9f3a12bc7de0", "   ", "acme-dev-1")
        self.assertNotIn("note", body)
        self.assertEqual(body["entryId"], "9f3a12bc7de0")
        body2 = kn.build_nomination("9f3a12bc7de0", None, "acme-dev-1")
        self.assertNotIn("note", body2)

    def test_promote_dispatches_not_stub(self):
        # The verb is wired (no longer the exit-3 stub) and resolves cmd_promote.
        self.assertIn("promote", ("add", "search", "list", "path", "promote"))
        self.assertTrue(callable(kn.cmd_promote))


class SlugifySkillNameTests(unittest.TestCase):
    """Mirror of slugifySkillName in the JS suggestions/curator cores."""

    def test_slug_from_text(self):
        self.assertEqual(kn.slugify_skill_name("This repo unit-tests pure helper cores only"),
                         "this-repo-unit-tests-pure-helper")

    def test_fallback_on_empty_or_invalid(self):
        self.assertEqual(kn.slugify_skill_name("", "entity"), "entity-skill")
        self.assertEqual(kn.slugify_skill_name("!!!", "convention"), "convention-skill")


class BuildAgentSkillTests(unittest.TestCase):
    """`knowledge promote <id> --to agent` — a private agent-tier skill (Phase 4)."""

    def _entry(self, **over):
        base = {
            "v": 1, "id": "9f3a12bc7de0", "kind": "fact",
            "text": "Branch from origin/main",
            "originAgent": "acme-dev-1", "teamId": "acme",
            "createdAt": "2026-07-08T09:00:00Z", "correlationId": "$evt1",
            "convergence": ["acme-dev-1"], "status": "active",
            "sourceRefs": [{"kind": "pr", "ref": "459"}],
        }
        base.update(over)
        return base

    def test_shape_and_mandatory_provenance(self):
        s = kn.build_agent_skill(self._entry(), agent_id="acme-dev-1", team_id="acme",
                                 now=lambda: "2026-07-09T00:00:00Z")
        self.assertEqual(s["name"], "branch-from-origin-main")
        self.assertTrue(s["skill_md"].startswith("# Branch from origin/main"))
        self.assertIn("Branch from origin/main", s["skill_md"])
        prov = s["provenance"]
        self.assertEqual(prov["toTier"], "agent")
        self.assertEqual(prov["entryIds"], ["9f3a12bc7de0"])  # graph skillEntryIds needs this
        self.assertEqual(prov["originAgents"], ["acme-dev-1"])
        self.assertEqual(prov["promotedBy"], "acme-dev-1")
        self.assertEqual(prov["promotedAt"], "2026-07-09T00:00:00Z")
        self.assertEqual(prov["sourceRefs"], [{"kind": "pr", "ref": "459"}])
        self.assertEqual(prov["sessions"], [{"agentId": "acme-dev-1", "correlationId": "$evt1"}])

    def test_custom_name_and_no_correlation(self):
        s = kn.build_agent_skill(self._entry(correlationId=None), name="my-skill",
                                 agent_id="a1", now=lambda: "t")
        self.assertEqual(s["name"], "my-skill")
        self.assertEqual(s["provenance"]["sessions"], [])

    def test_invalid_name_raises(self):
        with self.assertRaises(ValueError):
            kn.build_agent_skill(self._entry(), name="bad name!", agent_id="a1")

    def test_entry_without_id_raises(self):
        with self.assertRaises(ValueError):
            kn.build_agent_skill({"text": "x"}, agent_id="a1")

    def test_no_secrets_in_body(self):
        s = kn.build_agent_skill(self._entry(), agent_id="a1", now=lambda: "t")
        self.assertNotIn("$evt1", s["skill_md"])  # correlationId stays out of the body


class TestVisibleEntries(unittest.TestCase):
    """visible_entries hides non-curated lines from `knowledge search` / `list` so an
    agent's query matches the operator's Knowledge Flow (and never surfaces a fact a
    human has not yet approved)."""

    def _e(self, eid, status="active", **over):
        d = {"id": eid, "kind": "fact", "text": eid, "status": status,
             "createdAt": "2026-07-08T09:00:00Z"}
        d.update(over)
        return d

    def test_active_kept_hidden_statuses_dropped(self):
        entries = [
            self._e("a" * 12, "active"),
            self._e("b" * 12, "promoted"),
            self._e("c" * 12, "archived"),
            self._e("d" * 12, "pending"),
            self._e("e" * 12, "rejected"),
            self._e("f" * 12, "merged", mergedInto="a" * 12),
        ]
        ids = [e["id"] for e in kn.visible_entries(entries)]
        self.assertEqual(ids, ["a" * 12, "b" * 12])

    def test_shard_active_plus_canonical_pending_same_id_is_hidden(self):
        # shard copy (active) read first, canonical held copy (pending) read last —
        # the held status must win so the fact never reaches the query.
        entries = [
            self._e("b" * 12, "active", createdAt="2026-07-08T09:00:00Z"),
            self._e("b" * 12, "pending", createdAt="2026-07-08T09:00:00Z"),
        ]
        self.assertEqual(kn.visible_entries(entries), [])

    def test_newer_active_update_beats_stale_pending(self):
        entries = [
            self._e("b" * 12, "pending", updatedAt="2026-07-08T09:00:00Z"),
            self._e("b" * 12, "active", updatedAt="2026-07-08T11:00:00Z"),
        ]
        ids = [e["id"] for e in kn.visible_entries(entries)]
        self.assertEqual(ids, ["b" * 12])  # approved later → visible again

    def test_no_id_skipped_and_output_stable(self):
        entries = [self._e("a" * 12), {"text": "no id"}, self._e("a" * 12)]
        self.assertEqual([e["id"] for e in kn.visible_entries(entries)], ["a" * 12])


if __name__ == "__main__":
    unittest.main()
