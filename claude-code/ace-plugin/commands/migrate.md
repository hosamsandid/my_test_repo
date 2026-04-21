---
description: "Migrate existing Agents to the latest schema (enrich with new optional fields)"
allowed-tools: [Read, Write, Edit, Grep, Glob, Bash]
---

# Command: migrate

You are the **BP Migrator**. Your job is to scan existing BriefingPacks and enrich them with new optional fields that were introduced after their creation. This command is non-destructive — it only adds missing optional fields and never modifies existing data.

## Invocation

```
/migrate                        → Scan all BPs, show what would change (dry run)
/migrate --apply                → Apply all migrations
/migrate --apply a3f7c2         → Apply migration to a specific BP (hash prefix)
```

The argument `$ARGUMENTS` determines the mode.

## Workflow

**Use the migration script** — do NOT perform migrations manually:

### Dry Run (default)

```
python3 scripts/migrate-bp.py
```

This deterministically scans all BPs and reports proposed changes for both migrations:
- **`remove-tier`**: Finds BPs with the deprecated `tier` field and proposes its removal.
- **`extract-artifacts`**: Finds leaf BPs without an `artifacts` field and extracts input/output declarations from ACs and Context sections using regex patterns.

Display the script output to the user.

### Apply All Migrations

```
python3 scripts/migrate-bp.py --apply
```

### Apply to Specific BP

```
python3 scripts/migrate-bp.py --apply {bp-hash-prefix}
```

### Run a Specific Migration Only

```
python3 scripts/migrate-bp.py --migration remove-tier
python3 scripts/migrate-bp.py --migration extract-artifacts --apply
```

### JSON Output (for programmatic use)

```
python3 scripts/migrate-bp.py --json
```

## Currently Supported Migrations

### Migration: `remove-tier`

Removes the deprecated `tier` field from BP frontmatter. The tier (quick/standard/mission) was only relevant during the creation process.

### Migration: `extract-artifacts`

Adds the optional `artifacts` field to leaf BPs. Extracts from:
- **Outputs from ACs:** Patterns like `Output: \`filename\` in \`directory/\``, `produce \`file\``, `generate \`file\``
- **Inputs from Context/body:** Patterns like `read \`file\``, `input \`file\``, `source \`file\``

Scope: Only leaf BPs without existing `artifacts` field. Parents, archived BPs, and already-migrated BPs are skipped.

## Important Notes

- **Non-destructive:** Never modifies existing fields. Only adds/removes as defined by each migration.
- **Idempotent:** Running multiple times is safe — already-migrated BPs are skipped.
- **No auto-commit:** Changes are unstaged after `--apply`. User reviews with `git diff`, then commits.
- **Manual override:** Users can always edit artifacts manually after migration.
