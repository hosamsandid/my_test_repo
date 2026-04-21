#!/usr/bin/env python3
"""
Deterministic BP provenance/audit timeline for i-SASE.

Aggregates BP creation, CRPs, MRPs, VCRs into a chronological timeline.
Replaces LLM-driven data aggregation in status.md provenance view.

Usage:
    python3 scripts/audit-bp.py <bp-hash-prefix>
    python3 scripts/audit-bp.py <bp-hash-prefix> --json

Exit codes:
    0  BP found, timeline generated
    1  BP not found
    2  Ambiguous prefix
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sase_lib import (
    GUIDANCE_DIR, REPO_ROOT,
    parse_frontmatter, find_bp as _find_bp_base,
)


def find_bp(prefix: str) -> tuple[Path, str, str]:
    """Find a BP by hash prefix, including archive."""
    return _find_bp_base(prefix, include_archive=True)


# ---------------------------------------------------------------------------
# Artifact scanning
# ---------------------------------------------------------------------------

def scan_artifacts(bp_hash: str) -> dict:
    """Scan all guidance artifacts related to a BP."""
    crp_dir = GUIDANCE_DIR / "crp"
    mrp_dir = GUIDANCE_DIR / "mrp"
    vcr_dir = GUIDANCE_DIR / "vcr"

    crps, mrps, vcrs = [], [], []

    if crp_dir.exists():
        for path in sorted(crp_dir.glob("*.md")):
            fm = parse_frontmatter(path.read_text(encoding="utf-8"))
            bp = fm.get("bp") or fm.get("briefing-pack", "")
            if bp != bp_hash:
                continue
            crps.append({
                "id": fm.get("id", ""), "type": "crp",
                "status": fm.get("status", "open"),
                "mode": fm.get("mode", "blocking"),
                "trigger": fm.get("trigger", ""),
                "created": fm.get("created", ""),
                "agent": fm.get("raised-by", ""),
                "resolved_by_vcr": fm.get("resolved-by", ""),
            })

    if mrp_dir.exists():
        for path in sorted(mrp_dir.glob("*.md")):
            fm = parse_frontmatter(path.read_text(encoding="utf-8"))
            bp = fm.get("bp") or fm.get("briefing-pack", "")
            if bp != bp_hash:
                continue
            mrps.append({
                "id": fm.get("id", ""), "type": "mrp",
                "status": fm.get("status", "pending"),
                "created": fm.get("created", ""),
                "agent": fm.get("produced-by", ""),
            })

    related_ids = {c["id"] for c in crps} | {m["id"] for m in mrps}
    if vcr_dir.exists():
        for path in sorted(vcr_dir.glob("*.md")):
            fm = parse_frontmatter(path.read_text(encoding="utf-8"))
            resolves = fm.get("resolves", "")
            if resolves in related_ids or fm.get("briefing-pack") == bp_hash:
                vcrs.append({
                    "id": fm.get("id", ""), "type": "vcr",
                    "vcr_type": fm.get("type", ""),
                    "resolves": resolves,
                    "created": fm.get("created", ""),
                    "author": fm.get("author", ""),
                })

    return {"crps": crps, "mrps": mrps, "vcrs": vcrs}


# ---------------------------------------------------------------------------
# Timeline generation
# ---------------------------------------------------------------------------

def build_timeline(bp_fm: dict, artifacts: dict) -> list[dict]:
    """Build a chronological timeline of events."""
    events = []

    created = bp_fm.get("created", "")
    author = bp_fm.get("author", "")
    if isinstance(author, list):
        author = ", ".join(author)
    events.append({"date": created, "event": "BP created",
                    "detail": f"by {author}" if author else ""})

    claimed = bp_fm.get("claimed", "")
    agent_id = bp_fm.get("agent-id", "")
    if claimed:
        events.append({"date": claimed[:10] if len(claimed) >= 10 else claimed,
                        "event": "Dispatched",
                        "detail": f"agent: {agent_id}" if agent_id else ""})

    completed = bp_fm.get("completed", "")
    if completed:
        events.append({"date": completed[:10] if len(completed) >= 10 else completed,
                        "event": "Completed",
                        "detail": f"agent: {agent_id}" if agent_id else ""})

    for crp in artifacts["crps"]:
        events.append({"date": crp.get("created", ""),
                        "event": f"CRP {crp.get('id', '')[:12]} opened",
                        "detail": f"[{crp.get('mode', '')}] {crp.get('trigger', '')}"})
        if crp.get("resolved_by_vcr"):
            for vcr in artifacts["vcrs"]:
                if vcr.get("id") == crp.get("resolved_by_vcr") or vcr.get("resolves") == crp.get("id"):
                    events.append({"date": vcr.get("created", ""),
                                    "event": f"CRP {crp.get('id', '')[:12]} resolved",
                                    "detail": f"via VCR {vcr.get('id', '')[:12]}"})
                    break

    for mrp in artifacts["mrps"]:
        events.append({"date": mrp.get("created", ""),
                        "event": f"MRP {mrp.get('id', '')[:12]} submitted",
                        "detail": f"by agent {mrp.get('agent', '')[:8]}"})
        for vcr in artifacts["vcrs"]:
            if vcr["resolves"] == mrp["id"]:
                events.append({"date": vcr["created"],
                                "event": f"MRP {mrp['id'][:12]} {vcr.get('vcr_type', 'reviewed')}",
                                "detail": f"via VCR {vcr['id'][:12]} by {vcr.get('author', '')}"})

    events.sort(key=lambda e: e["date"])
    return events


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def format_text(bp_hash: str, slug: str, bp_fm: dict, artifacts: dict, timeline: list[dict]) -> str:
    lines = [
        f"PROVENANCE: bp:{bp_hash[:6]} ({slug})",
        "=" * (14 + len(bp_hash[:6]) + len(slug) + 3),
        "",
        f"BP: bp:{bp_hash[:6]} ({slug})  \"{bp_fm.get('mission') or bp_fm.get('title', '')}\"",
        f"Created: {bp_fm.get('created', '?')}  |  Status: {bp_fm.get('status', '?')}",
        "", "TIMELINE", "-" * 8,
    ]
    for event in timeline:
        detail = f"  {event['detail']}" if event.get("detail") else ""
        lines.append(f"  {event['date']}  {event['event']}{detail}")
    lines.extend(["", "RELATED ARTIFACTS", "-" * 17])
    crp_ids = [f"{c['id'][:12]} ({c['status']})" for c in artifacts["crps"]]
    mrp_ids = [f"{m['id'][:12]} ({m['status']})" for m in artifacts["mrps"]]
    vcr_ids = [v["id"][:12] for v in artifacts["vcrs"]]
    lines.append(f"  CRPs: {', '.join(crp_ids) if crp_ids else 'none'}")
    lines.append(f"  MRPs: {', '.join(mrp_ids) if mrp_ids else 'none'}")
    lines.append(f"  VCRs: {', '.join(vcr_ids) if vcr_ids else 'none'}")
    return "\n".join(lines)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="BP provenance/audit timeline for i-SASE")
    parser.add_argument("bp_prefix", help="BP hash or unique prefix")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    brief_path, bp_hash, slug = find_bp(args.bp_prefix)
    bp_fm = parse_frontmatter(brief_path.read_text(encoding="utf-8"))
    artifacts = scan_artifacts(bp_hash)
    timeline = build_timeline(bp_fm, artifacts)

    if args.json:
        print(json.dumps({
            "bp_hash": bp_hash, "slug": slug,
            "mission": bp_fm.get("mission") or bp_fm.get("title", ""),
            "status": bp_fm.get("status", ""), "created": bp_fm.get("created", ""),
            "timeline": timeline, "artifacts": artifacts,
        }, indent=2))
    else:
        print(format_text(bp_hash, slug, bp_fm, artifacts, timeline))


if __name__ == "__main__":
    main()
