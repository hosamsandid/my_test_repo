#!/usr/bin/env python3
"""Tests for the `gh` shim `aee-gh` (#2559).

Pure classification/marshalling tests plus end-to-end runs of the script
against a fake orchestrator (a local HTTP server) and a fake real `gh`
(`AEE_REAL_GH`), so every path — local passthrough, forwarded, refused,
baseline fallback — is exercised without GitHub.

    python -m pytest agent-image/scripts/test_aee_gh.py -q
"""
import base64
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "aee-gh"


def _load():
    loader = importlib.machinery.SourceFileLoader("aee_gh", str(SCRIPT))
    spec = importlib.util.spec_from_loader("aee_gh", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


G = _load()


class Classification(unittest.TestCase):
    def test_writes_are_forwarded(self):
        for argv in [
            "issue create --title t --body b",
            "issue comment 5 --body b",
            "issue edit 5 --add-label ready-for-review",
            "issue close 5",
            "pr comment 7 --body b",
            "pr review 7 --approve",
            "pr edit 7 --remove-label x",
            "label create foo --color FBCA04",
            "api -X POST repos/o/r/issues/1/comments -f body=x",
            "api repos/o/r/issues/1/labels -f labels[]=x",
            "api --method=PATCH repos/o/r/issues/1",
            "api -XDELETE repos/o/r/issues/1/labels/x",
        ]:
            with self.subTest(argv=argv):
                self.assertTrue(G.is_forwarded_write(G._normalise(argv.split())))

    def test_reads_and_local_commands_stay_local(self):
        for argv in [
            "issue view 5",
            "issue list --label ready",
            "pr view 7 --json body",
            "pr diff 7",
            "pr checks 7",
            "pr checkout 7",
            "repo clone o/r",
            "run view 1 --log",
            "label list",
            "api repos/o/r/issues",
            "api -X GET repos/o/r/issues -f state=open",
            "api repos/o/r --jq .name",
            "auth status",
            "config set editor vim",
            "extension install x/y",
            "search issues foo",
            "--version",
            "issue",
            "issue create --help",
        ]:
            with self.subTest(argv=argv):
                self.assertFalse(G.is_forwarded_write(G._normalise(argv.split())))

    def test_graphql_mutation_vs_query(self):
        self.assertTrue(G.api_is_write(["graphql", "-f", "query=mutation { addComment }"]))
        self.assertFalse(G.api_is_write(["graphql", "-f", "query=query { viewer { login } }"]))
        self.assertFalse(G.api_is_write(["graphql", "-f", "query={ viewer { login } }"]))
        with tempfile.NamedTemporaryFile("w", suffix=".graphql", delete=False) as fh:
            fh.write("  mutation M { x }")
        try:
            self.assertTrue(G.api_is_write(["graphql", "-F", f"query=@{fh.name}"]))
        finally:
            os.unlink(fh.name)
        # Unreadable query → fail closed (forwarded, never the baseline silently).
        self.assertTrue(G.api_is_write(["graphql"]))

    def test_file_references(self):
        args = G._normalise(["issue", "comment", "5", "--body-file=/tmp/a"])
        self.assertEqual(G._file_refs(args), [(4, "", "/tmp/a")])
        args = G._normalise(["pr", "review", "7", "--comment", "-F", "/tmp/b"])
        self.assertEqual(G._file_refs(args), [(5, "", "/tmp/b")])
        args = G._normalise(["api", "x", "-F", "body=@/tmp/c", "-F", "n=1", "--input", "-"])
        self.assertEqual(G._file_refs(args), [(3, "body=@", "/tmp/c"), (7, "", "-")])
        self.assertTrue(G._needs_stdin(args))
        # `-f` is a raw field — never a file, even with an @.
        self.assertEqual(G._file_refs(["api", "x", "-f", "body=@/tmp/c"]), [])

    def test_repo_from_remote(self):
        self.assertEqual(G._repo_from_remote_url("git@github.com:Org/repo.git\n"), "Org/repo")
        self.assertEqual(G._repo_from_remote_url("ssh://git@ssh.github.com:443/Org/repo.git"), None)
        self.assertEqual(G._repo_from_remote_url("https://github.com/Org/repo"), "Org/repo")
        self.assertEqual(G._repo_from_remote_url("https://x-access-token:t@github.com/Org/repo.git"), "Org/repo")
        self.assertEqual(G._repo_from_remote_url("https://ghe.corp/Org/repo.git"), "ghe.corp/Org/repo")
        self.assertIsNone(G._repo_from_remote_url("not a url"))


class _Orch(BaseHTTPRequestHandler):
    response = (200, {"ok": True, "mode": "baseline"})
    requests: list = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        _Orch.requests.append({"path": self.path, "body": json.loads(self.rfile.read(n)),
                               "auth": self.headers.get("Authorization")})
        status, body = _Orch.response
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Orch)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.tmp = tempfile.mkdtemp()
        cls.fake_gh = os.path.join(cls.tmp, "real-gh")
        # The "real" gh: echoes what it was asked and under which token.
        with open(cls.fake_gh, "w") as fh:
            fh.write("#!/bin/sh\necho \"LOCAL $* token=$GH_TOKEN\"\ncat >/dev/null\n")
        os.chmod(cls.fake_gh, 0o755)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _Orch.requests = []
        _Orch.response = (200, {"ok": True, "mode": "baseline"})

    def run_gh(self, args, sender="@b:local", stdin=None):
        env = dict(os.environ)
        env.update({
            "AGENT_ID": "team-x-dev",
            "AEE_REAL_GH": self.fake_gh,
            "GH_TOKEN": "baseline-token",
            "AEE_INTERNAL_TOKEN": "agent-tok",
            "ORCHESTRATOR_INTERNAL_URL": f"http://127.0.0.1:{self.server.server_port}",
            "GH_REPO": "o/r",
        })
        env.pop("AEE_ACTING_SENDER", None)
        if sender is not None:
            env["AEE_ACTING_SENDER"] = sender
        return subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin,
                              capture_output=True, text=True, env=env, cwd=self.tmp, timeout=30)

    def test_autonomous_run_never_forwards(self):
        # AC7: no acting sender (cron / GitHub event / loop) → the baseline, locally.
        p = self.run_gh(["issue", "comment", "5", "--body", "x"], sender=None)
        self.assertEqual(p.returncode, 0)
        self.assertIn("LOCAL issue comment 5 --body x token=baseline-token", p.stdout)
        self.assertEqual(_Orch.requests, [])

    def test_chat_turn_read_stays_local(self):
        # AC8: reads keep working without a personal token — never forwarded.
        _Orch.response = (424, {"ok": False, "code": "personal-credential-required", "error": "nope"})
        for args in (["issue", "view", "5"], ["api", "repos/o/r/issues"]):
            p = self.run_gh(args)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("token=baseline-token", p.stdout)
        self.assertEqual(_Orch.requests, [])

    def test_chat_turn_write_is_forwarded_and_relayed(self):
        _Orch.response = (200, {"ok": True, "mode": "attributed", "exitCode": 0,
                                "stdout": "https://github.com/o/r/issues/9\n", "stderr": ""})
        body = os.path.join(self.tmp, "body.md")
        with open(body, "w") as fh:
            fh.write("hi\n<!-- agent: team-x-dev -->\n")
        p = self.run_gh(["issue", "create", "--title", "T", "--body-file", body])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "https://github.com/o/r/issues/9\n")
        self.assertNotIn("LOCAL", p.stdout)
        [req] = _Orch.requests
        self.assertEqual(req["path"], "/internal/agents/team-x-dev/github/gh")
        self.assertEqual(req["auth"], "Bearer agent-tok")
        self.assertEqual(req["body"]["actingSender"], "@b:local")
        self.assertEqual(req["body"]["repo"], "o/r")
        self.assertEqual(req["body"]["args"], ["issue", "create", "--title", "T", "--body-file", body])
        [f] = req["body"]["files"]
        self.assertEqual(f["index"], 5)
        # The agent-identity stamp travels inside the body (loop protection).
        self.assertIn("<!-- agent: team-x-dev -->", base64.b64decode(f["content"]).decode())
        self.assertNotIn("GH_TOKEN", json.dumps(req["body"]))

    def test_forwarded_exit_code_is_relayed(self):
        _Orch.response = (200, {"ok": True, "mode": "attributed", "exitCode": 1, "stdout": "",
                                "stderr": "HTTP 403: Resource not accessible by personal access token\n"})
        p = self.run_gh(["pr", "review", "7", "--approve"])
        self.assertEqual(p.returncode, 1)
        self.assertIn("Resource not accessible", p.stderr)

    def test_refusal_writes_nothing_and_does_not_fall_back(self):
        # AC3/AC4: a refused write never runs the real gh under the baseline.
        for code in ("personal-credential-required", "personal-credential-orphaned"):
            _Orch.response = (424, {"ok": False, "code": code, "error": "Add a personal GitHub token"})
            p = self.run_gh(["issue", "comment", "5", "--body", "x"])
            self.assertEqual(p.returncode, 1)
            self.assertIn(code, p.stderr)
            self.assertIn("Add a personal GitHub token", p.stderr)
            self.assertNotIn("LOCAL", p.stdout)

    def test_unreachable_orchestrator_fails_closed(self):
        env_port = self.server.server_port
        try:
            self.server.server_port = 9  # connection refused
            p = self.run_gh(["issue", "comment", "5", "--body", "x"])
        finally:
            self.server.server_port = env_port
        self.assertEqual(p.returncode, 1)
        self.assertIn("Nothing was written", p.stderr)
        self.assertNotIn("LOCAL", p.stdout)

    def test_untrusted_sender_falls_back_to_baseline_locally(self):
        # AC5: the orchestrator says "baseline" → the real gh runs locally, as before.
        p = self.run_gh(["issue", "comment", "5", "--body-file", "-"], stdin="from stdin")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("LOCAL issue comment 5 --body-file - token=baseline-token", p.stdout)
        [req] = _Orch.requests
        self.assertEqual(base64.b64decode(req["body"]["files"][0]["content"]).decode(), "from stdin")


if __name__ == "__main__":
    unittest.main()
