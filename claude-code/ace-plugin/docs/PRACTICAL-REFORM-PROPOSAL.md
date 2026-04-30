# i-SASE Practical Reform Proposal

> **Historical document.** Most reforms below (3-tier system, inline/deferred CRPs, agent-drafted BPs, collapsed command surface, risk-proportional MRP review) are now implemented. Kept as reference for the design rationale.

## From Academic Framework to Daily Practice

> Result of a multi-perspective analysis: Practitioner critique, framework
> comparison (10+ alternatives), agent autonomy research, and UX redesign.
> Based on 50+ sources from 2025-2026 research and industry practice.

---

## The Diagnosis

The i-SASE framework is the **most governance-heavy** approach in the current
landscape of human-AI collaboration tools. Its intellectual foundations are
sound. Its CRP/VCR/MRP audit system is unique and unmatched. But it applies
the same ceremony to a 5-minute bug fix and a 100,000-LOC COBOL migration.

**The numbers tell the story:**

| Scenario | Current i-SASE | Just Using Claude Code | Overhead |
|----------|---------------|----------------------|----------|
| Fix a bug | ~15 interactions, 2+ artifacts, 12-16 min before code | 1 prompt, ~15 sec | 8-10x |
| Add a feature | ~20 interactions, 4+ artifacts | 2-3 prompts with plan mode | 5-7x |
| Large migration | ~25+ interactions, full ceremony | Chaos (no structure) | **SASE wins** |

**The core problem is not the ideas -- it's the granularity.** The solution
is not to remove governance but to make it **adaptive**: invisible for simple
tasks, proportional for standard work, full ceremony for high-stakes missions.

---

## The Competitive Landscape

SASE sits at the far right of a structure spectrum. Aider (pure chat) and
Claude Code (CLAUDE.md + plan mode) are minimal. Cursor (rules files) and
Kiro (3-file specs) are moderate. BMAD (8 agent personas, PRD-first) is
heavy. SASE (6 artifact types, 4 agents, CRP/VCR/MRP) is the heaviest.

**The emerging consensus:** Risk-proportional structure. Deeper verification
only when stakes are high.

### What SASE Has That No One Else Does (Keep)

- **CRP** -- Only framework with formal agent-to-human escalation
- **VCR** -- Only framework with immutable decision audit trail
- **MRP with 5 scored criteria** -- Only framework with structured evidence packages
- **Hierarchical BP decomposition** -- Best-in-class task breakdown
- **MentorScript rules** -- Stronger than CLAUDE.md or AGENTS.md patterns

### What Others Do Better (Adopt)

- **Agent-drafted specs** (Kiro, Copilot Workspace) -- agent proposes, human validates
- **Automatic risk classification** (Devin, Kiro) -- system selects ceremony level
- **Inline questions** (Claude Code, Cursor) -- no file for synchronous questions
- **Auto-approval** (Stripe Minions) -- low-risk work skips human review
- **Progressive autonomy** (Anthropic research) -- trust grows with track record

---

## The 7 Concrete Reforms

### Reform 1: Three-Tier Task System

Replace the one-size-fits-all ceremony with risk-proportional tiers.

#### Tier 1: QUICK

For small, reversible, well-defined tasks (bug fixes, test additions, refactors).

- **Entry:** `/do <natural language description>`
- **What happens:** Agent infers a mini-spec (goal, plan, escalation boundaries),
  presents a 3-line confirmation. Human says Y or adjusts.
- **No BP file.** No dispatch step. No formal MRP review.
- **Audit trail:** Conversation + compact inline summary at completion.
- **MentorScript rules still apply** (tests, security, error handling).
- **Auto-upgrades** to Tier 2 if agent detects security, multi-file scope,
  or architectural implications.
- **Human effort: 2 interactions** (describe + confirm).

#### Tier 2: STANDARD

For features, module-level changes, moderate complexity.

- **Entry:** `/brief <description>`
- **What happens:** Agent **drafts a complete BP** by analyzing the codebase.
  Human reviews the whole thing at once and makes targeted corrections.
  On approval, dispatch is automatic (no separate command).
- **BP file persisted** to `artifacts/briefings/` for audit trail.
- **MRP produced** with auto-scoring. Quick review unless score < 80.
- **Inline CRPs** for non-critical questions. Formal CRPs only for
  security and irreversibility.
- **Key shift:** Human reviews and corrects rather than authoring from scratch.
  The 7-step interview becomes a single review-and-adjust cycle.
