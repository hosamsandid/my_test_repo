---
id: bb000000000c
title: "Documentation Sync"
slug: documentation-sync
status: ready
rigor: standard
depends_on:
  - bb0000000007
  - bb0000000008
  - bb0000000009
  - bb000000000a
artifacts:
  - path: artifacts/output/pull-requests/feature-pr.md
    direction: input
    description: "Gemergter Feature PR als Basis für Docs-Update"
  - path: artifacts/output/pull-requests/docs-pr.md
    direction: output
    description: "Follow-up PR mit aktualisierten Docs"
---

# Documentation Sync

## Rolle

**Docs-Synchronisierer**. Nach jedem gemergten PR prüft er ob die Dokumentation
noch aktuell ist und öffnet bei Bedarf einen Follow-up PR.

## Auslöser

`github-event: pull_request.closed` — nur wenn `merged: true`. `from: any-except-self`.

## Aufgabe

1. Gemergten PR lesen: welche APIs, Config-Optionen, Beispiele haben sich geändert?
2. Docs-Dateien auf Drift prüfen (README, docs/, CHANGELOG)
3. Falls Drift: Follow-up PR mit Docs-Update öffnen
4. Falls keine Docs-Änderung nötig: kurzen Kommentar auf den Original-PR hinterlassen

## Agent-Konfiguration

```json
{
  "sessionPolicy": "per-invocation",
  "trigger": {
    "type": "github-event",
    "events": ["pull_request.closed"],
    "from": "any-except-self"
  }
}
```

## Acceptance Criteria

- [ ] Jeder gemergte PR wird innerhalb von 10 Minuten geprüft
- [ ] API-Änderungen werden immer in der Docs nachgezogen
- [ ] CHANGELOG wird bei jedem Feature-Merge aktualisiert
- [ ] Follow-up PR ist klein und fokussiert — nur Docs, kein Code

## Abhängigkeiten

**Upstream:** Code Reviewer (`bb0000000007`), Security Reviewer (`bb0000000008`),
Test Reviewer (`bb0000000009`), Performance Reviewer (`bb000000000a`) — alle müssen
approve bevor PR mergen kann

**Downstream:** Release Notes Writer (`bb000000000d`)
