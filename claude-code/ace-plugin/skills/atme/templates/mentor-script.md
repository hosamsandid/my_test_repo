---
schema: sase/mentor-script/v1
id: "MS-{{NAME}}-v1"
applies-to: "{{all|bp-hash|project-pattern}}"
---

# {{NAME}} MentorScript

<!-- Describe the purpose of this MentorScript:
     - Which area/project does it apply to?
     - What kind of rules does it contain?
     MentorScripts define rules that agents must follow during their work. -->

{{DESCRIPTION}}

---

## Mandatory Rules

<!-- Mandatory Rules MUST be followed. A violation leads to rejection of the MRP.
     Format: R-XXX with ascending numbering.
     Mandatory Rules typically: R-001 to R-099 -->

### R-001: {{RULE_TITLE}}

**Severity:** mandatory

<!-- Describe the rule clearly and unambiguously.
     - What exactly is required?
     - Why is this rule important?
     - How is compliance verified? -->

{{RULE_DESCRIPTION}}

- {{SPECIFIC_REQUIREMENT_1}}
- {{SPECIFIC_REQUIREMENT_2}}
- {{SPECIFIC_REQUIREMENT_3}}

### R-002: {{RULE_TITLE}}

**Severity:** mandatory

{{RULE_DESCRIPTION}}

- {{SPECIFIC_REQUIREMENT_1}}
- {{SPECIFIC_REQUIREMENT_2}}

---

## Recommended Rules

<!-- Recommended Rules SHOULD be followed. Deviations are acceptable,
     but must be justified in the MRP.
     Recommended Rules typically: R-100 to R-199 -->

### R-100: {{RULE_TITLE}}

**Severity:** recommended

{{RULE_DESCRIPTION}}

- {{SPECIFIC_REQUIREMENT_1}}
- {{SPECIFIC_REQUIREMENT_2}}

---

## Project-Specific Rules

<!-- Optional: Rules that only apply to specific technologies,
     frameworks, or project areas.
     Project-Specific Rules typically: R-200+ -->

<!-- ### R-200: {{RULE_TITLE}}

**Severity:** {{mandatory|recommended}}
**Applies-to:** {{Technology or Area}}

{{RULE_DESCRIPTION}} -->
