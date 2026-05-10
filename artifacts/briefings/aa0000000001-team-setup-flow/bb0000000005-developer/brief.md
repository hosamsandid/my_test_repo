---
id: bb0000000005
title: "Developer"
slug: developer
status: ready
rigor: high
depends_on:
  - bb0000000003
artifacts:
  - path: artifacts/output/issues/ready-issue.md
    direction: input
    description: "GitHub Issue mit Ready-Label als Arbeitsauftrag"
  - path: artifacts/output/pull-requests/feature-pr.md
    direction: output
    description: "Feature Branch + Pull Request mit Implementierung"
---

# Developer

## Rolle

**Reaktiver Implementierungs-Agent**. Pickt `ready`-gelabelte Issues auf und
implementiert sie auf einem Feature-Branch. Öffnet PR wenn fertig.

## Auslöser

`github-event: issues.labeled` — feuert wenn das `ready`-Label auf einem Issue gesetzt
wird. `from: any-except-self` verhindert Selbst-Loops.

## Aufgabe

1. Issue lesen und vollständig verstehen (Acceptance Criteria prüfen)
2. Feature-Branch anlegen: `feature/<issue-number>-<short-slug>`
3. Implementierung vornehmen (alle Tests müssen grün bleiben)
4. Commit mit `Closes #<issue>` im Message
5. PR öffnen mit: Beschreibung, Test-Anleitung, Screenshots wenn UI-Änderung

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

- [ ] Branch-Name folgt Schema `feature/<issue-number>-<slug>`
- [ ] Alle bestehenden Tests laufen durch
- [ ] PR enthält `Closes #<issue>` Referenz
- [ ] PR-Beschreibung erklärt Was + Warum der Änderung
- [ ] Kein Dead Code, keine auskommentierten Blöcke

## Abhängigkeiten

**Upstream:** Business Analyst (`bb0000000003`) — liefert das `ready`-gelabelte Issue

**Downstream:** Code Reviewer, Security Reviewer, Test Reviewer, Performance Reviewer (alle parallel)
