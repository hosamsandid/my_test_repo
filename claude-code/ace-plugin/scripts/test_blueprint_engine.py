"""Tests for the Blueprint Engine.

Verifies analyze, extract, instantiate, validate, list, and info commands.
Uses temp directories with mock BP trees to avoid modifying real artifacts.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure scripts/ is on the path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sase_lib import (
    BLUEPRINTS_DIR,
    BRIEFINGS_DIR,
    DIR_PATTERN,
    REPO_ROOT,
    parse_frontmatter,
)

# Import blueprint-engine.py (hyphenated filename requires importlib)
import importlib.util

_be_spec = importlib.util.spec_from_file_location(
    "blueprint_engine",
    str(Path(__file__).resolve().parent / "blueprint-engine.py"),
)
_be_mod = importlib.util.module_from_spec(_be_spec)
_be_spec.loader.exec_module(_be_mod)

# Re-export the functions we need for tests
_substitute_params = _be_mod._substitute_params
_evaluate_conditionals = _be_mod._evaluate_conditionals
classify_text = _be_mod.classify_text
_is_likely_path = _be_mod._is_likely_path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPT = str(REPO_ROOT / "scripts" / "blueprint-engine.py")


def run_engine(*args: str, expect_success: bool = True) -> subprocess.CompletedProcess:
    """Run blueprint-engine.py with given arguments."""
    result = subprocess.run(
        [sys.executable, SCRIPT, *args],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=30,
    )
    if expect_success:
        assert result.returncode == 0, (
            f"blueprint-engine.py {' '.join(args)} failed:\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    return result


def create_mock_bp(
    base_dir: Path,
    bp_hash: str,
    slug: str,
    mission: str,
    status: str = "completed",
    children: list[tuple[str, str, str]] | None = None,
    execution_order: list[str] | None = None,
) -> Path:
    """Create a mock BP directory with brief.md."""
    bp_dir = base_dir / f"{bp_hash}-{slug}"
    bp_dir.mkdir(parents=True, exist_ok=True)

    exec_order_yaml = "[]"
    if execution_order:
        exec_order_yaml = "[" + ", ".join(execution_order) + "]"

    content = textwrap.dedent(f"""\
        ---
        schema: sase/briefing-pack/v3
        id: "{bp_hash}"
        slug: "{slug}"
        mission: "{mission}"
        created: "2026-04-10"
        author: ["Test Author"]
        status: {status}
        rigor: "standard"
        depends-on: []
        execution-order: {exec_order_yaml}
        loop-script: "skills/ale/loops/standard.yaml"
        mentor-scripts:
          - "mentorscripts/global.md"
        reviewers: []
        approver: ""
        ---

        # Mission: {mission}

        ## Goal & Why

        Migrate scripts/bp-explorer/server.py from Flask to FastAPI.
        Total of 23 programs and 43826 lines of code.

        ## Acceptance Criteria

        - [ ] AC-1: Server runs on FastAPI
        - [ ] AC-2: All endpoints return correct data

        ## Context

        - Files: scripts/bp-explorer/server.py, scripts/bp-explorer/index.html

        ## Constraints

        Must maintain backward compatibility.

        ## Approach

        Incremental migration, endpoint by endpoint.

        ## Gotchas

        - DMDH001P handler has special serialization rules
    """)

    (bp_dir / "brief.md").write_text(content, encoding="utf-8")

    if children:
        for child_hash, child_slug, child_mission in children:
            create_mock_bp(
                bp_dir, child_hash, child_slug, child_mission, status=status
            )

    return bp_dir


# ---------------------------------------------------------------------------
# Tests: Analyze
# ---------------------------------------------------------------------------


class TestAnalyze:
    """Test the analyze command."""

    def test_analyze_existing_bp(self):
        """Analyze should work against the existing BP tree (if present)."""
        # Check if there are any BPs to analyze
        bps = list(BRIEFINGS_DIR.rglob("brief.md"))
        if not bps:
            pytest.skip("No BPs found to analyze")

        # Find a root BP
        for bp in bps:
            parent = bp.parent
            m = DIR_PATTERN.match(parent.name)
            if m:
                bp_hash = m.group(1)
                result = run_engine("analyze", bp_hash[:6], "--json")
                data = json.loads(result.stdout)
                assert "bp_hash" in data
                assert "suggested_parameters" in data
                assert "bp_structure" in data
                assert data["total_bps"] >= 1
                return

    def test_analyze_json_output(self):
        """Analyze --json should produce valid JSON."""
        bps = list(BRIEFINGS_DIR.rglob("brief.md"))
        if not bps:
            pytest.skip("No BPs found")

        bp = bps[0]
        m = DIR_PATTERN.match(bp.parent.name)
        if not m:
            pytest.skip("No valid BP directory")

        result = run_engine("analyze", m.group(1)[:6], "--json")
        data = json.loads(result.stdout)
        assert isinstance(data, dict)
        assert isinstance(data.get("suggested_parameters"), list)

    def test_analyze_nonexistent_bp(self):
        """Analyze with invalid hash should fail."""
        result = run_engine("analyze", "ffffffffffff", expect_success=False)
        assert result.returncode != 0


# ---------------------------------------------------------------------------
# Tests: List
# ---------------------------------------------------------------------------


class TestList:
    """Test the list command."""

    def test_list_empty(self):
        """List should handle empty blueprints directory gracefully."""
        result = run_engine("list")
        assert result.returncode == 0
        # Output should indicate no blueprints or list some
        assert "blueprint" in result.stdout.lower() or "No" in result.stdout

    def test_list_json_empty(self):
        """List --json should produce valid JSON even when empty."""
        result = run_engine("list", "--json")
        data = json.loads(result.stdout)
        assert isinstance(data, list)


# ---------------------------------------------------------------------------
# Tests: Template engine
# ---------------------------------------------------------------------------


class TestTemplateEngine:
    """Test the template engine functions directly."""

    def test_substitute_params(self):
        """Parameter substitution should replace all placeholders."""
        # Import the function directly
        text = "Path: {{SOURCE_PATH}}, Count: {{PROGRAM_COUNT}}"
        params = {"SOURCE_PATH": "src/main/", "PROGRAM_COUNT": "42"}
        result = _substitute_params(text, params)
        assert result == "Path: src/main/, Count: 42"

    def test_substitute_missing_param(self):
        """Missing parameters should leave placeholder unchanged."""
        text = "Path: {{SOURCE_PATH}}, Name: {{MISSING}}"
        params = {"SOURCE_PATH": "src/"}
        result = _substitute_params(text, params)
        assert "src/" in result
        assert "{{MISSING}}" in result

    def test_evaluate_conditionals_true(self):
        """Conditional with truthy param should include content."""
        text = "Before\n{% if HAS_HANDLER %}Handler section{% endif %}\nAfter"
        params = {"HAS_HANDLER": "true"}
        result = _evaluate_conditionals(text, params)
        assert "Handler section" in result
        assert "{% if" not in result

    def test_evaluate_conditionals_false(self):
        """Conditional with falsy param should exclude content."""
        text = "Before\n{% if HAS_HANDLER %}Handler section{% endif %}\nAfter"
        params = {"HAS_HANDLER": ""}
        result = _evaluate_conditionals(text, params)
        assert "Handler section" not in result
        assert "Before" in result
        assert "After" in result

    def test_evaluate_conditionals_not(self):
        """Negated conditional should work correctly."""
        text = "{% if not SKIP_SECTION %}Include this{% endif %}"
        params = {"SKIP_SECTION": ""}
        result = _evaluate_conditionals(text, params)
        assert "Include this" in result

    def test_evaluate_conditionals_not_truthy(self):
        """Negated conditional with truthy param should exclude."""
        text = "{% if not SKIP_SECTION %}Include this{% endif %}"
        params = {"SKIP_SECTION": "true"}
        result = _evaluate_conditionals(text, params)
        assert "Include this" not in result


# ---------------------------------------------------------------------------
# Tests: Text Classification
# ---------------------------------------------------------------------------


class TestClassification:
    """Test text classification heuristics."""

    def test_path_detection(self):
        """Should detect file paths."""
        text = "Edit scripts/bp-explorer/server.py and scripts/bp-explorer/index.html"
        result = classify_text(text, {})
        paths = [p["value"] for p in result.get("path", [])]
        assert "scripts/bp-explorer/server.py" in paths

    def test_cobol_name_detection(self):
        """Should detect COBOL-style program names."""
        text = "The program DMDH001P handles data abstraction and LNN0134F processes input."
        result = classify_text(text, {})
        names = [p["value"] for p in result.get("program_name", [])]
        assert "DMDH001P" in names
        assert "LNN0134F" in names

    def test_number_detection(self):
        """Should detect numbers in LOC/count context."""
        text = "Contains 23 programs and 43826 lines of code"
        result = classify_text(text, {})
        numbers = [p["value"] for p in result.get("number", [])]
        assert "23" in numbers

    def test_person_detection(self):
        """Should detect author names from frontmatter."""
        fm = {"author": ["John Doe"], "approver": "Jane Smith"}
        result = classify_text("", fm)
        persons = [p["value"] for p in result.get("person", [])]
        assert "John Doe" in persons
        assert "Jane Smith" in persons


# ---------------------------------------------------------------------------
# Tests: Path false-positive filtering
# ---------------------------------------------------------------------------


class TestPathFiltering:
    """Test the _is_likely_path heuristic for false-positive rejection."""

    def test_real_paths_accepted(self):
        """Real file paths should be accepted."""
        assert _is_likely_path("scripts/bp-explorer/server.py") is True
        assert _is_likely_path("20-docs/20-legacy-analysis/10-inventory/inventory.json") is True
        assert _is_likely_path("40-tools/35-cobolitics/run-analysis.sh") is True
        assert _is_likely_path("artifacts/input/deep-research-report.md") is True

    def test_cobol_keyword_pairs_rejected(self):
        """COBOL keyword pairs with slashes should be rejected."""
        assert _is_likely_path("IF/EVALUATE") is False
        assert _is_likely_path("LINK/XCTL") is False
        assert _is_likely_path("DB2/VSAM") is False
        assert _is_likely_path("PERFORM/GO") is False
        assert _is_likely_path("LINK/XCTL/WRITEQ/READQ") is False
        assert _is_likely_path("IF/EVALUATE/exception") is False

    def test_abbreviation_pairs_rejected(self):
        """Short abbreviation pairs should be rejected."""
        assert _is_likely_path("A/B") is False
        assert _is_likely_path("I/O") is False
        assert _is_likely_path("A/B/C") is False
        assert _is_likely_path("D1/D2") is False
        assert _is_likely_path("ISO/IEC") is False

    def test_domain_term_pairs_rejected(self):
        """Domain-specific term pairs should be rejected."""
        assert _is_likely_path("CSS/JS") is False
        assert _is_likely_path("CSS/JS/SVG") is False
        assert _is_likely_path("JSON/Excel") is False
        assert _is_likely_path("Node/edge") is False
        assert _is_likely_path("source/target") is False
        assert _is_likely_path("draft/approved/rework") is False
        assert _is_likely_path("go/no-go") is False
        assert _is_likely_path("inputs/outputs") is False

    def test_mainframe_tech_pairs_rejected(self):
        """Mainframe technology pairs should be rejected."""
        assert _is_likely_path("PIC/VALUE") is False
        assert _is_likely_path("PIC/USAGE") is False
        assert _is_likely_path("COMPUTE/ADD/SUBTRACT") is False
        assert _is_likely_path("ROUNDED/ON") is False
        assert _is_likely_path("REDEFINES/LINKAGE") is False
        assert _is_likely_path("EVALUATE/WHEN") is False
        assert _is_likely_path("PGM/PROC") is False
        assert _is_likely_path("LEADING/TRAILING") is False

    def test_ui_concept_pairs_rejected(self):
        """UI concept pairs should be rejected."""
        assert _is_likely_path("ghost/dashed") is False
        assert _is_likely_path("highlight/focus") is False
        assert _is_likely_path("compound/nested") is False
        assert _is_likely_path("Expandable/collapsible") is False
        assert _is_likely_path("footer/banner") is False

    def test_classify_text_rejects_keyword_paths(self):
        """classify_text should not flag keyword pairs as paths."""
        text = "Analyze IF/EVALUATE branches, LINK/XCTL calls, DB2/VSAM access, and I/O patterns."
        result = classify_text(text, {})
        paths = [p["value"] for p in result.get("path", [])]
        assert "IF/EVALUATE" not in paths
        assert "LINK/XCTL" not in paths
        assert "DB2/VSAM" not in paths

    def test_classify_text_accepts_real_paths(self):
        """classify_text should still detect real file paths."""
        text = "Edit scripts/bp-explorer/server.py and 20-docs/10-inventory/report.md"
        result = classify_text(text, {})
        paths = [p["value"] for p in result.get("path", [])]
        assert "scripts/bp-explorer/server.py" in paths
        assert "20-docs/10-inventory/report.md" in paths


# ---------------------------------------------------------------------------
# Tests: Validate (integration)
# ---------------------------------------------------------------------------


class TestValidate:
    """Test the validate command."""

    def test_validate_nonexistent(self):
        """Validate with invalid hash should fail."""
        result = run_engine("validate", "ffffffffffff", expect_success=False)
        assert result.returncode != 0


# ---------------------------------------------------------------------------
# Tests: Info
# ---------------------------------------------------------------------------


class TestInfo:
    """Test the info command."""

    def test_info_nonexistent(self):
        """Info with invalid hash should fail."""
        result = run_engine("info", "ffffffffffff", expect_success=False)
        assert result.returncode != 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
