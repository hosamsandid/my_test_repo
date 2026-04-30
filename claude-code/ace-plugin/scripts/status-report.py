#!/usr/bin/env python3
"""
Deterministic status data aggregation for i-SASE.

Replaces LLM-driven CRP/MRP/VCR scanning, stale detection,
auto-approval eligibility, and quick stats with a deterministic script.

Usage:
    python3 scripts/status-report.py              # Full report (JSON)
    python3 scripts/status-report.py --crps        # Only CRPs
    python3 scripts/status-report.py --mrps        # Only MRPs
    python3 scripts/status-report.py --active      # Only active BPs
    python3 scripts/status-report.py --text        # Human-readable output

Outputs structured JSON to stdout by default.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    REPO_ROOT, BRIEFINGS_DIR, GUIDANCE_DIR, CRP_DIR, MRP_DIR, VCR_DIR,
    INDEX_JSON, DIR_PATTERN,
    parse_frontmatter, extract_body,
    parse_iso_datetime, minutes_ago, format_age,
    regenerate_index, load_index, rel_path,
)

STALE_THRESHOLD_MINUTES = 180  # 3 hours


# ---------------------------------------------------------------------------
# Scanners
# ---------------------------------------------------------------------------

def scan_guidance_dir(directory: Path) -> list[dict]:
    """Scan a guidance directory for all .md files, returning parsed frontmatter."""
    results = []
    if not directory.exists():
        return results
    for path in sorted(directory.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        fm["_path"] = rel_path(path)
        fm["_body"] = extract_body(text)
        results.append(fm)
    return results


# ---------------------------------------------------------------------------
# CRP analysis
# ---------------------------------------------------------------------------

URGENCY_ORDER = {"blocking": 0, "high": 1, "medium": 2, "low": 3}


def analyze_crps(crps: list[dict]) -> dict:
    """Analyze CRPs: separate open from resolved, sort by urgency."""
    open_crps = []
    resolved_crps = []

    for crp in crps:
        status = crp.get("status", "open")
        entry = {
            "id": crp.get("id", ""),
            "bp": crp.get("bp") or crp.get("briefing-pack", ""),
            "agent": crp.get("raised-by", ""),
            "routed_to": crp.get("routed-to", ""),
            "mode": crp.get("mode", "blocking"),
            "urgency": crp.get("urgency", "medium"),
            "status": status,
            "created": crp.get("created", ""),
            "phase": crp.get("phase", ""),
            "trigger": crp.get("trigger", ""),
            "path": crp.get("_path", ""),
        }

        # Extract question from body (first heading or first line)
        body = crp.get("_body", "")
        question = ""
        for line in body.split("\n"):
            line = line.strip()
            if line.startswith("# "):
                question = line.lstrip("# ").strip()
                break
            if line and not line.startswith("<!--"):
                question = line[:80]
                break
        entry["question"] = question

        # Stale check (> 24h)
        created_dt = parse_iso_datetime(crp.get("created"))
        age_mins = minutes_ago(created_dt)
        entry["age"] = format_age(created_dt)
        entry["stale"] = age_mins is not None and age_mins > 24 * 60

        if status == "open":
            open_crps.append(entry)
        else:
            resolved_crps.append(entry)

    # Sort open CRPs: blocking first, then by urgency, then oldest first
    open_crps.sort(key=lambda c: (
        0 if c["mode"] == "blocking" else 1,
        URGENCY_ORDER.get(c["urgency"], 99),
        c["created"],
    ))

    return {
        "open": open_crps,
        "resolved": resolved_crps,
        "open_count": len(open_crps),
        "open_blocking_count": sum(1 for c in open_crps if c["mode"] == "blocking"),
        "resolved_count": len(resolved_crps),
    }


# ---------------------------------------------------------------------------
# MRP analysis
# ---------------------------------------------------------------------------

def analyze_mrps(mrps: list[dict], vcrs: list[dict], crps: list[dict]) -> dict:
    """Analyze MRPs: find pending (no VCR), check auto-approval eligibility."""
    # Build VCR lookup: which MRP IDs have been resolved
    resolved_mrp_ids = set()
    for vcr in vcrs:
        refs = vcr.get("references", "")
        mrp_ref = vcr.get("mrp") or ""
        # references can be in nested format
        if isinstance(refs, str):
            # Try to find mrp reference in body or other fields
            pass
        resolved_mrp_ids.add(mrp_ref)
        # Also check resolves field
        resolves = vcr.get("resolves", "")
        if resolves:
            resolved_mrp_ids.add(resolves)

    # Build CRP lookup by BP: check for security CRPs
    security_crps_by_bp = {}
    for crp in crps:
        bp_hash = crp.get("bp") or crp.get("briefing-pack", "")
        trigger = crp.get("trigger", "")
        if trigger in ("security", "auth", "authz", "crypto"):
            security_crps_by_bp.setdefault(bp_hash, []).append(crp.get("id", ""))

    pending_mrps = []
    reviewed_mrps = []

    for mrp in mrps:
        mrp_id = mrp.get("id", "")
        has_vcr = mrp_id in resolved_mrp_ids
        mrp_status = mrp.get("status", "")

        entry = {
            "id": mrp_id,
            "bp": mrp.get("bp") or mrp.get("briefing-pack", ""),
            "agent": mrp.get("produced-by", ""),
            "created": mrp.get("created", ""),
            "status": mrp_status,
            "has_vcr": has_vcr,
            "path": mrp.get("_path", ""),
        }

        # Extract title from body
        body = mrp.get("_body", "")
        title = ""
        for line in body.split("\n"):
            line = line.strip()
            if line.startswith("# "):
                title = line.lstrip("# ").strip()
                break
        entry["title"] = title

        # Extract auto-score if present
        auto_score = mrp.get("auto-score")
        if auto_score:
            try:
                entry["auto_score"] = int(auto_score)
            except (ValueError, TypeError):
                entry["auto_score"] = None
        else:
            entry["auto_score"] = None

        # AC completion from body
        ac_total = 0
        ac_passed = 0
        for line in body.split("\n"):
            if re.match(r"\s*-\s*\[\s*[xX]\s*\]", line):
                ac_total += 1
                ac_passed += 1
            elif re.match(r"\s*-\s*\[\s*\]", line):
                ac_total += 1
        entry["ac_total"] = ac_total
        entry["ac_passed"] = ac_passed

        # Security CRP check
        bp_hash = entry["bp"]
        has_security_crps = bp_hash in security_crps_by_bp
        entry["has_security_crps"] = has_security_crps

        # Auto-approval eligibility
        score = entry["auto_score"]
        auto_eligible = (
            score is not None
            and score >= 90
            and not has_security_crps
            and ac_total > 0
            and ac_passed == ac_total
        )
        entry["auto_approve_eligible"] = auto_eligible

        if has_vcr or mrp_status in ("approved", "rejected"):
            reviewed_mrps.append(entry)
        else:
            pending_mrps.append(entry)

    # Sort pending: oldest first
    pending_mrps.sort(key=lambda m: m["created"])

    return {
        "pending": pending_mrps,
        "reviewed": reviewed_mrps,
        "pending_count": len(pending_mrps),
        "auto_approve_eligible_count": sum(
            1 for m in pending_mrps if m["auto_approve_eligible"]
        ),
        "reviewed_count": len(reviewed_mrps),
    }


# ---------------------------------------------------------------------------
# BP analysis (from index)
# ---------------------------------------------------------------------------

def _compute_transitive_dependents(
    start_hashes: list[str],
    briefings: dict,
    *,
    exclude: set | None = None,
) -> list[dict]:
    """BFS forward through the 'dependents' graph from any of start_hashes.

    Returns the transitive set of reachable dependents as dicts
    {hash, slug, status, path}. Excludes hashes in `exclude` and the
    start hashes themselves. Used by /ace:status and /ace:revise to
    surface the full ripple beyond direct dependents.
    """
    skip = set(exclude or set()) | set(start_hashes)
    seen: set = set()
    result: list[dict] = []
    queue = list(start_hashes)
    while queue:
        current = queue.pop(0)
        for next_hash in (briefings.get(current, {}).get("dependents") or []):
            if next_hash in seen or next_hash in skip:
                continue
            seen.add(next_hash)
            entry = briefings.get(next_hash, {})
            result.append({
                "hash": next_hash,
                "slug": entry.get("slug", ""),
                "status": entry.get("status", ""),
                "path": entry.get("path", ""),
            })
            queue.append(next_hash)
    return result


def analyze_bps(briefings: dict) -> dict:
    """Analyze BPs from the index: active, ready, draft, completed, stale-inputs."""
    active = []
    ready = []
    draft = []
    completed = []
    stale_inputs = []
    parents = []

    for bp_hash, entry in briefings.items():
        status = entry.get("status", "draft")
        is_parent = bool(entry.get("children"))

        bp_entry = {
            "hash": bp_hash,
            "slug": entry.get("slug", ""),
            "mission": entry.get("mission", ""),
            "status": status,
            "rigor": entry.get("rigor", "standard"),
            "agent_id": entry.get("agent-id", ""),
            "phase": entry.get("phase", ""),
            "last_heartbeat": entry.get("last-heartbeat"),
            "created": entry.get("created", ""),
            "is_parent": is_parent,
            "children": entry.get("children", []),
            "branch": entry.get("branch"),
            "path": entry.get("path", ""),
            "stale-because": entry.get("stale-because", []),
            "depends-on": entry.get("depends-on", []),
            "dependents": entry.get("dependents", []),
            "revision": entry.get("revision"),
        }

        # Stale-heartbeat detection for active BPs (different from status:stale)
        if status in ("dispatched", "claimed", "in-progress"):
            hb = parse_iso_datetime(entry.get("last-heartbeat"))
            hb_age = minutes_ago(hb)
            bp_entry["heartbeat_age"] = format_age(hb) if hb else "no heartbeat"
            bp_entry["stale"] = hb_age is not None and hb_age > STALE_THRESHOLD_MINUTES
            active.append(bp_entry)
        elif status == "ready":
            ready.append(bp_entry)
        elif status == "draft":
            draft.append(bp_entry)
        elif status in ("completed", "reviewed"):
            completed.append(bp_entry)
        elif status == "stale":
            # Attach the transitive ripple so /ace:status can render it
            # without doing ad-hoc graph walks in markdown.
            bp_entry["ripple"] = _compute_transitive_dependents(
                [bp_hash], briefings, exclude={bp_hash}
            )
            stale_inputs.append(bp_entry)

        if is_parent:
            parents.append(bp_entry)

    # Sort active by dispatch time
    active.sort(key=lambda b: b.get("created", ""), reverse=True)
    ready.sort(key=lambda b: b.get("created", ""))
    draft.sort(key=lambda b: b.get("created", ""))
    # Sort stale-inputs by oldest flag first (most urgent for reassessment).
    # Defensive: if stale-because parsing went wrong upstream, fall back to "".
    def _stale_sort_key(b: dict) -> str:
        sb = b.get("stale-because") or []
        if not sb or not isinstance(sb[0], dict):
            return ""
        return sb[0].get("flagged-at", "") or ""

    stale_inputs.sort(key=_stale_sort_key)

    return {
        "active": active,
        "ready": ready,
        "draft": draft,
        "completed": completed,
        "stale_inputs": stale_inputs,
        "parents": parents,
        "active_count": len(active),
        "stale_count": sum(1 for b in active if b.get("stale")),
        "stale_inputs_count": len(stale_inputs),
        "ready_count": len(ready),
        "draft_count": len(draft),
        "completed_count": len(completed),
        "total_dispatched": len(active) + len(completed),
        "parent_count": len(parents),
    }


# ---------------------------------------------------------------------------
# Deferred CRP detection for MRP review
# ---------------------------------------------------------------------------

def find_deferred_crps_for_bp(crps: list[dict], bp_hash: str) -> list[dict]:
    """Find deferred CRPs associated with a BP that need review during MRP."""
    result = []
    for crp in crps:
        crp_bp = crp.get("bp") or crp.get("briefing-pack", "")
        if crp_bp != bp_hash:
            continue
        status = crp.get("status", "")
        mode = crp.get("mode", "")
        if status == "deferred-to-mrp" or (mode == "deferred" and status == "open"):
            result.append({
                "id": crp.get("id", ""),
                "question": "",  # filled by caller
                "mode": mode,
                "status": status,
                "phase": crp.get("phase", ""),
            })
    return result


# ---------------------------------------------------------------------------
# Full report
# ---------------------------------------------------------------------------

def generate_report(
    *,
    include_crps: bool = True,
    include_mrps: bool = True,
    include_active: bool = True,
    include_ready: bool = True,
    include_stale: bool = True,
) -> dict:
    """Generate a full status report as structured data."""
    # Scan guidance artifacts
    crps = scan_guidance_dir(CRP_DIR) if (include_crps or include_mrps) else []
    mrps = scan_guidance_dir(MRP_DIR) if include_mrps else []
    vcrs = scan_guidance_dir(VCR_DIR) if include_mrps else []

    # Load BP index
    briefings = load_index() if (include_active or include_ready or include_stale) else {}

    report = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    if include_crps:
        report["crps"] = analyze_crps(crps)

    if include_mrps:
        report["mrps"] = analyze_mrps(mrps, vcrs, crps)

    bp_data = analyze_bps(briefings) if briefings else None

    if include_active:
        if bp_data:
            report["active_bps"] = {
                "items": bp_data["active"],
                "count": bp_data["active_count"],
                "stale_count": bp_data["stale_count"],
            }
        else:
            report["active_bps"] = {"items": [], "count": 0, "stale_count": 0}

    if include_ready:
        if bp_data:
            report["ready_bps"] = {
                "items": bp_data["ready"],
                "count": bp_data["ready_count"],
            }
        else:
            report["ready_bps"] = {"items": [], "count": 0}

    if include_stale:
        if bp_data:
            report["stale_bps"] = {
                "items": bp_data["stale_inputs"],
                "count": bp_data["stale_inputs_count"],
            }
        else:
            report["stale_bps"] = {"items": [], "count": 0}

    # Quick stats (always included)
    stats = {}
    if bp_data:
        stats["active"] = bp_data["active_count"]
        stats["stale"] = bp_data["stale_count"]
        stats["stale_inputs"] = bp_data["stale_inputs_count"]
        stats["completed"] = bp_data["completed_count"]
        stats["total_dispatched"] = bp_data["total_dispatched"]
        stats["ready"] = bp_data["ready_count"]
        stats["draft"] = bp_data["draft_count"]
        stats["parent_derived"] = bp_data["parent_count"]
    if include_crps and "crps" in report:
        stats["crps_open"] = report["crps"]["open_count"]
        stats["crps_blocking"] = report["crps"]["open_blocking_count"]
        stats["crps_resolved"] = report["crps"]["resolved_count"]
    if include_mrps and "mrps" in report:
        stats["mrps_pending"] = report["mrps"]["pending_count"]
        stats["mrps_auto_eligible"] = report["mrps"]["auto_approve_eligible_count"]
        stats["mrps_reviewed"] = report["mrps"]["reviewed_count"]

    report["stats"] = stats

    return report


# ---------------------------------------------------------------------------
# Text output
# ---------------------------------------------------------------------------

def format_text_report(report: dict) -> str:
    """Format the report as human-readable text."""
    lines = []

    # CRPs
    crps = report.get("crps")
    if crps:
        if crps["open"]:
            lines.append("BLOCKED -- Agents waiting on you")
            lines.append("-" * 34)
            for c in crps["open"]:
                stale = " [STALE]" if c.get("stale") else ""
                mode_tag = c["mode"].upper()
                lines.append(
                    f"  {c['id'][:12]}  [{mode_tag}]{stale}  bp:{c['bp'][:6]}  "
                    f"agt:{c['agent'][:8]}  \"{c['question'][:50]}\"  ({c['age']})"
                )
                lines.append(f"    -> /resolve-crp {c['id'][:12]}")
            lines.append("")
        else:
            lines.append("No blocked agents. All CRPs resolved.")
            lines.append("")

    # MRPs
    mrps = report.get("mrps")
    if mrps:
        if mrps["pending"]:
            lines.append("REVIEW NEEDED -- BPs awaiting your decision")
            lines.append("-" * 48)
            for m in mrps["pending"]:
                auto_tag = " [auto-approve eligible]" if m["auto_approve_eligible"] else ""
                score_str = f"Score: {m['auto_score']}" if m["auto_score"] else ""
                lines.append(
                    f"  {m['id'][:12]}  bp:{m['bp'][:6]}  agt:{m['agent'][:8]}  "
                    f"\"{m['title'][:40]}\"  AC: {m['ac_passed']}/{m['ac_total']}  "
                    f"{score_str}{auto_tag}"
                )
                if m["auto_approve_eligible"]:
                    lines.append(f"    -> approve {m['id'][:12]}  |  /review-mrp {m['id'][:12]}")
                else:
                    lines.append(f"    -> /review-mrp {m['id'][:12]}")
            lines.append("")
        else:
            lines.append("No MRPs awaiting review.")
            lines.append("")

    # Stale BPs (inputs changed via upstream revision)
    stale = report.get("stale_bps")
    if stale and stale["items"]:
        lines.append("STALE (inputs changed) -- Reassessment required")
        lines.append("-" * 49)
        for b in stale["items"]:
            triggers = b.get("stale-because", []) or []
            count = len(triggers)
            sources = ", ".join(
                f"bp:{t.get('source-bp', '')[:6]} rev{t.get('source-revision', '?')}"
                for t in triggers[:3]
            )
            if count > 3:
                sources += f", +{count - 3} more"
            lines.append(
                f"  bp:{b['hash'][:6]} ({b['slug']})  \"{b['mission'][:40]}\"  "
                f"[{count} upstream change(s)]"
            )
            lines.append(f"    triggers: {sources}")
            ripple = b.get("ripple") or []
            if ripple:
                lines.append(
                    f"    ripple: {len(ripple)} transitive dependent(s) "
                    f"(not flagged unless you revise this BP):"
                )
                for r in ripple[:5]:
                    lines.append(
                        f"      bp:{r['hash'][:6]} ({r['slug']})  status: {r['status']}"
                    )
                if len(ripple) > 5:
                    lines.append(f"      ... +{len(ripple) - 5} more")
            lines.append(f"    -> /confirm-valid {b['hash'][:6]}  (assert still valid)")
            lines.append(f"    -> /revise {b['hash'][:6]}         (re-execute)")
        lines.append("")

    # Active BPs
    active = report.get("active_bps")
    if active:
        if active["items"]:
            lines.append("IN PROGRESS")
            lines.append("-" * 11)
            for b in active["items"]:
                stale = " [STALE LOCK]" if b.get("stale") else ""
                phase_str = f"Phase: {b['phase']}" if b["phase"] else "Phase: unknown"
                lines.append(
                    f"  bp:{b['hash'][:6]} ({b['slug']})  \"{b['mission'][:40]}\"  "
                    f"[{b['rigor']}]{stale}  agt:{b['agent_id'][:8]}"
                )
                lines.append(f"    {phase_str}  |  heartbeat: {b.get('heartbeat_age', 'n/a')}")
                if b.get("stale"):
                    lines.append(f"    -> /status release {b['hash'][:6]}")
            lines.append("")
        else:
            lines.append("No BPs in progress.")
            lines.append("")

    # Ready BPs
    ready = report.get("ready_bps")
    if ready:
        if ready["items"]:
            lines.append("READY TO DISPATCH")
            lines.append("-" * 17)
            for b in ready["items"]:
                lines.append(
                    f"  bp:{b['hash'][:6]} ({b['slug']})  \"{b['mission'][:40]}\"  "
                    f"created {b['created']}"
                )
                lines.append(f"    -> /dispatch {b['hash'][:12]}")
            lines.append("")
        else:
            lines.append("No BPs ready for dispatch.")
            lines.append("")

    # Quick stats
    stats = report.get("stats", {})
    if stats:
        lines.append("STATS")
        lines.append("-" * 5)
        active_n = stats.get("active", 0)
        completed_n = stats.get("completed", 0)
        total_disp = stats.get("total_dispatched", 0)
        lines.append(f"  Active:  {active_n} in-progress  |  {completed_n} completed  |  {total_disp} total dispatched")

        crp_open = stats.get("crps_open", 0)
        crp_block = stats.get("crps_blocking", 0)
        crp_res = stats.get("crps_resolved", 0)
        lines.append(f"  CRPs:    {crp_open} open ({crp_block} blocking)  |  {crp_res} resolved")

        mrp_pend = stats.get("mrps_pending", 0)
        mrp_auto = stats.get("mrps_auto_eligible", 0)
        mrp_rev = stats.get("mrps_reviewed", 0)
        lines.append(f"  MRPs:    {mrp_pend} pending review ({mrp_auto} auto-approve eligible)  |  {mrp_rev} reviewed")

        bp_ready = stats.get("ready", 0)
        bp_draft = stats.get("draft", 0)
        bp_parent = stats.get("parent_derived", 0)
        bp_stale_in = stats.get("stale_inputs", 0)
        stale_part = f"  |  {bp_stale_in} stale (inputs changed)" if bp_stale_in else ""
        lines.append(f"  BPs:     {bp_ready} ready  |  {bp_draft} draft  |  {bp_parent} parent (derived){stale_part}")

        # Blueprint stats
        blueprints_dir = Path(__file__).resolve().parent.parent / "artifacts" / "blueprints"
        if blueprints_dir.exists():
            bp_tmpl_count = sum(1 for _ in blueprints_dir.rglob("blueprint.md"))
            if bp_tmpl_count > 0:
                lines.append(f"  Blueprints: {bp_tmpl_count}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Deterministic status data aggregation for i-SASE"
    )
    parser.add_argument("--crps", action="store_true", help="Only CRP data")
    parser.add_argument("--mrps", action="store_true", help="Only MRP data")
    parser.add_argument("--active", action="store_true", help="Only active BPs")
    parser.add_argument("--stale", action="store_true", help="Only stale-inputs BPs")
    parser.add_argument("--text", action="store_true", help="Human-readable output")
    args = parser.parse_args()

    # If no filter, include everything
    has_filter = args.crps or args.mrps or args.active or args.stale
    include_crps = args.crps or not has_filter
    include_mrps = args.mrps or not has_filter
    include_active = args.active or not has_filter
    include_ready = not has_filter
    include_stale = args.stale or not has_filter

    # Regenerate index first
    regenerate_index()

    report = generate_report(
        include_crps=include_crps,
        include_mrps=include_mrps,
        include_active=include_active,
        include_ready=include_ready,
        include_stale=include_stale,
    )

    if args.text:
        print(format_text_report(report))
    else:
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
