#!/usr/bin/env bash
# briefings-guard-hook.sh
# Claude hook helper: blocks writes to disallowed files in artifacts/briefings/.
# Reads tool input JSON from stdin, extracts file_path, validates against allowlist.
# Exit 1 + stderr message = block the tool call.

set -euo pipefail

fp=$(jq -r '.tool_input.file_path // ""')

[ -z "$fp" ] && exit 0

case "$fp" in
    */artifacts/briefings/templates/*.md|artifacts/briefings/templates/*.md)
        # templates/*.md is allowed
        ;;
    */artifacts/briefings/*|artifacts/briefings/*)
        bn=$(basename "$fp")
        case "$bn" in
            brief.md|.index.json)
                # Allowed file
                ;;
            *)
                echo "BLOCKED: Only brief.md, .index.json, and templates/*.md are allowed in artifacts/briefings/. Attempted file: $fp. Write this artifact to a location outside the briefings directory structure." >&2
                exit 1
                ;;
        esac
        ;;
esac
