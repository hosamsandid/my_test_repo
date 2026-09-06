"""Removal guard for the agent-image half of the BriefingPack removal
(#1967, epic #1961 Phase 6).

The Python sibling of `orchestrator/bp-removal-guard.test.js` and
`admin-console/api/bp-removal-guard.test.js`. Those two guard the control plane;
nothing guarded the *image*, which is where the second operating mode lived — so
a re-added `--bp-hash` branch or a restored `dispatch-bp.py` would have gone
unnoticed by CI.

Two properties are asserted, and they are different in kind:

  * ABSENCE — the dispatch mode, its script, its helper modules and its fixtures
    are gone (AC1, AC4). Anchored on the specific symbol/token that went away
    rather than on the bare word "brief", which legitimately appears in prose
    ("append a brief note to memory/log.md" is a live trigger learn-hint).

  * SURVIVAL — the conversational path is untouched (AC2). Without these, every
    absence assertion above would also pass against an empty or hollowed-out
    file, which is the classic way a removal guard goes quietly vacuous.

`agent-image/CLAUDE.md` is deliberately NOT asserted on: the base instruction
file still opens by telling every agent it is executing a BriefingPack, and
changing it alters the behaviour of every agent on the platform. That is the
epic's R5 decision and gets its own ticket — a guard here would either fail on
main or freeze the wrong text.
"""

import re
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent.parent
ENTRYPOINT = SCRIPTS_DIR / "agent-entrypoint.py"


def strip_comments_and_docstrings(src: str) -> str:
    """Drop `#` comments and triple-quoted blocks.

    The comments in this file name the very feature under test — the module
    docstring says "BriefingPack dispatch ... was removed" and the SIGTERM
    handler explains which branch went — so asserting over the raw source would
    fail on the explanation rather than on a regression.

    Deliberately line-oriented for `#`: a `#` inside a string literal (e.g. an
    issue reference in a message) would otherwise truncate real code.
    """
    src = re.sub(r'"""[\s\S]*?"""', '""', src)
    src = re.sub(r"'''[\s\S]*?'''", "''", src)
    src = re.sub(r"^[ \t]*#[^\n]*$", "", src, flags=re.MULTILINE)
    return src


ENTRYPOINT_SRC = ENTRYPOINT.read_text(encoding="utf-8")
ENTRYPOINT_CODE = strip_comments_and_docstrings(ENTRYPOINT_SRC)


class StripIsNotDestructive(unittest.TestCase):
    """Sanity-check the strip itself.

    If it ever swallows real code the absence assertions become vacuous, so
    anchor on structural signatures that must survive it.
    """

    def test_strip_leaves_the_file_structurally_intact(self):
        self.assertGreater(
            len(ENTRYPOINT_CODE), len(ENTRYPOINT_SRC) * 0.5,
            "the strip removed more than half the file",
        )
        for signature in (
            "async def run_dm_listener(",
            "def main(",
            "def _handle_sigterm(",
        ):
            self.assertIn(signature, ENTRYPOINT_CODE,
                          f"the strip destroyed real code: {signature}")

    def test_strip_actually_removes_a_comment(self):
        # Non-vacuity: prove the strip does something, so a no-op strip cannot
        # make `test_no_bp_symbol_survives` pass by accident on the raw source.
        self.assertIn("BriefingPack", ENTRYPOINT_SRC)
        self.assertNotIn("BriefingPack", ENTRYPOINT_CODE)


class DispatchModeIsGone(unittest.TestCase):
    """AC1: the container has exactly one operating mode."""

    def test_no_bp_symbol_survives(self):
        for symbol in (
            "bp_hash",          # the CLI flag, its argparse dest and every read
            "_find_brief",      # the artifacts/briefings scan
            "_run_bp_dispatch",
            "build_agent_prompt",
            "load_context",
            "_resolve_loopscript",
            "_expand_claude_imports",
            "verify_workspace",
            "configure_git_identity",
            "MENTORSCRIPTS_DIR",
            "ClaimLoopScheduler",
            "claim-tick",
        ):
            self.assertNotIn(symbol, ENTRYPOINT_CODE,
                             f"{symbol} is back in agent-entrypoint.py")

    def test_no_brief_or_pack_path_is_looked_up(self):
        for token in ("artifacts/briefings", "brief.md", "LoopScript", "MentorScript"):
            self.assertNotIn(token, ENTRYPOINT_CODE,
                             f"the entrypoint still reaches for {token}")

    def test_the_argument_parser_accepts_nothing(self):
        # An empty parser is the contract with the orchestrator, which invokes
        # the entrypoint with no arguments — and it is what makes a stale
        # `--bp-hash` fail loudly instead of being accepted and ignored.
        self.assertNotIn("add_argument", ENTRYPOINT_CODE)
        self.assertIn("argparse.ArgumentParser(", ENTRYPOINT_CODE)

    def test_sigterm_handler_has_no_commit_branch(self):
        handler = slice_def(ENTRYPOINT_CODE, "def _handle_sigterm(")
        self.assertNotIn("commit", handler,
                         "the SIGTERM handler still commits partial work")
        self.assertNotIn("push", handler)
        self.assertNotIn("124", handler, "the BP exit code is back")
        # …and the half it must not have taken with it.
        self.assertIn("_shutdown.set()", handler)

    def test_the_dispatch_scripts_are_deleted(self):
        for name in ("dispatch-bp.py", "container-lifecycle.py", "sase_lib.py"):
            self.assertFalse((SCRIPTS_DIR / name).exists(),
                             f"{name} should be deleted")


