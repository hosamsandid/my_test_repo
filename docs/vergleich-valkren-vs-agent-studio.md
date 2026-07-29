# Vergleich: Valkren Starter Kit vs. agent-studio

> Analyse vom 2026-04-24 — Beide Systeme sind Wrapper um Claude Code für Enterprise-Arbeit.
>
> **Update 2026-05-06:** Das in diesem Vergleich beschriebene "Multi-Agent Pool"-Modell (Orchestrator als Router + gemeinsamer Multi-Agent-Room + Expert-Broadcast/Synthese) gibt es nicht mehr. agent-studio nutzt jetzt ein DM-only-Modell: jeder Agent hat einen eigenen Matrix-User, der Mensch chattet 1:1. Die Adversarial-Review-/Synthese-Vorschläge in diesem Dokument sind damit hypothetisch — sie waren auf eine Architektur gemünzt, die zurückgebaut wurde.

## Auf abstrakter Flughöhe: Das Gemeinsame

Beide Systeme sind **Wrapper um Claude Code**, die das rohe CLI in eine strukturierte, teamfähige Arbeitsumgebung verwandeln. Beide lösen das gleiche Grundproblem: *Wie orchestriert man Claude Code für Enterprise-Arbeit mit Prozessdisziplin, Gedächtnis und Qualitätssicherung?*

| Dimension | Valkren | agent-studio |
|-----------|---------|------------|
| **Interface** | Direkt in IDE/Terminal | Matrix Chat (Element) |
| **Agent-Modell** | "Oracle" Adversarial Review (3+ parallele Reviewer) | Multi-Agent Pool (Expert/Synthesizer/Autonomous) |
| **Prozess-Enforcement** | 27-Step Release Gate State Machine + Hooks | ACE Plugin (BP/CRP/MRP) |
| **Memory** | 80+ Behavior-Files, 142 Lessons Learned | 5-file memory system (context, log, facts, entities, users) |
| **Deployment** | Portable Kit → lokales Projekt + ~/.claude/ | Podman-Container-Stack |
| **Domäne** | SAP BTP Enterprise Knowledge Platform | Mainframe Migration (COBOL, JCL, DB2) |
| **LLM Backend** | Direkt (lokales Claude Code) | Azure AI Foundry |

---

## Was Valkren gut macht (und wir lernen können)

### 1. Behavioral Memory System — Unser grösstes Delta

Valkren hat **80+ Memory-Dateien** in klaren Kategorien (feedback, project, reference) mit strukturiertem Frontmatter. Beispiel:

```markdown
---
name: No mock code
description: Never use mocks — always real implementations
type: feedback
---
Mocks destroyed trust in R31-R73 (14 critical divergences found).
**Why:** Mock DB had critical divergences → bugs passed tests but broke prod
**How to apply:** Always real implementations. If backend missing, build backend FIRST.
```

**Bei uns:** Wir haben das Claude Code Memory-System jetzt mit 5 Dateien: `context.md`, `log.md`, `facts.md`, `entities.md`, `users.md`. Jede Datei hat eine dedizierte Rolle — Fakten gehen in `facts.md`, Entitätswissen in `entities.md`, User-Profile in `users.md`. Das Valkren-System zeigt dennoch, wie mächtig ein kuratierter Memory-Korpus *mit domänenspezifischem Inhalt* ist — jede Session lädt automatisch 80+ Verhaltensregeln.

**Takeaway:** Wir sollten unsere Agent-Workspaces mit domänenspezifischem Memory ausstatten — Lessons Learned aus Mainframe-Migrationen, Feedback-Patterns, Referenzen zu Systemen.

### 2. Release Gate State Machine — Erzwungene Prozessdisziplin

Valkren hat `release-gate.js` — eine 27-Schritt State Machine die den Release-Zyklus **erzwingt**:

