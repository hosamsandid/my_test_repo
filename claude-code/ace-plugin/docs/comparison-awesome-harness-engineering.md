# Abgleich: awesome-harness-engineering vs. i-SASE

> Quelle: [ai-boost/awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)
> Datum: 2026-04-27

---

## Was i-SASE bereits stark abdeckt (Validierung durch die Liste)

Diese Bereiche sind im Framework bereits gut oder sehr gut umgesetzt — die Awesome-Liste bestätigt, dass i-SASE auf dem richtigen Weg ist:

| Bereich | i-SASE | Awesome-List-Referenz |
|---------|--------|----------------------|
| Planning & Task Decomposition | BriefingPacks, Tier-System, Parent/Child-Hierarchien | "Plan-and-Execute Agents" (LangChain), "Run Long-Horizon Tasks" (OpenAI) |
| Human-in-the-Loop | CRP-System (blocking/deferred/inline) mit Blast-Radius-Regel | "Claude Code Auto Mode", HITL-Patterns |
| Sandbox/Isolation | Worktree-per-Agent | Alle Sandbox-Patterns der Liste |
| Git-native Persistence | Kein DB, keine Infra-Abhängigkeit | "Context Engineering for Reliable AI Agents" (Microsoft) — filesystem-based |
| Progressive Disclosure | Roadmap 6.1 | OpenAI "Harness Engineering" — genau dieses Pattern |
| Mechanical Enforcement | Roadmap 6.2 (Lints) | OpenAI's Invariant-Enforcement via custom linters |
| Structured Authorization | team.md Rollen, hooks.json | "Beyond Permission Prompts" (Anthropic) |

---

## Sinnvolle Ergänzungen (sortiert nach Impact)

### 1. Compaction-Strategie für Long-Running Agents (HOCH)

**Was die Liste zeigt:** Mehrere Einträge behandeln Context Compaction:
- Anthropic's Server-Side Compaction (84% Token-Reduktion)
- "Claude Code Compaction: How Context Compression Works" — *was überlebt* vs. *was verloren geht*
- "Active Context Compression" — Agent-gesteuerte Kompression
- "ByteRover" — gelernte Relevanz-Filterung

**Was i-SASE fehlt:** Kein explizites Compaction-Bewusstsein. Für 6h+ Agent-Runs (Roadmap 6.3 erwähnt das) ist das kritisch. Wenn Claude den Kontext komprimiert, könnten BP-Constraints, aktuelle Phase oder CRP-Entscheidungen verloren gehen.

**Empfehlung:** Ein `compaction-anchor`-Abschnitt in LoopScripts oder ein Pattern in MentorScripts, das definiert:
- Was MUSS überleben: BP-Frontmatter, Acceptance Criteria, aktuelle Phase, offene CRPs
- Was KANN komprimiert werden: erledigte Phasen-Details, aufgelöste CRPs
- Strukturierung der Agent-Arbeit in kompaktionsfreundliche Blöcke (Phase-Grenzen als natürliche Compaction-Punkte)

Dies wäre ein neues `docs/patterns/compaction-strategy.md` plus eine Erweiterung des LoopScript-Schemas.

---

### 2. Checkpointing an Phase-Grenzen (HOCH)

**Was die Liste zeigt:**
- "Ranking Engineer Agent (REA)" (Meta) — hibernate-and-wake Checkpointing für unterbrochene Tasks
- "Recoverability Has a Law: The ERR Measure" — formale Metrik für Failure Resilience
- LangGraph Checkpointing — typed state mit Restore-Fähigkeit

**Was i-SASE hat:** Heartbeat-Commits (60 min) und Completion Durability auf der Roadmap (3.3). Aber das ist reaktiv (Recovery nach Crash), nicht proaktiv.

**Empfehlung:** LoopScript-Phasen als explizite Checkpoints nutzen. Am Ende jeder Phase:
- Commit mit vollem Zustandssnapshot (Phase abgeschlossen, nächste Phase, Zwischenergebnisse)
- Ein `checkpoint`-Feld im BP-Frontmatter: `{phase: "implement", substep: 3, artifacts: [...], decisions: [...]}`
- Bei Resume (neuer Agent oder nach Pause): Checkpoint lesen, ab dort fortsetzen statt von vorn

