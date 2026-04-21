---
name: "BriefingEng"
description: "Briefing Engineering — Creating and managing Agents"
---

# Skill: BriefingEng — Briefing Engineering

## Purpose

Briefing Engineering is the discipline of translating human intent into structured, actionable BriefingPacks (BPs). A well-crafted BP is the single most important factor in mission success — it gives an AI Teammate everything it needs to execute autonomously while knowing exactly when to escalate.

## Key Concepts

### BP Identification (Hash-Based IDs)

BriefingPacks use 12-character hex hash IDs generated with:
```bash
openssl rand -hex 6
```
Example: `a1b2c3d4e5f6`

BPs are stored as `brief.md` inside a directory named `{hash}-{slug}`:
```
artifacts/briefings/{hash}-{slug}/brief.md
```

The **slug** is a required field -- a human-readable short name (2-4 words, lowercase, hyphens) derived from the mission title. Pattern: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Examples: `auth-refactor`, `db-migration-postgres`, `api-rate-limiting`.

The slug is used in:
- Directory name: `a3f7c2e1b9d4-auth-refactor/brief.md`
- Display output: `bp:a3f7c2 (auth-refactor)`
- INDEX.md listing

When creating a BP, always derive the slug from the mission title before creating the directory. Hash IDs are used in all references, commit messages, branch names, and cross-artifact links.

### Goal & Why
Every BP starts with a clear statement of **what** must be accomplished and **why** it matters. The "why" prevents the agent from making technically correct but strategically wrong decisions. A goal without motivation leads to brittle implementations.

### Acceptance Criteria (ACs)
The verifiable checklist that defines "done." Each criterion must be binary — either it passes or it does not. Vague criteria like "performs well" or "is clean" are not acceptable. Good ACs are specific, measurable, and testable:
- BAD: "The API should be fast"
- GOOD: "GET /users responds in < 200ms at p95 with 1000 concurrent connections"

### Context Mapping
Providing the agent with precise orientation: which files, modules, APIs, and patterns are relevant. The more specific the context, the fewer CRPs the agent needs to raise. Always include concrete file paths, not just module names.

### Constraints
Human-authored, binding boundaries that the agent **must not** cross without raising a CRP. Constraints define what is off-limits, required technologies, performance budgets, compatibility requirements, and non-negotiable architectural decisions. If an agent needs to deviate from a Constraint, it **must** create a CRP first — autonomous deviation is never permitted.

### Approach
The recommended implementation path, ordering, and techniques. An Approach may be proposed by the agent during drafting or authored by the human. Unlike Constraints, an agent **may** deviate from the Approach if it discovers a better path — but must justify the deviation in the MRP with concrete reasoning.

### Gotchas
Known pitfalls, edge cases, tech debt, and fragile areas. Each gotcha documented here is a CRP prevented. Think of this as institutional knowledge transfer.

### Artifacts (Inputs & Outputs)
Optional, machine-readable declarations of what a BP consumes (`input`) and produces (`output`). This enables traceability visualization across the entire BP hierarchy — you can trace which BP produced a given file and which BPs depend on it.

Each artifact entry has:
- **path** (required): Relative path from project root to the file or directory.
- **direction** (required): `input` or `output`.
- **ac** (optional): Reference to the Acceptance Criterion requiring this output (e.g. `AC-1`). Only meaningful for outputs.
- **description** (optional but recommended): Short description of the artifact.

**Rules:**
- Leaf BPs declare their own artifacts. Parent BPs do not — their children do.
- Outputs are extracted from Acceptance Criteria. The pattern `Output: \`filename\` in \`directory/\`` maps to a structured artifact entry.
- Inputs come from Context sections, "Input Artifacts" body sections, or cross-BP dependencies.
- The field is optional and backward-compatible — BPs without it remain valid.

### Escalation Triggers
Explicit situations where the agent must create a CRP instead of guessing. These go beyond the standard structural CRP triggers (API/schema changes, security implications, scope deviation, cross-scope reversal, multi-approach ambiguity, data-destructive operations, dependency changes, observable behavior changes) to include domain-specific triggers unique to this mission.

### Team Authoring Workflow

BriefingPacks support multi-author collaboration:
- **Author**: Creates the initial draft. Multiple authors may contribute sections.
- **Contributor**: Adds context, gotchas, or constraints to an existing draft.
- **Approver**: Reviews and transitions the BP from `draft` to `ready`. Only the designated Approver can make this transition.

The `authored-by`, `contributors`, and `approved-by` fields in the BP frontmatter track who participated. See `mentorscripts/team.md` for role definitions and the authorization matrix.

## Template

The BriefingPack template is located at:
```
skills/briefing-eng/templates/briefing-pack.md
```

Use this template for all new BPs. The template uses YAML frontmatter for metadata and markdown sections for content.

## Quality Criteria for Good BriefingPacks

A BP is **ready for dispatch** when it meets all of these:

