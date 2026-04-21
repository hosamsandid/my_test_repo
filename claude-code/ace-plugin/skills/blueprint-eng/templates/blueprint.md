---
schema: sase/blueprint/v1
id: "{{HASH-12}}"
slug: "{{SLUG}}"
title: "{{BLUEPRINT-TITLE}}"
version: "1.0.0"
abstraction-level: "{{methodology|technology|project}}"
parameters:
  - name: "{{PARAM_NAME}}"
    type: "string"
    required: true
    description: "{{PARAM_DESCRIPTION}}"
    example: "{{EXAMPLE_VALUE}}"
created: "{{YYYY-MM-DD}}"
author: ["{{AUTHOR}}"]
provenance:
  source-bp: "{{SOURCE_BP_HASH}}"
  source-slug: "{{SOURCE_SLUG}}"
  source-mission: "{{SOURCE_MISSION}}"
  extracted-date: "{{YYYY-MM-DD}}"
  extracted-by: "{{AUTHOR}}"
tags: []
execution-order: []
description: "{{SHORT_DESCRIPTION}}"
instantiation-count: 0
---

# Blueprint: {{TITLE}}

## Purpose

<!-- What class of missions does this blueprint produce?
     What problem pattern does it solve?
     What was learned from the source project? -->

{{PURPOSE_DESCRIPTION}}

## Parameters

<!-- Document all parameters in a table for quick reference.
     This section is informational — the frontmatter `parameters` array is authoritative. -->

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `{{PARAM_NAME}}` | {{type}} | {{yes/no}} | {{description}} | `{{example}}` |

## Goal & Why

<!-- Use {{PARAM}} placeholders for project-specific values.
     Preserve the structural reasoning — why this goal matters. -->

{{GOAL_TEMPLATE}}

## Acceptance Criteria

<!-- Template ACs with placeholders. Each must remain binary and testable
     after instantiation. -->

- [ ] AC-1: {{AC_TEMPLATE}}
- [ ] AC-2: {{AC_TEMPLATE}}

## Context

<!-- Use {{PARAM}} placeholders for project-specific paths and modules.
     Preserve structural references (e.g., "the main entry point at {{MAIN_FILE}}"). -->

- Files: {{FILE_PATHS_TEMPLATE}}
- Modules: {{MODULE_TEMPLATE}}

## Constraints

<!-- Constraints that apply regardless of the specific project.
     Project-specific constraints use {{PARAM}} placeholders. -->

{{CONSTRAINTS_TEMPLATE}}

## Approach

<!-- Methodology and ordering that transfers across projects.
     Implementation details use {{PARAM}} placeholders. -->

{{APPROACH_TEMPLATE}}

## Gotchas

<!-- Lessons learned from the source project, generalized.
     Concrete file names replaced with {{PARAM}} placeholders. -->

- {{GOTCHA_TEMPLATE}}

## Escalation Triggers

<!-- Domain-specific CRP triggers that apply to this class of missions. -->

- {{TRIGGER_TEMPLATE}}

{% if HAS_EXAMPLES %}
## Anonymized Examples

<!-- Preserved from source BP with concrete details replaced.
     These examples show what good output looks like for this Blueprint. -->

{{EXAMPLE_CONTENT}}
{% endif %}
