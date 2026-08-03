# Banking / Insurance Use Case: Regulatory Change Management

## 1. Chosen Workflow and Rationale

**Selected workflow: Regulatory Change Management**

Of the four candidate workflows evaluated in the issue:

| Workflow | AEE Fit | Reason for ranking |
|---|---|---|
| **Regulatory Change Management** | **High** | Closest structural parallel to SDLC; clear sequential gates; low sensitivity around agent messaging |
| Audit Preparation | High | Equally document-driven, but typically event-driven less frequently and with less automation potential |
| Claims Triage and Processing | Medium | High volume but claims data sensitivity requires strong isolation design before templating |
| Underwriting Support | Medium | Document-heavy but actuarial data access requirements are domain-specific and hard to template generically |

Regulatory Change Management is selected because:

- **Structural isomorphism with SDLC.** A regulatory change arriving → policy draft produced → review by compliance → legal sign-off → publication is a one-to-one analogue of issue → feature branch → code review → security approval → merge. The existing platform primitives map directly without requiring new engine features.
- **Recurring, predictable cadence.** Regulatory bodies publish update cycles (EBA, BaFin, PRA quarterly reviews). This maps well to the AEE trigger model (timer-based or document-submission events).
- **Compliance audit trail built-in.** Every agent handover, comment, and status change is logged in the session JSONL. This is exactly what compliance officers need: a durable, structured record of who reviewed what and when.
- **Low agent-to-agent message sensitivity.** Unlike claims data, a policy draft review thread between an analyst, an author, and a reviewer does not expose personal customer data — it contains internal policy text, which is a better starting point for the first non-SDLC template.

---

## 2. Stakeholder Narrative

> *As a compliance officer at a mid-size European bank, I need to track regulatory updates from the EBA and translate them into approved internal policy amendments within our 90-day implementation window. Today I chase Word documents across email threads, chase reviewers in meetings, and hand-deliver the final signed PDF to the document management system. I want a structured workflow where the right expert picks up each step, progress is visible, and the audit trail is automatic — without my team needing to learn a software development tool.*

The key requirements that flow from this:

- No exposure to GitHub concepts (branches, PRs, issues, labels). The language is: **regulatory item**, **policy draft**, **review**, **sign-off**, **publication**.
- The workflow initiates from a document (e.g. a regulation PDF or a summary published to a shared inbox), not from a code repository event.
- Status should be expressible in plain workflow terms: `pending`, `drafting`, `under review`, `awaiting sign-off`, `published`, `archived`.
- Reviewers comment on the *policy content*, not on code style or security vectors.

---

## 3. Agent Team Composition

### Team: `regulatory-change` (illustrative id)

| Role | Agent Id Suffix | Analogue | Responsibility |
|---|---|---|---|
| Regulatory Analyst | `-analyst` | Issue Triage / BA | Monitors for new regulations, triages impact, creates structured change requests |
| Policy Author | `-author` | Developer | Drafts the policy amendment document from the change request |
| Compliance Reviewer | `-compliance` | Code Reviewer | Reviews the draft for regulatory accuracy, internal consistency, coverage gaps |
| Legal Approver | `-legal` | Security Reviewer + final gate | Reviews for legal risk; signs off before publication |

**Handover chain:**

```
Regulatory item created (analyst)
  → Policy draft produced (author)
      → Compliance review posted (compliance reviewer)
          → Legal sign-off given (legal approver)
              → Policy published / archived
```

Each step is a discrete handover with a status transition. The agent triggering the transition posts a structured summary so the next agent has context without reading the full thread.

---

## 4. Concrete Example Run-Through

**Scenario:** The EBA publishes a new guideline on operational resilience reporting (EBA/GL/2026/04) requiring banks to update their IRRBB policy within 60 days.

1. **Regulatory Analyst** receives a trigger (timer-based scan of a regulatory feed, or a manual DM from the compliance officer with the guideline attached). It reads the document, assesses impact scope (IRRBB policy, stress-testing procedures), and creates a **regulatory item** (a GitHub issue in SDLC terms, but exposed to the user as a "change request") with:
   - Summary of the new requirement
   - Affected internal policies
   - Suggested implementation window
   - Acceptance criteria for the policy amendment

2. **Policy Author** picks up the change request and produces a draft amendment to the IRRBB policy document (checked into the repo as a Markdown or Word-equivalent file). It commits the draft and opens a **policy submission** (PR equivalent) with a link back to the change request.