- **Human effort: 4-6 interactions** (describe + review draft + approve +
  answer Qs + approve MRP).

#### Tier 3: MISSION

For critical changes, large migrations, multi-agent coordination.

- **Entry:** `/brief --full` or auto-upgrade when scope assessment hits Red
  (>20 files, >5000 LOC, >3 deliverables).
- **What happens:** Current full 7-step interactive briefing, preserved as-is.
  Hierarchical decomposition. Separate dispatch. Full MRP audit.
- **This tier exists for the 10-20% of tasks that genuinely need it.**
- **Human effort: 25+ interactions** (justified by the stakes).

#### Tier Selection (Automatic)

| Signal | QUICK | STANDARD | MISSION |
|--------|-------|----------|---------|
| Estimated files | 1-5 | 5-20 | >20 |
| Estimated LOC | <500 | 500-5000 | >5000 |
| Security involved | No | No | Yes |
| API/schema changes | No | Minor | Major |
| Human override | always available | always available | always available |

---

### Reform 2: LoopScripts Become Invisible

**Problem:** Humans must select or author LoopScript YAML before work starts.

**Reform:** LoopScripts become internal implementation details.

- **Tier 1:** Agent follows phases internally. Invisible to human.
- **Tier 2:** Agent proposes a plan (derived from standard phases).
  Human approves the plan, not the LoopScript.
- **Tier 3:** Full LoopScript with gates, visible and auditable. But even
  here: agent proposes, human approves/modifies.

The existing `standard.yaml` and `high-rigor.yaml` remain as internal
templates. No new LoopScripts need to be written by humans.

---

### Reform 3: Context-Appropriate Escalation (Replace Blocking CRPs)

**Problem:** All CRPs block execution. Agent idles while human is unavailable.

**Reform:** Three CRP modes based on significance.

**Blocking CRP** (for security, irreversibility, scope expansion):
Agent pauses. Human must respond. Preserved as-is.

**Deferred CRP** (for ambiguities and gray areas):
Agent makes a provisional decision, marks it clearly, continues working.
Human reviews during MRP review and can overturn.

**Inline CRP** (for synchronous sessions):
Agent asks inline with compact format. No file created for low-significance
questions. Human types a letter and agent continues.

**Replace the 70% confidence threshold** with structural triggers:
1. Affects API contract, database schema, or public interface?
2. Involves authentication, authorization, or cryptography?
3. Contradicts or goes beyond the BriefingPack?
4. Multiple valid approaches with different tradeoffs?
5. Reversing requires touching files beyond current scope?

If any is yes: escalate. This is deterministic, not self-assessed.

---

### Reform 4: Collapse the Command Surface

**Current:** 6 commands. **Reformed:** 3 primary + on-demand.

| Primary Command | What It Does | Replaces |
|----------------|-------------|----------|
| `/do <desc>` | Tier 1: describe, confirm, execute | `/ace-brief` + `/ace-dispatch` (simple) |
| `/brief <desc>` | Tier 2/3: draft BP, review, dispatch | `/ace-brief` + `/ace-dispatch` (complex) |
| `/status` | Open CRPs, pending MRPs, active missions | `/ace-dashboard` |

On-demand: `/review`, `/answer`, `/compare` -- shown by `/status` only when relevant.

Batch resolution from `/status`: resolve multiple CRPs and MRPs in one line.

---

### Reform 5: Risk-Proportional MRP Review

**Tier 1 (from `/do`):** Inline summary. No MRP file. No VCR.

**Tier 2:** Compact review with auto-scoring (one line per criterion).
Human says "approve" and VCR is auto-created.

**Auto-approval** (configurable): When score >= 90, no security changes,
all tests pass -- auto-approve with notification.

**Tier 3:** Full 5-criteria audit. Preserved as-is.

---

### Reform 6: Split "Strategy" into "Constraints" + "Approach"

**Constraints** (human-authored, always binding): Business rules, technology
mandates, performance budgets, organizational context.

**Approach** (agent-proposed or human-authored, optional): Implementation
strategy. If human has no preference, agent proposes during Plan phase.

**Human defines strategy when:** Business context, cross-system architecture,
technology mandates, hard constraints.

**Agent determines strategy when:** Implementation patterns, file organization,
test approach, refactoring sequence.

---

### Reform 7: Enforce Gates with Tooling

