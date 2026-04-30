---
name: "Engineering"
description: "Agentic Software Engineering — disciplines for authoring, executing, governing, and templating Agent missions in the ACE framework"
---

# Skill: Engineering

This is the unified engineering skill of the ACE plugin. It bundles the five disciplines that turn human intent into structured agent work and back into reviewed deliverables:

| Discipline | Purpose | Sections below |
|---|---|---|
| **Briefing Engineering** | Translate intent into BriefingPacks (BPs) | [§ Briefing Engineering](#briefing-engineering) |
| **Loop Engineering (ALE)** | Design phase-by-phase SOPs (LoopScripts) | [§ Loop Engineering](#loop-engineering) |
| **Mentorship Engineering (ATME)** | Codify rules agents must follow (MentorScripts) | [§ Mentorship Engineering](#mentorship-engineering) |
| **Guidance Engineering (AGE)** | Govern agent–coach communication (CRP/MRP/VCR) | [§ Guidance Engineering](#guidance-engineering) |
| **Blueprint Engineering** | Extract reusable templates from completed BP trees | [§ Blueprint Engineering](#blueprint-engineering) |

The original SASE-paper terms (BriefingEng, ALE, ATME, AGE, BlueprintEng) live on as section headings — the discipline structure is preserved, the filesystem footprint is not.

## Common Conventions

These apply to **every** artifact produced by this skill.

### Hash-Based IDs

All artifacts use 12-character hex IDs generated with:
```bash
openssl rand -hex 6
```
Example: `a1b2c3d4e5f6`. IDs are never sequential. Display abbreviation is the first 6 chars (`a1b2c3`); extend to 7-8 chars only on collision.

### Slugs

Artifacts that ship as directories (BriefingPacks, Blueprints) require a `slug` — a human-readable short name (2-4 words, lowercase, hyphens). Pattern: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Examples: `auth-refactor`, `db-migration-postgres`. The slug appears in the directory name (`{hash}-{slug}/`), in display output (`bp:a3f7c2 (auth-refactor)`), and in the index.

### File Layout

```
skills/engineering/
├── SKILL.md                              # this file
├── schemas/                              # JSON Schemas (briefing-pack, crp, mrp, vcr, mentor-script, loop-script, blueprint)
├── templates/                            # Markdown / YAML templates (briefing-pack, crp, mrp, vcr, mentor-script, loop-script, blueprint)
└── loops/                                # Pre-built LoopScripts (standard, high-rigor, text-standard)
```

All cross-references in commands, agents, and scripts point into these three directories.

---

## Briefing Engineering

Briefing Engineering is the discipline of translating human intent into structured, actionable BriefingPacks. A well-crafted BP is the single most important factor in mission success — it gives an AI Teammate everything it needs to execute autonomously while knowing exactly when to escalate.

### BP Storage

BPs are stored as `brief.md` inside a directory named `{hash}-{slug}`:
```
artifacts/briefings/{hash}-{slug}/brief.md
```

### BP Sections

| Section | Purpose |
|---|---|
| **Goal & Why** | What must be accomplished and why it matters. The "why" prevents technically correct but strategically wrong decisions. |
| **Acceptance Criteria** | Binary, verifiable checklist. BAD: "API should be fast." GOOD: "GET /users responds in <200ms at p95 with 1000 concurrent connections." |
| **Context** | Concrete file paths, modules, APIs, patterns. The more specific, the fewer CRPs. |
| **Constraints** | Binding boundaries. The agent **must not** cross these without raising a CRP. |
| **Approach** | Recommended path. The agent **may** deviate but must justify in the MRP. |
| **Gotchas** | Known pitfalls, edge cases, fragile areas. Each gotcha is a CRP prevented. |
| **Escalation Triggers** | Domain-specific situations beyond the standard CRP triggers where the agent must pause and ask. |

### Artifacts (Inputs & Outputs)

Optional, machine-readable declarations of what a BP consumes (`input`) and produces (`output`). Enables traceability across the BP hierarchy.

Each entry has:
- **path** (required): Relative path from project root
- **direction** (required): `input` or `output`
- **ac** (optional): Reference to the AC requiring this output (e.g. `AC-1`)
- **description** (optional): Short description

Rules: Leaf BPs declare their own artifacts. Parents do not — their children do. Outputs come from ACs (`Output: \`filename\` in \`directory/\``); inputs come from Context sections or cross-BP dependencies.

**verify-command (optional):**

For output artifacts where validity is shell-checkable, declare a `verify-command`. The executor runs it from the project root during the `artifact-verify` LoopScript phase. Exit 0 means valid.

When to use:
- Build files: `pom.xml` → `mvn validate -N`, `build.gradle` → `gradle dependencies`
- Source code: `mvn compile -pl <module>`, `go build ./...`, `tsc --noEmit`
- Structured data: `python3 -c "import json; json.load(open('path'))"`
- Config: `docker build --check -f path .`, `terraform validate`
- SQL: `psql -f path --set ON_ERROR_STOP=1`

When NOT to use: prose documentation, design documents, analysis reports — no machine-verifiable definition of "valid." Keep commands fast (< 60 s). Full test suites belong in the implement-phase gate-command.

### LoopScript Selection

The LoopScript matches the type of output the mission produces:

- **Text-Output Missions** → `text-standard.yaml` (`.md`, `.txt`, `.adoc`, `.rst`, `.csv`). No build/compile gate-commands; verification is self-review + content accuracy.
- **Code/Build-Output Missions** → `standard.yaml` (default). Source code, build files, configuration, infrastructure.
- **Mixed-Output Missions** → `standard.yaml` (conservative; build/test gates do not harm text artifacts).

The briefing engineer sets the LoopScript explicitly via `loop-script` in BP frontmatter. If omitted, auto-selection: `standard` rigor → `standard.yaml`, `high`/`critical` rigor → `high-rigor.yaml`.

### Template & Schema

- Template: `skills/engineering/templates/briefing-pack.md`
- Schema: `skills/engineering/schemas/briefing-pack.schema.json`

### Quality Criteria for BPs

A BP is **ready for dispatch** when it meets all of these:

1. **Specific ACs** — Every AC is binary and testable.
2. **Clear Scope** — In-scope and out-of-scope are explicit.
3. **Identified Risks** — Gotchas and escalation triggers cover known unknowns.
4. **Sufficient Context** — File paths exist, module references are correct, API docs linked or summarized.
5. **Clear Constraints** — Binding boundaries distinguishable from suggested approaches.
6. **Correct Metadata** — Hash ID valid, slug valid, LoopScript and MentorScripts referenced and existing.

### BP Workflow

```
Draft → Review → Ready → Dispatched (leaf BPs only)
```

- **Tier 2:** `/brief` → agent drafts → human reviews → auto-dispatch
- **Tier 3:** `/brief --full` → interactive 7-step → manual dispatch

Parent BPs are not stored with a status — it is **derived** from their children. Parent BPs cannot be dispatched; only leaf descendants are.

### Team Authoring

- **Author**: Creates initial draft. Multiple authors may contribute sections.
- **Contributor**: Adds context, gotchas, or constraints.
- **Approver**: Transitions BP from `draft` to `ready`. Only the designated Approver may do so.

The `authored-by`, `contributors`, and `approved-by` fields track participation. See `mentorscripts/team.md` for the authorization matrix.

### Scope Assessment

Every BP must fit a single agent execution. Assess scope **before** writing ACs:

| Indicator | Single BP OK | Consider splitting |
|---|---|---|
| Files to analyze/modify | ≤ 20 | > 20 |
| LOC in scope | ≤ 5,000 | > 5,000 |
| Distinct deliverables | ≤ 3 | > 3 |
| Estimated context loads | ≤ 5 file reads | > 15 file reads |
| Independent sub-goals | 1 | > 1 clearly separable |

Over threshold → propose a hierarchical breakdown to the Agent Coach before proceeding.

### Hierarchical Decomposition

BPs nest via directories (arbitrary depth):

```
artifacts/briefings/{parent-hash}-{parent-slug}/
  brief.md                                   # Parent (status derived from children)
  {child-hash-1}-{child-slug-1}/
    brief.md                                 # Child (leaf or further parent)
  {child-hash-2}-{child-slug-2}/
    brief.md
```

Parent frontmatter contains an `execution-order` list:
```yaml
execution-order:
  - a1b2c3d4e5f6    # First child
  - f6e5d4c3b2a1    # Second child (depends on first)
  - 112233445566    # Third child
```

The directory nesting encodes the parent-child relationship; `execution-order` encodes sequencing. Cross-tree `depends-on` is supported. Agents MUST read the full ancestor chain (every `brief.md` up the tree) before starting a leaf BP.

Decomposition rules:
- Each child must be independently executable and produce a usable deliverable
- Earlier children should produce artifacts that later children reference
- Typical pattern: Inventory/Overview → Deep Analysis → Consolidation/Synthesis
- Decomposition creates a VCR documenting the split rationale

### Revisions

A reviewed BP may need corrections post-approval:
```bash
python3 scripts/bp-transition.py revise <bp-hash> --reason "what needs fixing"
```
This moves the BP from `reviewed` (or `completed`/`stale`) back to `ready`, increments the revision counter, and preserves the previous execution's metadata in `revision-log`.

After revising, before re-dispatch:
1. Update the BP if needed (e.g., add `verify-command` to prevent recurrence)
2. Optionally set `re-execution-scope` to narrow the next agent's focus
3. Dispatch as normal

Difference from reset:
- **reset** = MRP rejection ("the execution failed quality review")
- **revise** = post-approval correction ("approved, but a defect was found later"). Preserves full audit history.

### Cascading Revisions and `stale`

When a BP is revised, every BP that consumed its outputs may now be working from inputs that have shifted. Tracked via the dedicated `stale` status:

- **Lazy flagging.** On `revise`, only *direct* dependents (BPs whose `depends-on` contains the revised hash) currently in `completed`/`reviewed`/`stale` are flagged. Each receives a `stale-because` entry recording the upstream hash, new revision, reason, timestamp, and prior status. Cascade does **not** auto-propagate to indirect dependents.
- **Eager visibility.** `/revise` and `/status` compute the *full transitive closure* and display it for operator awareness — so the operator sees the full ripple before deciding.
- **Two human decisions per stale BP.**
  - `/confirm-valid <hash>` — outputs not affected. Clear `stale-because`, restore prior status, append `revision-log` entry `outcome: confirmed-valid`. **No cascade.**
  - `/revise <hash>` — must be re-executed. Status → `ready`, revision counter increments, cascade re-runs from this BP's direct dependents.
- **Why lazy + eager.** Eager flagging would block BPs that may be fine, overriding human authority. Lazy flagging keeps each link in the chain a deliberate decision; eager visibility ensures the operator never loses sight.
- **Audit trail.** Each upstream's `revision-log` records the revision; each downstream's `stale-because` records the trigger; each downstream's `revision-log` records the resolution.
- **In flight (deferred).** Dependents currently `dispatched`/`claimed`/`in-progress` are not flagged on cascade. Future iteration will raise a CRP to the running agent.

### BP Anti-Patterns

- **Kitchen Sink BP**: Too many goals. Scope Assessment must catch this before AC writing.
- **Wishful BP**: ACs describe outcomes, not verifiable conditions.
- **Context-Free BP**: No file paths, just abstract descriptions.
- **Over-Prescribed BP**: So detailed the agent has no engineering judgment room.

---

## Loop Engineering

Loop Engineering is the discipline of designing SOPs (Standard Operating Procedures) that agents follow phase by phase. A LoopScript defines what happens in each phase, what gate must pass before proceeding, and when to escalate. Well-designed LoopScripts ensure predictable, auditable agent behavior.

### Agent Worktree Workflow

Each agent executes in its own **git worktree** — an isolated working directory with its own branch. Parallel agent execution is possible while main stays on `main`.

- **Branch:** `agent/{agent-id}/{bp-hash}`
- **Worktree:** `.worktrees/{agent-id}-{bp-hash}/`

Lifecycle:
1. **Claim**: Agent creates worktree + branch (`git worktree add`) and records a `claim()` commit. Lock is set.
2. **Heartbeat**: Periodic commits (every 60 min) from inside the worktree signal liveness.
3. **Complete**: `complete()` commit when work finishes.
4. **Merge**: On approval, branch is merged to main; worktree removed; branch deleted.

**Stale detection:** No commit (incl. heartbeat) within 3 h → stale. Exception: agents blocked on a blocking CRP are stale-exempt. Stale locks released via `/status release` (worktree removed; branch preserved for audit). See `mentorscripts/team.md` for the full convention.

### Phases

A LoopScript is a sequence of named phases, each with a clear objective and defined outputs. Phases execute **strictly sequentially** — never skip ahead, never work on multiple in parallel.

Typical progression:
1. **Orientation** — Read and understand the BP, map the codebase, identify affected areas.
2. **Planning** — Design the approach, break down into steps, identify risks.
3. **Implementation** — Write the code, create the artifacts.
4. **Verification** — Run tests, check ACs, verify MentorScript compliance.
5. **Documentation** — Update docs, write rationale, prepare MRP.

### Gates

Each phase ends with a gate — a condition that must be met before the agent proceeds. Gates are quality checkpoints. If a gate fails, the agent retries the phase or escalates via CRP.

Examples:
- Orientation: "All referenced files from BP exist and are readable"
- Planning: "Every AC has a corresponding implementation step"
- Implementation: "Code compiles without errors"
- Verification: "All tests pass and every AC is checked off"

### Automated Gate Commands

Phases can define a `gate-command` — a shell command that must exit 0 for the gate to pass:

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
```

**Gate-commands are MANDATORY when defined.** The executor MUST run every `gate-command` via Bash and only proceed on exit 0. Self-assessment alone is never sufficient. On failure, follow `on-failure` (retry or CRP). When no `gate-command` is defined, note "no automated gate available" in the MRP under the relevant criterion.

### Escalation Rules

LoopScripts define when an agent must pause and create a CRP. These augment the standard CRP triggers (see Guidance Engineering) with phase-specific rules — e.g., during Planning, escalate if estimated scope exceeds the BP.

### N-Version Verification

For high-rigor missions, the LoopScript can specify multiple agents executing independently. Each follows the same LoopScript but produces an independent implementation. Results compared via `/compare` to catch design blind spots.

### LoopScript Visibility by Tier

| Tier | LoopScript Behavior |
|---|---|
| **Tier 1** | No LoopScript referenced. Agent follows phases internally. |
| **Tier 2** | Auto-selected by rigor; invisible to the human. |
| **Tier 3** | Full LoopScript with visible gates, customizable, monitored. |

### Pre-Built LoopScripts

- **`standard.yaml`** — Default. Five phases (Orientation, Planning, Implementation, Verification, Documentation) for `rigor: standard`.
- **`text-standard.yaml`** — Documentation/analysis/design missions. Five phases without build/compile/test gate-commands. Verification is content accuracy + structural validity for any structured outputs.
- **`high-rigor.yaml`** — Critical missions. Adds threat modeling, independent review, N-Version comparison, stricter gates (mutation testing, security scan).

Resolved at runtime from the plugin install path; not copied into projects. Projects can override by placing custom LoopScripts in their own `skills/engineering/loops/` directory.

### Template & Schema

- Template: `skills/engineering/templates/loop-script.yaml`
- Schema: `skills/engineering/schemas/loop-script.schema.json`
- Pre-built loops: `skills/engineering/loops/`

### Design Principles

1. **Every phase has a clear gate.** No "continue when ready."
2. **Uncertainty triggers CRP.** If a gate cannot be passed after a reasonable attempt, escalate.
3. **Phases are sequential.** No parallelism within a single agent.
4. **Phases are scoped.** Bounded objective per phase.
5. **Gates are cumulative.** Later gates assume earlier ones passed.
6. **LoopScripts are reusable.** Design for a class of missions, not a single one. Mission-specific details belong in the BP.

### When to Create a Custom LoopScript

- Domain-specific phases (data migration, infrastructure provisioning)
- Standard gates insufficient (compliance requirements)
- Phase ordering must differ
- Additional verification steps beyond standard testing

Always base custom LoopScripts on `templates/loop-script.yaml` and `loops/standard.yaml`.

---

## Mentorship Engineering

Mentorship Engineering (formerly ATME) is the discipline of codifying engineering standards, team conventions, and behavioral rules that agents must follow. MentorScripts encode what a senior engineer would tell a new team member on day one.

### Rules with IDs

Every rule has a unique ID `R-NNN`. This enables precise referencing in CRPs, MRPs, and VCRs. When an agent flags a violation or a coach reviews compliance, both can point to the exact rule.

### Severity Levels

| Severity | Meaning |
|---|---|
| **mandatory** | Must be followed. Violation is a gate failure. No exceptions without a VCR. |
| **recommended** | Should be followed. Agent may deviate with documented rationale in the MRP. |

### Applies-To Scope

- **global** — All missions, all code
- **language:{lang}** — Specific language only
- **module:{name}** — Specific module/directory only
- **phase:{name}** — Specific LoopScript phase only

### Rule Format

```
### R-NNN: Rule Title

**Severity:** mandatory | recommended
**Applies-to:** global | language:typescript | module:auth | phase:implementation

Description of the rule. Be specific and actionable. Include examples of
correct and incorrect behavior where helpful.
```

Example:

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
```

### Files

- **`mentorscripts/global.md`** — Project-wide rules, loaded at startup by every agent (referenced from the root MentorScript in `CLAUDE.md`).
- **`mentorscripts/team.md`** — Team roles (Author, Contributor, Approver, Reviewer, Dispatcher), review policies (`any-1`, `any-2`, `all`), CRP routing, the authorization matrix for status transitions, stale-lock policy, branch and commit conventions.
- Mission-specific rules can be added via additional MentorScripts referenced in the BP.

### Template & Schema

- Template: `skills/engineering/templates/mentor-script.md`
- Schema: `skills/engineering/schemas/mentor-script.schema.json`

### Lifecycle

1. **Proposed** — A new rule is drafted (often from a CRP generalization via `/resolve-crp`).
2. **Active** — Rule is in the MentorScript and enforced.
3. **Deprecated** — Marked as no longer applicable (kept for audit, with deprecation note).

### When to Add a Rule

- A CRP resolution reveals a decision that should apply to future missions
- A code review finds a recurring issue across missions
- A new team convention is established
- A security or compliance requirement is introduced

**Inline CRPs cannot generate rules.** Only formal CRPs (blocking or deferred mode) produce auditable artifacts and can be generalized via `/resolve-crp`. If a pattern from an inline CRP warrants a rule, file a formal CRP retroactively.

### Best Practices

- Keep rules atomic — one concept per rule
- Include examples of correct AND incorrect behavior
- Reference external documentation where applicable
- Use `mandatory` sparingly — too many mandatory rules create excessive CRPs
- Review periodically to prune outdated rules
- When a rule is added from a CRP, include the CRP ID for traceability

### MentorScript Compliance in MRPs

The MRP "SE Hygiene" criterion includes MentorScript compliance. The agent must:
1. List all applicable rules
2. Confirm compliance or document justified deviations
3. Reference rule IDs for any flagged items

`/review-mrp` can automatically check compliance against mandatory rules.

---

## Guidance Engineering

Guidance Engineering (formerly AGE) governs structured communication between human (Agent Coach) and AI Teammate through three artifact types: agents ask questions (CRP), agents present results (MRP), and coaches record decisions (VCR). Together they form a fully auditable decision trail.

### CRP — Consultation Request Pack

A CRP is a structured question from an agent. Created when the agent encounters a situation it cannot or should not resolve independently.

- Template: `skills/engineering/templates/crp.md`
- Schema: `skills/engineering/schemas/crp.schema.json`
- Storage: `artifacts/guidance/crp/`
- Resolved via: `/resolve-crp`

#### CRP Triggers

| Trigger | Description | Mode |
|---|---|---|
| **API/Schema Change** | Public API, DB schema, or contract that consumers depend on | Blocking |
| **Security** | Auth, authz, crypto, data privacy | Blocking |
| **Scope Deviation** | Work needed exceeds BP description | Blocking |
| **Cross-Scope Reversal** | Decision conflicts with a sibling BP | Blocking |
| **Multi-Approach Ambiguity** | ≥2 valid approaches with materially different trade-offs | Deferred |
| **Data-Destructive** | Possible data loss, silent corruption, irreversible state changes | Blocking |
| **Dependency Change** | Add/remove/major-upgrade external dependency | Deferred |
| **Observable Behavior Change** | Modify user-visible output, errors, logs not specified by BP | Deferred |
| **Conflict** | MentorScript ↔ BP, or rule ↔ rule | Deferred |

#### CRP Structure

```yaml
schema: sase/crp/v1
id: "{12-char-hex-hash}"
raised-by: "{agent-id}"
routed-to: "{reviewer-or-role}"
bp: "{bp-hash}"
briefing-pack: "{bp-hash}"
phase: "{current LoopScript phase}"
mode: "blocking|deferred|inline"
urgency: "high|medium|low"
status: "open"
created: "YYYY-MM-DD"
```

**Routing.** CRPs are routed by domain expertise. See `mentorscripts/team.md` for the table. Examples: Security → security reviewer; API/schema → architecture reviewer; Scope deviation → agent coach (default).

Body sections:
- **Question** — The specific decision needed
- **Context** — What the agent knows, what it has tried, code references
- **Options** — Enumerated options with pros/cons and the agent's assessment
- **Recommendation** — The agent's preferred option (if any) with rationale

#### CRP Modes

| Mode | When | Agent Behavior | File? |
|---|---|---|---|
| **Blocking** | API changes, security, scope deviation, cross-scope reversal | Pause; await resolution via `/resolve-crp` | Yes |
| **Deferred** | Non-critical ambiguity, multi-approach trade-offs, rule conflicts | Pick best option, continue, flag in MRP | Yes |
| **Inline** | Minor clarifications resolved in the current turn | Ask conversationally; continue without interruption | No |

- **Deferred blast-radius limit:** A provisional decision affecting >200 LOC or >3 files **auto-escalates to blocking**. Deferred mode is for contained decisions, not architectural choices.
- **Inline budget:** Maximum 3 per mission. The 4th must be a formal deferred CRP. All inline decisions must be listed in the MRP.

### MRP — Mission Review Protocol

The agent's completion report. Presents deliverables and argues the mission is done according to the BP.

- Template: `skills/engineering/templates/mrp.md`
- Schema: `skills/engineering/schemas/mrp.schema.json`
- Storage: `artifacts/guidance/mrp/`
- Reviewed via: `/review-mrp`

#### MRP 5 Criteria

| # | Criterion | What it measures |
|---|---|---|
| 1 | **Functional Completeness** | Every AC met with evidence |
| 2 | **Sound Verification** | Tests exist, pass, cover changes; Gotchas-edge-cases addressed |
| 3 | **SE Hygiene** | MentorScript rules followed; clean naming; no debug artifacts |
| 4 | **Clear Rationale** | Design decisions explained; deviations justified; CRPs referenced |
| 5 | **Full Auditability** | Complete trail from BP through implementation to MRP |

#### MRP Structure

```yaml
schema: sase/mrp/v1
id: "{12-char-hex-hash}"
produced-by: "{agent-id}"
bp: "{bp-hash}"
briefing-pack: "{bp-hash}"
created: "YYYY-MM-DD"
reviewers: ["{reviewer-1}", "{reviewer-2}"]
```

**Multi-Reviewer Workflow:** MRPs are assigned reviewers based on the BP's `rigor`:
- `rigor: standard` → policy `any-1` (any single reviewer approves)
- `rigor: high` → policy `any-2` (two must approve)
- `rigor: critical` → policy `all` (all designated must approve)

Each reviewer submits an independent VCR. The MRP is approved only when policy is satisfied.

Body sections:
- **Summary** — What was accomplished
- **AC Checklist** — Each AC with pass/fail and evidence
- **Verification** — Tests run, coverage, results
- **Design Decisions** — Key choices and rationale
- **MentorScript Compliance** — Rule-by-rule
- **CRP References** — All CRPs raised with resolution links
- **Risks and Notes** — Anything the coach should know

### VCR — Version Control Record

The coach's recorded decision. Every CRP resolution and every MRP review produces a VCR. **Append-only**, never modified after creation.

- Template: `skills/engineering/templates/vcr.md`
- Schema: `skills/engineering/schemas/vcr.schema.json`
- Storage: `artifacts/guidance/vcr/`

#### VCR Types

| Type | Created when | Records |
|---|---|---|
| `crp-response` | Coach resolves a CRP via `/resolve-crp` | Chosen option and rationale |
| `mrp-approval` | Coach approves an MRP via `/review-mrp` | Approval with criteria assessment |
| `mrp-rejection` | Coach rejects an MRP | Rejection reason and failed criteria |
| `mrp-revision` | Coach requests MRP revision | What must be changed and why |

#### VCR Structure

```yaml
schema: sase/vcr/v1
id: "{12-char-hex-hash}"
type: "crp-response|mrp-approval|mrp-rejection|mrp-revision"
created: "YYYY-MM-DD"
author: "{reviewer-id or agent-coach}"
references:
  crp: "{crp-hash}"        # for crp-response
  mrp: "{mrp-hash}"        # for mrp-* types
  briefing-pack: "{bp-hash}"
decision: |
  {The decision made}
rationale: |
  {Why this decision was made}
```

### The Guidance Loop

```
Agent Coach                          AI Teammate
    |                                     |
    |  -- dispatch (BP) -->               |
    |                                     | [creates branch: agent/{id}/{bp-hash}]
    |                                     | [commit: claim()]
    |                                     |
    |                                     | [works through LoopScript on branch]
    |                                     | [periodic commit: heartbeat()]
    |                                     |
    |  <-- blocking CRP (question) --     | [PAUSED, stale-exempt while CRP open]
    |                                     |
    |  -- VCR (answer) -->                |
    |                                     | [continues work on branch]
    |                                     |
    |  <-- deferred CRP (logged) --       | [continues with provisional choice]
    |                                     |
    |  <-- MRP (done) --                  | [commit: complete()]
    |                                     |
    |  -- VCR (approve/reject) -->        | [reviewer(s) assess per review policy]
    |                                     |
    |  [on approval: merge branch]        | [commit: merge()]
```

This loop ensures: the agent never guesses on critical decisions; the coach always has full context when deciding; every decision is recorded and traceable; the agent resumes immediately after receiving guidance; all work is isolated in worktrees and merged only after approval.

### Best Practices

**For CRPs**
- Be specific in the question — "Should I use X or Y?" not "What should I do?"
- Always provide options — never present an open-ended question without analysis
- Include enough context that the coach can decide without reading all the code
- Set urgency honestly — `high` means the agent is fully blocked

**For MRPs**
- Address every AC explicitly, even if just "PASS — see test X"
- Do not hide issues — partial passes beat false passes
- Link to specific files and line numbers
- Reference all CRPs raised during the mission

**For VCRs**
- Record rationale, not just the decision — future agents and coaches need to understand why
- If a CRP resolution should become a permanent rule, flag it for MentorScript generalization
- VCRs are immutable — supersede via a new VCR if a decision needs to change

---

## Blueprint Engineering

Blueprint Engineering is the discipline of abstracting concrete, project-specific BPs into reusable, parameterized templates. A Blueprint captures institutional knowledge about how to decompose and execute a class of missions — turning hard-won experience into a repeatable playbook.

The key insight: **abstraction is not deletion.** Removing all concrete details produces a useless skeleton. Good Blueprints preserve structure, methodology, quality criteria, and anonymized examples; only project-specific values become typed parameters.

### Three-Level Abstraction Model

| Level | Scope | Example |
|---|---|---|
| **methodology** | Any legacy modernization, any technology | "Reverse Engineering Pipeline" (static, semantic, knowledge, verification) |
| **technology** | Specific source/target pair, project-independent | "COBOL-to-Java Batch Conversion" (CICS mappings, DB2 retention, copybook handling) |
| **project** | Project-template with many parameters | "VGH Insurance Migration — PoC Slice" (specific program lists, LOC counts) |

Higher levels are more reusable; lower levels more actionable. A tree may mix levels (methodology parent with technology children).

### Blueprint Storage

```
artifacts/blueprints/{hash}-{slug}/blueprint.md
```

Display: `bp-tmpl:{hash[:6]} ({slug})`

### Parameter System

Typed placeholders replaced during instantiation:

```yaml
parameters:
  - name: LEGACY_SOURCE_PATH
    type: path
    required: true
    description: "Root directory of COBOL source code"
    example: "10-legacy/10-100k-poc-slice/"
```

| Type | Validation | Example |
|---|---|---|
| `string` | Non-empty | `"VGH Insurance Migration"` |
| `path` | Valid file/directory path | `"src/main/cobol/"` |
| `number` | Numeric value | `23` |
| `boolean` | `true` / `false` | `true` |
| `enum` | Value from `enum-values` | `"db2"` from `[db2, vsam, ims-db]` |
| `list` | Comma-separated or array | `["PROG001", "PROG002"]` |

Naming: `UPPER_SNAKE_CASE`, pattern `^[A-Z][A-Z0-9_]*$`.

### Placeholder Syntax

In the body, parameters are referenced as `{{PARAMETER_NAME}}`:

```markdown
Perform reverse engineering of the {{DB_TECHNOLOGY}}-based COBOL codebase at
`{{LEGACY_SOURCE_PATH}}` for {{PROGRAM_COUNT}} programs.
```

### Conditional Sections

```markdown
{% if HAS_CENTRAL_DATA_HANDLER %}
## Data Handler Analysis
Analyze the central data abstraction layer at `{{DATA_HANDLER_PATH}}`...
{% endif %}
```

Supported (minimal, no external template engine):
- `{% if PARAM %}...{% endif %}`
- `{% if not PARAM %}...{% endif %}`

### Provenance Tracking

```yaml
provenance:
  source-bp: "53fcbce07bf1"
  source-slug: "cobol-extraction"
  source-mission: "Comprehensive COBOL Reverse Engineering"
  extracted-date: 2026-04-10
  extracted-by: "Thorsten Maier"
```

Lets users assess how much they can trust a Blueprint — what scope it was validated on, who created it.

### Anonymized Examples

When extracting, concrete examples are preserved but anonymized:
- Program names: `LNN0134F` → `PROG001`, `DMDH001P` → `HANDLER001`
- File paths: replaced with `{{PARAM}}` placeholders
- Numbers: replaced with size classes or parameters
- Business logic: structure preserved, specifics generalized

### Extraction (`/blueprint extract`)

1. **Auto-Analysis** — Script scans the BP tree, classifies segments, suggests parameters with types
2. **User Refinement** — Review suggestions, adjust parameters, set abstraction level, add tags
3. **Generation** — Produce the Blueprint tree with placeholders and provenance

#### Classification Heuristics

| Pattern | Classification | Suggested Type |
|---|---|---|
| File paths (`scripts/...`, `src/...`) | Project-specific | `path` |
| 12-char hex IDs | Always replace | (internal) |
| Numbers in LOC/count context | Project-specific | `number` |
| COBOL program names (`[A-Z]{2,}[0-9]{2,}`) | Project-specific | `string` or `list` |
| Technology keywords (FastAPI, DB2, CICS) | Technology-level | `enum` |
| Team/person names | Project-specific | `string` |

### Instantiation (`/blueprint instantiate`)

1. **Parameter Collection** — Walk through each parameter, collect values
2. **Validation** — Required parameters present, types correct
3. **BP Generation** — Replace placeholders, evaluate conditionals, generate new BP tree with fresh IDs
4. **Output** — New BP tree under `artifacts/briefings/` with `status: draft`

### Template & Schema

- Template: `skills/engineering/templates/blueprint.md`
- Schema: `skills/engineering/schemas/blueprint.schema.json`

### Quality Criteria

A Blueprint is ready when:

1. **All parameters documented** — Every `{{PARAM}}` has a corresponding entry with type, description, example
2. **No orphaned placeholders** — No `{{PARAM}}` without a parameter definition
3. **No unused parameters** — No parameter without at least one `{{PARAM}}` reference
4. **Valid conditional syntax** — Every `{% if %}` has a matching `{% endif %}`
5. **Complete provenance** — Source BP, extraction date, extractor recorded
6. **Anonymized examples present** — At least one concrete example preserved in anonymized form
7. **Correct metadata** — Hash valid, slug valid, version SemVer, abstraction level set

### Blueprint Anti-Patterns

- **Naked Template** — Too many details removed; empty skeleton.
- **Over-Parameterized Blueprint** — Every sentence has a placeholder. >15 parameters → too specific for the abstraction level; consider splitting or raising the level.
- **Copy-Paste Blueprint** — Concrete project details left in by accident. Always validate with `/blueprint validate`.
- **Parameter Soup** — Unclear names or missing examples. `{{BATCH_SCHEDULING_STRATEGY}}` without an example is unusable.

### Hierarchical Blueprints

```
artifacts/blueprints/
  .index.json                      # Auto-generated index
  {hash}-{slug}/
    blueprint.md                   # Root blueprint
    {hash}-{slug}/
      blueprint.md                 # Child blueprint (mirrors BP hierarchy)
```

Hierarchical Blueprints mirror the BP decomposition pattern: a parent with `execution-order` and child Blueprint subdirectories, each producing a child BP on instantiation.
