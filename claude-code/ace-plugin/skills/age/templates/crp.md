---
schema: sase/crp/v1
id: "{{HASH-12}}"
bp: "{{BP-HASH}}"
urgency: "{{blocking|high|medium|low}}"
category: "{{ambiguity|conflict|security|scope|irreversibility|architecture}}"
status: open
mode: "{{blocking|deferred|inline}}"
raised-by: "{{AGENT-ID}}"
routed-to: "{{TEAM-MEMBER or empty}}"
---

# Clarification Request Package

## Question — Clear, specific question

<!-- Formulate a precise, answerable question.
     Avoid vague phrasing. The question should be stated such that
     a clear decision can be given as an answer. -->

{{QUESTION}}

## Context — What the agent was doing

<!-- Describe the current state of work:
     - Which phase of the LoopScript are you in?
     - What has been implemented so far?
     - What led to the uncertainty?
     The reviewer needs enough context for an informed decision. -->

{{CONTEXT}}

## Options — Decision options

### Option A: {{OPTION_A_TITLE}}

- **Description:** {{DESCRIPTION_A}}
- **Pros:** {{PROS_A}}
- **Cons:** {{CONS_A}}
- **Confidence:** {{CONFIDENCE_A}}%

### Option B: {{OPTION_B_TITLE}}

- **Description:** {{DESCRIPTION_B}}
- **Pros:** {{PROS_B}}
- **Cons:** {{CONS_B}}
- **Confidence:** {{CONFIDENCE_B}}%

## Agent Recommendation — Preference + rationale

<!-- Provide a justified recommendation:
     - Which option do you prefer and why?
     - What prevented you from making an independent decision?
     The reviewer can adopt or override your recommendation. -->

**Recommendation:** Option {{A|B}}

**Rationale:** {{RATIONALE}}

## Impact of Delay

<!-- Describe the impact if this question is not answered promptly:
     - What work is blocked?
     - Are there workarounds?
     - How urgent is the answer? -->

{{IMPACT_DESCRIPTION}}

## Provisional Decision (deferred mode only)

<!-- If mode=deferred: Document the decision you are proceeding with.
     This will be reviewed during MRP review.
     If mode=blocking or inline: Remove this section. -->

{{PROVISIONAL_DECISION}}
