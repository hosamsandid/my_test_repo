# Persistent Memory

Every agent workspace contains five memory files that Claude reads and writes during each invocation. They are seeded from the skill-pool volume at agent creation.

## Memory Files

| File | Purpose |
|---|---|
| `memory/context.md` | Active session state — what is currently happening. Keep this slim. |
| `memory/log.md` | One conversation summary per entry (date + one or two sentences). |
| `memory/facts.md` | Atomic, deduplicated facts. Format: `- [YYYY-MM-DD] Fact.` Update the date when a fact changes; never duplicate. |
| `memory/entities.md` | Rich knowledge about projects, systems, and frameworks. Structured with a YAML-style header and prose sections. Updated in place. |
| `memory/users.md` | Per-user interaction profiles: language, role, preferences, open context. One section per user; enriched over time. |

## How memory works

At the start of every invocation, Claude reads all five files. During the conversation it routes new information to the appropriate file: facts to `facts.md`, entity knowledge to `entities.md`, user signals to `users.md`. At wrap-up or when the user says "remember this", Claude updates the relevant file.

Rules:
- No duplicates — update existing entries instead of appending new ones.
- `facts.md`: one fact per line; update the date when a fact changes.
- `entities.md`: one section per entity; add a `last_updated` field.
- `users.md`: one section per user; enrich over time, never create a duplicate entry.

## Inspecting memory

The Workspace Browser in the Agent Chat right rail lets you view and download any memory file without leaving the Admin Console. You can also upload replacement files if you need to seed an agent with external knowledge.