- Kein Commit ohne vorherige Tests, Build, Deploy, UAT
- **Temporal Plausibility**: Physische Schritte brauchen min. 60s (verhindert "fake" Attestierungen)
- **Artifact Attestation**: Jeder Schritt braucht Beweis (MTAR-Output, CF-App-Status, Git-Commit)
- PreToolUse Hooks **blockieren** Bypass-Versuche (wer `mbt build` direkt aufruft, wird zu `release-gate.js run build` umgeleitet)

**Bei uns:** Wir haben ACE mit BP/CRP/MRP, aber die Hooks sind **advisory only** (warnen, blockieren nicht). Es gibt keine erzwungene Sequenz.

**Takeaway:** Die Idee einer State Machine für kritische Workflows (z.B. Migration-Pipeline: Analyse → Konvertierung → Test → Review → Deploy) ist sehr stark. Wir könnten ein ähnliches Gate-System für Migration-Schritte bauen.

### 3. Oracle Adversarial Review Pattern

Valkren verlangt bei **jedem** Artefakt/Build/Deploy mindestens **3 parallele, unabhängige Oracle-Reviews**:

- Jeder Agent traced unabhängig die Pipeline end-to-end
- Agents verifizieren/widerlegen sich gegenseitig mit Code-Evidence
- Kein Rubber-Stamping — Konsens vor Weiterarbeit

**Bei uns:** Wir HABEN die Multi-Agent-Infrastruktur dafür (Expert-Broadcast + Synthesis). Aber wir nutzen sie primär für **komplementäre** Expertise (COBOL-Expert + Java-Expert), nicht für **adversarial** Review.

**Takeaway:** Unser Expert-Broadcast könnte um einen "Review-Modus" erweitert werden, bei dem mehrere Agents denselben Code unabhängig prüfen und eine Synthese nur bei Konsens durchgeht.

### 4. Lessons Learned als Machine-Readable Rules

142 dokumentierte Produktions-Incidents mit Root Cause und Prevention:

- LL-02: Mock-DB hatte 14 kritische Divergenzen → immer echte DB testen
- LL-112: BTP-Regression muss XSUAA-Tokens + Endpoint-URLs enthalten
- LL-124: Domain-Access braucht Admin-Bypass-Checks

Diese werden automatisch in Oracle-Prompts geladen, um Wiederholung zu verhindern.

**Bei uns:** Fehlt komplett. Wenn ein Agent einen Fehler macht, gibt es keinen Mechanismus, der das für alle zukünftigen Sessions festhält.

### 5. Skill Overlay Pattern

Valkren trennt sauber:

- **Upstream Skills** (`~/.claude/skills/<name>/`) — git-managed, immutable
- **Custom Overlays** (`~/.claude/skills/sap-skills-custom/overlays/`) — Anpassungen
- **Reconciliation Script** prüft Kompatibilität nach Upstream-Pull

**Bei uns:** Wir kopieren Skills in den Workspace, aber es gibt keine Overlay-Trennung. Updates am Skill überschreiben Anpassungen.

### 6. Rules als Enforcement (nicht nur Dokumentation)

25 MUST/NEVER-Regeln in `rules.md`, die per Hook **erzwungen** werden. Nicht nur "bitte halte dich daran", sondern "wenn du das tust, blockiert der Hook".

---

## Was bei uns besser ist

### 1. Chat-basierte Multi-Agent-Orchestrierung

Valkren hat **kein Chat-Interface**. Alles läuft direkt in IDE/Terminal. Es gibt keine Möglichkeit, dass mehrere Agents in einem Raum **sichtbar kommunizieren**.

**Unser Vorteil:** Matrix als Chat-Layer gibt uns:

- Natürliche Konversation mit mehreren Agents
- Sichtbare Expert-Responses + Synthese
- @-Mention-Routing
- Audit-Trail (Matrix-History)
- Zugang für nicht-technische User via Element

### 2. Dynamische Agent-Verwaltung zur Laufzeit

