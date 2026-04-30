#!/usr/bin/env python3
"""Stop hook: finalizes token usage log entries for completed ACE command markers."""

import sys
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    transcript_path = payload.get("transcript_path")
    cwd = payload.get("cwd", ".")

    pending_dir = Path(cwd) / "artifacts" / "token-usage" / ".pending"
    if not pending_dir.exists():
        sys.exit(0)

    for marker_file in pending_dir.glob("*.json"):
        try:
            with open(marker_file, encoding="utf-8") as f:
                marker = json.load(f)

            if not marker.get("completed"):
                continue

            start_time = marker["start_time"]
            tokens = sum_tokens_from_transcript(transcript_path, start_time)

            start_dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            duration_seconds = int((now - start_dt).total_seconds())

            entry = {
                "timestamp": start_time,
                "command": marker["command"],
                "model": marker.get("model", "unknown"),
                "effort": marker.get("effort", "unknown"),
                "duration_seconds": duration_seconds,
                "input_tokens": tokens["input_tokens"],
                "output_tokens": tokens["output_tokens"],
                "cache_read_tokens": tokens["cache_read_tokens"],
                "cache_write_tokens": tokens["cache_write_tokens"],
            }

            log_dir = Path(cwd) / "artifacts" / "token-usage"
            bp_hash = marker["bp_hash"]
            slug = marker.get("slug", bp_hash)
            log_file = log_dir / f"{bp_hash}-{slug}.jsonl"

            with open(log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")

            marker_file.unlink()

        except Exception as e:
            print(f"WARNING: token-usage-hook: failed to process {marker_file.name}: {e}", file=sys.stderr)


def sum_tokens_from_transcript(transcript_path, start_time):
    result = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}

    if not transcript_path or not os.path.exists(transcript_path):
        return result

    try:
        start_dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        start_dt = None

    with open(transcript_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Filter by timestamp when available
            if start_dt:
                event_ts = event.get("timestamp")
                if event_ts:
                    try:
                        event_dt = datetime.fromisoformat(event_ts.replace("Z", "+00:00"))
                        if event_dt < start_dt:
                            continue
                    except (ValueError, AttributeError):
                        pass

            # Extract token counts — handles both direct fields (api_request events)
            # and nested usage fields (assistant message events)
            usage = event if event.get("type") == "api_request" else event.get("usage", {})
            if not usage:
                continue

            result["input_tokens"] += usage.get("input_tokens", 0) or 0
            result["output_tokens"] += usage.get("output_tokens", 0) or 0
            result["cache_read_tokens"] += (
                usage.get("cache_read_tokens")
                or usage.get("cache_read_input_tokens")
                or 0
            )
            result["cache_write_tokens"] += (
                usage.get("cache_write_tokens")
                or usage.get("cache_creation_tokens")
                or usage.get("cache_creation_input_tokens")
                or 0
            )

    return result


if __name__ == "__main__":
    main()
