"""Tests for the heartbeat transition in bp-transition.py.

Confirms phase and last-heartbeat are written on first call, refreshed on
subsequent calls, and that ownership mismatch is rejected.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

_spec = importlib.util.spec_from_file_location(
    "bp_transition",
    str(Path(__file__).resolve().parent / "bp-transition.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


BRIEF_TEMPLATE = """\
---
schema: briefingpack/v3
hash: {hash}
slug: {slug}
mission: Heartbeat test BP
status: {status}
agent-id: {agent_id}
---

# Body
"""


def _scaffold_bp(briefings_dir: Path, *, hash_: str, slug: str, status: str, agent_id: str) -> Path:
    bp_dir = briefings_dir / f"{hash_}-{slug}"
    bp_dir.mkdir(parents=True)
    brief = bp_dir / "brief.md"
    brief.write_text(
        BRIEF_TEMPLATE.format(hash=hash_, slug=slug, status=status, agent_id=agent_id),
        encoding="utf-8",
    )
    return brief


@pytest.fixture
def fake_briefings(tmp_path, monkeypatch):
    briefings = tmp_path / "briefings"
    briefings.mkdir()
    monkeypatch.setattr(_mod, "BRIEFINGS_DIR", briefings)
    monkeypatch.setattr(_mod, "INDEX_JSON", briefings / ".index.json")
    return briefings


def _read_field(brief: Path, field: str) -> str | None:
    text = brief.read_text(encoding="utf-8")
    m = re.search(rf"^{re.escape(field)}:\s*(.+)$", text, re.MULTILINE)
    if not m:
        return None
    return m.group(1).strip().strip('"').strip("'")


def test_heartbeat_first_call_sets_phase_and_promotes_status(fake_briefings):
    brief = _scaffold_bp(
        fake_briefings, hash_="a" * 12, slug="hb-test", status="claimed", agent_id="deadbeef"
    )

    _mod.execute_transition(
        "heartbeat",
        "a" * 6,
        phase="understand",
        no_commit=True,
        no_index=True,
    )

    assert _read_field(brief, "status") == "in-progress"
    assert _read_field(brief, "phase") == "understand"
    hb = _read_field(brief, "last-heartbeat")
    assert hb and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", hb)


def test_heartbeat_second_call_refreshes_fields(fake_briefings):
    brief = _scaffold_bp(
        fake_briefings, hash_="b" * 12, slug="hb-test", status="claimed", agent_id="deadbeef"
    )

    _mod.execute_transition(
        "heartbeat", "b" * 6, phase="understand", no_commit=True, no_index=True
    )
    first_hb = _read_field(brief, "last-heartbeat")

    # Force time to advance enough that the ISO-second resolution differs.
    import time as _time
    _time.sleep(1.1)

    _mod.execute_transition(
        "heartbeat", "b" * 6, phase="implement", no_commit=True, no_index=True
    )

    assert _read_field(brief, "status") == "in-progress"
    assert _read_field(brief, "phase") == "implement"
    second_hb = _read_field(brief, "last-heartbeat")
    assert second_hb != first_hb


def test_heartbeat_requires_phase(fake_briefings, capsys):
    _scaffold_bp(
        fake_briefings, hash_="c" * 12, slug="hb-test", status="claimed", agent_id="deadbeef"
    )
    with pytest.raises(SystemExit) as exc:
        _mod.execute_transition(
            "heartbeat", "c" * 6, phase=None, no_commit=True, no_index=True
        )
    assert exc.value.code == 1
    assert "--phase is required" in capsys.readouterr().err


def test_heartbeat_ownership_mismatch_rejected(fake_briefings, capsys):
    _scaffold_bp(
        fake_briefings, hash_="d" * 12, slug="hb-test", status="claimed", agent_id="deadbeef"
    )
    with pytest.raises(SystemExit) as exc:
        _mod.execute_transition(
            "heartbeat",
            "d" * 6,
            agent_id="cafef00d",
            phase="understand",
            no_commit=True,
            no_index=True,
        )
    assert exc.value.code == 1
    assert "Ownership mismatch" in capsys.readouterr().err


def test_heartbeat_matching_agent_id_accepted(fake_briefings):
    brief = _scaffold_bp(
        fake_briefings, hash_="e" * 12, slug="hb-test", status="claimed", agent_id="deadbeef"
    )
    _mod.execute_transition(
        "heartbeat",
        "e" * 6,
        agent_id="deadbeef",
        phase="plan",
        no_commit=True,
        no_index=True,
    )
    assert _read_field(brief, "phase") == "plan"


def test_heartbeat_rejects_wrong_starting_status(fake_briefings, capsys):
    _scaffold_bp(
        fake_briefings, hash_="f" * 12, slug="hb-test", status="ready", agent_id=""
    )
    with pytest.raises(SystemExit) as exc:
        _mod.execute_transition(
            "heartbeat", "f" * 6, phase="understand", no_commit=True, no_index=True
        )
    assert exc.value.code == 1
    assert "expected" in capsys.readouterr().err