class FixturesAreGone(unittest.TestCase):
    """AC4: no fixture, Makefile target or helper script names a briefings dir."""

    def test_the_seeded_briefings_tree_is_deleted(self):
        self.assertFalse((REPO_ROOT / "artifacts" / "briefings").exists())

    def test_the_makefile_names_no_briefings_dir(self):
        # AC4 is about a *reference to a briefings directory*, not about the
        # word "BriefingPack" — the seed-skills comment legitimately records
        # that the skill's former BriefingPack consumer is gone, and freezing
        # that out would forbid explaining the removal.
        makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
        for token in ("artifacts/briefings", "brief.md", "dispatch-bp", "bp-instance"):
            self.assertNotIn(token, makefile, f"Makefile still references {token}")

    def test_the_dockerfile_names_no_mission_artifacts(self):
        dockerfile = (REPO_ROOT / "agent-image" / "Dockerfile").read_text(encoding="utf-8")
        for token in ("sase_lib", "mission artifacts", "dispatch-bp"):
            self.assertNotIn(token, dockerfile, f"Dockerfile still references {token}")


class ConversationalPathSurvives(unittest.TestCase):
    """AC2: the DM listener is untouched.

    These pass against origin/main too, by design — their job is to fail if a
    later cleanup pass takes the surviving mode with it.
    """

    def test_the_dm_listener_and_its_machinery_are_intact(self):
        for kept in (
            "async def run_dm_listener(",
            "class TriggerScheduler",
            "class WorkspaceGate",
            "def build_knowledge_digest(",
            "def _build_memory_hint(",
            "asyncio.run(run_dm_listener())",
            "signal.signal(signal.SIGTERM, _handle_sigterm)",
        ):
            self.assertIn(kept, ENTRYPOINT_CODE, f"{kept} must survive")

    def test_the_orchestrator_internal_url_survives_the_claim_loop(self):
        # The claim loop defined this constant, but the flow-emit / wake helpers
        # read it — removing the loop must not have taken it along.
        self.assertIn("ORCHESTRATOR_INTERNAL_URL = os.environ.get(", ENTRYPOINT_CODE)
        self.assertGreaterEqual(
            ENTRYPOINT_CODE.count("ORCHESTRATOR_INTERNAL_URL"), 2,
            "the constant is defined but nothing reads it",
        )

    def test_a_leftover_bp_queue_entry_is_still_skipped(self):
        # Nothing writes `bp-event-batch` any more, but an upgraded install may
        # still carry one in pending-triggers.json. Keeping it in the skip set
        # is what stops it being executed as a prompt.
        self.assertIn("bp-event-batch", ENTRYPOINT_CODE)

    def test_the_base_instruction_file_is_untouched(self):
        # AC6: agent-image/CLAUDE.md is the next ticket's, not this one's.
        claude_md = (REPO_ROOT / "agent-image" / "CLAUDE.md").read_text(encoding="utf-8")
        self.assertIn("BriefingPack", claude_md,
                      "agent-image/CLAUDE.md was changed by this phase — it is "
                      "scoped out (epic decision R5) and has its own ticket")


def slice_def(code: str, header: str) -> str:
    """Return one top-level `def`'s body, from its header to the next one.

    Scanning for the next `def` at column 0 rather than for `'\\ndef '` alone:
    a bare `indexOf` style search would also stop at a nested/decorated form and
    an unterminated search would run to EOF, which is exactly how a
    "X is not in here" assertion goes silently vacuous.
    """
    start = code.index(header)
    match = re.compile(r"^(?:@|def |class )", re.MULTILINE).search(
        code, start + len(header)
    )
    end = match.start() if match else len(code)
    body = code[start:end]
    assert len(body) > 100, f"slice for {header!r} looks empty — update the anchor"
    return body


if __name__ == "__main__":
    unittest.main()
