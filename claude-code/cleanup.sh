#!/bin/sh
# Memory cleanup — runs a one-shot Claude Code instance to tidy up memory files,
# then sends a summary to Matrix.

cd "$(dirname "$0")/.."

# Load .env if present
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

ROOM_ID="${MATRIX_DEFAULT_ROOM}"
MATRIX_TOKEN="${MATRIX_ACCESS_TOKEN}"
MATRIX_URL="http://localhost:8448"

CLEANUP_PROMPT="You are the memory housekeeper. Your task is to clean up and consolidate the memory files.

Read:
- memory/context.md
- memory/log.md

Then:

1. **context.md**: Remove duplicates. Merge similar entries. Sort by category. Entries older than 90 days: check if still relevant, otherwise remove.

2. **log.md**: Keep only the last 30 days. Older entries: summarize per week in one line (e.g. 'CW 12: migration analysis, COBOL review, JCL conversion'). Delete the individual entries for those weeks.

3. Write the cleaned files back. Create files that don't exist yet as empty templates.

4. Reply ONLY with a short summary (2-3 sentences) of what you cleaned up."

# Run cleanup and capture output
RESULT=$(podman compose run --rm \
  --no-deps \
  -e HOME=/root \
  --entrypoint /entrypoint.sh \
  claude-bridge \
  claude -p "$CLEANUP_PROMPT" \
    --output-format text \
    --permission-mode acceptEdits \
    --allowedTools "Read(*)" \
    --allowedTools "Write(*)" \
    --allowedTools "Edit(*)" \
    --allowedTools "Glob(*)" \
    --allowedTools "Grep(*)" \
    2>&1)

echo "[$(date)] $RESULT" >> /tmp/claude-bridge-cleanup.log

# Send summary to Matrix (with HTML formatting)
if [ -n "$ROOM_ID" ] && [ -n "$MATRIX_TOKEN" ]; then
  TXNID=$(date +%s%N)
  PAYLOAD=$(echo "$RESULT" | python3 -c '
import sys, json, re

text = sys.stdin.read().strip()
html = text
html = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html)
html = re.sub(r"`(.+?)`", r"<code>\1</code>", html)
html = re.sub(r"^- (.+)$", r"<li>\1</li>", html, flags=re.MULTILINE)
html = re.sub(r"((?:<li>.*</li>\n?)+)", r"<ul>\1</ul>", html)
html = html.replace("\n", "<br>")
html = html.replace("<br><ul>", "<ul>").replace("</ul><br>", "</ul>")

print(json.dumps({
    "msgtype": "m.text",
    "body": text,
    "format": "org.matrix.custom.html",
    "formatted_body": html
}))
')

  curl -s -X PUT \
    -H "Authorization: Bearer $MATRIX_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID/send/m.room.message/$TXNID" \
    >> /tmp/claude-bridge-cleanup.log 2>&1
fi

echo "" >> /tmp/claude-bridge-cleanup.log
