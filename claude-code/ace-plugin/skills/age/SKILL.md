---
name: "AGE"
description: "Agentic Guidance Engineering — Managing CRPs, MRPs, and VCRs"
---

# Skill: AGE — Agentic Guidance Engineering

## Purpose

Agentic Guidance Engineering is the discipline of structured communication between human (Agent Coach) and AI Teammate through typed guidance artifacts. AGE defines the three artifact types that form the feedback loop: agents ask questions (CRP), agents present results (MRP), and coaches record decisions (VCR). Together, these create a fully auditable decision trail.

## Key Concepts

### CRP — Consultation Request Pack

A CRP is a structured question from an agent to the Agent Coach. It is created when the agent encounters a situation it cannot or should not resolve independently.

**Template:** `skills/age/templates/crp.md`
**Storage:** `artifacts/guidance/crp/`
**Resolved via:** `/resolve-crp`

#### CRP Triggers

An agent **must** create a CRP when any of these structural conditions apply:

| Trigger                      | Description                                                                         | CRP Mode     |
|------------------------------|-------------------------------------------------------------------------------------|--------------|
| **API/Schema Change**        | Any change to a public API surface, database schema, or contract that consumers depend on. | Blocking     |
| **Security**                 | Any decision involving authentication, authorization, cryptography, or data privacy. | Blocking     |
| **Scope Deviation**          | The work needed exceeds what the BP describes. New requirements are emerging.        | Blocking     |
| **Cross-Scope Reversal**     | A decision that would reverse or conflict with a sibling BP's deliverables.          | Blocking     |
| **Multi-Approach Ambiguity** | Two or more valid approaches exist with materially different trade-offs and no clear winner. | Deferred     |
| **Data-Destructive**         | Changes that could cause data loss, silent data corruption, or irreversible state changes -- even without schema changes. | Blocking     |
| **Dependency Change**        | Adding, removing, or upgrading (major version) any external dependency.              | Deferred     |
| **Observable Behavior Change** | Modifying user-visible output, error messages, log formats, or response structure not explicitly specified by the BP. | Deferred     |
| **Conflict**                 | MentorScript rules conflict with BP instructions, or two rules contradict.           | Deferred     |

#### CRP Structure

```yaml
schema: sase/crp/v1
id: "{12-char-hex-hash}"          # generated via: openssl rand -hex 6
raised-by: "{agent-id}"           # the agent that created this CRP
routed-to: "{reviewer-or-role}"   # who should resolve (e.g. "security-reviewer", "agent-coach")
bp: "{bp-hash}"
briefing-pack: "{bp-hash}"
phase: "{current LoopScript phase}"
mode: "blocking|deferred|inline"
urgency: "high|medium|low"
status: "open"
created: "YYYY-MM-DD"
```

**CRP Routing (`routed-to` field):**
CRPs are routed based on domain expertise. See `mentorscripts/team.md` for the routing table. Examples:
- Security CRPs -> security reviewer
- API/schema CRPs -> architecture reviewer
- Scope deviation CRPs -> agent coach (default)

Body sections:
- **Question**: The specific decision the agent needs help with
- **Context**: What the agent knows, what it has tried, relevant code references
- **Options**: Enumerated options with pros/cons and agent's assessment
- **Recommendation**: The agent's preferred option (if any) with rationale

#### CRP Modes

| Mode         | When Used                                                        | Agent Behavior                                                  | File Created? |
|--------------|------------------------------------------------------------------|-----------------------------------------------------------------|---------------|
| **Blocking** | Critical decisions: API changes, security, scope deviation, cross-scope reversal. | Agent **pauses** the current phase and waits for resolution.    | Yes           |
| **Deferred** | Non-critical ambiguity: multi-approach trade-offs, rule conflicts. | Agent picks its best option, continues working, flags for review in MRP. | Yes           |
| **Inline**   | Minor clarifications resolved within the current conversation turn. | Agent asks, receives answer, continues without interruption.    | No            |

- **Blocking** CRPs halt execution. The Agent Coach resolves them via `/resolve-crp`.
- **Deferred** CRPs are logged as files but do not halt execution. The agent documents its provisional choice. The coach reviews deferred CRPs during MRP review. **Blast-radius limit:** If a provisional decision would affect more than ~200 LOC or spread across more than 3 files, auto-escalate to blocking. Deferred mode is for contained decisions, not architectural choices.
- **Inline** CRPs are conversational — no file is created, no formal artifact. They are suitable only for low-impact clarifications within an active session. **Budget:** Maximum 3 inline CRPs per mission. The 4th must be a formal deferred CRP. All inline decisions must be listed in the MRP.

