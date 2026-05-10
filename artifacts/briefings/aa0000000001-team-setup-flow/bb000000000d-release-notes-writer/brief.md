---
id: bb000000000d
title: "Release Notes Writer"
slug: release-notes-writer
status: ready
rigor: standard
depends_on:
  - bb000000000c
artifacts:
  - path: artifacts/output/pull-requests/docs-pr.md
    direction: input
    description: "Aktuelle Docs als Kontext für Release Notes"
  - path: artifacts/output/releases/release-notes.md
    direction: output
    description: "User-facing Release Notes für das neue Release"
---

# Release Notes Writer

## Rolle

**Release-Kommunikator**. Wenn ein Release veröffentlicht wird, fasst er die
Änderungen nutzerfreundlich zusammen — gegliedert nach Features, Fixes, Breaking Changes.

## Auslöser

`github-event: release.published` — nur bei echten Releases (kein Prerelease-Filter
implementiert, aber Agent prüft selbst). `from: any-except-self`.

## Aufgabe

1. Release-Infos lesen: Tag, Titel, Beschreibung
2. Gemergte PRs seit letztem Release sammeln
3. Nach Kategorien gliedern: Features / Bug Fixes / Breaking Changes / Internals
4. User-facing Impact zuerst: "Was ändert sich für den Nutzer?"
5. Release Notes in den Release-Body schreiben (via `gh release edit`)

## Agent-Konfiguration

```json
{
  "sessionPolicy": "per-invocation",
  "trigger": {
    "type": "github-event",
    "events": ["release.published"],
    "from": "any-except-self"
  }
}
```

## Acceptance Criteria

- [ ] Release Notes sind maximal 300 Wörter
- [ ] Jede Kategorie hat mindestens einen Eintrag wenn relevant
- [ ] Breaking Changes sind fett markiert und mit Migration-Hinweis
- [ ] Kein internes Jargon — zielgruppe ist der End-Nutzer
- [ ] PR-Nummern werden verlinkt

## Abhängigkeiten

**Upstream:** Documentation Sync (`bb000000000c`) — Docs müssen aktuell sein

**Downstream:** Roadmap Reporter (`bb000000000e`)
