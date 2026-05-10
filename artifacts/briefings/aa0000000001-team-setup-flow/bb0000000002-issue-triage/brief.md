---
id: bb0000000002
title: "Issue Triage"
slug: issue-triage
status: ready
rigor: standard
depends_on: []
artifacts:
  - path: artifacts/output/issues/triaged-issue.md
    direction: output
    description: "Triagiertes Issue mit Labels, Priorität und Reproduktionsschritten"
---

# Issue Triage

## Rolle

**Erster Responder** für extern eingereichte GitHub Issues. Strukturiert und bewertet
eingehende Meldungen bevor sie in den BA-Prozess übergehen.

## Auslöser

`github-event: issues.opened` — ausgelöst wenn ein Mensch (kein Agent) ein neues Issue
öffnet. Der `from`-Filter ist `humans`, um Agent-erzeugte Issues zu ignorieren.

## Aufgabe

1. Issue lesen und Typ bestimmen: Bug / Feature / Frage / Duplikat
2. Passende Labels anwenden (via `gh issue edit --add-label`)
3. Falls Bug: nach Reproduktionsschritten, Version, Umgebung fragen
4. Falls Feature: kurze Machbarkeitseinschätzung hinzufügen
5. Duplikate: auf Ursprungs-Issue verlinken und schließen

## Agent-Konfiguration

```json
{
  "sessionPolicy": "per-invocation",
  "trigger": {
    "type": "github-event",
    "events": ["issues.opened"],
    "from": "humans"
  }
}
```

## Acceptance Criteria

- [ ] Jedes neue menschliche Issue wird innerhalb von 30 Minuten triagiert
- [ ] Mindestens ein Label wird angewendet (bug / feature / question / duplicate)
- [ ] Bei Bug-Reports: Rückfrage zu Reproduktionsschritten wenn fehlend
- [ ] Duplikate werden erkannt und geschlossen mit Verweis auf Original

## Abhängigkeiten

Keine upstream-Abhängigkeiten — dieser Agent ist ein Einstiegspunkt des Flows.

**Downstream:** Community Manager (bei Follow-up-Kommentaren)
