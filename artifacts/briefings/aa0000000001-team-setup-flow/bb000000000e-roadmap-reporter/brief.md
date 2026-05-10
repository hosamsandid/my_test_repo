---
id: bb000000000e
title: "Roadmap Reporter"
slug: roadmap-reporter
status: ready
rigor: standard
depends_on:
  - bb000000000d
artifacts:
  - path: artifacts/output/releases/release-notes.md
    direction: input
    description: "Letztes Release als Kontext für den Wochenbericht"
  - path: artifacts/output/reports/weekly-report.md
    direction: output
    description: "Wöchentlicher Stakeholder-Bericht (max. 200 Wörter)"
---

# Roadmap Reporter

## Rolle

**Wöchentlicher Stakeholder-Berichterstatter**. Liefert jeden Montag um 9 Uhr einen
kompakten Überblick: Was wurde geliefert, was ist in Arbeit, was ist blockiert.

## Auslöser

`cron: 0 9 * * 1` — jeden Montag um 9:00 Uhr Ortszeit.
Zusätzlich selbst-kurierender Cron für Memory-Cleanup.

## Aufgabe

1. Letzte Woche: Abgeschlossene Issues und gemergte PRs sammeln
2. Aktuelle Woche: Offene `ready`-gelabelte Issues und laufende PRs
3. Blockaden: Issues ohne Aktivität > 3 Tage
4. Bericht auf max. 200 Wörter komprimieren
5. Direkt als DM an Auftraggeber senden

## Agent-Konfiguration

```json
{
  "sessionPolicy": "per-invocation",
  "triggers": [
    {
      "id": "roadmap-weekly",
      "type": "cron",
      "cron": "0 9 * * 1",
      "description": "Weekly stakeholder report"
    },
    {
      "id": "self-curation",
      "type": "cron",
      "cron": "55 3 * * 1",
      "description": "Weekly memory pruning"
    }
  ]
}
```

## Acceptance Criteria

- [ ] Bericht erscheint jeden Montag zwischen 9:00 und 9:05 Uhr
- [ ] Max. 200 Wörter — nicht mehr
- [ ] Führt mit der wichtigsten Neuigkeit (Headline zuerst)
- [ ] Kein interner Jargon — Stakeholder-tauglich
- [ ] Bei nichts Neuem: `[PASS]` zurückgeben (kein leerer Bericht)

## Abhängigkeiten

**Upstream:** Release Notes Writer (`bb000000000d`) — gibt Kontext über letzte Releases

**Downstream:** Kein Downstream — Endpunkt des Flows
