---
name: "ATME"
description: "AI Teammate Mentorship Engineering — Creating and maintaining MentorScripts"
---

# Skill: ATME — AI Teammate Mentorship Engineering

## Purpose

AI Teammate Mentorship Engineering is the discipline of codifying engineering standards, team conventions, and behavioral rules that agents must follow. MentorScripts are the mechanism for transferring institutional knowledge to AI Teammates — they encode what a senior engineer would tell a new team member on day one.

## Key Concepts

### Rules with IDs
Every rule in a MentorScript has a unique identifier following the pattern `R-NNN`. This enables precise referencing in CRPs, MRPs, and VCRs. When an agent flags a MentorScript violation or when a coach reviews compliance, both parties can point to the exact rule.

### Severity Levels

| Severity      | Meaning                                                              |
|---------------|----------------------------------------------------------------------|
| **mandatory** | Must be followed. Violation is a gate failure. No exceptions without a VCR. |
| **recommended** | Should be followed. Agent may deviate with documented rationale in the MRP. |

### Applies-To Scope
Rules can be scoped to specific contexts:
- **global** — Applies to all missions and all code
- **language:{lang}** — Applies only when working in a specific language
- **module:{name}** — Applies only to a specific module or directory
- **phase:{name}** — Applies only during a specific LoopScript phase

## Template

The MentorScript template is located at:
```
skills/atme/templates/mentor-script.md
```

MentorScripts use YAML frontmatter for metadata and markdown for rules.

## Rule Format

Each rule follows this structure:

```
### R-NNN: Rule Title

**Severity:** mandatory | recommended
**Applies-to:** global | language:typescript | module:auth | phase:implementation

Description of the rule. Be specific and actionable. Include examples of
correct and incorrect behavior where helpful.
```

Example rules:

```
### R-001: No secrets in source code

**Severity:** mandatory
**Applies-to:** global

Never commit API keys, passwords, tokens, or other secrets to source code.
Use environment variables or a secrets manager. If a secret is needed during
development, document it in a .env.example with placeholder values.

### R-002: Error handling must be explicit

**Severity:** mandatory
**Applies-to:** language:typescript

Never use empty catch blocks. Every catch must either handle the error
meaningfully, wrap and re-throw it, or log it with sufficient context.

BAD:  try { ... } catch (e) { }
GOOD: try { ... } catch (e) { throw new AuthError('Login failed', { cause: e }); }

### R-003: Prefer composition over inheritance

**Severity:** recommended
**Applies-to:** global

Use composition and interfaces rather than deep inheritance hierarchies.
Deviation is acceptable when the domain model naturally forms an is-a
relationship (document rationale in MRP).
```

## Global MentorScript

The project-wide MentorScript lives at:
```
mentorscripts/global.md
```

This file is loaded by every agent at startup (referenced from the root MentorScript in `CLAUDE.md`). It contains rules that apply across all missions. Mission-specific rules can be added via additional MentorScripts referenced in the BriefingPack.

## Team MentorScript

The team-specific MentorScript lives at:
```
mentorscripts/team.md
```

This file defines team roles (Author, Contributor, Approver, Reviewer, Dispatcher), review policies (`any-1`, `any-2`, `all`), CRP routing rules, the authorization matrix for BP status transitions, stale lock policies, branch conventions, and commit prefix conventions. It is loaded alongside `global.md` and governs multi-agent collaboration workflows.

All artifacts use 12-character hex hash IDs (generated via `openssl rand -hex 6`) instead of the former sequential `TYPE-YYYY-MMDD-NNN` pattern.

## Creating and Maintaining MentorScripts

### When to add a rule
- A CRP resolution reveals a decision that should apply to future missions
- A code review finds a recurring issue across missions
- A new team convention is established
- A security or compliance requirement is introduced

**Note on Inline CRPs:** Only formal CRPs that produce a file (blocking or deferred mode) can be generalized into MentorScript rules. Inline CRPs — resolved conversationally without creating an artifact — have no auditable record and therefore cannot be referenced or generalized via `/resolve-crp`. If a pattern from an inline CRP warrants a rule, a formal CRP must be filed retroactively.

### When to update a rule
- The rule is too vague and agents interpret it inconsistently
- The rule conflicts with a newer convention
- The technology or framework it references has changed

### Rule lifecycle
1. **Proposed** — A new rule is drafted (often from a CRP generalization via `/resolve-crp`)
2. **Active** — The rule is in the MentorScript and enforced
3. **Deprecated** — The rule is marked as no longer applicable (keep for audit trail, add deprecation note)

### Best practices
- Keep rules atomic — one concept per rule
- Include examples of both correct and incorrect behavior
- Reference external documentation where applicable
- Use mandatory sparingly — too many mandatory rules create excessive CRPs
- Review MentorScripts periodically to prune outdated rules
- When a rule is added from a CRP, include the CRP ID in the rule description for traceability

## MentorScript Compliance in MRPs

When an agent submits an MRP, the "SE Hygiene" criterion includes MentorScript compliance. The agent must:
1. List all applicable MentorScript rules
2. Confirm compliance or document justified deviations
3. Reference the rule IDs for any flagged items

The quality-gate agent can automatically check compliance against mandatory rules during `/review-mrp`.