### MRP — Mission Review Protocol

An MRP is the agent's completion report. It presents the deliverables and argues that the mission is done according to the BriefingPack.

**Template:** `skills/age/templates/mrp.md`
**Storage:** `artifacts/guidance/mrp/`
**Reviewed via:** `/review-mrp`

#### MRP 5 Criteria

Every MRP is evaluated against these five criteria:

| # | Criterion                  | What it measures                                                   |
|---|----------------------------|--------------------------------------------------------------------|
| 1 | **Functional Completeness** | All Acceptance Criteria from the BP are met. Every AC is checked off with evidence. |
| 2 | **Sound Verification**      | Tests exist, pass, and cover the changes adequately. Edge cases from Gotchas are addressed. |
| 3 | **SE Hygiene**              | Code follows MentorScript rules. No debug artifacts, clean naming, proper documentation. |
| 4 | **Clear Rationale**         | Design decisions are explained. Deviations from Strategy are justified. CRP references included. |
| 5 | **Full Auditability**       | Complete trail from BP through implementation to MRP. All CRPs referenced and resolved. |

#### MRP Structure

```yaml
schema: sase/mrp/v1
id: "{12-char-hex-hash}"          # generated via: openssl rand -hex 6
produced-by: "{agent-id}"         # the agent that created this MRP
bp: "{bp-hash}"
briefing-pack: "{bp-hash}"
created: "YYYY-MM-DD"
reviewers: ["{reviewer-1}", "{reviewer-2}"]   # assigned reviewers
```

**Multi-Reviewer Workflow:**
MRPs can be assigned to multiple reviewers based on the BP's `rigor` level:
- `rigor: standard` -> review policy `any-1` (any single reviewer can approve)
- `rigor: high` -> review policy `any-2` (two reviewers must approve)
- `rigor: critical` -> review policy `all` (all designated reviewers must approve)

Each reviewer submits an independent VCR. The MRP is approved only when the review policy is satisfied. See `mentorscripts/team.md` for review policy details.

Body sections:
- **Summary**: What was accomplished
- **AC Checklist**: Each AC with pass/fail and evidence
- **Verification**: Tests run, coverage, results
- **Design Decisions**: Key choices made and their rationale
- **MentorScript Compliance**: Rule-by-rule compliance or justified deviations
- **CRP References**: All CRPs raised during the mission with resolution links
- **Risks and Notes**: Anything the coach should know

### VCR — Version Control Record

A VCR is the coach's recorded decision. Every CRP resolution and every MRP review produces a VCR. VCRs are the authoritative decision trail — they are append-only and never modified after creation.

**Template:** `skills/age/templates/vcr.md`
**Storage:** `artifacts/guidance/vcr/`

#### VCR Types

| Type              | Created when                                 | Records                          |
|-------------------|----------------------------------------------|----------------------------------|
| `crp-response`    | Coach resolves a CRP via `/resolve-crp`  | The chosen option and rationale  |
| `mrp-approval`    | Coach approves an MRP via `/review-mrp`  | Approval with criteria assessment |
| `mrp-rejection`   | Coach rejects an MRP                         | Rejection reason and failed criteria |
| `mrp-revision`    | Coach requests MRP revision                  | What must be changed and why     |

#### VCR Structure

```yaml
schema: sase/vcr/v1
id: "{12-char-hex-hash}"          # generated via: openssl rand -hex 6
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

## The Guidance Loop

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
    |                                     |
```

This loop ensures:
- The agent never guesses on critical decisions
- The coach always has full context when making decisions
- Every decision is recorded and traceable
- The agent can resume work immediately after receiving guidance
- All work is isolated in agent worktrees and merged only after approval

## Best Practices

### For CRPs
- Be specific in the question — "Should I use X or Y?" not "What should I do?"
- Always provide options — never present an open-ended question without analysis
- Include enough context that the coach can decide without reading all the code
- Set urgency honestly — high means the agent is fully blocked

### For MRPs
- Address every AC explicitly, even if it is just "PASS — see test X"
- Do not hide issues — partial passes are better than false passes
- Link to specific files and line numbers for evidence
- Reference all CRPs raised during the mission

### For VCRs
- Record the rationale, not just the decision — future agents and coaches need to understand why
- If a CRP resolution should become a permanent rule, flag it for MentorScript generalization
- VCRs are immutable — if a decision needs to change, create a new VCR that supersedes the old one
