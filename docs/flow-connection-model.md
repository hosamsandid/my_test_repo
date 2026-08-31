# Flow-Editor: Einheitliches Verbindungsmodell (Konzept)

Status: **Implementiert** (Schritte 1–6, Issues #409–#414), plus Revision (s. u.).
Bezieht sich auf den Flow-Editor (`/flows`, `ProcessGraphPanel`) und den BriefingPack-Viewer (`FlowGraph.jsx`).
Die Capability-Matrix lebt in `admin-console/src/pages/process/connection-capabilities.js`,
die Dialoge in `EdgeDialogs.jsx`, das Aktor-Mapping in `admin-console/api/unified-graph.js` / `process-graph.js`.

## Revision (Juli 2026): weniger Aktoren, Trigger im Knoten, orthogonale Aktor-Kanten

Die 4-Aktoren-Außenwelt aus Teil 2 hat sich in der Praxis als zu laut erwiesen
(Kreuz-und-quer-Bezierkurven von links, verwirrender ⏰/👤-Split). Fünf
Änderungen ersetzen die betroffenen Abschnitte:

1. **Nur noch zwei Aktoren: 🐙 GitHub und ⚡ Drittsystem.**
   - **⏰ Zeit entfällt als Aktor.** Cron/Once-Trigger zeichnen keine Kante
     mehr; sie erscheinen als ⏰-Zeile **in der Agenten-Karte** (Klartext-
     Schedule, klickbar → Schedule-Edit-Dialog). Neue Schedules legt man im
     Trigger-Tab des Inspectors an.
   - **👤 Mensch ist in 🐙 GitHub aufgegangen** — menschengesetzte Labels,
     Gates (`human:*`) und Bremsen sind GitHub-Label-Events; ihre Kanten
     starten jetzt am GitHub-Aktor, behalten aber Gate-Optik (`👤✓`-Chip)
     und `humanSet`/`gate`-Flags.
2. **Ein GitHub-Trigger-Dialog** (`GithubTriggerForm`): Roh-Events UND
   Label-Filter (inkl. `humans`-Origin-Filter) in einem Formular — ersetzt
   `EventForm` + `HumanLabelForm`. **Kein Repo-Feld mehr**: das Repo ist beim
   Modellieren unbekannt; live füllt es der Adapter aus dem Working
   Environment (`liveOps.createTrigger`), im Draft setzt es die
   Materialisierung (`vars.repoFullName`).
3. **Aktor-Kanten laufen durch den orthogonalen Kanal-Router**
   (`edge-router.js`): Aktoren bilden Spalte 0 des Layered-Layouts (Spalte
   links bei Fluss nach rechts, Reihe oben bei Fluss nach unten) — keine
   Bezier-Kurven mehr quer durch Knoten.
4. **Per-Trigger-Sichtbarkeit:** Jede Trigger-Zeile in der Karte (🐙/🏷/⚡)
   trägt ein 👁-Icon, das die zugehörige Kante ein-/ausblendet (persistiert
   in `localStorage`), zusätzlich zum Aktor-Filter in der Legende.
   Außerdem ist der volle Trigger-Editor (`TriggersPanel`, aus dem
   Agent-Chat) jetzt auch im **Draft-Inspector** als Tab eingebettet
   (ops-Adapter-fähig) — Trigger lassen sich im Flow-Editor anlegen,
   bearbeiten, schalten und löschen, im Draft wie im Live-Team.
5. **Ein Layout für alles — Layered auch mit Hierarchie.** Das alte
   Baum-Layout (das griff, sobald eine Parent-Child-Beziehung existierte,
   und alle Kanten wieder als Bezier zeichnete) ist entfernt. Jeder Flow —
   Prozess, Draft, Member-Baum, BriefingPack — läuft durch das Layered-
   Layout; die Hierarchie speist die Spaltenzuordnung (sichtbares Kind →
   Spalte nach dem Parent, Geschwister gruppiert). Die graue Hierarchie-
   Kante selbst bleibt bewusst eine label- und pfeillose **Bézier-Kurve**
   unterhalb der Prozess-Verdrahtung: sie belegt keine Kanal-Lanes/Ports,
   kann dank der Gruppierung nichts kreuzen und trennt Struktur visuell
   von Arbeits-Hand-offs. Kinder bleiben pro Karte auf-/zuklappbar
   (`Children (n)`-Button); die Live-/Team-Baum-Ansichten (`FlowGraph`)
   klappen sie per Default auf (`expandChildrenByDefault` an `initFlowGraph`,
   Nutzer-Zuklappen überlebt Daten-Refreshes). Der Prozess-/Flows-Canvas
   (`ProcessCanvas`) startet dagegen seit #1790 default-zugeklappt — der
   Nutzer klappt bei Bedarf auf; das verhindert Render-Abstürze bei sehr
   großen Flows. BP-Workspaces bleiben ebenfalls default-zugeklappt.

Dieses Dokument beschreibt, wie das Erstellen, Bearbeiten und Darstellen von
Verbindungen zwischen Agenten (und externen Quellen) über **alle Ansichten
hinweg vereinheitlicht** wird: eine Geste, ein Dialog, ein Edge-Lifecycle —
und eine vollständige grafische Repräsentation *aller* Trigger-Arten,
einschließlich zeit-, menschen- und drittsystem-getriebener Auslöser.

---

## Teil 1 — Ist-Analyse

### 1.1 Verbindungstypen (Datenmodell-Ebene)

Der Graph kennt heute 9 Edge-Typen (`on`-Diskriminator in
`admin-console/api/unified-graph.js`):

| Typ | Semantik | Autorisierbar? | Datenmodell |
|---|---|---|---|
| `label` | Label-Hand-off: A emittiert Label, B lauscht | ja | `agent.emits[]` + Trigger mit `labelFilter` auf B |
| `github` | A öffnet PR/Issue, B reagiert (Channel) | ja | `github.producesPr/Issue` auf A + `channels[]` auf B |
| `dependency` | B hängt von A ab (Ordering) | ja | `dependsOn[]` bzw. `dataFlow.dependsOn[]` |
| `artifact` | Datenfluss: A produziert, B konsumiert | ja | `outputs[]`/`inputs[]` (Name- oder Pfad-Match) |
| `parent` | Hierarchie | ja | `parent` bzw. `parentMemberId` |
| `gate` | Human-Approval (Flag auf label/github-Edge) | ja | `human:*`-Label bzw. `gate: 'human'` am Channel |
| `timer` | Cron/Once-Self-Loop | (über Trigger-Tab) | `triggers.json` |
| `event` | Externes GitHub-Rohevent | (über Trigger-Tab) | Trigger ohne `labelFilter` |
| `review` | Abgeleiteter Review-Flow | nein (derived) | — |

### 1.2 Anfasspunkte und ihre unterschiedlichen Flows

Heute existieren **zwei konkurrierende Drag-Quellen** mit unterschiedlichem
Verhalten (`admin-console/src/pages/process/flow-graph-render.js`):

1. **Lila Port (●)** → nach dem Drop öffnet `CreateEdgeDialog` mit
   **Typ-Auswahl** → delegiert an Sub-Formulare (Label / Dependency /
   Artifact / Hierarchy / GitHub).
2. **PR/Issue-Pills** (farbige Ports rechts am Producer-Node) → öffnen
   **direkt** den `CreateChannelDialog`, ohne Typ-Auswahl.

Dazu kommen als dritter und vierter Erstellungsweg der **Node-Inspector**
(`ConnectionsSection`: Parent, Stage, Produce-Flags; nur *Entfernen* von
Deps/Artifacts/Channels) und **Toolbar-Buttons** (Human-Approval als eigener
`AddApprovalDialog`, obwohl das technisch ein Label-Hand-off mit Preset ist).

### 1.3 Modi-Matrix

| Ansicht | Editierbar | ●-Port | PR/Issue-Ports | Edge-Klick | Erstellbare Typen |
|---|---|---|---|---|---|
| Draft | ja | ✅ | ✅ | ✅ | label, dependency, artifact, hierarchy, github |
| Live Team | ja | ✅ | ✅ | ✅ | wie Draft |
| Blueprint (Templates) | nein | sichtbar, Drag wird stumm ignoriert | dito | ✗ | — |
| BriefingPack (Workspace) | ja | ✅ | ✗ nicht verdrahtet | ✗ nicht verdrahtet | nur dependency, artifact |
| BP-Viewer / Import-Preview | nein | stumm ignoriert | dito | ✗ | — |

### 1.4 Konkrete Inkonsistenzen

1. **Zwei Anfasspunkt-Arten, zwei Flows.** ●-Port führt über einen
   Typ-Picker, die Pills direkt in einen Dialog. Der GitHub-Typ ist
   zusätzlich *auch* im Typ-Picker — dieselbe Verbindung hat zwei
   Erstellungswege mit unterschiedlicher UX.
2. **Asymmetrischer Lifecycle.** Label-/GitHub-Edges sind per Edge-Klick voll
   editierbar, Dependency/Artifact/Parent nur löschbar (Remove-Dialoge),
   Review/Manual nur read-only — nicht vorhersagbar, was ein Klick tut.
3. **Read-only-Ansichten geben kein Feedback.** In Blueprint/Viewer sind die
   Ports sichtbar, Drag verpufft kommentarlos.
4. **BP-Ansicht ist ein Sonderweg.** Eigener Adapter (`makeBpOps`),
   reduziertes Typ-Set, kein Edge-Klick.
5. **Human-Approval ist ein separater Dialog**, obwohl es ein
   Label-Hand-off mit Preset (`human:*`, `from: humans`) ist; umgekehrt kann
   der Label-Dialog kein Gate anlegen.
6. **Verwaiste Produce-Flags.** Beim Entfernen eines Channels bleibt
   `producesPr/producesIssue` auf dem Producer stehen.
7. **Zwei Emit-Speicherorte** (`agent.emits[]` neu vs. `trigger.emits[]`
   legacy) mit unterschiedlichen UI-Pfaden.
8. **Feldnamen-Drift** zwischen live (`parentMemberId`, `dataFlow.*`) und
   Draft (`parent`, direkte Felder) — durch die Adapter gekapselt, aber jede
   neue Funktion muss den Split erneut behandeln.

### 1.5 Unsichtbare Trigger (externe Quellen)

Genau die Trigger, die *nicht* von einem Agenten ausgehen, sind heute
unsichtbar bzw. nicht zeichenbar:

- **Raw-GitHub-Event-Trigger** (z. B. `issues.opened`) erzeugen Edges mit
  `from: null, external: true` — der Renderer verwirft sie.
- **Label-Trigger mit `from: humans`** (Mensch erstellt Issue, Mensch setzt
  Label → Agent startet) sehen für den Graph-Builder wie ein
  **Orphan-Listener** aus und werden fälschlich als Lint geflaggt, obwohl
  sie korrekt verdrahtet sind. Grafisch erstellbar sind sie gar nicht.
- **Cron/Once-Trigger** rendern als Self-Loop — sichtbar, aber nicht
  erstellbar, und semantisch schief (die Zeit triggert den Agenten, nicht
  der Agent sich selbst).
- **HTTP-Webhook-Trigger** (`type: http`) tauchen im Graph überhaupt nicht auf.
- **Human-Approval-Gates** rendern als eigener roter Gate-Knoten — ein
  Sonder-Visual nur für diesen einen Fall.

---

## Teil 2 — Zielbild

### Leitprinzipien

1. **Ein Anfasspunkt pro Node.** Es gibt genau einen Connect-Port. *Was*
   verbunden wird, entscheidet man nach dem Drop — nicht durch die Wahl des
   Anfassers.
2. **Ein Dialog, überall derselbe.** Erstellung läuft immer durch denselben
   zweistufigen Dialog: Typ wählen → Details ausfüllen. Ansichten
   unterscheiden sich nur darin, *welche Typen angeboten werden* — nie im
   Flow.
3. **Symmetrischer Lifecycle.** Jede sichtbare Kante ist klickbar und öffnet
   dieselbe Dialog-Hülle: Typ + Endpunkte + editierbare Eigenschaften +
   Löschen. Abgeleitete Kanten zeigen dieselbe Hülle read-only mit Verweis,
   *wo* sie autorisiert werden.
4. **Fähigkeiten sind deklariert, nicht verstreut.** Eine zentrale
   Capability-Matrix pro Modus (und Quell-Art) ersetzt ad-hoc `types`-Props
   und fehlende Callbacks.
5. **Information ≠ Interaktion.** PR/Issue-Erzeugung bleibt sichtbar
   (Badges), ist aber kein eigener Drag-Anfasser mehr.
6. **Vollständigkeit.** Alles, was einen Agenten starten kann, hat eine
   grafische Heimat — auch Zeit, Menschen und Drittsysteme.

### 2.1 Aktor-Knoten: externe Quellen als Erstklass-Elemente

Der Graph bekommt eine neue Node-Kategorie **„Aktor"** — Quellen, die keine
Agenten sind. Vier Singleton-Knoten, gerendert in einer schmalen Spalte am
linken Rand („Außenwelt"), visuell klar von Agenten unterschieden
(rund/abgerundet, gedämpfte Farbe, Icon):

| Aktor | Icon | Repräsentiert | Trigger-Typen, die von ihm ausgehen |
|---|---|---|---|
| **Mensch** | 👤 | Menschliche Nutzer (via GitHub oder Chat) | Label-Trigger mit `from: humans`; Human-Approval-Gates (`human:*`); Bremsen (`hold`, `needs:human`) |
| **GitHub** | 🐙 | Roh-Events aus dem Repo | `github-event` ohne `labelFilter` (`issues.opened`, `pull_request.opened`, `push`, …) |
| **Drittsystem** | ⚡ | Externe Systeme via Webhook | `http`-Trigger (CI, externe Tools) |
| **Zeit** | ⏰ | Der Scheduler | `cron`- und `once`-Trigger |

Damit gilt durchgängig: **Jede Verbindung ist ein Pfeil von einer Quelle zu
einem Agenten** — die Quelle ist entweder ein anderer Agent oder ein Aktor.
Keine unsichtbaren Trigger, keine Self-Loops mehr.

```
┌ Außenwelt ┐
│           │  Label »priorisiert«        ┌──────────────────┐  Label »ready-for-dev« ┌────────────┐
│ 👤 Mensch ●───────────────────────────▶│ business-analyst │●──────────────────────▶│ developer  │
│           │                             └──────────────────┘                        │    ⇅ PR    │
│ 🐙 GitHub ●──┐ issues.opened                                                        └────────────┘
│           │  └────────────────────────▶┌──────────────────┐                               │
│ ⏰ Zeit   ●───┐ cron: mo 06:00         │  issue-triage    │                          PR-Kanal 👤✓
│           │   └───────────────────────▶└──────────────────┘                               ▼
│ ⚡ Webhook●                                                                         ┌─────────────┐
└───────────┘                                                                        │code-reviewer│
                                                                                     └─────────────┘
```

Beispiel-Szenario, das damit erstmals zeichenbar wird: *Ein Mensch erstellt
ein Issue und setzt später ein Label; der Agent soll darauf starten.* →
Pfeil von 👤 Mensch → Agent, Typ „Label", Label-Name `priorisiert` → erzeugt
auf dem Agenten einen `github-event`-Trigger mit `labelFilter: priorisiert`
und `from: humans`.

### 2.2 Der eine Anfasspunkt

- Der bisherige lila ●-Port wird **der** Connect-Handle — auf Agenten und
  Aktoren gleichermaßen. Die PR/Issue-Pills verlieren ihre Drag-Funktion.
- Erscheint bei Hover über dem Node (in editierbaren Ansichten); Drag
  zeichnet wie heute die Ghost-Linie.
- **Während des Drags:** gültige Ziel-Nodes werden hervorgehoben, ungültige
  abgedunkelt (der Node selbst; Aktoren als Ziel; perspektivisch zyklische
  Parent-Ziele). Drop auf Leerraum oder `Esc` bricht ab.
- **In read-only-Ansichten** (Blueprint, Viewer, Import-Preview) wird der
  Port nicht gerendert; die Toolbar zeigt Grund und Handlung: *„Blueprint
  ist schreibgeschützt — ‚Als Draft bearbeiten' zum Ändern."* Kein stummes
  Verpuffen mehr.

### 2.3 Der einheitliche Verbindungs-Dialog (zweistufig)

Nach dem Drop öffnet sich immer derselbe Dialog.

**Schritt 1 — Typ wählen.** Kacheln mit Farbe (bestehende
`EDGE_STYLES`-Palette), Icon und Ein-Satz-Beschreibung:

```
┌─ Verbindung: business-analyst → developer ─────────────────────┐
│                                                                 │
│  Wie soll „developer" mit „business-analyst" verbunden werden?  │
│                                                                 │
│  ▸ ⇅ Pull-Request-Kanal   (empfohlen — dieser Agent öffnet PRs)│
│      developer reagiert auf PRs von business-analyst            │
│  ▸ ◉ Issue-Kanal                                                │
│      developer reagiert auf Issues von business-analyst         │
│  ▸ 🏷 Label-Hand-off                                            │
│      business-analyst setzt ein Label, developer lauscht        │
│  ▸ ⇢ Datenfluss / Abhängigkeit                                  │
│      developer nutzt ein Artefakt von business-analyst          │
│  ▸ ⌂ Hierarchie                                                 │
│      business-analyst wird Parent von developer                 │
│                                                                 │
│  ☐ Human-Approval-Gate auf diese Verbindung legen               │
└─────────────────────────────────────────────────────────────────┘
```

Eigenschaften dieses Schritts:

- **Kontext-Sortierung statt Spezial-Ports:** Erzeugt der Quell-Node
  PRs/Issues (`github.producesPr/Issue`), stehen die Kanal-Optionen oben und
  sind als „empfohlen" markiert. Das ersetzt die semantische Funktion der
  Pills, ohne einen zweiten Interaktionsweg zu brauchen.
- **Gefiltert nach Capability-Matrix:** Im BP-Modus zeigt derselbe Dialog
  nur „Datenfluss/Abhängigkeit" — gleicher Dialog, kleineres Angebot.
- **Gate als Querschnitts-Option:** Das Human-Approval-Gate ist eine
  Checkbox, anwendbar auf Label- und Kanal-Verbindungen. Der separate
  `AddApprovalDialog` wird zu einem Preset dieses Dialogs (der
  Toolbar-Button bleibt, öffnet aber denselben Dialog vorbelegt: Typ Label,
  `human:*`-Slug, `from: humans`).
- **Die Quelle bestimmt das Typ-Angebot** (gleiche Matrix-Mechanik, um die
  Dimension „Quell-Art" erweitert):

| Drag von → auf Agent | Angebotene Typen (Schritt 1) | Schritt 2 (Details) |
|---|---|---|
| **Agent** | Label-Hand-off, PR-/Issue-Kanal, Datenfluss/Abhängigkeit, Hierarchie | typspezifische Formulare (s. u.) |
| **👤 Mensch** | „Label durch Mensch", „Human-Approval-Gate" (Preset) | Label-Name, Issue/PR, labeled/unlabeled, Listener-Prompt |
| **🐙 GitHub** | „GitHub-Ereignis" | Event-Picker (Checkboxen: `issues.opened`, `pull_request.opened`, `push`, …), Repo, Origin-Filter |
| **⚡ Drittsystem** | „Webhook" | Beschreibung; nach Anlegen zeigt der Dialog die Hook-URL + Secret (`POST /hooks/:agentId/:hookId`) zum Kopieren |
| **⏰ Zeit** | „Zeitplan" | Cron-Editor (5-Feld-Expression mit Klartext-Vorschau) oder Einmal-Zeitpunkt |

**Schritt 2 — Details.** Die typspezifischen Formulare (weitgehend die
heutigen Sub-Formulare): Label-Name/Events/Origin-Filter beim Hand-off;
Routing-Label + Gate beim Kanal; Artefakt-Name/Hint beim Datenfluss (leer =
reine Abhängigkeit, wie heute); Hierarchie braucht keinen Schritt 2. Ein
„Zurück" zu Schritt 1 ist immer möglich.

### 2.4 Symmetrischer Edge-Lifecycle: eine Dialog-Hülle

Jeder Klick auf eine Kante öffnet dieselbe Hülle **„Verbindung"**:

```
┌─ Verbindung ────────────────────────────────────┐
│ ⇅ PR-Kanal   business-analyst → developer       │
│                                                  │
│ [ editierbare Eigenschaften des Typs             │
│   – oder Hinweis „abgeleitet aus X, dort ändern"]│
│                                                  │
│           [Löschen]   [Abbrechen]   [Speichern]  │
└──────────────────────────────────────────────────┘
```

- **Label / GitHub-Kanal:** voll editierbar (heutige `EditLabelHandoff` /
  `EditChannelDialog`), plus Löschen.
- **Dependency / Artifact / Parent:** dieselbe Hülle; es gibt schlicht keine
  editierbaren Eigenschaften außer den Endpunkten → Beschreibung + Löschen.
  Kein „mal Edit-Dialog, mal Remove-Dialog" mehr.
- **Aktor-Kanten:** 👤-Label-Kante (Label, Events, Prompt editierbar);
  🐙-Event-Kante (Event-Set, Origin-Filter); ⚡-Webhook-Kante (URL
  anzeigen/kopieren, Secret rotieren); ⏰-Kante (Cron-Expression /
  Zeitpunkt). Der Trigger-Tab im Inspector bleibt als Zweitweg — beide
  schreiben dasselbe `triggers.json`.
- **Abgeleitete Kanten** (review, derived Data-Flow-Trigger): read-only in
  derselben Hülle, mit klickbarem Verweis auf den Ort der Wahrheit
  („bearbeiten im Trigger-Tab von *code-reviewer*").
- **Aufräum-Logik beim Löschen:** Beim Entfernen des letzten Kanals, der
  einen Producer konsumiert, bietet der Dialog per Checkbox „PR/Issue-
  Erzeugung am Producer ebenfalls entfernen?" (Default: an) — beseitigt
  verwaiste Produce-Flags. Das Löschen eines Label-Hand-offs bietet wie
  heute die Wahl „Listener löschen / Emit entfernen", nur konsistent in
  derselben Hülle.

Der bisherige rote Gate-Sonderknoten entfällt: Ein Human-Approval ist eine
**Kante von 👤** mit dem bekannten roten `👤✓`-Chip — dieselbe visuelle
Sprache wie Gates auf PR-Kanälen.

### 2.5 PR/Issue-Erzeugung: Badge statt Drag-Port

- Die **Badges** (`⇅ PR`, `◉ Issue`) am Node-Header bleiben — die optische
  Information, dass ein Agent PRs/Issues erzeugt, ist gewollt.
- Gesetzt werden die Flags **explizit** über die Checkboxen in der
  `ConnectionsSection` und **implizit** beim Anlegen eines Kanals (Dialog
  setzt das Flag auf dem Producer mit) — wie heute.
- Feinschliff: Badge-Klick öffnet den Node-Inspector auf dem
  Connections-Tab — der Badge wird zum „mehr erfahren", nicht zum
  Drag-Anfasser.

### 2.6 Capability-Matrix als Single Source of Truth

Ein deklaratives Modul (konzeptionell `connection-capabilities.js`)
beschreibt pro Modus (und Quell-Art, s. 2.3), was geht — Renderer, Dialoge
und Inspector lesen alle daraus:

| Modus | erstellbar | editierbar | Port sichtbar | Aktoren | Hinweis bei read-only |
|---|---|---|---|---|---|
| Draft | label, github(pr/issue), dataflow/dependency, hierarchy, gate, timer, event, webhook | alle eigenen | ✅ | ✅ | — |
| Live Team | wie Draft | wie Draft | ✅ | ✅ | — |
| BP (Workspace) | dataflow/dependency | dito | ✅ | ✗ (BPs haben keine Trigger) | — |
| Blueprint | — | — | ✗ | nur mit Kanten, ohne Port | „Als Draft bearbeiten" |
| BP-Viewer / Import-Preview | — | — | ✗ | dito | „Nur Ansicht" |

Damit verschwinden die drei heutigen Mechanismen (`types`-Prop, fehlende
Callbacks, `editable`-Flag im Renderer-State) hinter einer einzigen
Deklaration. Neue Ansichten oder Verbindungstypen werden an genau einer
Stelle registriert.

Wichtig: **Die BP-Ansicht bekommt denselben Edge-Klick-Flow** (heute fehlt
`onSelectEdge` dort komplett). Entfernen von Deps/Artifacts geht dann im
BP-Modus sowohl über die Kante als auch — wie bisher — über den Inspector.

### 2.7 Graph-Builder- und Lint-Anpassungen

1. **Pseudo-Node-IDs:** `unified-graph.js` emittiert Aktor-Knoten
   (`@human`, `@github`, `@external`, `@timer`, `kind: 'actor'`) und hängt
   die heutigen `from: null`-Edges dort an. Der Renderer braucht keine
   Sonderfälle mehr (das Verwerfen von `external`-Edges entfällt).
2. **`from: humans`-Mapping:** Ein Label-Trigger, dessen Origin-Filter
   Menschen einschließt und für den kein Agent das Label emittiert, wird als
   Kante von `@human` gezeichnet — **und der `orphan-listener`-Lint schlägt
   dafür nicht mehr an.** Orphan bleibt nur, was wirklich niemand auslösen
   kann (z. B. `from: agents` ohne emittierenden Agenten).
3. **Timer:** `on: 'timer'` wechselt von Self-Loop auf Kante
   `@timer → Agent`, Chip = Klartext-Schedule.
4. **HTTP-Trigger** werden erstmals in den Graph aufgenommen
   (`@external → Agent`, `on: 'webhook'` — der einzige neue `on`-Wert
   dieses Konzepts).
5. **Layout:** Die Aktor-Spalte steht links vor der ersten Stage/Schicht —
   passt natürlich zum Layered-Layout (Quellen → Senken) und gibt jedem
   Prozess einen sichtbaren Anfang.

### 2.8 Sichtbarkeit und Clutter-Kontrolle

- **Aktoren erscheinen nur, wenn sie Kanten haben** — plus im editierbaren
  Modus immer (sonst könnte man von ihnen nichts ziehen). In
  read-only-Ansichten erscheinen sie nur bei vorhandenen Kanten, ohne Port.
- **Legende wird zum Filter:** Klick auf „Zeit" in der Legende blendet
  Timer-Kanten aus/ein (analog je Aktor). Wöchentliche
  Memory-Curation-Crons sind wichtig zu *haben*, aber selten wichtig zu
  *sehen*.
- Die BP-Ansicht bleibt unberührt — BriefingPacks haben keine Trigger, dort
  tauchen keine Aktoren auf.

### 2.9 Datenmodell-Begleitmaßnahmen

1. **Emits kanonisieren (umgesetzt, #414):** `agent.emits[]` ist der einzige
   Schreibort — der Emits-Editor sitzt in der `ConnectionsSection`
   („Emits labels", Draft- und Live-Inspector). `trigger.emits[]` bleibt
   lesbar (der Graph-Builder wertet es weiter aus) und wird in der
   TriggerCard als „emits (legacy)" angezeigt; dort ist nur noch
   *Entfernen* (Aufräumen) möglich, kein Hinzufügen. Die Delete-Pfade des
   Label-Hand-offs räumen weiterhin beide Orte.
2. **Adapter-Parität dokumentiert halten:** `liveOps` / `makeDraftOps` /
   `makeBpOps` behalten ihre identische Signatur; die Feldnamen-Drift
   (`parent` vs. `parentMemberId`, `dataFlow.*`) bleibt in den Adaptern
   gekapselt — neue Ops müssen in allen drei (bzw. als bewusstes „nicht
   unterstützt" in der Capability-Matrix) definiert werden.
3. **Nur ein neuer Edge-Typ (`webhook`):** Ansonsten kommt das Konzept
   vollständig mit den bestehenden `on`-Typen und Ports aus — es ändert
   nur, *wie* sie erzeugt und bearbeitet werden.

---

## Teil 3 — Vollständigkeits-Check: jede Trigger-Art hat eine grafische Heimat

| Trigger im Datenmodell | Grafisch heute | Grafisch im Zielbild |
|---|---|---|
| `github-event` + `labelFilter`, Emitter = Agent | ✅ Label-Kante | Agent → Agent (unverändert) |
| `github-event` + `labelFilter`, `from: humans` | ⚠️ unsichtbar / fälschlich Orphan | **👤 → Agent** |
| `human:*` / `hold` / `needs:human` | roter Sonderknoten | 👤 → Agent mit Gate-/Bremsen-Chip |
| `github-event` ohne `labelFilter` (Roh-Event) | ❌ verworfen | **🐙 → Agent** |
| `channel: true` (PR/Issue-Kanal, derived) | ✅ Kanal-Kante | Agent → Agent (unverändert) |
| `cron` / `once` | ⚠️ Self-Loop, nicht erstellbar | **⏰ → Agent**, voll erstell-/editierbar |
| `http` (Webhook) | ❌ gar nicht | **⚡ → Agent** |
| Datenfluss-Trigger (derived aus `dataFlow`) | ✅ Artifact-Kante | unverändert (read-only, Verweis auf Ports) |

## Teil 4 — Vorher/Nachher aus Nutzersicht

| Situation | Heute | Zielbild |
|---|---|---|
| „Ich will A mit B verbinden" | Erst überlegen: lila Punkt oder Pill? Je nachdem anderer Dialog | Immer: ● ziehen → Typ wählen → Details |
| „B soll auf PRs von A reagieren" | Pill „PR" ziehen (nur wenn man sie kennt) *oder* ●-Port → Typ „github" | ● ziehen → „PR-Kanal" steht dank Badge-Kontext oben als Empfehlung |
| „Agent soll starten, wenn ein Mensch ein Label setzt" | Nur über den Trigger-Editor; im Graph unsichtbar bzw. Orphan-Lint | ● von 👤 auf den Agenten ziehen → „Label durch Mensch" |
| „Agent soll jeden Montag laufen" | Trigger-Tab; im Graph nur Self-Loop | ● von ⏰ auf den Agenten ziehen → Cron-Editor |
| „CI soll den Agenten anstoßen" | Trigger-Tab; im Graph gar nicht sichtbar | ● von ⚡ ziehen → Webhook; Dialog zeigt URL + Secret |
| „Kante anklicken" | Mal Edit, mal Remove-only, mal gar nichts (BP) | Immer dieselbe Hülle: Eigenschaften (falls vorhanden) + Löschen; derived = read-only mit Verweis |
| „Human-Approval einbauen" | Eigener Toolbar-Dialog; im Label-Dialog nicht möglich | Option im selben Verbindungs-Dialog; Toolbar-Button = Preset |
| Drag im Blueprint | Passiert stumm nichts | Port nicht sichtbar + Hinweis „Als Draft bearbeiten" |
| Channel gelöscht | Produce-Badge bleibt verwaist stehen | Dialog bietet Aufräumen des Producer-Flags an |
| BP-Flow bearbeiten | Nur ●-Port + Inspector, Kanten nicht klickbar | Gleiche Gesten wie überall, Typ-Set {Datenfluss/Abhängigkeit} |

## Teil 5 — Umsetzungsskizze (jeweils unabhängig shippable)

1. **Capability-Matrix einführen** (inkl. Quell-Dimension) und bestehende
   Gates (`types`-Props, `editable`, fehlende Callbacks) darauf umstellen —
   reines Refactoring, kein UX-Delta.
2. **Aktor-Knoten + Builder-Mapping** — reine Darstellung, sofortiger
   Mehrwert: Unsichtbares (Roh-Events, `from: humans`, Webhooks) wird
   sichtbar; Timer wandern vom Self-Loop an den ⏰-Aktor; Orphan-Lint-
   Verfeinerung.
3. **Unified Create-Dialog:** `CreateEdgeDialog` zum kontext-sortierenden
   Typ-Picker ausbauen (PR/Issue als Kacheln, Gate-Option, Empfehlung aus
   Producer-Badges, Aktor-Quellen mit eigenem Typ-Angebot); Pills-Drag
   entfernen, Badges bleiben.
4. **Unified Edit-Hülle:** `EditHandoffDialog`-Dispatcher in die gemeinsame
   „Verbindung"-Hülle überführen; Remove-only- und Readonly-Fälle
   einbetten; Aktor-Kanten editierbar; `onSelectEdge` im BP-Modus
   verdrahten; Produce-Flag-Aufräumen.
5. **Read-only-Feedback** (Port ausblenden + Hinweis) und
   `AddApprovalDialog` als Preset.
6. **Emits-Kanonisierung** (Datenmodell-Nacharbeit).

## Offene Punkte

- **DM-Konversationen** (Mensch chattet mit persistentem Agenten) als
  dezente 👤-Kante? Empfehlung: vorerst nein — kein Trigger im technischen
  Sinn, würde von jedem Agenten eine Kante erzwingen. Später als
  abschaltbare Info-Kante möglich.
- **Drag von Agent auf 👤** („Mensch benachrichtigen") ist bewusst
  ausgeklammert; beim Drag sind Aktoren als Ziel abgedunkelt.
- **Pills als Experten-Shortcut behalten?** Aktuell verworfen zugunsten der
  einen Geste; die Kontext-Empfehlung im Typ-Picker kompensiert den
  verlorenen Ein-Schritt-Weg.