Valkren hat keine dynamischen Agents. Die "Oracle"-Agents sind Claude Code Sub-Agents, die innerhalb einer Session gespawnt werden.

**Unser Vorteil:** `!agent add/update/delete/list/enable/disable` — wir können Agents **zur Laufzeit** erstellen, konfigurieren und verwalten, ohne Code zu ändern. Neue Expertise = neuer Agent per Chat-Wizard.

### 3. Autonomous Agents mit Self-Managed Triggers

Unser `triggers.json`-System mit Cron/Once und Self-Management (der Agent kann seinen eigenen Schedule ändern) ist ein Feature, das Valkren nicht hat. Dort muss der Mensch jede Aktion anstoßen.

### 4. Workspace Seeding mit Template-Vererbung

Neue Agents erben automatisch Skills, Memory, Settings vom Template-Workspace. Das ist bei Valkren ein manueller Prozess (setup.sh einmal, dann fertig).

### 5. Containerisierte Architektur

Podman-Stack mit Volume-Isolation, separaten Containern pro Service. Valkren ist ein lokales Shell-Script das in ein Verzeichnis installiert. Unser Ansatz ist reproduzierbarer und deployment-fähiger.

### 6. Drei spezialisierte Agent-Rollen

Expert + Synthesizer + Autonomous ist ein differenzierteres Modell als Valkrens "alle sind Oracle-Reviewer". Unsere Rollen bilden unterschiedliche Arbeitsweisen ab.

---

## Konkrete Verbesserungspotentiale für agent-studio

| # | Idee von Valkren | Umsetzung bei uns | Aufwand |
|---|---|---|---|
| 1 | **Behavioral Memory** (80+ Files) | Domänenspezifische Memory-Files für Mainframe-Migration erstellen und in Template-Workspace legen | Mittel |
| 2 | **Lessons Learned System** | `lessons-learned.md` pro Agent, automatisch in Prompts geladen | Klein |
| 3 | **Workflow Gate** (State Machine) | Migration-Pipeline-Gate: Analyse→Konvertierung→Test→Review→Deploy, erzwungen per Hook | Gross |
| 4 | **Adversarial Review Mode** | Neuer Routing-Modus in agent-pool.js: "review" statt "broadcast" — gleicher Code, mehrere unabhängige Reviews, Synthese nur bei Konsens | Mittel |
| 5 | **Hook-basiertes Enforcement** | PreToolUse Hooks die gefährliche Operationen blockieren (nicht nur warnen) | Klein |
| 6 | **Skill Overlay Pattern** | Upstream/Overlay-Trennung im Seeding + Reconciliation-Script | Klein |
| 7 | **Dashboard/Visibility** | Einfaches Web-UI das agent-pool Status, aktive Tasks, Agent-Health zeigt (analog Valkren Cartridge Site) | Mittel |

---

## Fazit

**Valkren** ist ein **Prozess-Enforcement-System** — es geht darum, dass Claude Code nach strengen Regeln arbeitet, nichts überspringt und aus Fehlern lernt. Die Stärke liegt in der **Tiefe der Disziplin** (27 Steps, 142 Lessons, 80 Memory-Files).

**agent-studio** ist ein **Agent-Orchestrierungs-System** — es geht darum, mehrere spezialisierte Agents dynamisch zu koordinieren und über Chat zugänglich zu machen. Die Stärke liegt in der **Breite der Kollaboration** (dynamische Agents, Chat-Interface, Rollen, Routing).

Die grösste Lücke bei uns ist das **institutionelle Gedächtnis** — Valkren zeigt eindrucksvoll, wie 80+ Memory-Dateien + 142 Lessons Learned die Qualität über Sessions hinweg dramatisch verbessern können. Das wäre der höchste ROI-Hebel für uns: domänenspezifisches Memory für Mainframe-Migration aufbauen und systematisch in alle Agent-Workspaces seeden.
