---
schema: sase/mentor-script/v1
id: MS-global-v1
applies-to: all
---

# Global MentorScript

This MentorScript contains the fundamental rules that apply to all missions.
It is automatically included in every mission.

---

## Mandatory Rules

### R-001: Test Coverage

**Severity:** mandatory

Every new function requires tests. No implementation without corresponding unit or integration tests. Existing tests must not be removed or disabled without justification.

- New functions: at least unit tests for the happy path and important edge cases
- Bug fixes: at least one regression test that reproduces the bug
- Refactoring: existing tests must continue to pass

### R-002: Error Handling

**Severity:** mandatory

Never silently swallow exceptions. Every error must either be handled correctly, logged meaningfully, or deliberately propagated upward.

- No empty catch blocks without a documented reason
- Error messages must be descriptive and context-rich
- Prefer fail-fast where appropriate

### R-003: Security

**Severity:** mandatory

No secrets in code or logs. Security-relevant decisions always require a CRP.

- No passwords, API keys, or tokens in source code
- No secrets in log output (not even masked)
- Input validation at all trust boundaries
- When uncertain about security implications: create a CRP

### R-004: Code Review

**Severity:** mandatory

Own code is always self-reviewed. Before creating the MRP, the agent must critically review their own code as if they were an external reviewer.

- Check for correctness, readability, and maintainability
- Check for unintended side effects
- Check for compliance with all other MentorScript rules

### R-030: CRP Creation (Structural Triggers)

**Severity:** mandatory

When facing any of the following structural triggers, a CRP must be created.
These are deterministic checks, not self-assessed confidence levels.
CRP IDs use 12-char hex hashes (generated via `openssl rand -hex 6`).

1. **API/Schema/Interface** -- Change affects API contract, database schema, or public interface. Mode: blocking.
2. **Security** -- Involves authentication, authorization, or cryptography. Mode: blocking.
3. **Scope deviation** -- Contradicts or goes beyond the BriefingPack. Mode: blocking.
4. **Cross-scope reversal** -- Reversing requires touching files beyond current scope. Mode: blocking.
5. **Multi-approach ambiguity** -- Multiple valid approaches with significant tradeoffs and no BP guidance. Mode: deferred.
6. **Data-destructive operation** -- Changes that could cause data loss, silent corruption, or irreversible state changes. Mode: blocking.
7. **Dependency change** -- Adding, removing, or upgrading (major version) any external dependency. Mode: deferred.
8. **Observable behavior change** -- Modifying user-visible output, error messages, log formats, or response structure not explicitly specified by the BP. Mode: deferred.

**CRP Mode selection:**
- Triggers 1-4, 6: `mode: blocking` (agent pauses and waits)
- Triggers 5, 7, 8: `mode: deferred` (agent makes provisional decision, continues)
- Synchronous low-significance questions: `mode: inline` (no file created)

**CRP routing:** Set the `routed-to` field per the routing table in `mentorscripts/team.md`.
**Agent identification:** Set the `raised-by` field to the agent's ID.

Guessing is not an acceptable alternative to a blocking CRP.

### R-031: MRP Completeness

**Severity:** mandatory

All 5 criteria of the Mission Result Package must be addressed. An incomplete MRP will be rejected.

1. Functional Completeness — all ACs verified
2. Sound Verification — tests and evidence
3. SE Hygiene — linting, formatting, compliance
4. Clear Rationale — decisions documented
5. Full Auditability — traceable history

---

## Recommended Rules

### R-010: Commit Messages

**Severity:** recommended

Use Conventional Commits format on non-agent branches. On agent branches, use the SASE commit prefix convention.

**Non-agent branches (main, feature branches):**
- Format: `type(scope): description`
- Types: feat, fix, refactor, test, docs, chore
- Scope: affected module or area
- Reference artifact hashes: `feat(auth): implement login bp:a1b2c3d4e5f6`

**Agent branches (`agent/{agent-id}/{bp-hash}`, committed from within agent worktrees):**
- Format: `prefix(bp:{hash}): description [agent:{agent-id}]`
- Prefixes: `draft()`, `refine()`, `approve()`, `claim()`, `heartbeat()`, `complete()`, `merge()`, `release()`
- The `bp:{hash}` scope uses the 12-char hex BP hash (or 6-char abbreviation)
- The `[agent:{agent-id}]` tag is required for `claim()`, `heartbeat()`, and `complete()`
- See `mentorscripts/team.md` for the full prefix table

### R-011: Documentation

**Severity:** recommended

Public APIs need documentation. Every public interface should be documented so that other agents or developers can use it.

- Public functions: description, parameters, return values
- Public classes/modules: purpose and usage
- Configuration options: description and defaults

### R-020: DRY

**Severity:** recommended

Avoid code duplication. Repeated code should be extracted into shared functions, modules, or utilities.

- Same logic in multiple places: extract it
- Similar patterns: consider a shared abstraction
- But: no premature abstraction — prefer duplication over choosing the wrong abstraction