**Current:** Self-assessed gates (agent checks itself).
**Reformed:** Deterministic automated checks.

| Gate | Self-assessed (current) | Automated (reformed) |
|------|------------------------|---------------------|
| IMPLEMENT | "Tests pass?" | Run test suite, must exit 0 |
| SELF-REVIEW | "Would I approve?" | Run linter, must exit 0 |
| PACKAGE | "MRP complete?" | Schema validation |
| SCOPE | "Within BP scope?" | Diff must match declared files |

---

## Autonomy Modes

Replace binary standard/high-rigor with four modes.

### AUTOPILOT

For routine, well-understood tasks. Internal planning, CRPs only for
security/irreversibility, lightweight MRP, auto-approve eligible.
Scope limit: <20 files. Auto-escalates if exceeded.

### SUPERVISED (default)

For standard development. Agent proposes plan, human approves. Deferred
CRPs for non-critical items. Full MRP with auto-scoring. Human reviews.

### GUARDED

For critical changes. Full LoopScript with explicit gates. All CRPs
blocking. Full MRP audit. N-Version available. Threat modeling mandatory.

### COLLABORATIVE

For exploration and prototyping. Conversation-driven, no fixed plan.
CRPs replaced by direct conversation. Time-boxed. No production merges.

### Progressive Trust

| Level | After | Default Mode |
|-------|-------|-------------|
| New | First mission | SUPERVISED |
| Established | 5 successes | SUPERVISED (AUTOPILOT available) |
| Trusted | 20 missions, >80% acceptance | AUTOPILOT |

**Never changes:** Security CRPs, MentorScript rules, MRP production.

---

## What We Keep, What We Change, What We Drop

### Always Keep

- MentorScript rules (enforced in all tiers/modes)
- CRPs for security and irreversibility
- MRP production (even if lightweight)
- LoopScript phases internally
- Hierarchical BP decomposition for large tasks

### Change

| Current | Reformed |
|---------|----------|
| Human authors BPs from scratch | Agent drafts, human validates |
| Human selects LoopScripts | Agent proposes plan |
| All CRPs block | Block / deferred / inline modes |
| 70% confidence threshold | Structural triggers |
| 6 commands | 3 primary + on-demand |
| Every MRP gets full review | Risk-proportional review |
| "Strategy" section | "Constraints" + "Approach" |
| Self-assessed gates | Automated gates |

### Drop (opt-in for regulated environments)

- Formal BP file for Tier 1 tasks
- Separate dispatch command
- VCR for every approval
- VCR for low-significance CRPs
- N-Version for standard missions

---

## Implementation Priority

**Phase 1 -- Reduce Friction (implement first):**
1. `/do` command (Tier 1 quick tasks)
2. Agent-drafted BPs for `/brief` (Tier 2)
3. Auto-dispatch on BP approval
4. Inline CRPs for synchronous sessions

**Phase 2 -- Smarter Escalation:**
5. Structural triggers replacing 70% threshold
6. Deferred CRPs (flag-and-continue)
7. Auto-approval for MRPs

**Phase 3 -- Progressive Autonomy:**
8. Autonomy mode selection
9. Mission success tracking
10. Automated gates (lint/test runners)

**Phase 4 -- Polish:**
11. Collapsed command surface
12. Batch CRP/MRP resolution
13. "Constraints" + "Approach" split

---

## The Principle

> **The framework should disappear for simple tasks and surface
> proportionally for complex ones. The agent carries the framework
> internally at all times. The human interacts with ceremony only
> when the stakes justify it.**

| Current | Reformed |
|---------|----------|
| Same ceremony for everything | Risk-proportional tiers |
| Human authors everything | Agent proposes, human validates |
| All CRPs block | Block only for security/irreversibility |
| 6 commands to learn | 3 primary commands |
| Every result needs review | Auto-approve when conditions met |
| 80% overhead for simple tasks | Near-zero overhead for simple tasks |
| Reserved for structured missions | **Usable every day, on every task** |

---

*Based on research from: Anthropic (Agentic Coding Trends 2026, Measuring
Agent Autonomy), Stripe (Minions), Amazon (Kiro), GitHub (spec-kit, Copilot
Workspace), BMAD, SuperClaude, OpenHands, SWE-agent, AGENTS.md (Linux
Foundation), METR (AI Productivity Study), Stack Overflow (2025 Survey),
and 30+ additional sources from 2025-2026.*
