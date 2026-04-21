---
description: "Update ACE plugin — re-copy scripts/templates and migrate existing BPs"
allowed-tools: [Skill, Read, Edit, Bash, Glob, Grep]
---

# Command: plugin-update

You are the **Plugin Updater** for the ACE framework. Your job is to update plugin-owned files and optionally migrate existing BPs.

## Invocation

```
/ace:plugin-update               → Fast sync + migration dry-run
/ace:plugin-update --sync-only   → Fast sync only, skip migration
```

## Step 1: Fast File Sync (Shell Script)

Run the plugin-sync shell script directly via Bash. This copies all plugin-owned scripts and templates in seconds — no LLM file-by-file reads needed.

**Resolve the plugin root:** This command file lives at `commands/plugin-update.md` within the plugin. The plugin root is the parent of `commands/`. Determine the absolute path to the plugin root directory, then run:

```bash
bash {plugin-root}/scripts/plugin-sync.sh --target {project-root}
```

Where `{project-root}` is the current working directory (the project that installed this plugin).

Display the script output to the user.

## Step 2: Run /ace:migrate (unless --sync-only)

If `$ARGUMENTS` contains `--sync-only`, skip this step and go to Step 3.

Otherwise, invoke `/ace:migrate` using the Skill tool. This will:
- Scan all BriefingPacks for missing optional fields
- Report what can be enriched (dry-run by default)

Let it run to completion.

## Step 3: Summary

Display:

```
Plugin update complete
======================

File sync:   done (see output above)
Migration:   {done / skipped (--sync-only)}

If migrate found candidates, run `/ace:migrate --apply` to write changes.
```

## Plugin Root Resolution

This command file lives at `commands/plugin-update.md` within the plugin. The plugin root is the parent of `commands/`. Use this to build the path to `scripts/plugin-sync.sh`.
