"""End-to-end regression for /ace:review-mrp on a fresh git init with no remote.

Covers the two bugs reported in v1.35.1:

* Bug A — `guidance-ops.py find-mrp/update-mrp` must locate an MRP that
  lives only on an agent branch (inside a `.worktrees/` checkout) and not
  yet on `main`.
* Bug B — `merge-agent-work.py` direct mode must exit 0 when the local
  merge succeeds but `git push` fails because no remote is configured.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS_DIR / filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=str(cwd),
        capture_output=True, text=True, check=False,
    )


def _git_must(args: list[str], cwd: Path) -> None:
    r = _git(args, cwd)
    assert r.returncode == 0, f"git {args!r} failed: {r.stderr}"


@pytest.fixture
def fresh_repo(tmp_path, monkeypatch):
    """Initialise a bare-of-remote git repo with the SASE directory layout."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git_must(["init", "-b", "main"], repo)
    _git_must(["config", "user.email", "test@example.com"], repo)
    _git_must(["config", "user.name", "Test User"], repo)
    _git_must(["config", "commit.gpgsign", "false"], repo)
    (repo / ".gitignore").write_text(".worktrees/\n", encoding="utf-8")
    _git_must(["add", ".gitignore"], repo)
    _git_must(["commit", "-m", "init"], repo)

    (repo / "artifacts" / "guidance" / "mrp").mkdir(parents=True)
    return repo


def _reload_with_repo(repo: Path):
    """Reload sase_lib + guidance-ops + merge-agent-work pointed at *repo*."""
    # Force the modules to re-evaluate REPO_ROOT.
    for mod in ["sase_lib", "guidance_ops", "merge_agent_work"]:
        sys.modules.pop(mod, None)

    # sase_lib derives REPO_ROOT from __file__; we monkey-patch it after load.
    sase_lib = _load("sase_lib", "sase_lib.py")
    sase_lib.REPO_ROOT = repo
    sase_lib.GUIDANCE_DIR = repo / "artifacts" / "guidance"
    sase_lib.CRP_DIR = sase_lib.GUIDANCE_DIR / "crp"
    sase_lib.MRP_DIR = sase_lib.GUIDANCE_DIR / "mrp"
    sase_lib.VCR_DIR = sase_lib.GUIDANCE_DIR / "vcr"
    sase_lib.BRIEFINGS_DIR = repo / "artifacts" / "briefings"

    # Patch git_run to default to the repo cwd.
    original_git_run = sase_lib.git_run

    def _patched_git_run(args, check=True, cwd=None):
        return original_git_run(args, check=check, cwd=cwd or str(repo))

    sase_lib.git_run = _patched_git_run

    sys.modules["sase_lib"] = sase_lib
    guidance_ops = _load("guidance_ops", "guidance-ops.py")
    merge_mod = _load("merge_agent_work", "merge-agent-work.py")

    # The submodules took their own `from sase_lib import REPO_ROOT, ...`
    # snapshots at import time. Override those snapshots to point at the
    # tmp repo as well.
    for mod in (guidance_ops, merge_mod):
        if hasattr(mod, "REPO_ROOT"):
            mod.REPO_ROOT = repo
        if hasattr(mod, "MRP_DIR"):
            mod.MRP_DIR = sase_lib.MRP_DIR
        if hasattr(mod, "CRP_DIR"):
            mod.CRP_DIR = sase_lib.CRP_DIR
        if hasattr(mod, "VCR_DIR"):
            mod.VCR_DIR = sase_lib.VCR_DIR
        if hasattr(mod, "git_run"):
            mod.git_run = _patched_git_run

    return sase_lib, guidance_ops, merge_mod


def _write_mrp(path: Path, mrp_id: str, bp_hash: str, agent_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        "schema: sase/mrp/v1\n"
        f'id: "{mrp_id}"\n'
        f'bp: "{bp_hash}"\n'
        f'produced-by: "{agent_id}"\n'
        'status: pending\n'
        "---\n\n# MRP\n",
        encoding="utf-8",
    )


