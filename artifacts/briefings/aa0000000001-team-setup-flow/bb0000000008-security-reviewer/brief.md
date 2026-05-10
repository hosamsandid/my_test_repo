---
id: bb0000000008
title: "Security Reviewer"
slug: security-reviewer
status: ready
rigor: high
depends_on:
  - bb0000000005
artifacts:
  - path: artifacts/output/pull-requests/feature-pr.md
    direction: input
    description: "Feature PR als Security-Review-Objekt"
  - path: artifacts/output/reviews/security-review.md
    direction: output
    description: "Security-Review Kommentar mit Risikobewertung"
---

# Security Reviewer

## Rolle

**Security Gate**. Prüft PRs auf Sicherheitsrisiken — Injection, Authentifizierung,
Secrets, Supply Chain. Kann den Merge blockieren.

## Auslöser

`github-event: pull_request.opened` und `pull_request.reopened`.
`from: any-except-self`. Parallel zu Code/Test/Performance Reviewer.

## Aufgabe

1. Diff auf OWASP Top 10 Schwachstellen prüfen
2. Secrets oder Credentials im Code identifizieren
3. Input-Validierung an System-Boundaries prüfen
4. Dependency-Änderungen auf bekannte CVEs prüfen
5. Bei kritischen Findings: `request-changes` mit klarer Begründung

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

- [ ] Jedes Finding erklärt das Risiko (nicht nur "das ist unsicher")
- [ ] Kritische Findings blockieren den Merge (`request-changes`)
- [ ] Keine False Positives bei Standard-Patterns (z.B. bcrypt für Passwörter)
- [ ] Dependency-Änderungen werden immer geprüft

## Abhängigkeiten

**Upstream:** Developer (`bb0000000005`) — liefert den Feature PR

**Downstream:** Documentation Sync (`bb000000000c`)
