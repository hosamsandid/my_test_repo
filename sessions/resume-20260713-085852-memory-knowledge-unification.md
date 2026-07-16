# 🔄 Resume Prompt — Memory/Knowledge Unification

**Session ID**: 20260713-085852-memory-knowledge-unification
**Session Date**: 2026-07-13 08:58 UTC
**Project**: i-sase-aee (e-vgh-claw stack)
**Status**: ⏸️ Paused — skill activation SHIPPED (3 commits), unification concept READY, implementation not started

---

## 💬 Suggested Opening Message (copy-paste into the new session)

```
Ich setze die Session 20260713-085852-memory-knowledge-unification fort.

Lies zuerst:
1. sessions/session-20260713-085852-memory-knowledge-unification.md (voller Kontext)
2. docs/memory-knowledge-unification-concept.md (das Arbeitspaket — alle Entscheidungen sind darin fixiert, nichts erneut erfragen)

Dann starte mit Phase 0 (Full-Learn-Fix, frontend-only) und anschließend Phase 1
(Knowledge-Digest, additiv). Wichtig: Transparenz-Prinzip aus §4 des Konzepts ist
harte Anforderung; der Memory-Hint ist ein byte-identischer Zwei-Seiten-Vertrag
(prompt-assembly.js ↔ agent-entrypoint.py) — bei Phase 2 beide Seiten in einem
Commit ändern. Committe nach jeder Phase.
```

---

## 🎯 Last Session Recap

**Branch**: feat/knowledge-skill-aggregation (clean nach Handover-Commit)
**Letzte Commits**:
- `0c1e76e` activation closes the loop (Phasen 3+4: Dialog-Checkboxen, Feed-Events, Autonomie-3 Auto-Aktivierung)
- `54cac36` one-click activation (Phase 2: Manifest, Sync-Endpoints, Status-UI)
- `52f5ccd` team-owned skill grants (Phase 1: Ownership-Move weg vom Env)

**Verifiziert**: 261 + 257 Unit-Tests grün, vite build grün. **Noch nicht deployed** (Live-Stack = separates Checkout `~/Projects/e-vgh-claw`).

---

## ⚡ Immediate Next Actions

### Priority 1: Phase 0 — Full-Learn-Fix (~30 min, frontend-only)
`LEARN_PROMPT` (`admin-console/src/pages/agent-chat/ChatPanel.jsx:17-26`) um Knowledge-Absatz ergänzen (Wortlaut an `build_harvest_hint()` in `agent-image/scripts/agent-entrypoint.py:1081-1101` anlehnen; "skip if the team knowledge base is not available" deckt Autonomie 0). Tooltip des Full-Learn-Buttons (Zeile ~776-786) erweitern. Knowledge-Tab (right rail) nach der Learn-Antwort refreshen.

### Priority 2: Phase 1 — Knowledge-Digest, additiv (Kernstück)
Purer Builder `orchestrator/knowledge-digest.js` (+ byte-äquivalenter Python-Port in `agent-entrypoint.py`, Drift-Guard-Test wie beim Memory-Hint-Vertrag). Digest-Regeln: alle conventions → konvergierte Einträge → jüngste, Budget ~2–4k Tokens, Header-Banner (Quelle/Zeitstempel/Counts/"do not edit"). Regeneration: (a) Runtime vor jeder Invocation, (b) Orchestrator event-getrieben bei KB-Änderung (Hook in `emitKnowledgeHarvest`, orchestrator.js ~2123). `@knowledge-digest.md`-Import in CLAUDE.md via `prompt-assembly.js`, nur wenn KB-Checkout provisioniert; Seeding schreibt Initial-Digest (Import darf nie ins Leere zeigen). **Nichts wird entfernt.**

### Priority 3: Phasen 2+3 (nur nach Freigabe von 0+1)
Semantisches Umrouten (Hint-/CLAUDE.md-Varianten, autonomie-gegated) + Einmal-Migration facts/entities → KB mit Archivierung nach `memory/_archive/`.

---

## ❗ Nicht vergessen
- Transparenz = harte Anforderung (Konzept §4 + Memory `workspace-transparency-principle`): Digest ist sichtbare, stets aktuelle Workspace-Datei; keine versteckten Kontext-Kanäle.
- `users.md` niemals in die Team-KB (personenbezogen).
- Knowledge-Team = Squad (`agentKnowledgeTeamId`), nie `cfg.teamId`.
- Nur fachliche Fragen an den User; technische Entscheidungen selbst treffen; auf Deutsch antworten.
- Tests: `cd orchestrator && node --test *.test.js` · `cd admin-console/api && node --test *.test.js` · `cd admin-console && npx vite build`.