1. **Specific ACs** — Every acceptance criterion is binary and testable. No ambiguity about what "done" means.
2. **Clear Scope** — The boundary of what is in-scope and out-of-scope is explicit. The agent should never wonder "is this part of my mission?"
3. **Identified Risks** — Gotchas and escalation triggers cover the known unknowns. The agent has a map of where dragons live.
4. **Sufficient Context** — File paths exist, module references are correct, API docs are linked or summarized.
5. **Clear Constraints** — Binding boundaries are explicit and distinguishable from suggested approaches. The agent knows what it must not violate versus what it may adapt.
6. **Correct Metadata** — Hash ID is valid (12-char hex), slug is valid (lowercase, hyphens, 2-4 words), LoopScript and MentorScripts are referenced and exist.

## Workflow

```
Draft → Review → Ready → Dispatched (leaf BPs only)
```

**Tier 2:** `/brief` -> agent drafts -> human reviews -> auto-dispatch
**Tier 3:** `/brief --full` -> interactive 7-step -> manual dispatch

1. **Draft**: Initial creation via `/brief --full` (Tier 3) or `/brief` (Tier 2). Status is `draft`. The BP may be incomplete or have vague sections. A hash ID is generated via `openssl rand -hex 6`, a slug is derived from the mission title, and the BP is stored at `artifacts/briefings/{hash}-{slug}/brief.md`.
2. **Review**: The Agent Coach reviews all sections. ACs are sharpened, context is verified, gotchas are added. Edit via `/brief {hash}`.
3. **Ready**: All quality criteria are met. The Approver transitions status to `ready`. The BP can now be dispatched via `/dispatch` (Tier 3) or auto-dispatched (Tier 2).

**Parent BPs**: When a BP is split into child BPs, its status is automatically **derived** from its children (not stored in frontmatter). Parent BPs cannot be dispatched — only their leaf descendants are.

## Scope Assessment

Every BP must be scoped to fit within a single agent execution. The Briefing Engineer **must** assess scope proactively after capturing the mission goal — before writing acceptance criteria.

### Sizing Heuristics

| Indicator | Single BP OK | Consider splitting |
|-----------|-------------|-------------------|
| Files to analyze/modify | ≤ 20 | > 20 |
| Lines of code in scope | ≤ 5.000 | > 5.000 |
| Distinct deliverables | ≤ 3 | > 3 |
| Estimated agent context loads | ≤ 5 file reads | > 15 file reads |
| Independent sub-goals | 1 | > 1 clearly separable goals |

When a mission exceeds these thresholds, the Briefing Engineer must:
1. Inform the Agent Coach that the scope is too large for reliable execution
2. Propose a concrete breakdown into smaller BPs with dependencies and ordering
3. Get confirmation before proceeding

### Hierarchical Decomposition (Directory-Based)

BriefingPacks support arbitrary nesting depth via directory structure. When a mission is too large:

1. Child BPs are created as `brief.md` files inside subdirectories of the parent's hash directory. The parent BP's status is automatically derived from its children — no manual status change needed.
2. Each child gets its own hash ID (generated via `openssl rand -hex 6`)
3. The parent BP's frontmatter includes an `execution-order` list that defines the sequence in which children should be dispatched
4. Children inherit the parent's **Shared Context** — information that applies to all descendants
5. Only **leaf BPs** (without children) are dispatched to agents
6. A parent BP's ACs are met when all children are completed

**Directory structure:**
```
artifacts/briefings/{parent-hash}-{parent-slug}/
  brief.md                                        # Parent BP (status derived from children, has execution-order)
  {child-hash-1}-{child-slug-1}/
    brief.md                                      # Child BP (leaf or further parent)
  {child-hash-2}-{child-slug-2}/
    brief.md                                      # Child BP
```

**`execution-order` field (parent frontmatter):**
```yaml
execution-order:
  - a1b2c3d4e5f6    # First child
  - f6e5d4c3b2a1    # Second child (depends on first)
  - 112233445566    # Third child (depends on second)
```

This replaces the former `parent:`, `children:`, and `depends-on` fields. The directory nesting itself encodes the parent-child relationship, and `execution-order` encodes sequencing.

Dependencies can reference any BP in the system, not just siblings within the same parent. This enables cross-tree coordination (e.g., a BP in project A depending on a BP in project B completing first).

Agents MUST read the full ancestor chain (all `brief.md` files up the directory tree) before starting a leaf BP.

**Decomposition rules:**
- Each child must be independently executable and produce a usable deliverable
- Earlier children should produce artifacts that later children can reference
- A typical pattern: Inventory/Overview -> Deep Analysis -> Consolidation/Synthesis
- Decomposition creates a VCR entry documenting the split rationale

## Anti-Patterns

- **The Kitchen Sink BP**: Too many goals in one BP. The Scope Assessment step exists to catch this early — if a BP triggers "red" on sizing heuristics, it must be split before proceeding.
- **The Wishful BP**: ACs describe desired outcomes but not verifiable conditions.
- **The Context-Free BP**: No file paths, no module names, just abstract descriptions.
- **The Over-Prescribed BP**: So detailed that the agent has no room for engineering judgment. Strategy should guide, not dictate every line of code.
