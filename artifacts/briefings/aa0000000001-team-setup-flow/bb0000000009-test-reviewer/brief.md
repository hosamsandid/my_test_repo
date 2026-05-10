---
id: bb0000000009
title: "Test Reviewer"
slug: test-reviewer
status: ready
rigor: high
depends_on:
  - bb0000000005
  - bb0000000006
artifacts:
  - path: artifacts/output/pull-requests/feature-pr.md
    direction: input
    description: "Feature PR mit Implementierung"
  - path: artifacts/output/test-plans/test-plan.md
    direction: input
    description: "Testplan des Quality Engineers als Referenz"
  - path: artifacts/output/reviews/test-review.md
    direction: output
    description: "Test-Review mit Coverage-Bewertung und fehlenden Testfällen"
---

# Test Reviewer

## Rolle

**Test-Coverage-Reviewer**. Prüft ob der PR ausreichend getestet ist — vergleicht
die Implementierung mit dem QE-Testplan und identifiziert fehlende Tests.

## Auslöser

`github-event: pull_request.opened` und `pull_request.reopened`.
`from: any-except-self`. Parallel zu Code/Security/Performance Reviewer.

## Aufgabe

1. Diff und bestehende Tests lesen
2. QE-Testplan vom Issue abrufen (falls vorhanden)
3. Testlücken identifizieren: Welche ACs haben keine Tests?
4. Konkrete Testfälle als Mini-Code-Snippets vorschlagen
5. Bei fehlenden kritischen Tests: `request-changes`

## Agent-Konfiguration

```json
{
  "sessionPolicy": "per-invocation",
  "trigger": {
    "type": "github-event",
    "events": ["pull_request.opened", "pull_request.reopened"],
    "from": "any-except-self"
  }
}
```

## Acceptance Criteria

- [ ] Jede Acceptance Criteria hat mindestens einen Unit-Test
- [ ] Edge Cases aus dem QE-Testplan sind abgedeckt
- [ ] Vorgeschlagene Tests sind konkret (Datei + Testname + Beispiel-Code)
- [ ] Kein Bestehen auf 100% Coverage wenn der Code trivial ist

## Abhängigkeiten

**Upstream:** Developer (`bb0000000005`), Quality Engineer (`bb0000000006`)

**Downstream:** Documentation Sync (`bb000000000c`)
