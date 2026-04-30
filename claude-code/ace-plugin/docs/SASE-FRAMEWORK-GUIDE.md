# The SASE Framework: From Paper to Practice

## A Comprehensive Guide to Structured Agentic Software Engineering

> This document explains every concept from the SASE paper
> (Hassan et al., 2025, [arXiv:2509.06216](https://arxiv.org/abs/2509.06216))
> and shows exactly how each concept is implemented in this repository.

---

## Table of Contents

1. [Why SASE Exists](#1-why-sase-exists)
2. [The Big Picture: SE 3.0](#2-the-big-picture-se-30)
3. [The Fundamental Duality](#3-the-fundamental-duality)
4. [The Four Pillars](#4-the-four-pillars)
5. [The Actors: Who Does What](#5-the-actors-who-does-what)
6. [The Artifacts: Contracts Between Humans and Agents](#6-the-artifacts-contracts-between-humans-and-agents)
7. [The Workbenches: Where Work Happens](#7-the-workbenches-where-work-happens)
8. [The Engineering Activities: How Work Gets Done](#8-the-engineering-activities-how-work-gets-done)
9. [The Complete Workflow: A Mission From Start to Finish](#9-the-complete-workflow-a-mission-from-start-to-finish)
10. [Key Principles and Design Decisions](#10-key-principles-and-design-decisions)
11. [Repository Map](#11-repository-map)
12. [Glossary](#12-glossary)

---

## 1. Why SASE Exists

### The Problem: Speed Without Trust

AI coding agents (like Claude Code, Copilot, Devin) can produce code incredibly
fast. But speed alone is not enough. Research shows serious quality gaps:

- **29.6%** of plausible agent-generated fixes introduce regressions when
  rigorously retested
- True solve rates drop dramatically after manual audits (e.g. 12.47% down
  to 3.97%)
- Agents tend to produce superficial, single-file patches rather than
  holistic solutions
- Many patches pass unit tests but fail broader CI checks

**The core tension:** Agents are fast but not yet trustworthy enough for
unsupervised production work. Humans are trustworthy but cannot keep up
with the volume of agent output.

### The Solution: Structure

SASE bridges this gap not by slowing agents down, but by wrapping their
work in structured, auditable processes. Think of it like this:

- **Without SASE:** You paste a ticket into an AI chat, hope for the best,
  then spend hours reviewing a messy PR.
- **With SASE:** You write a clear mission brief, the agent follows a
  defined process, asks when uncertain, and delivers a structured evidence
  package proving its work meets your standards.

---

## 2. The Big Picture: SE 3.0

The paper defines a progression of AI capabilities in software engineering,
similar to self-driving car autonomy levels:

| Level | Name | What It Does | Examples |
|-------|------|-------------|----------|
| 1.0 | Token Assistance | Predicts the next few tokens | IDE auto-complete |
| 2.0 | Task-Agentic | Generates a code block from a description | Copilot, CodeWhisperer |
| **3.0** | **Goal-Agentic** | **Maps a technical goal to a multi-step plan and executes it** | **Claude Code, Devin** |
| 4.0 | Specialized Domain Autonomy | Deep expertise in a specific domain | Future |
| 5.0 | General Domain Autonomy | Expertise across all stacks | Theoretical |

**SASE focuses on Level 3.0** -- the current frontier where agents can
autonomously plan and execute multi-step tasks, but still need human
oversight for quality, safety, and strategic decisions. This is where we
are today, and where disciplined practices matter most.

---

## 3. The Fundamental Duality

The most important idea in SASE is the **Fundamental Duality**:

> Software engineering must now simultaneously serve two modalities:
> **SE for Humans (SE4H)** and **SE for Agents (SE4A)**.

What does this mean in practice?

| Aspect | SE4H (for Humans) | SE4A (for Agents) |
|--------|-------------------|-------------------|
| **Optimized for** | Human cognition, visual understanding | Computational speed, machine parsing |
| **Tools** | IDEs with GUIs, visual diff viewers | CLI tools, AST-based editors, raw APIs |
| **Communication** | Natural language, diagrams | Structured YAML/Markdown, schemas |
| **Workflow** | Flexible, judgment-based | Phase-gated, rule-driven |
| **Quality signals** | Code review by peers | Schema validation, automated gates |

The two modalities meet through **structured artifacts** -- documents that
both humans and agents can read, write, and act upon. These artifacts are
the contracts that make collaboration possible.

### How this repository implements the duality

- **SE4H side:** The `ACE` commands (`commands/`) provide
  a human-friendly interface for creating briefs, reviewing results, and
  making decisions
- **SE4A side:** The `AEE` -- agent definitions (`agents/`),
  LoopScripts (`skills/engineering/loops/`), and MentorScripts (`mentorscripts/`)
  -- provides machine-readable rules and processes for agents
- **Bridge:** All 6 artifact types use YAML frontmatter + Markdown, readable
  by both humans and machines, validated by JSON schemas (`skills/engineering/schemas/`)

---

## 4. The Four Pillars

SASE restructures software engineering around four classical pillars,
adapted for the age of AI agents:

```
                    ┌─────────────────────────────┐
                    │         SASE Framework       │
                    └─────────────────────────────┘
                                  │
          ┌───────────┬───────────┼───────────┬───────────┐
          │           │           │           │           │
     ┌────▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼─────┐
     │ Actors  │ │Process │ │ Tools  │ │Artifacts│
     │         │ │   es   │ │        │ │         │
     │ Coach + │ │ 6 Eng. │ │ACE+AEE│ │6 typed  │
     │Teammates│ │  Activ.│ │workb.  │ │documents│
     └─────────┘ └────────┘ └────────┘ └─────────┘
```

| Pillar | Paper Concept | Repository Implementation |
|--------|---------------|---------------------------|
| **Actors** | Agent Coach (human) + AI Teammates (agents) | `agents/` defines 4 agent roles; ACE commands are the coach's interface |
| **Processes** | 6 Engineering Activities | `skills/` implements 4 activities as Skills; 2 more are implied |
| **Tools** | ACE (human workbench) + AEE (agent workbench) | `commands/` = ACE; agents + loops + mentorscripts = AEE |
| **Artifacts** | 6 typed, schema-validated documents | `artifacts/` + `mentorscripts/` + `skills/engineering/schemas/` |

---

## 5. The Actors: Who Does What

### The Agent Coach (Human)

The Agent Coach is the human in the loop. Think of this role as a
**team lead who manages a team of AI developers**. The coach does not
write code directly (though they can). Instead, they:

1. **Write mission briefs** -- Clear descriptions of what needs to be done
2. **Dispatch missions** -- Assign work to the right agent(s)
3. **Answer questions** -- When agents are uncertain, the coach decides
4. **Review results** -- Evaluate whether agent output meets standards
5. **Record decisions** -- Create an audit trail of all human guidance

The coach interacts with the system through **ACE commands** -- six
slash-commands that form the human-facing interface:

| Command | What the Coach Does | Paper Concept |
|---------|-------------------|---------------|
| `/ace-brief` | Creates a BriefingPack | Briefing Engineering |
| `/ace-dispatch` | Sends a mission to agent(s) | Agentic Loop Engineering |
| `/ace-resolve-crp` | Answers an agent's question | Agentic Guidance Engineering |
| `/ace-review-mrp` | Reviews agent's finished work | Agentic Guidance Engineering |
| `/ace-compare` | Compares multiple solutions | N-Version Programming |
| `/ace-dashboard` | Gets an overview of all missions | Observability |

**Implementation:** `commands/brief.md`, `dispatch.md`,
`resolve-crp.md`, `review-mrp.md`, `compare.md`, `status.md`

### AI Teammates (Agents)

AI Teammates are specialized agents, each with a defined role. The paper
envisions heterogeneous agent teams where different agents handle different
aspects of a mission. This repository defines four roles:

| Role | What It Does | When It's Used |
|------|-------------|----------------|
| **Executor** | The primary work agent. Reads the BriefingPack, follows the LoopScript phase by phase, creates CRPs when uncertain, and produces an MRP at completion. | Every mission |
| **Briefing Engineer** | Creates BriefingPacks interactively with the Agent Coach. Asks structured questions to fill all sections of a BP. | When `/ace-brief` is invoked |
| **Quality Gate** | Evaluates MRPs against the 5 Merge-Readiness criteria. Returns a score (0-100) with specific improvement suggestions. | When `/ace-review-mrp` triggers automated scoring |
| **Reviewer** | Independent reviewer for N-Version comparison. Reads the same BriefingPack and produces an independent implementation. | High-rigor missions only |

**Implementation:** `agents/executor.md`, `briefing-engineer.md`,
`quality-gate.md`, `reviewer.md`

### N-to-N Collaboration

The paper emphasizes that SASE is not just about one human talking to one
AI. It supports multiple collaboration patterns:

- **1-to-1:** One coach, one executor (standard missions)
- **1-to-N:** One coach dispatching to multiple agents (N-version programming)
- **N-to-1:** Multiple specialists answering one agent's CRPs (domain expertise)
- **N-to-N:** Multiple coaches overseeing shared agent pools (team scale)

In this repository, the **1-to-N pattern** is implemented through
high-rigor missions where both an executor and a reviewer independently
work on the same BriefingPack, and `/ace-compare` helps synthesize
the results.

---

## 6. The Artifacts: Contracts Between Humans and Agents

Artifacts are the heart of SASE. They are structured documents that serve
as **contracts** between humans and agents. Every artifact has:

- **YAML frontmatter** with metadata (schema version, ID, status, etc.)
- **Markdown body** with structured content
- **A JSON schema** for validation (`skills/engineering/schemas/`)
- **An ID pattern:** `TYPE-YYYY-MMDD-NNN` (e.g. `BP-2026-0311-001`)

Here is how they flow through a mission:

```
  HUMAN                          AGENT                         HUMAN
    │                              │                              │
    │  ① BriefingPack (BP)         │                              │
    │─────────────────────────────>│                              │
    │                              │                              │
    │                              │  (works through LoopScript)  │
    │                              │                              │
    │  ④ VCR (answer)    ③ CRP (question)                        │
    │<─────────────────────────────│                              │
    │─────────────────────────────>│                              │
    │                              │                              │
    │                              │  ⑤ MRP (evidence package)    │
    │                              │─────────────────────────────>│
    │                              │                              │
    │                              │  ⑥ VCR (accept/reject)       │
    │                              │<─────────────────────────────│
    │                              │                              │

    ② LoopScript + MentorScript govern the agent's behavior throughout
```

### 6.1 BriefingPack (BP) -- The Mission Brief

**Paper concept:** "A structured, version-controlled mission briefing
transforming vague tickets into actionable work orders."

A BriefingPack is NOT a traditional requirements document. It is a
**specification for action** -- machine-readable, testable, and as central
as source code itself. The paper explicitly distinguishes it from
implementation-agnostic SRS documents: a BP contains strategic guidance
and constraints while preserving agent autonomy for tactical decisions.

**What it contains:**

| Section | Purpose | Example |
|---------|---------|---------|
| **Goal & Why** | High-level objective + business value. Gives the agent purpose for better micro-decisions. | "Add greeting CLI so users can test the system works" |
| **Acceptance Criteria** | Binary, testable checklist. Transforms abstract goals into verifiable properties. | "AC-1: `greet('World')` returns `'Hello, World!'`" |
| **Context** | Curated links, files, APIs. Prevents hallucination without context overload. | "Files: `src/greet.py`; APIs: none" |
| **Strategy** | Strategic guidance + constraints (not step-by-step instructions). | "Use argparse for CLI; keep it simple" |
| **Gotchas** | Known pitfalls the agent should watch for. | "Don't add timestamp -- keep output deterministic" |
| **Escalation Triggers** | Situations where the agent MUST ask instead of guessing. | "If greeting format is ambiguous, create a CRP" |

**Hierarchical BriefingPacks:**

For large tasks, a single BP can be decomposed into child BPs:

```
BP-001 (Root, status: decomposed)
  ├── Shared Context (inherited by all children)
  ├── BP-002 (Inventory & Gap Analysis)  ← must complete first
  ├── BP-003 (LNW Module Extraction)     ← depends on BP-002
  ├── BP-004 (LNM Module Extraction)     ← depends on BP-002
  ├── BP-005 (LNN Module Extraction)     ← depends on BP-002
  └── BP-006 (LND+LNU Extraction)        ← depends on BP-002
```

Only **leaf BPs** (without children) are dispatched to agents. Agents must
read the entire ancestor chain to inherit shared context.

The repository includes a **Scope Assessment** step (built into `/ace-brief`)
that proactively checks whether a BP is too large:

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Files touched | ≤ 20 | 20-50 | > 50 |
| Lines of code | ≤ 5,000 | 5,000-15,000 | > 15,000 |
| Deliverables | ≤ 3 | 4-5 | > 5 |
| Independent sub-goals | 1 | 2 | > 2 |

If the assessment comes back Red, the BP should be split into children.

**Implementation:**
- Template: `skills/engineering/templates/briefing-pack.md`
- Schema: `skills/engineering/schemas/briefing-pack.schema.json`
- Storage: `artifacts/briefings/`
- Example: `artifacts/briefings/BP-2026-0311-001.md` (hierarchical parent)
- Created via: `/brief` command or `briefing-eng` skill

### 6.2 LoopScript (LS) -- The Execution Plan

**Paper concept:** "A declarative language defining Standard Operating
Procedures (SOPs) for agent execution."

A LoopScript defines **what phases an agent goes through** and **what
conditions must be met** before moving to the next phase. It is NOT
ad-hoc prompt engineering; it is an explicit orchestration contract.

The repository includes two pre-built LoopScripts:

**Standard LoopScript** (`skills/engineering/loops/standard.yaml`) -- 5 phases:

```
Phase 1: UNDERSTAND
  → Read BriefingPack and MentorScripts
  → Gate: Can the agent restate the mission goal? All AC understood?

Phase 2: PLAN
  → Analyze codebase, identify affected files, plan changes
  → Gate: Is the plan complete? Does it cover all AC?

Phase 3: IMPLEMENT
  → Execute the plan, write code, write tests
  → Gate: All AC met? All tests pass?

Phase 4: SELF-REVIEW
  → Review own code against MentorScript rules
  → Gate: Linting clean? No debug artifacts? MentorScript compliant?

Phase 5: PACKAGE
  → Create MRP with evidence for all 5 merge-readiness criteria
  → Gate: MRP complete and schema-valid?
```

**High-Rigor LoopScript** (`skills/engineering/loops/high-rigor.yaml`) -- 7 phases:

Adds two extra phases between PLAN and IMPLEMENT:
- **THREAT-MODEL:** Analyze security implications, identify attack surfaces
- **FORMAL-VERIFY:** Create formal property checks, verify pre/post-conditions

Also enables **N-Version Programming** (3 parallel implementations).

**Key LoopScript features:**
- **Gates:** Each phase has a condition that must pass before the agent
  proceeds. Failed gates mean: repeat the phase or create a CRP.
- **Escalation rules:** Define when agents must create CRPs
  (uncertainty threshold, scope creep, security decisions)
- **N-Version support:** `n-version.enabled: true` launches multiple
  independent agents on the same BP

**Implementation:**
- Template: `skills/engineering/templates/loop-script.yaml`
- Schema: `skills/engineering/schemas/loop-script.schema.json`
- Storage: `skills/engineering/loops/`
- Pre-built: `standard.yaml`, `high-rigor.yaml`

### 6.3 MentorScript (MS) -- The Rule Book

**Paper concept:** "Mentorship-as-code -- transforming implicit, ephemeral
guidance into explicit, evolving discipline."

Every team has unwritten rules: "We always write tests first," "Never use
`any` in TypeScript," "Error messages must include the operation that
failed." In traditional development, these rules live in people's heads
and get passed down through code reviews and pair programming.

A MentorScript makes these rules **explicit, machine-readable, and
enforceable**. Agents load MentorScripts at startup and must follow them
throughout execution.

**Rule structure:**

```markdown
### R-001: Test Coverage (mandatory)
Every new function or modified function must have at least one
deterministic unit test. Test file naming: `test_<module>.py` or
`<Module>Test.java`.
```

Each rule has:
- A unique ID (`R-NNN`)
- A severity (`mandatory` = must follow; `recommended` = should follow)
- A scope (`global`, `language:python`, `module:auth`, `phase:implement`)

**The repository's global MentorScript** (`mentorscripts/global.md`)
defines 10 rules:

| Rule | Severity | What It Requires |
|------|----------|-----------------|
| R-001 | mandatory | Every new/modified function must have a unit test |
| R-002 | mandatory | No silent error swallowing; always log or re-raise |
| R-003 | mandatory | Never hardcode secrets; no `eval()` on user input |
| R-004 | mandatory | Self-review before submission |
| R-010 | recommended | Imperative commit messages referencing artifact IDs |
| R-011 | recommended | Public functions need a docstring/JSDoc |
| R-020 | recommended | No copy-paste; extract shared logic |
| R-030 | mandatory | CRP required when confidence < 70% or scope creep |
| R-031 | mandatory | MRP must address all 5 merge-readiness criteria |

The **Root MentorScript** is `CLAUDE.md` itself -- it defines the entire
framework's rules and conventions and is always loaded.

**The paper's three types of mentorship:**
1. **Explicit:** Direct rules written by the coach (what we have in `global.md`)
2. **Inferred:** Agent proposes generalizations from corrections (future capability)
3. **Process:** Guidance on approach, not just output (encoded in LoopScripts)

**Implementation:**
- Template: `skills/engineering/templates/mentor-script.md`
- Schema: `skills/engineering/schemas/mentor-script.schema.json`
- Storage: `mentorscripts/`
- Root: `CLAUDE.md` (this repo's root MentorScript)

### 6.4 Clarification Request Protocol (CRP) -- The Agent's Question

**Paper concept:** "A structured escalation artifact enabling agent-to-human
consultation during execution."

This is one of SASE's most important innovations. Instead of agents
guessing when they're uncertain (and getting it wrong), they are
**required to ask**.

**When must an agent create a CRP?** (Mandatory -- never guess instead)

1. **Confidence < 70%** -- The agent is unsure about a decision
2. **Scope creep** -- The task is growing beyond what the BP defines
3. **Security implications** -- Anything touching auth, crypto, or privacy
4. **Requirements ambiguity** -- The BP is contradictory or unclear
5. **Irreversible decisions** -- Architecture, data model, or API changes
   that are hard to undo

**What a CRP contains:**

```
Trigger:     Why this CRP exists
Question:    Specific, answerable question
Context:     What the agent was doing when it got stuck
Options:     A, B, C -- each with pros and cons
Recommendation: Which option the agent prefers and why
Impact:      What happens if the answer is delayed
```

**The CRP flow:**

1. Agent detects a trigger condition
2. Agent creates a CRP file in `artifacts/guidance/crp/`
3. Agent **pauses** the affected phase (does NOT proceed)
4. Coach resolves the CRP via `/ace-resolve-crp`
5. A VCR is created recording the decision
6. Agent resumes with the answer

This is what makes SASE different from "just chatting with an AI." The
agent does not ask casually -- it files a structured document that becomes
part of the auditable record.

**Implementation:**
- Template: `skills/engineering/templates/crp.md`
- Schema: `skills/engineering/schemas/crp.schema.json`
- Storage: `artifacts/guidance/crp/`
- Resolved via: `/resolve-crp` command

### 6.5 Mission Review Protocol (MRP) -- The Evidence Package

**Paper concept:** "A structured evidence bundle demonstrating agent work
meets all criteria for production merge."

The MRP solves a critical problem: when an agent finishes work, how does
the human know if it's actually good? Reading every line of code doesn't
scale. Instead, the agent produces a **structured proof** organized around
five criteria.

**The 5 Merge-Readiness Criteria:**

| # | Criterion | What It Proves | Gap It Addresses |
|---|-----------|---------------|------------------|
| 1 | **Functional Completeness** | Every Acceptance Criterion from the BP is met, with evidence | Agents producing partial fixes that pass narrow tests |
| 2 | **Sound Verification** | Tests are comprehensive, coverage is adequate, edge cases handled | Weak test suites that don't catch agent mistakes |
| 3 | **SE Hygiene** | Linting clean, MentorScript rules followed, no debug artifacts left | Functional code that violates style/engineering principles |
| 4 | **Clear Rationale** | Design decisions explained, CRP references included | Agent reasoning buried in verbose trajectory logs |
| 5 | **Full Auditability** | Complete trail from BP to implementation to MRP | Non-deterministic agent output that can't be reproduced |

**Scoring (by the Quality Gate agent):**
- Each criterion: 0-20 points
- Total: 0-100
- ≥ 80 = **PASS** (ready to merge)
- 60-79 = **CONDITIONAL PASS** (minor fixes needed)
- < 60 = **FAIL** (significant rework required)

**Progressive disclosure:** The MRP provides a high-level summary first.
The coach can drill down into test logs, execution traces, or detailed
analysis only if needed. This respects human cognitive load.

**Implementation:**
- Template: `skills/engineering/templates/mrp.md`
- Schema: `skills/engineering/schemas/mrp.schema.json`
- Storage: `artifacts/guidance/mrp/`
- Reviewed via: `/review-mrp` command
- Scored by: `quality-gate` agent

### 6.6 Version Control Record (VCR) -- The Decision Log

**Paper concept:** "An auditable artifact formally addressing each CRP or
MRP, ensuring traceability and decision rationale."

Every time the coach makes a decision -- answering a CRP, approving or
rejecting an MRP -- a VCR is created. VCRs are **append-only** (never
modified after creation) and form an immutable audit trail.

**What a VCR contains:**

```
Decision:      Clear statement of the choice made
Rationale:     Why this option was chosen (auditable reasoning)
Instructions:  Next steps for the agent
```

**VCR types:**
- `crp-response` -- Coach answers an agent's question
- `mrp-approval` -- Coach accepts the agent's deliverable
- `mrp-rejection` -- Coach rejects the deliverable
- `mrp-revision` -- Coach requests specific changes

**Why this matters:** In a world where agents make hundreds of changes per
day, the VCR trail lets you answer: "Who decided this? Why? What
information did they have?" This is essential for compliance, debugging,
and organizational learning.

**Implementation:**
- Template: `skills/engineering/templates/vcr.md`
- Schema: `skills/engineering/schemas/vcr.schema.json`
- Storage: `artifacts/guidance/vcr/`
- Created by: `/resolve-crp` and `/review-mrp`

---

## 7. The Workbenches: Where Work Happens

### 7.1 ACE -- Agent Coach Environment

The ACE is the **human-facing workbench**. The paper envisions it as a
command center optimized for human cognition: inbox-like triage of agent
requests, N-version comparison tools, voice-first interaction, and
seamless transitions between oversight and hands-on coding.

In this repository, ACE is implemented as **six slash-commands** that
the coach uses to interact with the framework:

```
/ace-brief          Create or edit a BriefingPack
/ace-dispatch       Send a mission to agent(s)
/ace-resolve-crp    Answer an agent's CRP
/ace-review-mrp     Evaluate an agent's MRP
/ace-compare        Compare N-version implementations
/ace-dashboard      Overview of all missions
```

Each command is defined in `commands/` and provides a structured,
step-by-step workflow. For example, `/ace-brief` walks the coach through
7 steps: Goal, Scope Assessment, Acceptance Criteria, Context, Strategy,
Gotchas, and Escalation Triggers.

### 7.2 AEE -- Agent Execution Environment

The AEE is the **agent-facing workbench**. The paper describes it as
optimized for agent computation: machine-readable tools, persistent
memory, self-monitoring infrastructure, and multi-agent orchestration.

In this repository, the AEE is composed of:

- **Agent definitions** (`agents/`) -- Role-specific behavior rules
- **LoopScripts** (`skills/engineering/loops/`) -- Phase-gated execution plans
- **MentorScripts** (`mentorscripts/`) -- Behavioral constraints
- **JSON schemas** (`skills/engineering/schemas/`) -- Artifact validation
- **Audit hooks** (`hooks/hooks.json`) -- Automatic logging of all
  Write/Edit operations

The paper emphasizes that many human-centric best practices are
**inverted** for agents. For example:
- The DRY principle matters less (code cloning simplifies agent reasoning)
- Strong type systems are more valuable (compile errors guide agents)
- Clean code has high ROI (reduces friction for agent navigation)

---

## 8. The Engineering Activities: How Work Gets Done

The paper defines six engineering activities. This repository implements
four as Skills and two implicitly:

### 8.1 Briefing Engineering

**Paper:** "Moving beyond raw-ticket-pasting to disciplined specification
as a central engineering skill."

**The idea:** Writing a good brief for an AI agent is a skill in itself.
It's not just copying a Jira ticket into a prompt. Briefing Engineering
treats specification as a **first-class engineering activity** -- as
important as writing code.

**Key practices:**
- Start with Goal & Why (not implementation details)
- Define binary, testable Acceptance Criteria
- Curate context (too much is as bad as too little)
- Identify escalation triggers upfront
- Assess scope before proceeding
- Decompose large missions hierarchically

**Implementation:** `skills/engineering/SKILL.md` (§ Briefing Engineering)

### 8.2 Agent Loop Engineering (ALE)

**Paper:** "Transforming opaque agent execution into disciplined,
auditable, reproducible workflows."

**The idea:** Instead of letting agents do whatever they want, you define
a Standard Operating Procedure. The LoopScript is your playbook -- it
says what phases the agent goes through, what gates it must pass, and
when it must escalate.

**Key practices:**
- Define phases sequentially (understand → plan → implement → review → package)
- Set gates for each phase (conditions that must be true before proceeding)
- Choose rigor level (standard vs. high for critical changes)
- Enable N-version programming for important missions
- Define escalation rules (when to create CRPs)

**Implementation:** `skills/engineering/SKILL.md` (§ Loop Engineering)

### 8.3 AI Teammate Mentorship Engineering (ATME)

**Paper:** "Codifying team norms and best practices as explicit, testable
guidance."

**The idea:** Every team has tribal knowledge -- unwritten rules that
experienced developers just know. ATME makes these rules explicit so
agents can follow them too. It's "mentorship-as-code."

**Key practices:**
- Write rules with IDs and severity levels
- Scope rules appropriately (global, language-specific, phase-specific)
- Subject rules to their own quality checks (no contradictions)
- Evolve rules based on agent performance

**Implementation:** `skills/engineering/SKILL.md` (§ Mentorship Engineering)

### 8.4 Agentic Guidance Engineering (AGE)

**Paper:** "Formalizing and optimizing human participation throughout
agent execution."

**The idea:** The human is not just a rubber-stamp approver. AGE designs
how and when humans inject their expertise. Through CRPs and MRPs,
agents invoke human specialists precisely when needed, and every
interaction is recorded in VCRs.

**Key practices:**
- Monitor CRPs by urgency (blocking > high > medium > low)
- Review MRPs against the 5 merge-readiness criteria
- Record every decision in a VCR for auditability
- Route CRPs to the right specialist

**Implementation:** `skills/engineering/SKILL.md` (§ Guidance Engineering)

### 8.5 AI Teammate Lifecycle Engineering (ATLE)

**Paper:** "Enabling agents to retain institutional memory and learn
over time."

**The idea:** Agents should evolve from stateless contractors to
persistent teammates. They should remember project history, avoid
repeating mistakes, and even proactively suggest improvements.

**Implementation:** Not yet directly implemented in this repository.
This is a future capability that would involve persistent memory systems
and knowledge distillation from past missions.

### 8.6 AI Teammate Infrastructure Engineering (ATIE)

**Paper:** "Building agent-native toolchains and environments for
effective operation at scale."

**The idea:** Agents need different tools than humans. ATIE designs
the infrastructure: agent-native MCP servers, semantic search, structural
editors, self-monitoring, and multi-agent coordination.

**Implementation:** Partially realized through the agent definitions,
JSON schemas for validation, and the audit hooks in `hooks/hooks.json`.

---

## 9. The Complete Workflow: A Mission From Start to Finish

Here is how a mission flows through the framework, using the example
included in `examples/mission-hello-world/`:

### Step 1: Coach Creates a BriefingPack

```
Coach runs: /ace-brief
```

The briefing-engineer agent walks the coach through creating a BP:

```yaml
# examples/mission-hello-world/briefing-pack.md
id: BP-2025-0115-001
mission: "Hello World CLI Greeting"
status: completed
rigor: standard
loop-script: skills/engineering/loops/standard.yaml
```

The BP defines 5 Acceptance Criteria, points to relevant files, suggests
a strategy, and lists escalation triggers.

### Step 2: Coach Dispatches the Mission

```
Coach runs: /ace-dispatch
```

The system validates the BP, creates a mission workspace, determines
execution mode (standard), and launches the executor agent.

### Step 3: Agent Encounters Uncertainty → Creates CRP

While implementing, the executor agent realizes the BP doesn't specify
whether the greeting should include a timestamp. This is ambiguous.
Per R-030 (confidence < 70%) and the escalation trigger in the BP,
the agent creates a CRP:

```yaml
# examples/mission-hello-world/crp-001.md
id: CRP-2025-0115-001
urgency: blocking
category: ambiguity
question: "Should the greeting include a timestamp?"
options:
  A: Simple format "Hello, {name}!" (agent's recommendation)
  B: With timestamp "Hello, {name}! [2025-01-15 10:30]"
```

The agent **pauses** and waits.

### Step 4: Coach Resolves the CRP

```
Coach runs: /ace-resolve-crp
```

The coach sees the CRP, reads the options, and decides: **Option A**
(no timestamp). A VCR is created:

```yaml
# examples/mission-hello-world/vcr-001.md
id: VCR-2025-0115-001
resolves: CRP-2025-0115-001
decision: "Go with Option A -- simple greeting without timestamp"
rationale: "ACs don't mention timestamps. Determinism matters for testing."
```

### Step 5: Agent Completes → Creates MRP

With the ambiguity resolved, the agent finishes the implementation and
creates an MRP with evidence for all 5 criteria:

```yaml
# examples/mission-hello-world/mrp-001.md
id: MRP-2025-0115-001
status: pending-review

# 1. Functional Completeness: All 5 ACs met ✓
# 2. Sound Verification: 4 tests, 100% coverage ✓
# 3. SE Hygiene: Linting clean, R-001/R-002 satisfied ✓
# 4. Clear Rationale: CRP-2025-0115-001 referenced ✓
# 5. Full Auditability: Commit a1b2c3d, git diff included ✓
```

### Step 6: Coach Reviews the MRP

```
Coach runs: /ace-review-mrp
```

The coach (optionally assisted by the quality-gate agent) reviews
the evidence, scores it, and creates a final VCR approving the mission.

**Mission complete.** The entire trail -- from brief to questions to
answers to evidence to approval -- is preserved in structured,
versioned artifacts.

---

## 10. Key Principles and Design Decisions

### 10.1 The Speed vs. Trust Gap

SASE does not slow agents down. It wraps their speed in structure that
builds trust. The overhead of writing a BP and reviewing an MRP is far
less than the cost of debugging a bad agent-generated PR.

### 10.2 Living Documents, Not Waterfall

The paper explicitly rejects waterfall-style upfront specification.
All SASE artifacts are **living documents**:

- BPs start as lightweight drafts and are enriched iteratively
- LoopScripts can be adjusted mid-execution
- MentorScripts evolve as the team learns
- CRP/VCR cycles refine understanding in real-time

### 10.3 The Bitter Lesson With Nuance

The paper acknowledges Rich Sutton's "Bitter Lesson" (general methods
that scale with computation ultimately win) but adds nuance:

- For common problems: let agents learn and scale
- For novel/niche tasks: humans provide strategic guardrails
- Structure is essential for **coordination and governance**
- The key skill is knowing **when to impose structure** vs.
  **when to grant autonomy**

### 10.4 Agents Must Ask, Not Guess

The CRP mechanism is non-negotiable. When an agent is uncertain (below
70% confidence), encounters security implications, sees scope creep,
or faces an irreversible decision, it **must** stop and ask. This is
codified in MentorScript rule R-030 and enforced through LoopScript
escalation rules.

### 10.5 Evidence Over Trust

The MRP's 5 criteria embody a principle: **don't trust, verify.** The
agent doesn't just say "I'm done." It provides structured proof:
tests pass, coverage is adequate, code is clean, decisions are explained,
and the entire trail is reproducible.

### 10.6 Auditability by Default

Every decision is recorded:
- VCRs capture human decisions (append-only, never modified)
- The audit hook in `hooks/hooks.json` logs every file Write/Edit
- MRPs link back to BPs, CRPs, and VCRs
- Commit messages reference artifact IDs

---

## 11. Repository Map

```
i-sase/
│
├── CLAUDE.md                          # Root MentorScript (framework spec)
│
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest (name: "ace")
│
├── agents/                            # AI Teammate definitions
│   ├── executor.md                    #   Primary work agent
│   ├── briefing-engineer.md           #   BP creation assistant
│   ├── quality-gate.md                #   MRP scoring (5 criteria, 0-100)
│   └── reviewer.md                    #   Independent N-Version reviewer
│
├── commands/                          # ACE commands (human interface)
│   ├── brief.md                       #   Create/edit BriefingPacks
│   ├── dispatch.md                    #   Launch missions
│   ├── do.md                          #   Quick task execution (Tier 1)
│   ├── status.md                      #   Actionable overview
│   ├── resolve-crp.md                 #   Answer agent questions
│   ├── review-mrp.md                  #   Review agent deliverables
│   ├── compare.md                     #   Compare N-version solutions
│   └── getting-started.md             #   Interactive onboarding
│
├── skills/                            # Engineering activity implementations
│   ├── briefing-eng/                  #   Briefing Engineering
│   │   ├── SKILL.md
│   │   ├── schemas/                   #   JSON Schema validators
│   │   │   ├── briefing-pack.schema.json
│   │   │   ├── loop-script.schema.json
│   │   │   ├── mentor-script.schema.json
│   │   │   ├── crp.schema.json
│   │   │   ├── mrp.schema.json
│   │   │   └── vcr.schema.json
│   │   └── templates/
│   │       └── briefing-pack.md       #     BP template
│   ├── ale/                           #   Agent Loop Engineering
│   │   ├── SKILL.md
│   │   ├── loops/                     #   Pre-built LoopScripts
│   │   │   ├── standard.yaml          #     5-phase standard workflow
│   │   │   └── high-rigor.yaml        #     7-phase + N-Version
│   │   └── templates/
│   │       └── loop-script.yaml       #     LoopScript template
│   ├── atme/                          #   AI Teammate Mentorship Eng.
│   │   ├── SKILL.md
│   │   └── templates/
│   │       └── mentor-script.md       #     MentorScript template
│   └── age/                           #   Agentic Guidance Engineering
│       ├── SKILL.md
│       └── templates/
│           ├── crp.md                 #     CRP template
│           ├── mrp.md                 #     MRP template
│           └── vcr.md                 #     VCR template
│
├── hooks/
│   └── hooks.json                     # Plugin hooks (audit logging, BP protection)
│
├── settings.json                      # Plugin settings (env vars)
│
├── .claude/
│   ├── settings.json                  # Local development overrides
│   └── audit.log                      # Audit trail
│
├── artifacts/                         # All mission artifacts
│   ├── briefings/                     #   BriefingPacks
│   │   └── {hash}-{slug}/brief.md    #     Directory-based hierarchy
│   └── guidance/                      #   Governance artifacts
│       ├── crp/                       #     Agent questions
│       ├── mrp/                       #     Agent evidence packages
│       └── vcr/                       #     Human decision records
│
├── mentorscripts/
│   ├── global.md                      # Project-wide rules (R-001..R-031)
│   └── team.md                        # Team roles and review policies
│
└── docs/
    └── SASE-FRAMEWORK-GUIDE.md        # This document
```

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **ACE** | Agent Coach Environment -- the human-facing workbench (slash-commands) |
| **AEE** | Agent Execution Environment -- the agent-facing workbench (loops, rules, schemas) |
| **Agent Coach** | The human who writes briefs, answers questions, and reviews results |
| **AI Teammate** | A specialized AI agent executing tasks within the framework |
| **ALE** | Agent Loop Engineering -- designing LoopScripts and execution workflows |
| **AGE** | Agentic Guidance Engineering -- managing CRPs, MRPs, and VCRs |
| **ATME** | AI Teammate Mentorship Engineering -- creating and maintaining MentorScripts |
| **ATLE** | AI Teammate Lifecycle Engineering -- persistent memory and learning (future) |
| **ATIE** | AI Teammate Infrastructure Engineering -- agent-native toolchains (partial) |
| **BriefingPack (BP)** | Structured mission brief -- the input contract for an agent |
| **CRP** | Clarification Request Protocol -- a structured question from agent to coach |
| **Gate** | A condition that must be met before an agent can proceed to the next phase |
| **LoopScript (LS)** | Phase-gated execution plan defining how an agent works through a mission |
| **MentorScript (MS)** | Machine-readable rulebook codifying team norms and best practices |
| **MRP** | Mission Review Protocol -- structured evidence package proving work quality |
| **N-Version Programming** | Running multiple agents independently on the same task for comparison |
| **SASE** | Structured Agentic Software Engineering (the paper's framework) |
| **i-SASE** | instrumented SASE (this repository's implementation) |
| **SE4H** | Software Engineering for Humans -- human-optimized processes and tools |
| **SE4A** | Software Engineering for Agents -- computation-optimized processes and tools |
| **VCR** | Version Control Record -- immutable record of a human decision |

---

*This guide is based on Hassan et al. (2025),
"[Structured Agentic Software Engineering](https://arxiv.org/abs/2509.06216)"
and the i-SASE repository implementation.*
