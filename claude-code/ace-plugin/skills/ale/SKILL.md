---
name: "ALE"
description: "Agentic Loop Engineering — Designing and optimizing LoopScripts"
---

# Skill: ALE — Agentic Loop Engineering

## Purpose

Agentic Loop Engineering is the discipline of designing SOPs (Standard Operating Procedures) that AI Teammates follow phase by phase. A LoopScript defines the execution plan: what happens in each phase, what gate must be passed before proceeding, and when to escalate. Well-designed LoopScripts ensure predictable, auditable agent behavior.

## Key Concepts

### Agent Worktree Workflow

Each agent executes in its own **git worktree** — an isolated working directory with its own branch. This enables parallel agent execution while the main workspace stays on `main`.

**Branch:** `agent/{agent-id}/{bp-hash}`
**Worktree:** `.worktrees/{agent-id}-{bp-hash}/`

**Lifecycle:**
1. **Claim**: Agent creates the worktree + branch (`git worktree add`) and records a `claim()` commit. This sets the lock.
2. **Heartbeat**: Agent periodically commits `heartbeat()` (every 60 minutes by default) from within the worktree to signal it is still active.
3. **Complete**: Agent finishes work and commits `complete()`.
4. **Merge**: On approval, the branch is merged to main, then the worktree is removed and branch deleted.

**Stale Detection:**
- A lock is considered **stale** if no commit (including heartbeat) has occurred within 3 hours.
- Exception: agents blocked on a CRP (`mode: blocking`) are exempt from stale detection.
- Stale locks can be released via `/status release` (removes worktree, preserves branch for audit).

See `mentorscripts/team.md` for the full worktree/branch convention and commit prefix table.

### Phases
A LoopScript is a sequence of named phases, each with a clear objective and defined outputs. Phases are executed **strictly sequentially** — an agent must never skip ahead or work on multiple phases in parallel. Each phase represents a coherent unit of work.

Typical phase progression:
1. **Orientation** — Read and understand the BP, map the codebase, identify affected areas.
2. **Planning** — Design the approach, break down into steps, identify risks.
3. **Implementation** — Write the code, create the artifacts.
4. **Verification** — Run tests, check ACs, verify MentorScript compliance.
5. **Documentation** — Update docs, write rationale, prepare MRP.

### Gates
Each phase ends with a gate — a condition that must be met before the agent proceeds. Gates are the quality checkpoints of the LoopScript. If a gate fails, the agent must either retry the phase or escalate via CRP.

Gate examples:
- Orientation gate: "All referenced files from BP exist and are readable"
- Planning gate: "Every AC has a corresponding implementation step"
- Implementation gate: "Code compiles without errors"
- Verification gate: "All tests pass and every AC is checked off"

### Escalation Rules
LoopScripts define when an agent must pause and create a CRP. These augment the standard CRP triggers from the root MentorScript with phase-specific rules. For example, during the Planning phase, an escalation might trigger if the estimated scope exceeds what the BP describes.

### N-Version Verification
For high-rigor missions, the LoopScript can specify that multiple agents execute independently. Each agent follows the same LoopScript but produces an independent implementation. The results are compared via `/compare` to catch design blind spots.

## Template

The LoopScript template is located at:
```
skills/ale/templates/loop-script.yaml
```

LoopScripts are pure YAML (no markdown body). They live in `skills/ale/loops/` when instantiated.

## Pre-Built LoopScripts

### standard.yaml
The default LoopScript for most missions. Five phases (Orientation, Planning, Implementation, Verification, Documentation) with standard gates. Suitable for `rigor: standard` missions.

### high-rigor.yaml
Extended LoopScript for critical missions. Adds phases for threat modeling, independent review, and N-Version comparison. Includes stricter gates (e.g., mutation testing threshold, security scan). Suitable for `rigor: high` missions.

## Design Principles

1. **Every phase has a clear gate.** No phase ends with "continue when you feel ready." Gates are objective and verifiable.

