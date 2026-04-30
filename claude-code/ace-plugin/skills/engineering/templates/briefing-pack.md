---
schema: sase/briefing-pack/v3
id: "{{HASH-12}}"
slug: "{{SLUG}}"
mission: "{{MISSION-TITLE}}"
created: "{{YYYY-MM-DD}}"
author: ["{{AUTHOR}}"]
status: draft
rigor: "{{standard|high|critical}}"
depends-on: []
execution-order: []
loop-script: "skills/engineering/loops/standard.yaml"
mentor-scripts:
  - "mentorscripts/global.md"
reviewers: []
approver: ""
artifacts: []
# Example artifact entries:
#   - path: "path/to/input/file"
#     direction: input
#     description: "What this input provides"
#   - path: "path/to/output/file"
#     direction: output
#     ac: "AC-1"
#     description: "What this output contains"
#     verify-command: "command that exits 0 if artifact is valid"
---

# Mission: {{TITLE}}

## Goal & Why

<!-- Describe the goal and the motivation.
     - What should be achieved?
     - What problem is being solved?
     - What value does the change deliver?
     Keep the description concrete and measurable. -->

{{GOAL_DESCRIPTION}}

## Acceptance Criteria

<!-- Verifiable checklist. Each criterion must be binary (pass/fail).
     For parent BPs: ACs are considered met when all child BPs are completed. -->

- [ ] {{AC-1: Description of the first criterion}}
- [ ] {{AC-2: Description of the second criterion}}
- [ ] {{AC-3: Description of the third criterion}}

## Context

<!-- BP-specific context.
     Which files, modules, APIs are relevant for THIS BP?
     Context from parent BPs is inherited via directory traversal. -->

- Files: {{FILE_PATHS}}
- Modules: {{MODULE_NAMES}}
- APIs: {{API_REFERENCES}}

## Constraints

<!-- Human-authored, always binding.
     Business rules, technology mandates, performance budgets, organizational context.
     The agent MUST respect these. Deviations require a CRP. -->

{{CONSTRAINTS_DESCRIPTION}}

## Approach

<!-- Implementation strategy. Can be human-authored or agent-proposed.
     If left empty, the agent proposes during Plan phase.
     The agent may deviate with justification in the MRP. -->

{{APPROACH_DESCRIPTION}}

## Gotchas

<!-- Known pitfalls. Each gotcha saves the agent a CRP. -->

- {{GOTCHA-1}}
- {{GOTCHA-2}}

## Escalation Triggers

<!-- Situations in which the agent MUST create a CRP. -->

- When unclear about {{AREA}} -> create CRP
- When modifying {{CRITICAL_COMPONENT}} -> create CRP
- When making security-relevant decisions -> create CRP

<!-- Note: Child BPs are subdirectories of this BP's directory.
     Use `execution-order` in frontmatter to define sequencing. -->