Das verbessert auch die Pause/Resume-Funktion (Roadmap 5.3) erheblich — der Agent weiß genau, wo er aufhören und wo er weitermachen soll.

---

### 3. Eval-Framework für Agent-Performance (HOCH)

**Was die Liste zeigt:**
- "promptfoo" — YAML-driven Testing mit LLM-as-Judge
- "Agent Evaluation Readiness Checklist" (LangChain) — 33-Item-Checklist mit 3 Granularitätsstufen
- "AgentAssay" — Behavioral Fingerprinting für Regression-Detection (86% Detection vs. 0% bei binärem Pass/Fail)
- "Testing Agent Skills Systematically" (OpenAI) — vier Eval-Dimensionen

**Was i-SASE hat:** Quality Gates und MRP-Review mit 5 Kriterien. Aber keine systematische Messung über Zeit.

**Empfehlung:** Ergänzung der Metrics-Roadmap (1.2) um Agent-Eval-Dimensionen:
- **Correctness:** MRP first-pass approval rate
- **Efficiency:** Tokens pro Phase, CRP-Overhead
- **Adherence:** Schema-Violations, Commit-Convention-Verletzungen
- **Autonomy:** Verhältnis blocking vs. deferred CRPs

Dies könnte als Erweiterung von `/metrics` kommen — eine Art "Agent Report Card" pro Mission, aggregierbar über Zeit.

---

### 4. "Multi-Agent Workflows Often Fail" — Distributed-Systems-Denken (MITTEL)

**Was die Liste zeigt:**
- "Multi-Agent Workflows Often Fail" (GitHub, Feb 2026) — Multi-Agent als Distributed-Systems-Problem
- "Task-Adaptive Multi-Agent Orchestration (AdaptOrch)" — dynamische Topologie-Auswahl: 12-23% Verbesserung
- "Choosing the Right Multi-Agent Architecture" (LangChain) — Entscheidungs-Framework für vier Patterns

**Was i-SASE hat:** Parallele Dispatch, `depends-on`, `execution-order`. Aber jeder Agent ist isoliert — es gibt kein explizites Failure-Propagation oder Cascade-Handling.

**Empfehlung:** Ein Guidance-Dokument `docs/patterns/parallel-agents.md`, das behandelt:
- Was passiert, wenn Agent A scheitert und Agent B von A abhängt? (Aktuell: manuell)
- Timeout-Semantik für `depends-on` (wie lange wartet B?)
- Pattern für "Fan-out / Fan-in" bei parallelen Gruppen
- Die GitHub-Erkenntnis: Multi-Agent ist ein verteiltes System — behandelt es auch so (Idempotenz, Retry, Partial Failure)

---

### 5. MCP Tool Annotations als CRP-Brücke (MITTEL)

**Was die Liste zeigt:**
- "Tool Annotations as Risk Vocabulary" (MCP team) — vier Annotation-Hints als Permission-Inputs
- "Design Patterns for Deploying AI Agents with Model Context Protocol" — drei Protocol-Level Gaps

**Was i-SASE hat:** CRP-Trigger sind umfassender (8 strukturelle Trigger), aber sie leben in MentorScripts, nicht in den Tool-Definitionen selbst.

**Empfehlung:** MCP Tool Annotations mit CRP-Triggern verbinden. Wenn ein Tool als `destructive: true` annotiert ist (MCP Standard), sollte das automatisch CRP-Trigger #6 (Data-destructive operation) aktivieren. Das macht CRP-Trigger composable mit dem MCP-Ökosystem statt nur in Prosa definiert.

---

### 6. Composable Hook Pipeline (MITTEL)

**Was die Liste zeigt:**
- "How Middleware Lets You Customize Your Agent Harness" (LangChain) — sechs composable Hooks für Policy Enforcement
- Konzept: Hooks als Pipeline statt als einzelne Checks

**Was i-SASE hat:** `hooks/hooks.json` mit Pre/PostToolUse Hooks. Funktional, aber monolithisch.

**Empfehlung:** Hooks als composable Pipeline denken. Statt einer großen hooks.json mit allen Checks, ein Hook-Chain-Pattern:
```
audit-log → schema-validation → role-check → lint-check → budget-check
```
Jeder Hook ist eine separate Datei, die hooks.json ist nur die Orchestration. Das macht Hooks testbar, wiederverwendbar (Export/Import, Roadmap 5.6), und einfacher zu debuggen.