def test_find_mrp_locates_artifact_on_agent_branch(fresh_repo):
    """Bug A — MRP committed only on an agent branch must still be found."""
    repo = fresh_repo
    sase_lib, guidance_ops, _ = _reload_with_repo(repo)

    agent_id = "deadbeef"
    bp_hash = "a3f7c2e1b9d4"
    mrp_id = "0ba4cef94bb8"

    branch = f"agent/{agent_id}/{bp_hash}"
    wt_path = repo / ".worktrees" / f"{agent_id}-{bp_hash}"
    _git_must(["worktree", "add", str(wt_path), "-b", branch], repo)

    mrp_path = wt_path / "artifacts" / "guidance" / "mrp" / f"{mrp_id}.md"
    _write_mrp(mrp_path, mrp_id, bp_hash, agent_id)
    _git_must(["add", str(mrp_path.relative_to(wt_path))], wt_path)
    _git_must(["commit", "-m", f"complete(bp:{bp_hash[:6]}): MRP"], wt_path)

    # main has no MRP yet
    assert list((repo / "artifacts" / "guidance" / "mrp").glob("*.md")) == []

    # find_artifact must locate the worktree copy
    path, found_id = guidance_ops.find_artifact(sase_lib.MRP_DIR, mrp_id[:6])
    assert path == mrp_path
    assert found_id == mrp_id


def test_update_mrp_writes_to_agent_branch_copy(fresh_repo):
    """Bug A — update-mrp commits the status flip on the agent branch."""
    repo = fresh_repo
    sase_lib, guidance_ops, _ = _reload_with_repo(repo)

    agent_id = "cafef00d"
    bp_hash = "b1c2d3e4f5a6"
    mrp_id = "11223344aabb"
    branch = f"agent/{agent_id}/{bp_hash}"
    wt_path = repo / ".worktrees" / f"{agent_id}-{bp_hash}"

    _git_must(["worktree", "add", str(wt_path), "-b", branch], repo)
    mrp_path = wt_path / "artifacts" / "guidance" / "mrp" / f"{mrp_id}.md"
    _write_mrp(mrp_path, mrp_id, bp_hash, agent_id)
    _git_must(["add", str(mrp_path.relative_to(wt_path))], wt_path)
    _git_must(["commit", "-m", "draft mrp"], wt_path)

    guidance_ops.update_mrp(mrp_id[:6], "approved", no_commit=False)

    # The worktree file must show the new status...
    assert "status: approved" in mrp_path.read_text(encoding="utf-8")

    # ...and the commit must have landed on the agent branch, not main.
    branch_log = _git(["log", "--format=%s", branch], repo).stdout
    assert f"review-mrp({mrp_id[:6]}): approved" in branch_log
    main_log = _git(["log", "--format=%s", "main"], repo).stdout
    assert "review-mrp" not in main_log


def test_merge_direct_no_remote_exits_zero(fresh_repo):
    """Bug B — local merge succeeds, push is skipped, exit 0 with `merged: true`."""
    repo = fresh_repo
    sase_lib, _, merge_mod = _reload_with_repo(repo)

    agent_id = "feedface"
    bp_hash = "c0ffee1234ab"
    branch = f"agent/{agent_id}/{bp_hash}"
    wt_path = repo / ".worktrees" / f"{agent_id}-{bp_hash}"

    _git_must(["worktree", "add", str(wt_path), "-b", branch], repo)
    deliverable = wt_path / "deliverable.txt"
    deliverable.write_text("agent output\n", encoding="utf-8")
    _git_must(["add", "deliverable.txt"], wt_path)
    _git_must(["commit", "-m", f"complete(bp:{bp_hash[:6]}): work"], wt_path)

    # Sanity: no remote configured.
    assert _git(["remote"], repo).stdout.strip() == ""

    result = merge_mod.merge_direct(agent_id, bp_hash)

    assert result["merged"] is True, result
    assert result["pushed"] is False, result
    assert result["success"] is True, result
    assert any("SKIP: git push" in step for step in result["steps"]), result["steps"]
    assert "FAIL" not in " ".join(result["steps"]), result["steps"]

    # The merge commit must exist on main.
    log = _git(["log", "--format=%s", "main"], repo).stdout
    assert f"merge(bp:{bp_hash[:6]})" in log


def test_merge_direct_actual_merge_failure_still_exits_one(fresh_repo, capsys):
    """Bug B regression guard — true merge failures must still abort."""
    repo = fresh_repo
    sase_lib, _, merge_mod = _reload_with_repo(repo)

    # No agent branch was ever created → `git merge --no-ff` will fail.
    with pytest.raises(SystemExit) as exc:
        merge_mod.merge_direct("00000000", "abcdefabcdef")
    assert exc.value.code == 1
