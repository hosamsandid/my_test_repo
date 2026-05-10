---
id: aa0000000001
title: "Team Setup Flow"
slug: team-setup-flow
status: ready
rigor: high
depends_on: []
artifacts:
  - path: artifacts/briefings/aa0000000001-team-setup-flow/team-config.md
    direction: output
    description: "Shared team configuration (repo URL, branch, ready-label)"
---

# Team Setup Flow

Dieses Briefing Pack ist der übergeordnete Rahmen für den gesamten **Team Setup Flow** —
die strukturierte Zusammenarbeit aller Agent-Rollen innerhalb eines GitHub-Projekts.

## Ziel

Einen vollständigen Software-Delivery-Prozess durch koordinierte KI-Agenten abbilden:
von der ersten Anforderung über Implementierung und Reviews bis zu Release Notes und
wöchentlichem Stakeholder-Bericht.

## Mitglieder & Reihenfolge

| Schritt | Rolle | Auslöser |
|---------|-------|----------|
| 1 | Issue Triage | Issue wird extern geöffnet |
| 2a | Business Analyst | DM — Anforderungen klären |
| 2b | Architect | DM — Design-Entscheidungen |
| 3a | Developer | Issue erhält Ready-Label |
| 3b | Quality Engineer | Issue erhält Ready-Label (parallel) |
| 4 | Code Reviewer | PR wird geöffnet |
| 4 | Security Reviewer | PR wird geöffnet (parallel) |
| 4 | Test Reviewer | PR wird geöffnet (parallel) |
| 4 | Performance Reviewer | PR wird geöffnet (parallel) |
| 5 | Community Manager | Kommentar auf Issue/PR |
| 6 | Documentation Sync | PR wird gemergt |
| 7 | Release Notes Writer | Release wird veröffentlicht |
| 8 | Roadmap Reporter | Wöchentlich (cron) |

## Handover-Logik

Der Flow nutzt GitHub als Kommunikationskanal zwischen den Agenten:
- **BA → Developer**: BA setzt das `ready`-Label auf dem Issue
- **Developer → Reviewer**: Developer öffnet PR mit `Closes #<issue>` Link
- **Reviewer → Doc-Sync**: PR wird nach Approval gemergt
- **Doc-Sync → Release**: Release wird manuell published
- **Release → Roadmap**: Roadmap-Reporter liest geschlossene Issues + merged PRs

## Acceptance Criteria

- [ ] Alle 13 Rollen-BPs sind im Status `ready` oder höher
- [ ] Die `depends_on`-Kette ist vollständig und zyklenfrei
- [ ] Jede Rolle hat ein entsprechendes Agent-Template in `orchestrator/skill-pool/agent-templates/`
- [ ] Der Flow kann über den BP-Explorer als Graph visualisiert werden