---

### 7. Skill-Versioning (NIEDRIG-MITTEL)

**Was die Liste zeigt:**
- "Shell + Skills + Compaction" (OpenAI) — versioned Skill Bundles
- "Microsoft Skills Framework" — standardisierte Skill-Versionierung
- "SkillNet & SkillsBench" — Skill-Evaluation

**Was i-SASE hat:** Skills unter `skills/` ohne formale Versionierung. Schema-Versionen existieren (`briefingpack/v3`), aber Skills selbst haben keine Version.

**Empfehlung:** Ein `version`-Feld in SKILL.md Dateien und ein Kompatibilitäts-Check beim Plugin-Update. Relevant für die Plugin-Distribution (Roadmap 4.3).

---

## Korrekturen / Verfeinerungen bestehender Konzepte

### A. Roadmap "Not Planned: A2A" — Watchlist ergänzen

Die Awesome-Liste zeigt, dass A2A-Protokolle schnell reifen:
- Google A2A Protocol (HTTP/SSE-basiert)
- AG-UI (Event-driven Agent-to-UI)
- IETF draft-klrc-aiagent-auth (erstes Standards-Track Spec)

i-SASE hat A2A explizit als "not planned" markiert ("Revisit when dependency chains exceed 10 steps"). Die Bedingung ist richtig, aber der Hinweis auf die reifenden Standards sollte in die Roadmap aufgenommen werden — nicht als aktives Work-Item, sondern als Watchlist-Eintrag mit Verweis auf die konkreten Specs.

### B. CRP-Trigger #8 mechanisieren

Der Eintrag "AgentAssay: Token-Efficient Regression Testing — Behavioral Fingerprinting" zeigt ein Pattern, das zum CRP-Trigger #8 (Observable behavior change not in BP) passt. Die aktuelle Definition ist breit. Eine Verfeinerung wäre: Agent soll vor-/nach-Snapshots von beobachtbarem Verhalten machen (Test-Output, API-Responses) und bei Abweichungen automatisch einen deferred CRP erstellen. Das macht Trigger #8 mechanisch statt subjektiv.

### C. Initializer-Pattern für die Understand-Phase

"Effective Harnesses for Long-Running Agents" (Anthropic) beschreibt ein Initializer-Pattern: Ein schneller Agent bereitet den Kontext vor (liest Dateien, baut Index, identifiziert relevante Code-Stellen), dann übergibt an den eigentlichen Executor. i-SASE's Claim-Protocol könnte das aufgreifen: Die `understand`-Phase des LoopScripts als expliziter Initializer, der einen kompakten Kontext-Summary erzeugt, der den Rest der Mission überlebt (auch bei Compaction).

---

## Zusammenfassung

| Prio | Thema | Aufwand | Wo |
|------|-------|---------|-----|
| **1** | Compaction-Strategie | Niedrig (Docs + Schema) | Neues Pattern-Doc + LoopScript-Erweiterung |
| **2** | Phase-Checkpointing | Mittel (Schema + Executor) | LoopScript-Schema + agents/executor.md |
| **3** | Eval-Framework | Mittel (Metrics-Erweiterung) | Roadmap 1.2 Erweiterung |
| **4** | Parallel-Agent Failure Patterns | Niedrig (Docs) | Neues Pattern-Doc |
| **5** | MCP Tool Annotations ↔ CRP | Niedrig (Hook) | hooks.json Erweiterung |
| **6** | Composable Hook Pipeline | Mittel (Refactoring) | hooks/ Architektur |
| **7** | Skill Versioning | Niedrig (Schema) | SKILL.md Erweiterung |
| **A** | A2A Watchlist in Roadmap | Trivial | ROADMAP.md Update |
| **B** | CRP #8 mechanisieren | Niedrig | agents/executor.md |
| **C** | Initializer-Pattern | Niedrig (Docs) | LoopScript-Guidance |

Die drei höchstprioritären Items (Compaction, Checkpointing, Eval) adressieren alle dasselbe Grundproblem: **Agents, die länger und autonomer laufen, brauchen bessere Selbst-Überwachung und Resilience.** Das ist genau der Trend, den die Awesome-Liste durchgängig zeigt — das Harness wird wichtiger als das Modell.