2. **Uncertainty triggers CRP.** If an agent cannot pass a gate after a reasonable attempt, it must escalate rather than produce low-confidence work.

3. **Phases are sequential.** No parallelism within a single agent's execution. This ensures a clean audit trail and prevents the agent from context-switching between incomplete tasks.

4. **Phases are scoped.** Each phase has a bounded objective. If a phase is doing too much, split it.

5. **Gates are cumulative.** Later gates assume earlier gates passed. The Verification phase assumes the Implementation phase produced compilable code.

6. **LoopScripts are reusable.** Design them for a class of missions, not a single mission. Mission-specific details belong in the BP, not the LoopScript.

## LoopScript YAML Structure

```yaml
schema: sase/loop-script/v1
id: "LS-standard"
name: "Standard Execution Loop"
version: "1.0"
phases:
  - name: "orientation"
    objective: "Understand the mission and map the codebase"
    inputs: ["briefing-pack", "mentor-scripts"]
    outputs: ["context-map"]
    gate:
      condition: "All BP references verified, context map complete"
      on-failure: "retry"
    max-retries: 2
  - name: "planning"
    objective: "Design the implementation approach"
    inputs: ["context-map", "briefing-pack"]
    outputs: ["implementation-plan"]
    gate:
      condition: "Every AC has a mapped implementation step"
      on-failure: "crp"
    max-retries: 1
  # ... additional phases
escalation:
  default-urgency: "medium"
  triggers:
    - condition: "api-or-schema-change"
      action: "crp"
    - condition: "security-implication"
      action: "crp"
    - condition: "scope-change-detected"
      action: "crp"
      urgency: "high"
```

## LoopScript Visibility by Tier

The visibility and management of LoopScripts depends on the mission tier:

| Tier | LoopScript Behavior |
|------|---------------------|
| **Tier 1** | No LoopScript referenced. The agent follows phases internally (orient, implement, verify) without exposing phase structure to the human. |
| **Tier 2** | Auto-selected based on `rigor` level. The LoopScript exists and governs execution, but is invisible to the human — no manual selection or editing. |
| **Tier 3** | Full LoopScript with visible gates. The Agent Coach can inspect, customize, and monitor phase transitions. Gate pass/fail is reported explicitly. |

## Automated Gates

Phases can define a `gate-command` field — a shell command that must exit 0 for the gate to pass. This enables objective, automated gate verification alongside the descriptive `condition` field.

```yaml
phases:
  - name: "implement"
    objective: "Write the code changes"
    gate:
      condition: "Code compiles and all tests pass"
      gate-command: "npm test"
      on-failure: "retry"
  - name: "self-review"
    objective: "Lint and static analysis"
    gate:
      condition: "No lint errors or type violations"
      gate-command: "ruff check"
      on-failure: "crp"
  - name: "formal-verify"
    objective: "Type-check the entire project"
    gate:
      condition: "No TypeScript errors"
      gate-command: "tsc --noEmit"
      on-failure: "crp"
```

**Gate-commands are MANDATORY when defined.** The executor MUST run every `gate-command` via Bash and only proceed if exit code is 0. This is not optional and self-assessment alone is never sufficient when a gate-command exists. If the command fails, the agent follows the `on-failure` strategy (retry or CRP). If no `gate-command` is defined for a phase, the agent notes "no automated gate available" in the MRP under the relevant criterion (Sound Verification for test gates, SE Hygiene for lint gates). The descriptive `condition` remains for human readability and audit.

## When to Create a Custom LoopScript

Use a custom LoopScript when:
- The mission requires domain-specific phases (e.g., data migration, infrastructure provisioning)
- The standard gates are insufficient (e.g., compliance requirements)
- The phase ordering must differ from the standard progression
- Additional verification steps are needed beyond standard testing

Always base custom LoopScripts on the template and standard.yaml as starting points.