3. **Compliance Reviewer** is triggered when the policy submission is opened. It reads the draft, compares against the source regulation, posts review comments on specific sections (gaps, over-interpretations, missing definitions), and requests changes or approves.

4. **Legal Approver** receives the compliance-approved submission and performs a final legal risk review: liability language, conflicts with existing agreements, enforceability. It posts a sign-off comment and approves the submission.

5. The compliance officer (human) sees the approved submission in their workflow UI, confirms publication, and the policy document is merged into the main policy repository.

**What the compliance officer sees:** A clean workflow with named stages, document-centric language, and a timeline of who reviewed what. No mention of GitHub, branches, or PRs unless the organisation explicitly uses GitHub for policy versioning.

---

## 5. Platform Adaptation: What Must Be Hidden or Made Configurable

### 5.1 Language abstraction layer (high priority)

The current platform surfaces GitHub-centric vocabulary in:
- Agent prompt templates (`"open a PR"`, `"label an issue"`, `"feature branch"`)
- The Admin Console UI (`Working Environment`, `dispatch` label, PR status badges)
- Trigger field names (`pull_request.opened`, `issues.labeled`)

For a non-SDLC domain, these must be abstracted at the template level (and optionally at the UI level):

| SDLC concept | Domain-neutral concept | Banking/Insurance label |
|---|---|---|
| Issue | Work item / change request | Regulatory item |
| Label `ready` | Workflow state: ready for work | `awaiting-author` |
| Label `dispatch` | Workflow state: dispatched | `in-progress` |
| Pull Request | Submission for review | Policy submission / draft |
| Branch | Working copy | Policy version |
| Commit | Save revision | Version checkpoint |
| Merge | Publish | Finalize / Publish |
| Repository | Document store | Policy repository |
| Code review comment | Review comment | Review finding |

**Recommendation:** Add an optional `domainVocabulary` map to the Working Environment or team config. Prompt templates reference `{{workItemName}}`, `{{submissionName}}` etc. which are resolved from the map before being injected into the agent's CLAUDE.md.

### 5.2 Trigger types (medium priority)

The current trigger set is heavily GitHub-event driven. Non-SDLC workflows need:

| Missing trigger type | Description | Banking use case |
|---|---|---|
| `document-inbox` | Fires when a document appears in a watched directory or shared folder | Regulatory feed scan |
| `email-received` | Fires on incoming email matching a pattern (sender, subject) | Regulator notification email |
| `external-api-poll` | Generic polling trigger with a configurable URL and JSON-path match condition | EBA/BaFin API, RSS feeds |
| `manual-escalation` | Human posts a structured message in the agent's DM room to initiate a workflow | Compliance officer initiates ad-hoc review |

The `http` trigger type partially covers the `manual-escalation` case (external system posts to the webhook endpoint). The `cron` trigger partially covers `external-api-poll`. A purpose-built `external-api-poll` trigger would let non-technical operators configure a feed URL without writing a cron script.

### 5.3 Document handling (medium priority)

SDLC workflows centre on code diffs. Policy workflows centre on structured documents (Markdown, DOCX, PDF). The platform needs:

- A document attachment mechanism: agents should be able to commit binary or structured-text documents to the repo alongside code.
- Diff rendering for document formats: showing what changed between policy versions, not just code lines.
- An optional document store abstraction (an MCP server for a SharePoint/Confluence backend) so that the canonical policy source can live outside GitHub if the organisation requires it.

### 5.4 Role and persona language (low priority, high visibility)

The Admin Console's agent list currently shows roles like "Developer", "Code Reviewer". For a banking deployment these should be relabeled. This is already partially addressed by `displayName` in the template schema — operators set the display name to domain language when creating the team.

What is missing:
- A `domain` field on the team config to select a pre-built vocabulary set (e.g. `domain: "regulatory"` sets default label names, trigger descriptions, and help text).
- The Agent Team Wizard should surface domain selection as the first step, driving downstream defaults.

### 5.5 Isolation and data handling (high priority for production)

Claims and underwriting workflows (medium-fit candidates) require stronger data isolation:
- Per-agent encrypted workspaces for PII
- Audit-log export to SIEM (the session JSONL is the right source; needs an export connector)
- Role-based access to the Admin Console (who can read agent logs, who can trigger a run)

These are not blockers for the Regulatory Change Management use case (policy text is internal but not PII), but they must be addressed before AEE is positioned for claims or underwriting.
