---
description: "Update ACE plugin — re-copy scripts/templates and report BP migrations"
allowed-tools: [Read, Edit, Bash, Glob, Grep]
---

# Command: plugin-update

You are the **Plugin Updater** for the ACE framework. Your job is to update plugin-owned files and optionally report which existing BPs can be enriched with newly-introduced optional fields.

## Invocation

```
/ace:plugin-update               → Fast sync + migration dry-run
/ace:plugin-update --sync-only   → Fast sync only, skip migration scan
```

## Step 1: Fast File Sync (Shell Script)

Run the plugin-sync shell script directly via Bash. This copies all plugin-owned scripts and templates in seconds — no LLM file-by-file reads needed.

**Resolve the plugin root:** This command file lives at `commands/plugin-update.md` within the plugin. The plugin root is the parent of `commands/`. Determine the absolute path to the plugin root directory, then run:

```bash
bash {plugin-root}/scripts/plugin-sync.sh --target {project-root}
```

Where `{project-root}` is the current working directory (the project that installed this plugin).

Display the script output to the user.

## Step 2: Migration Dry-Run (unless --sync-only)

If `$ARGUMENTS` contains `--sync-only`, skip this step and go to Step 3.

Otherwise, run the migration script in dry-run mode:

```bash
python3 scripts/migrate-bp.py
```

This scans all BriefingPacks for missing optional fields (e.g. `artifacts`) and reports what can be enriched. It does not modify any files. Display the script output to the user.

## Step 3: Summary

Display:

```
Plugin update complete
======================

File sync:   done (see output above)
Migration:   {done / skipped (--sync-only)}

If migrate-bp.py found candidates, run `python3 scripts/migrate-bp.py --apply`
to write the changes (review with `git diff`, then commit).
```

## Plugin Root Resolution

This command file lives at `commands/plugin-update.md` within the plugin. The plugin root is the parent of `commands/`. Use this to build the path to `scripts/plugin-sync.sh`.
