---
schema: sase/mrp/v1
id: "{{HASH-12}}"
bp: "{{BP-HASH}}"
status: pending-review
tier: "{{quick|standard|mission}}"
auto-score: "{{0-100}}"
produced-by: "{{AGENT-ID}}"
reviewed-by: []
approved-by: ""
---

<!-- Tier 1 (quick): Only sections 1 and 4 required (inline summary).
     Tier 2 (standard): All 5 sections, compact format.
     Tier 3 (mission): All 5 sections, full detail. -->

# Mission Result Package

## 1. Functional Completeness — AC-Checklist + Evidence

<!-- Go through each Acceptance Criterion from the BriefingPack.
     Mark it as fulfilled and provide evidence (test output, screenshot, log).
     Unfulfilled ACs must be justified (with CRP reference). -->

| AC  | Description | Status | Evidence |
|-----|-------------|--------|---------|
| AC-1 | {{DESCRIPTION}} | {{done/partial/open}} | {{EVIDENCE}} |
| AC-2 | {{DESCRIPTION}} | {{done/partial/open}} | {{EVIDENCE}} |
| AC-3 | {{DESCRIPTION}} | {{done/partial/open}} | {{EVIDENCE}} |

## 2. Sound Verification — Test-Summary + Coverage + Commands

<!-- Document the verification performed:
     - Which tests were executed?
     - What is the test coverage?
     - Which commands reproduce the results? -->

**Test-Summary:**

{{TEST_SUMMARY}}

**Coverage:**

{{COVERAGE_VALUE}}

**Reproducible Commands:**

```bash
{{TEST_COMMANDS}}
```

## 3. SE Hygiene — Linting, Formatting, MentorScript-Compliance

<!-- Document compliance with engineering standards:
     - Linting: no warnings/errors
     - Formatting: consistent with project standard
     - MentorScript-Compliance: all mandatory rules followed -->

- **Linting:** {{LINTING_STATUS}}
- **Formatting:** {{FORMATTING_STATUS}}
- **MentorScript-Compliance:**
  - R-001 Test Coverage: {{STATUS}}
  - R-002 Error Handling: {{STATUS}}
  - R-003 Security: {{STATUS}}
  - R-004 Code Review: {{STATUS}}
  - R-030 CRP Creation: {{STATUS}}

## 4. Clear Rationale — Decisions, CRP references, deviations

<!-- Document all decisions and deviations:
     - Which design decisions were made and why?
     - Which CRPs were created and how were they decided?
     - Are there deviations from the BriefingPack plan? -->

**Decisions:**

- {{DECISION_1}}: {{RATIONALE}}

**CRP References:**

- {{CRP-HASH}}: {{BRIEF_DESCRIPTION}} — {{DECISION}}

**Deviations from Plan:**

- {{DEVIATION}}: {{RATIONALE}}

## 5. Full Auditability — git diff --stat, Commit-History, BriefingPack-Link

<!-- Ensure complete traceability:
     - git diff --stat for an overview of changed files
     - Commit history with links
     - Reference to the underlying BriefingPack -->

**BriefingPack:** {{BP-HASH}}

**git diff --stat:**

```
{{GIT_DIFF_STAT}}
```

**Commit-History:**

```
{{COMMIT_HISTORY}}
```
