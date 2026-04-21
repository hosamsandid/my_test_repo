---
description: "Archive reviewed Agent trees, list archived Agents, restore from archive"
allowed-tools: [Read, Grep, Glob, Bash]
---

# Command: archive

You are the **Archive Manager**. Your job is to manage the archival lifecycle of completed BriefingPack trees -- moving reviewed work to `.archive/` to keep the active workspace clean, listing what's been archived, and restoring BPs when needed.

**Important:** Archiving is a **physical directory move** to `artifacts/briefings/.archive/`, NOT a frontmatter status change. Never set `status: archived` in a BP's frontmatter. The archive mechanism preserves the full directory structure for provenance.

## Invocation

```
/archive {bp-hash}            → Archive a completed BP tree (all children included)
/archive --list               → List all archived BPs
/archive --restore {bp-hash}  → Restore a BP tree from archive to active briefings
```

## Argument Parsing

Read `$ARGUMENTS` to determine the mode:

1. If `$ARGUMENTS` contains `--list` → **List mode**
2. If `$ARGUMENTS` contains `--restore {hash}` → **Restore mode** (extract the hash)
3. Otherwise treat `$ARGUMENTS` as a BP hash prefix → **Archive mode**

---

## Workflow: Archive a BP Tree

Triggered when arguments are a BP hash prefix (no flags).

### Steps

1. Run the deterministic transition script:
   ```
   python3 scripts/bp-transition.py archive {bp-hash-prefix}
   ```
2. The script will:
   - Find the BP and walk up to its root (archiving always operates on the topmost parent)
   - Validate that **all leaf BPs** in the tree are `completed` or `reviewed`
   - Move the entire directory tree to `artifacts/briefings/.archive/`
   - Regenerate the index
   - Create a git commit: `archive(bp:{hash}): archived completed tree`
3. Display the script output to the user.
4. If the script exits with an error (e.g., incomplete children), display the error and suggest:
   ```
   Some BPs are not yet completed/reviewed. Complete them first:
     -> /status {incomplete-hash}
   ```

### Output Format

```
ARCHIVED
--------
bp:{hash} ({slug})  "{title}"
  {N} BP(s) moved to .archive/
  committed: archive(bp:{hash}): archived completed tree

The BP tree is now archived and no longer appears in /status.
  -> /archive --list    (view all archived BPs)
  -> /archive --restore {hash}  (undo this archival)
```

---

## Workflow: List Archived BPs

Triggered when `$ARGUMENTS` contains `--list`.

### Steps

1. Run:
   ```
   python3 scripts/bp-transition.py list-archive
   ```
2. Display the output. If no archived BPs exist, show:
   ```
   No archived BPs found.
   ```

---

## Workflow: Restore a BP from Archive

Triggered when `$ARGUMENTS` contains `--restore {hash}`.

### Steps

1. Run:
   ```
   python3 scripts/bp-transition.py restore {bp-hash-prefix}
   ```
2. The script will:
   - Find the BP in `.archive/`
   - Move it back to `artifacts/briefings/`
   - Regenerate the index
   - Create a git commit: `restore(bp:{hash}): restored from archive`
3. Display the result.

### Output Format

```
RESTORED
--------
bp:{hash} ({slug})  "{title}"
  Restored from .archive/ to active briefings.
  committed: restore(bp:{hash}): restored from archive

  -> /status {hash}  (view restored BP)
```

---

## Design Notes

- Archiving is irreversible in the sense that it moves files -- but `/archive --restore` provides the inverse operation. Both are git-committed, so full history is always available.
- The transition script handles all validation, filesystem operations, and git commits. This command is a thin wrapper that invokes the script and formats output.
- Only humans (Author, Approver) should archive BPs. Agents must never archive autonomously.
- `/status audit {hash}` continues to search both active and `.archive/` directories for provenance.
