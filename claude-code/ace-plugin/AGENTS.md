# AGENTS.md -- i-SASE Cross-Tool Agent Instructions

> Auto-derived from the i-SASE MentorScripts (CLAUDE.md + mentorscripts/global.md + mentorscripts/team.md).
> For the full framework, see CLAUDE.md.

## Project Overview

**i-SASE** = *instrumented Software Agent Software Engineering*

This repository implements a CLI-driven workflow for collaboration between
humans (Agent Coaches) and AI agents (AI Teammates). The framework uses
typed, schema-validated artifacts (BriefingPacks, LoopScripts, MentorScripts,
CRPs, MRPs, VCRs) to coordinate agent-assisted software engineering.

Key paths: `agents/`, `commands/`, `skills/`, `artifacts/`, `mentorscripts/`.

## Artifact IDs

All artifacts use **12-character hex hash IDs** generated via `openssl rand -hex 6`.
Example: `a1b2c3d4e5f6`. This applies to BPs, CRPs, MRPs, and VCRs.
BriefingPacks are stored as `artifacts/briefings/{hash}/brief.md`.

## Team Roles

Agents operate within a team structure defined in `mentorscripts/team.md`:
- **Author**: Creates BP drafts
- **Contributor**: Adds sections to existing drafts
- **Approver**: Transitions BPs from `draft` to `ready`
- **Reviewer**: Evaluates MRPs against the 5 criteria
- **Dispatcher**: Transitions BPs from `ready` to `dispatched`

## Git Integration

Agent work is isolated in dedicated **git worktrees**, each on its own branch (`agent/{agent-id}/{bp-hash}`).
Worktrees are stored at `.worktrees/{agent-id}-{bp-hash}/`, enabling parallel agent execution.
Agents commit with SASE prefixes (`claim()`, `heartbeat()`, `complete()`, etc.)
and include `[agent:{agent-id}]` tags. See `mentorscripts/team.md` for details.

## Code Conventions

- All artifacts use UTF-8
- YAML Frontmatter delimited by `---`
- Schema reference in frontmatter: `schema: <type>/<version>`
- Date format: ISO 8601 (`YYYY-MM-DD`)
- Language in artifacts: English (unless explicitly stated otherwise)
- Commit messages: Conventional Commits on non-agent branches; SASE prefix convention on agent branches/worktrees (see `mentorscripts/team.md`)
- Never modify `CLAUDE.md` or `mentorscripts/` without explicit human instruction

## Key Rules

### R-001: Test Coverage (mandatory)
Every new function requires tests. Bug fixes need a regression test. Existing tests must not be removed without justification.

### R-002: Error Handling (mandatory)
Never silently swallow exceptions. No empty catch blocks without documented reason. Error messages must be descriptive and context-rich. Prefer fail-fast.

### R-003: Security (mandatory)
No secrets in code or logs. Input validation at all trust boundaries. Security-relevant decisions always require escalation (CRP).

### R-004: Code Review (mandatory)
Self-review all code before completion. Check for correctness, readability, maintainability, unintended side effects, and compliance with all rules.

## Escalation Guidance (CRP Triggers)

An agent **must** escalate (create a Clarification Request Protocol) when any of these structural triggers apply:

| # | Trigger | Mode |
|---|---------|------|
| 1 | API/Schema/Interface change | blocking |
| 2 | Security (auth, crypto) | blocking |
| 3 | Scope deviation from task spec | blocking |
| 4 | Cross-scope reversal (changes beyond current scope) | blocking |
| 5 | Multi-approach ambiguity (no guidance given) | deferred |
| 6 | Data-destructive operation | blocking |
| 7 | Dependency change (add/remove/major upgrade) | deferred |
| 8 | Observable behavior change (not specified by task) | deferred |

- **Blocking**: Agent pauses and waits for human response.
- **Deferred**: Agent documents decision, continues, human reviews later.
- Guessing is not an acceptable alternative to a blocking escalation.

## Additional Recommended Rules

- **R-010 Commit Messages**: On non-agent branches use Conventional Commits (`type(scope): description`). On agent branches (from within worktrees) use SASE prefix convention: `prefix(bp:{hash}): description [agent:{agent-id}]`.
- **R-011 Documentation**: Public APIs need documentation (description, parameters, return values).
- **R-020 DRY**: Avoid code duplication, but prefer duplication over wrong abstraction.

---

*This file is auto-derived from the i-SASE MentorScripts (CLAUDE.md + mentorscripts/global.md + mentorscripts/team.md). For the full framework, see CLAUDE.md.*
