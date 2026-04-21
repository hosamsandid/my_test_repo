---
schema: sase/vcr/v1
id: "{{HASH-12}}"
resolves: "{{CRP-or-MRP-HASH}}"
resolved-by: "{{TEAM-MEMBER}}"
decision-type: "{{crp-response|mrp-approval|mrp-rejection|mrp-revision}}"
---

# Validated Clarification Response

## Decision — Clear statement

<!-- Formulate the decision clearly and unambiguously.
     The agent must immediately understand what to do.
     Avoid vague phrasing like "maybe" or "possibly". -->

{{DECISION}}

## Rationale — Why (auditable)

<!-- Justify the decision in a traceable manner:
     - Why was this option chosen?
     - Which factors were decisive?
     - This rationale serves auditability and must
       be understandable to third parties as well. -->

{{RATIONALE}}

## Instructions — Next steps for the agent

<!-- Give the agent clear action instructions:
     - What exactly should be implemented?
     - Are there additional constraints?
     - Are there aspects that require special attention?
     The agent implements these instructions directly. -->

1. {{STEP_1}}
2. {{STEP_2}}
3. {{STEP_3}}
