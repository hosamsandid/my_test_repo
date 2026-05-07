# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a mainframe modernization project migrating a large-scale insurance platform (~3 million LOC) from COBOL/Mainframe to Java/Jakarta EE. The legacy system covers policy management, contract lifecycle, financial postings, premium/interest calculations, payment processing, and batch operations. The legacy stack is COBOL + C modules, DB2 databases, and Control-M scheduling.

## Repository Layout

- `10-legacy/` — Read-only reference copy of the original mainframe source code. **Never modify files here.**
- `20-docs/` — All project documentation (customer input, legacy analysis, architecture, guidelines, migration plans, templates), numbered by concern (10- through 90-).
- `30-migrated/` — The target Java/Jakarta EE application being built.
- `40-tools/` — Migration tooling (Docker environments, taskboard).
  - **Visualization Tools** — Run `make tools` to start all tools behind Traefik at `http://tools.localhost`. Individual tools: `make bp-explorer`, `make kg-viewer`, `make slidev`, `make cobolitics`, `make reports`, `make taskboard`. Stop with `make tools-stop`. See `40-tools/70-portal/tools.json` for the full tool registry.
  - **BP Explorer** is part of the ACE plugin and is copied to `scripts/bp-explorer/` by `ace:plugin-update`. Available at `http://bp-explorer.localhost` via `make tools`, or standalone via `python3 scripts/bp-explorer/server.py` → http://localhost:8765.
- `50-orga/` — Project organization (tasks, meetings, status reports, decision log).
- `.claude/` — Custom agents, skills, and commands for Claude Code.

## Key Conventions

- All documentation and commit messages must be in **English**.
- The numbered prefix scheme (10-, 20-, 30-, ...) is used throughout to enforce ordering. Maintain this convention when adding new directories or files.
- Legacy source in `10-legacy/` is strictly read-only — it serves as the baseline for analysis and must never be edited.
- When modifying onboarding guides in `20-docs/90-guides/`, run `/onboard-sync` to check for drift in derived artifacts (`/onboard` command and onboarding slides).

## Task Management

Tasks are tracked as GitHub Issues on the [Greenfield Modernization](https://github.com/orgs/AccentureCodeFoundry/projects/147) project board (project #147). All three repos are linked:
- `AccentureCodeFoundry/314092_agentic-mainframe-modernization` — main repo: legacy source, docs, migrated code, tooling
- `AccentureCodeFoundry/314092_agent-command-environment` — ACE plugin: agent skills, commands, BP/MRP tooling
- `AccentureCodeFoundry/314092_agent-execution-environment` — AEE: Conduwuit + orchestrator + Admin Console; container-per-agent target product

**Wrapper script** (`40-tools/80-gh-tasks/gh-tasks.sh`) abstracts field IDs:
```bash
bash 40-tools/80-gh-tasks/gh-tasks.sh list                                    # all tasks
bash 40-tools/80-gh-tasks/gh-tasks.sh list --status "In Progress"             # filter by status
bash 40-tools/80-gh-tasks/gh-tasks.sh list --json                             # structured output for agents
bash 40-tools/80-gh-tasks/gh-tasks.sh view <issue-number>                     # task details (human-readable)
bash 40-tools/80-gh-tasks/gh-tasks.sh describe <issue-number>                 # task details (JSON for agents)
bash 40-tools/80-gh-tasks/gh-tasks.sh pick-next                               # next highest-priority Todo task
bash 40-tools/80-gh-tasks/gh-tasks.sh pick-next --claim                       # pick next + set to In Progress
bash 40-tools/80-gh-tasks/gh-tasks.sh create --title "..." --type Task        # new task (auto-assigns type ID)
bash 40-tools/80-gh-tasks/gh-tasks.sh update <issue-number> --status in-progress  # move task
bash 40-tools/80-gh-tasks/gh-tasks.sh close <issue-number> --reason "Done"    # close with reason
bash 40-tools/80-gh-tasks/gh-tasks.sh export --format csv                     # export all tasks
```

**Direct `gh` CLI** also works:
```bash
gh project item-list 147 --owner AccentureCodeFoundry --format json --limit 200
gh issue list -R AccentureCodeFoundry/314092_agentic-mainframe-modernization --label "type:Task"
gh issue view <number> -R AccentureCodeFoundry/314092_agentic-mainframe-modernization
```

**Conventions:**
- Issue titles are prefixed with `[TYPE_ID]`, e.g. `[FEA-12] Add export feature`
- Type IDs are auto-assigned by `gh-tasks.sh create`
- Set status to "In Progress" when starting work on a task
- Statuses: Backlog, Todo, In Progress, Review, Done, Closed
- Types: Feature, Improvement, Analysis, Task, Experiment
- Priority: high, medium, low

## Domain Context

The insurance domain uses German business terminology extensively in the legacy code (e.g., Vertrag = contract, Angebot = offer, Tilgung = repayment, Sollstellung = scheduled posting, Auszahlung = disbursement). Understanding these terms is essential for accurate analysis and migration.
