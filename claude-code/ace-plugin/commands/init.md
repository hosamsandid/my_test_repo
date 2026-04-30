---
description: "Initialize a project for ACE (Agent Control Environment)"
allowed-tools: [Read, Write, Bash, Glob]
---

# Command: init

You are the **Project Initializer** for the ACE framework. Your job is to scaffold a new project so it can use ACE commands (`/ace:do`, `/ace:brief`, `/ace:status`, etc.). You create the directory structure, copy MentorScript templates, generate a `CLAUDE.md`, and copy utility scripts (index builder, briefings guard, git hooks).

## Invocation

```
/ace:init
```

No arguments. The command is interactive.

## Step 1: Check If Already Initialized

Before doing anything, check whether this project already has ACE artifacts:

```python
# Check for these indicators:
# - artifacts/briefings/ directory exists
# - CLAUDE.md file exists
```

If **both** exist, display this warning:

```
This project appears to already be initialized. Running init again will not overwrite existing files.
```

Then proceed through the steps below, but **skip any file or directory that already exists**. Report which items were skipped.

If **neither** exists, proceed normally.

## Step 2: Create Directories, Copy MentorScripts and Scripts (Shell Script)

Run the plugin-sync shell script to create the directory structure, copy MentorScripts (skip if exist), and copy all plugin-owned scripts in one fast operation:

```bash
bash {plugin-root}/scripts/plugin-sync.sh --target {project-root} --init
```

Where:
- `{plugin-root}` is the parent of `commands/` (resolved from this command file's location)
- `{project-root}` is the current working directory

This single command handles:
- Creating all required directories
- Copying `mentorscripts/global.md` (skip if exists)
- Copying `mentorscripts/team.md` (skip if exists)
- Copying all plugin-owned utility scripts (always overwrite)
- Copying BP Explorer files (always overwrite)

Display the script output to the user, then proceed to Step 3 (CLAUDE.md generation).

## Step 3: Generate CLAUDE.md

Generate `CLAUDE.md` at the project root.

````markdown
# Project MentorScript

> Powered by [ACE](https://github.com/AccentureCodeFoundry/314092_agent-command-environment) (Agent Control Environment)
> Based on: Hassan et al. (2025), "Structured Agentic Software Engineering"

## MentorScript Import

```
@import mentorscripts/global.md
@import mentorscripts/team.md
```

Agents MUST load these on startup.

## Project-Specific Rules

<!-- Add your project-specific rules here. Examples:
### R-100: Use TypeScript strict mode
**Severity:** mandatory
All TypeScript files must use strict mode.

### R-101: API responses use JSON:API format
**Severity:** recommended
-->

## Quick Start

- `/ace:do <task>` -- Quick fix (Tier 1, no ceremony)
- `/ace:brief <task>` -- Plan and execute (Tier 2, agent-drafted BP)
- `/ace:brief --full <task>` -- Full interactive briefing (Tier 3, for complex work)
- `/ace:status` -- See what needs your attention
````

**Skip if `CLAUDE.md` already exists in the project.**

## Step 4: Report

After all steps are complete, display the summary.

```
ACE initialized!

Created:
  artifacts/briefings/       -- Your Agent definitions live here
  artifacts/blueprints/      -- Reusable Agent Templates
  artifacts/guidance/crp/    -- Agent questions
  artifacts/guidance/mrp/    -- Agent deliverables
  artifacts/guidance/vcr/    -- Decision records
  artifacts/log/             -- Audit logs
  mentorscripts/global.md   -- Project rules
  mentorscripts/team.md     -- Team configuration
  CLAUDE.md                  -- Project MentorScript
  scripts/build-index.py    -- BP index generator
  scripts/briefings-guard-hook.sh      -- Claude hook helper for briefings guard
  scripts/pre-commit-briefings-guard.sh -- Git pre-commit hook for briefings guard
  scripts/install-git-hooks.sh          -- Git hooks installer
  scripts/bp-explorer/                  -- BP Explorer (server, UI, Docker)

Next steps:
  /ace:do <task>             -- Try a quick task
  /ace:getting-started       -- Interactive onboarding (5 min)
  bash scripts/bp-explorer/start.sh    -- Start BP Explorer with Docker
  bash scripts/install-git-hooks.sh    -- Enable the pre-commit briefings guard (optional)
```

If any items were skipped (already existed), append a "Skipped" section listing them.

## Plugin Root Resolution

This command file lives at `commands/init.md` within the plugin. The plugin root is the parent of `commands/`. Use this to resolve the path to `scripts/plugin-sync.sh`.

## Important Notes

- **Idempotency:** Running init multiple times is safe. User files (CLAUDE.md, mentorscripts) are skipped if present. Plugin-owned scripts are always overwritten with the latest version.
- **LoopScripts are resolved from the plugin:** Standard LoopScripts (`standard.yaml`, `high-rigor.yaml`) are resolved directly from the plugin install path at runtime — they are NOT copied into the project. Projects can override by placing custom LoopScripts in `skills/engineering/loops/`.
- **Git-agnostic:** This command works in any directory. It does not require or create a Git repository.
- **MentorScript rules:** This command does not execute code that requires MentorScript compliance -- it only creates scaffolding files.
