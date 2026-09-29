#!/usr/bin/env python3
"""Shared CLI-contract conformance test (#1522).

Exercises the five built-in agent CLIs — `aee-artifact`, `aee-wake`,
`aee-ask`, `knowledge`, `gh-as-agent` — against the one shared contract documented in
`docs/cli-contract.md` (concept `docs/plugin-system-concept.md` §4.5):

  * Discovery: `--help` / `-h` / `help` / bare invocation → exit 0 with the
    help text on **stdout**.
  * Usage errors (unknown subcommand, bad/missing arguments) → exit **2**,
    diagnostic on **stderr**.
  * Machine-readable output: `--json` yields a single JSON object/line on
    **stdout** for the data-returning subcommands.
  * Exit-code semantics: 0 ok · 1 domain error · 2 usage error · 3 backend
    (orchestrator) unreachable.

Only the **backend-free** surface is exercised (help, arg validation, offline
`--json`, and the unreachable-orchestrator path forced with a dead endpoint);
the live git + network happy paths in the `cmd_*` wrappers are verified
manually per the repo convention (see test_knowledge.py). Run with:

    python3 -m unittest agent-image/scripts/test_cli_contract.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent

# Interpreter per CLI — the CLIs are extensionless and not guaranteed +x in the
# repo tree, so invoke them through their runtime rather than relying on the
# exec bit or a shebang lookup.
CLIS = {
    "aee-artifact": [sys.executable, str(SCRIPTS / "aee-artifact")],
    "aee-wake": [sys.executable, str(SCRIPTS / "aee-wake")],
    "aee-ask": [sys.executable, str(SCRIPTS / "aee-ask")],
    "knowledge": [sys.executable, str(SCRIPTS / "knowledge")],
    "gh-as-agent": ["bash", str(SCRIPTS / "gh-as-agent")],
}

# A dead endpoint (connection refused) so the network-touching CLIs take their
# "orchestrator unreachable" branch deterministically, without a real backend.
DEAD_ORCH = "http://127.0.0.1:9"


def run(cli, args, env_extra=None, cwd=None):
    env = dict(os.environ)
    # AGENT_ID is a precondition for gh-as-agent/aee-wake; set a conformant one
    # so we test the *contract* paths, not the missing-identity guard.
    env["AGENT_ID"] = "contract-test"
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        CLIS[cli] + args,
        capture_output=True, text=True, env=env, cwd=cwd, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


class HelpDiscovery(unittest.TestCase):
    """Every CLI answers --help / -h / help / bare with help on stdout, exit 0."""

    def test_help_variants(self):
        for cli in CLIS:
            for variant in (["--help"], ["-h"], ["help"], []):
                with self.subTest(cli=cli, variant=variant):
                    code, out, _ = run(cli, variant)
                    self.assertEqual(code, 0, f"{cli} {variant} should exit 0")
                    self.assertTrue(out.strip(), f"{cli} {variant} should print help to stdout")
                    self.assertIn(cli, out, f"{cli} help should name the tool")


class UsageErrors(unittest.TestCase):
    """Unknown subcommand / bad usage → exit 2 with a diagnostic on stderr."""

    def test_unknown_subcommand(self):
        for cli in CLIS:
            with self.subTest(cli=cli):
                code, _out, err = run(cli, ["definitely-not-a-subcommand"])
                self.assertEqual(code, 2, f"{cli} unknown subcommand should exit 2")
                self.assertTrue(err.strip(), f"{cli} should diagnose on stderr")

    def test_missing_required_args(self):
        cases = [
            ("aee-wake", ["--to"]),             # --to with no value
            ("aee-ask", ["Which?"]),            # question but no --option
            ("aee-artifact", ["add", "only-name"]),  # missing <path>
            ("knowledge", ["add"]),             # missing <kind> <text>
            ("gh-as-agent", ["pr"]),            # missing --title (before any network)
        ]
        for cli, args in cases:
            with self.subTest(cli=cli, args=args):
                code, _out, _err = run(cli, args)
                self.assertEqual(code, 2, f"{cli} {args} should be a usage error (exit 2)")


class JsonOutput(unittest.TestCase):
    """--json produces a single machine-readable JSON object on stdout."""

    def test_gh_as_agent_marker_json(self):
        code, out, _ = run("gh-as-agent", ["marker", "--json"])
        self.assertEqual(code, 0)
        obj = json.loads(out.strip())
        self.assertIn("marker", obj)
        self.assertIn("contract-test", obj["marker"])

    def test_aee_artifact_json_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q"], cwd=d, check=True)
            code, out, _ = run("aee-artifact", ["add", "Design", "designs/fd.md", "--json"], cwd=d)
            self.assertEqual(code, 0)
            entry = json.loads(out.strip())
            self.assertEqual(entry["artifact"], "Design")
            self.assertEqual(entry["path"], "designs/fd.md")

            code, out, _ = run("aee-artifact", ["path", "Design", "--json"], cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.strip()), {"artifact": "Design", "path": "designs/fd.md"})

            # `list` is machine-readable by default (one JSON object per line).
            code, out, _ = run("aee-artifact", ["list"], cwd=d)
            self.assertEqual(code, 0)
            rows = [json.loads(ln) for ln in out.splitlines() if ln.strip()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["artifact"], "Design")

    def test_aee_wake_json_usage_error(self):
        code, out, _ = run("aee-wake", ["--json"])
        self.assertEqual(code, 2)
        obj = json.loads(out.strip())
        self.assertFalse(obj["ok"])
        self.assertIn("error", obj)

    def test_aee_wake_forgotten_value_is_a_usage_error_not_a_target(self):
        # #2030: swallowing the next flag as --to's value would POST
        # `toAgentId: "--json"` and report a 404 wiring problem (exit 1) for
        # what is really a usage error.
        for args in (["--to", "--json"], ["--to", "--note"], ["--to", "x", "--note", "--json"]):
            with self.subTest(args=args):
                code, _out, err = run("aee-wake", args)
                self.assertEqual(code, 2, f"{args} should be a usage error")
                self.assertTrue(err.strip())

    def test_aee_wake_note_may_begin_with_a_dash(self):
        # Only aee-wake's OWN flags are rejected in a value slot, so a note is
        # not silently refused for starting with punctuation.
        code, out, _err = run(
            "aee-wake", ["--to", "r", "--note", "-- see the PR", "--json"],
            env_extra={"ORCHESTRATOR_INTERNAL_URL": DEAD_ORCH},
        )
        self.assertEqual(code, 3, "it reached the unreachable-backend path, not a usage error")
        self.assertFalse(json.loads(out.strip())["ok"])


    def test_aee_ask_json_roundtrip_and_usage_error(self):
        # Backend-free by design (#2523): the question goes to a sentinel file.
        with tempfile.TemporaryDirectory() as d:
            sentinel = os.path.join(d, "ask.json")
            code, out, _ = run("aee-ask", ["Go?", "--option", "yes", "--json"],
                               env_extra={"AEE_ASK_FILE": sentinel})
            self.assertEqual(code, 0)
            obj = json.loads(out.strip())
            self.assertTrue(obj["ok"])
            self.assertEqual(obj["questions"], 1)
            self.assertTrue(os.path.exists(sentinel))

            code, out, _ = run("aee-ask", ["Go?", "--json"],
                               env_extra={"AEE_ASK_FILE": sentinel + ".2"})
            self.assertEqual(code, 2)
            self.assertFalse(json.loads(out.strip())["ok"])
            self.assertFalse(os.path.exists(sentinel + ".2"))


class UnreachableBackend(unittest.TestCase):
    """A dead orchestrator → exit 3 (nothing was delivered / pushed)."""

    def test_gh_as_agent_push_unreachable(self):
        code, out, _err = run(
            "gh-as-agent", ["push", "--json"],
            env_extra={"ORCHESTRATOR_INTERNAL_URL": DEAD_ORCH},
        )
        self.assertEqual(code, 3, "unreachable orchestrator must be exit 3")
        self.assertFalse(json.loads(out.strip())["ok"])

    def test_aee_wake_unreachable(self):
        # #2030: target-LESS, so this needs no git clone at all — there is no
        # repo to resolve a hand-off against.
        code, out, _err = run(
            "aee-wake", ["--to", "some-reviewer", "--json"],
            env_extra={"ORCHESTRATOR_INTERNAL_URL": DEAD_ORCH},
        )
        self.assertEqual(code, 3, "unreachable orchestrator must be exit 3")
        self.assertFalse(json.loads(out.strip())["ok"])


if __name__ == "__main__":
    unittest.main()
