---
id: bb0000000006
title: "Quality Engineer"
slug: quality-engineer
status: ready
rigor: high
depends_on:
  - bb0000000003
artifacts:
  - path: artifacts/output/issues/ready-issue.md
    direction: input
    description: "GitHub Issue mit Ready-Label als Basis für Testplan"
  - path: artifacts/output/test-plans/test-plan.md
    direction: output
    description: "Unabhängiger Testplan mit Edge Cases und Fehlerszenarien"
---

# Quality Engineer

## Rolle

**Unabhängiger Test-Stratege**. Erarbeitet Testpläne parallel zum Developer — ohne
den Code zu sehen, nur auf Basis der Acceptance Criteria.

## Auslöser

`github-event: issues.labeled` — parallel zum Developer, gleicher Auslöser.
`from: any-except-self`.

## Aufgabe

1. Issue und Acceptance Criteria lesen
2. Unabhängigen Testplan aus Nutzerperspektive erstellen
3. Edge Cases und Fehlerszenarien identifizieren (die der Developer übersehen könnte)
4. Testplan als Kommentar auf dem Issue hinterlassen
5. Nach PR-Erstellung: Testplan gegen Implementierung prüfen (via `test-reviewer`)

## Agent-Konfiguration

```json
{
  "sessionPolicy": "per-invocation",
  "trigger": {
    "type": "github-event",
    "events": ["issues.labeled"],
    "from": "any-except-self"
  }
}
```

## Acceptance Criteria

- [ ] Testplan enthält: Happy Path, Edge Cases, Error Paths
- [ ] Mindestens 3 konkrete Testfälle pro Acceptance Criterion
- [ ] Tests sind ausführbar beschrieben (Input → Expected Output)
- [ ] Testplan ist auf dem Issue als Kommentar sichtbar bevor PR geöffnet wird

## Abhängigkeiten

**Upstream:** Business Analyst (`bb0000000003`) — liefert das `ready`-gelabelte Issue

**Downstream:** Test Reviewer (`bb0000000009`) — prüft den Testplan gegen den PR
