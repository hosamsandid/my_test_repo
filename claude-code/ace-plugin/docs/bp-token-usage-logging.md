# Solution Design: BP Token Usage Logging

## Problem

When executing ACE plugin commands that drive BP lifecycle (dispatch, briefing, review, etc.), there is no record of how many tokens were consumed, which model was used, or how long the command took. This makes it impossible to audit cost attribution per BP or track usage trends over time.

## Scope

Token usage is logged for the following in-scope ACE commands:

- `/brief` (Tier 2 and Tier 3)
- `/dispatch`
- `/review-mrp`
- `/resolve-crp`

Commands that are read-only or purely navigational (`/status`, `/archive`, `/compare`) are excluded.

---

## Log Storage

One JSONL file per BP, stored under `artifacts/token-usage/`:

```
artifacts/token-usage/{bp-hash}-{slug}.jsonl
```

Example: `artifacts/token-usage/a3f7c2e1b9d4-cobol-extraction.jsonl`

Each line in the file is one JSON object representing a single command invocation from start to completion.

### Entry Schema

```json
{
  "timestamp": "2026-04-28T10:31:13Z",
  "command": "dispatch",
  "model": "claude-sonnet-4-6",
  "effort": "medium",
  "duration_seconds": 47,
  "input_tokens": 12400,
  "output_tokens": 830,
  "cache_read_tokens": 9200,
  "cache_write_tokens": 1100
}
```

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 UTC timestamp of when the command was invoked |
| `command` | The ACE command name (`brief`, `dispatch`, `review-mrp`, `resolve-crp`) |
| `model` | Claude model identifier at invocation time |
| `effort` | Effort level setting at invocation time |
| `duration_seconds` | Wall-clock seconds from invocation to completion |
| `input_tokens` | Total input tokens across all API requests during the command |
| `output_tokens` | Total output tokens across all API requests during the command |
| `cache_read_tokens` | Total cache read tokens across all API requests during the command |
| `cache_write_tokens` | Total cache write (creation) tokens across all API requests during the command |

---

## Mechanism

Token usage data is not available in Claude Code hook payloads directly. However, every hook receives a `transcript_path` field pointing to a JSONL file that contains `api_request` events with full token metadata. The design exploits this via a **start marker + Stop hook** pattern.

### Overview

```
Skill starts
  └─> writes .pending marker (command, bp, model, effort, start_time)

Skill completes
  └─> sets completed: true in marker

Claude Code Stop hook fires (after every turn)
  └─> scans .pending/ for completed markers
  └─> parses transcript, sums tokens since start_time
  └─> appends entry to artifacts/token-usage/{bp-hash}-{slug}.jsonl
  └─> deletes marker
```

### 1. Start Marker

When an in-scope skill begins execution, it writes a marker file:

**Path:** `artifacts/token-usage/.pending/{bp-hash}-{slug}.json`

**Contents:**
```json
{
  "command": "dispatch",
  "bp_hash": "a3f7c2e1b9d4",
  "slug": "cobol-extraction",
  "model": "claude-sonnet-4-6",
  "effort": "medium",
  "start_time": "2026-04-28T10:31:13Z"
}
```

This is the only modification required to each skill at its start.

### 2. Completion Signal

When the skill declares itself complete (end of its final phase), it updates the marker file by adding:

```json
{
  "completed": true
}
```

This is the only modification required to each skill at its end.

Markers without `completed: true` are ignored by the Stop hook. This correctly handles multi-turn commands (e.g., `/brief` Tier 3 interactive): while the command is in progress across multiple conversation turns, the marker persists and tokens accumulate in the transcript. The hook only finalizes the log entry once the skill signals completion.

### 3. Stop Hook

A shell script registered as a `Stop` hook in `.claude/settings.json`. It fires after every Claude turn and runs the following logic:

1. Scan `artifacts/token-usage/.pending/` for `.json` files where `completed == true`
2. For each completed marker:
   a. Read `transcript_path` from the hook's stdin payload
   b. Parse the transcript JSONL and filter all `api_request` events where `timestamp >= start_time`
   c. Sum `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` across the filtered events
   d. Compute `duration_seconds = current_time - start_time`
   e. Construct the log entry JSON object
   f. Append the entry to `artifacts/token-usage/{bp_hash}-{slug}.jsonl` (create file if it does not exist)
   g. Delete the marker file from `.pending/`

The hook is non-blocking and must not fail silently — if the transcript cannot be parsed or the output file cannot be written, it should log a warning to stderr and exit cleanly without corrupting existing log data.

---

## File Layout

```
artifacts/
  token-usage/
    .pending/                              ← transient markers (gitignored)
      a3f7c2e1b9d4-cobol-extraction.json  ← in-flight command marker
    a3f7c2e1b9d4-cobol-extraction.jsonl   ← completed log for this BP
    7b2d4e9f1a8c-inventory-analysis.jsonl
```

The `.pending/` directory should be added to `.gitignore`. The `.jsonl` log files should be committed as part of the repository.

---

## Implementation Checklist

- [ ] Create `artifacts/token-usage/` directory and add `.pending/` to `.gitignore`
- [ ] Write the Stop hook shell script
- [ ] Register the Stop hook in `.claude/settings.json`
- [ ] Add start marker write to each in-scope skill: `brief`, `dispatch`, `review-mrp`, `resolve-crp`
- [ ] Add completion signal write to each in-scope skill
- [ ] Validate on a test BP that the marker lifecycle and transcript parsing work end-to-end

---

## Open Questions

- **Transcript format stability:** The `api_request` event schema in the transcript JSONL is not part of a versioned public API. If Claude Code changes the transcript format, the hook script will need to be updated.
- **Clock skew:** The `start_time` written by the skill and the `timestamp` fields in the transcript events must both be UTC. Verify this assumption during implementation.
- **Multiple concurrent commands:** If two in-scope commands run simultaneously (unlikely in normal use), two separate marker files will exist in `.pending/`. The Stop hook processes each independently, which is correct.
