# Workspace Git Diff View — Konzept

Status: Entwurf · 2026-05-08
Bezieht sich auf: `admin-console/src/pages/agent-chat/WorkspaceBrowser.jsx`, `admin-console/api/api.js` (Workspace-/Git-Endpoints)

## 1. Ziel

Im Agent-Chat (Right-Rail) gibt es heute den Workspace-Tab mit Datei-Baum und einer
kleinen Git-Info (Branch-Name, ggf. dirty). Die Inspektion „was hat der Agent
eigentlich geändert?“ ist damit nur indirekt möglich — man muss in den richtigen
Ordner navigieren, die Datei öffnen und mit dem letzten Commit vergleichen.

Das neue Feature liefert eine **dedizierte Diff-Ansicht** pro Agent-Workspace mit:

1. einer **flachen Liste** aller geänderten / neu angelegten / gelöschten Dateien,
2. einer **Detailansicht je Datei**, die den Diff anzeigt — wahlweise als
   Unified- oder als **Side-by-Side**-Diff (zwei Spalten).

Read-only, wie der bestehende Workspace-Browser. Stagen / Committen / Reverten
gehört dem Agenten, nicht dem Bediener.

## 2. Scope und Annahmen

- **Multi-Repo.** Ein Agent-Workspace kann mehrere Git-Repos enthalten — entweder
  direkt im Workspace-Root oder in einem ersten Subdirectory (siehe
  `discoverGitRepos()` in `api.js`). Die Diff-View arbeitet pro Repo; bei
  mehreren wird ein Repo-Selector vorgeschaltet (Default: erstes Repo, das
  `isDirty: true` meldet, sonst das einzige Repo, sonst ein Hinweis-Stub).
- **Vergleichsbasis.** Per Default vergleicht die View den **Working Tree gegen
  HEAD** (also alles was `git status` als modifiziert / neu / gelöscht
  zeigt — staged + unstaged + untracked). Ein zweiter Modus „nur staged“
  (`HEAD` vs. Index) wird nicht in MVP-1 ausgeliefert, ist aber per
  Query-Parameter `mode` API-seitig vorbereitet.
- **Untracked.** Werden als „Add“ angezeigt. Vorher = leer, nachher =
  Dateiinhalt. `git diff --no-index /dev/null <file>` liefert das, ohne
  vorher zu stagen.
- **Binäre Dateien & Größenlimit.** Wie beim File-Viewer: 512 KB Cap, NUL-Byte-
  Heuristik. Binärdateien zeigen nur den Status, keinen Text-Diff.
- **Read-only.** Keine Schreiboperationen. Insbesondere: kein `git add`,
  kein `git checkout`, kein „revert this hunk“-Knopf. Die View ist eine
  **Inspektionshilfe**, nicht ein Git-Client.
- **Performance.** `git status --porcelain=v1 -z` und `git diff` werden über
  `runGitAsync()` (async `execFile`, seit #1683 — vorher `spawnSync`) mit kurzen
  Timeouts (5 s) aufgerufen, damit ein langsamer git-Aufruf den Event-Loop nicht
  blockiert. Die Branch-Ermittlung liest `.git/HEAD` direkt (kein git-Prozess);
  der `git-info`-Poll cached seinen Dirty-Status (`AEE_GIT_INFO_TTL_MS`,
  Default 35 s, seit #2923 über dem 30-s-Poll) und liefert ein abgelaufenes
  Ergebnis sofort aus, während ein einzelnes `git status` im Hintergrund
  nachlädt (stale-while-revalidate, bis 10 min alt). Sehr große Diffs werden serverseitig gekappt (s. §6).

## 3. UX

### 3.1 Einstieg

Der Workspace-Tab bekommt im Toolbar-Bereich (über dem Baum) einen kleinen
Mode-Switch:

```
[ Tree | Diff ]   /workspace/agents/<id>/
```

Default bleibt Tree. Der Mode wird in `localStorage` (`agentChat.workspaceMode`)
persistiert, damit ein Reload nicht die Auswahl wegwirft.

Alternative: separater Tab im Right-Rail (neben „Log / Workspace / Triggers“).
**Empfehlung: Mode-Switch innerhalb von Workspace.** Der Diff teilt sich Repo,
Pfad-Kontext und Refresh-Logik mit dem Tree, ein eigener Tab würde diesen Zustand
duplizieren.

### 3.2 Layout im Diff-Modus

```
┌─────────────────────────────────────────┐
│  Tree | [Diff]    /workspace/agents/.../│
├─────────────────────────────────────────┤
│  Repo: ▾ repo-a (main · dirty 7)        │   ← Repo-Selector (nur wenn >1)
├─────────────────────────────────────────┤
│  Changes (7)                            │
│  ──────────────────────────────────────  │
│  M  src/foo/bar.js               +12 -3 │
│  M  README.md                     +1 -1 │
│  A  docs/new.md                   +42   │
│  D  legacy/old.cob                  -88 │
│  ?? scratch/notes.txt             +9    │
│  ──────────────────────────────────────  │
│                                         │
│  ▼  Diff: src/foo/bar.js                │   ← Detail-Pane unter der Liste
│  [Unified | Side-by-Side]               │
│  ────────────────────────────────────── │
│   alt (HEAD)         │ neu (working)    │
│   ...                │ ...              │
└─────────────────────────────────────────┘
```

**Aufteilung.** Im Diff-Modus wird (analog zum heutigen FileViewer) die obere
Hälfte für die Liste verwendet, die untere für den Diff der gewählten Datei.
40/60-Split, identisch zur Tree/FileViewer-Aufteilung. Über das
Maximize-Icon im Diff-Header öffnet sich der Modal-Vollbild-Diff (Portal,
ESC schließt) — wieder genau wie beim FileViewer.

### 3.3 Liste der Änderungen

Eine **flache, sortierte Liste** — keine Baum-Hierarchie. Jede Zeile besteht aus:

| Spalte | Inhalt |
|---|---|
| Status-Badge | `M` `A` `D` `R` `?` (untracked) — farbcodiert |
| Pfad | repo-relativ, mit `text-overflow: ellipsis`, voller Pfad als `title` |
| `+/-`-Zähler | grün/rot, monospace, optional bei Binär: `BIN` |

Sortierung: nach Status-Gruppe (modified → added → deleted → untracked → renamed),
innerhalb der Gruppe alphabetisch. Dieser Sort hilft beim Scannen — typischerweise
will man zuerst sehen, *was bestehende Dateien wurden geändert*.

Klick auf eine Zeile lädt den Diff in das untere Pane. Aktive Zeile bekommt das
gleiche `--eb-accent-muted`-Background-Treatment wie der heutige FileViewer.

### 3.4 Diff-Pane

Header zeigt:

- Status-Badge + Dateipfad (mit `dir/` gedimmt, Filename hervorgehoben)
- Toggle „Unified | Side-by-Side“ (in `localStorage` persistiert)
- „Open file“-Button → wechselt zurück in den Tree-Modus, öffnet die Datei im
  bestehenden FileViewer (für volle Inhaltssicht)
- Maximize / Close

**Unified View.** Klassische `git diff`-Darstellung: Hunk-Header in dezent,
Zeilen mit `+` grün-getöntem Background, `-` rot-getöntem Background, Kontext
neutral. Monospace, `tab-size: 2`.

**Side-by-Side View.** Zwei Spalten. Links HEAD, rechts Working. Zeilen werden
über die Hunk-Information ausgerichtet — bei reinen Änderungen Zeile-zu-Zeile,
bei Adds nur rechts, bei Deletes nur links. Eine **leichtgewichtige
clientseitige Implementierung** auf Basis von `parse-diff` (oder
`diff2html`) — beide reine NPM-Pakete ohne native Abhängigkeiten — reicht für
unseren Bedarf.

> Empfehlung: **`react-diff-view` + `gitdiff-parser`**. Bewährt, klein
> (~30 KB gz), unterstützt Unified + Split, hat Themes und ist mit React-19
> kompatibel. Falls die Bundle-Size kritisch ist: `parse-diff` für den Parse-Schritt
> + handgerollte Render-Komponente (~200 LoC).

**Big-Diff-Handling.** Über 2.000 Zeilen pro Datei wird der Diff
in der UI standardmäßig nicht expandiert dargestellt. Stattdessen ein Banner
„Großer Diff (3.124 Zeilen) — Anzeigen?“ mit Confirm-Button. Schützt vor
versehentlichem Renderen mehrere-MB-Diffs in der Liste.

### 3.5 Empty States

- Repo ist sauber: „Keine Änderungen — Working Tree entspricht HEAD.“
- Repo ist nicht-Git: „Dieses Verzeichnis ist kein Git-Repo.“ (relevant
  wenn der Workspace selbst kein Repo ist und der Selector leer wäre).
- Workspace hat überhaupt kein Repo: kompletter Diff-Modus zeigt diesen
  Hinweis ohne Repo-Selector.

### 3.6 Refresh

- Manuell: Refresh-Button in der Toolbar (existiert bereits, wirkt im Diff-Modus
  auf `git status` + offenen Datei-Diff).
- Automatisch: einmaliger Re-Fetch, wenn der Tab vom Background nach Foreground
  wechselt (`active`-Prop, schon vorhanden). Kein Polling — der Workspace ist
  zwischen Agent-Turns statisch genug.
- Zukunft (out of scope): SSE-Push, sobald der Agent geschrieben hat. Hängt
  davon ab, dass der Agent-Runner `tool_result`-Events mit `Edit`/`Write` an
  einen Filesystem-Bus weiterleitet — dafür gibt es bisher keine Infrastruktur.

### 3.7 Tastatur

- `j` / `k` (oder ↑/↓) wandert in der Liste rauf/runter, lädt den Diff
  inkrementell.
- `s` togglet Unified ↔ Side-by-Side.
- `Esc` schließt den Modal-Diff (existiert).
- Keine globalen Shortcuts; nur wenn der Diff-Pane den Fokus hat.

## 4. Backend-API

Zwei neue Endpoints, beide im Stil der bestehenden `workspace/*`-Routen
(d. h. mit `AGENT_ID_RE`-Validierung, `safeAgentPath`, git-Aufruf mit Timeout —
seit #1683 async über `runGitAsync()`/`execFile`, davor `spawnSync`).

### 4.1 `GET /api/agents/:agentId/workspace/git-status`

Listet pro Repo den Status aller geänderten Dateien.

**Query**:
- `repo` — repo-relativer Pfad (default: alle Repos zurückgeben)
- `mode` — `worktree` (default) | `staged` (HEAD vs. Index) | `all`

**Response**:

```json
{
  "repos": [
    {
      "repoPath": ".",                  // oder "subdir-name"
      "branch": "main",
      "head": "abc1234",                // short hash
      "ahead": 2,                       // optional, nur wenn upstream gesetzt
      "behind": 0,
      "files": [
        {
          "path": "src/foo/bar.js",
          "status": "M",                // M | A | D | R | C | U | ??
          "indexStatus": " ",
          "worktreeStatus": "M",
          "renameFrom": null,
          "additions": 12,
          "deletions": 3,
          "binary": false
        }
      ]
    }
  ]
}
```

**Implementierung**:
- `git status --porcelain=v1 -z` für die Liste
- `git diff --numstat HEAD` (bzw. `--cached`) für die `+/-`-Zähler. Ein Aufruf
  pro Mode, ergebnisse werden gemerged. Untracked Dateien werden mit
  `wc -l` für `additions` aufgefüllt — günstig und ausreichend.
- Timeout 5 s, `cwd` = absoluter Repo-Pfad, beides validiert über
  `safeAgentPath`.

### 4.2 `GET /api/agents/:agentId/workspace/git-diff`

Liefert den Diff einer einzelnen Datei.

**Query**:
- `repo` — repo-relativer Pfad (Pflicht, kann `.` sein)
- `path` — Datei-Pfad innerhalb des Repos (Pflicht)
- `mode` — `worktree` | `staged`
- `context` — Anzahl Kontext-Zeilen, Default 3, Max 20

**Response**:

```json
{
  "repo": ".",
  "path": "src/foo/bar.js",
  "status": "M",
  "binary": false,
  "truncated": false,
  "additions": 12,
  "deletions": 3,
  "diff": "diff --git a/...\n@@ ... @@\n-...\n+...\n"
}
```

**Implementierung**:
- Modified: `git diff -U<context> -- <path>`
- Staged: `git diff --cached -U<context> -- <path>`
- Untracked: `git diff --no-index -U<context> /dev/null <path>` (Exit-Code 1
  ist hier *Erfolg* — heißt „Unterschiede gefunden“, muss sauber gehandhabt
  werden).
- Deleted: vom `git diff` automatisch korrekt produziert (`/dev/null` als
  rechte Seite).
- Cap: 1 MB Diff-Output (`execFile` `maxBuffer`), bei Überschreitung
  `truncated: true` + abgeschnittenes `diff`.
- Binäre Dateien: `git diff` emittiert nur die `Binary files differ`-Zeile,
  Backend erkennt das und setzt `binary: true`, `diff: ""`.

### 4.3 Sicherheit / Hardening

- `safeAgentPath` für **beide** Pfadeingaben (`repo` und `repo + path`) —
  jede Auflösung außerhalb von `/workspace/agents/<id>/` => 400.
- `repoPath` muss tatsächlich auf ein `.git`-Verzeichnis zeigen
  (Existenz-Check vor `git`-Spawn). Sonst 400 — verhindert, dass `git` aus
  einem Übergeordneten-Repo „raus-suchet“.
- `execFile` ohne Shell, `timeout: 5000`, `maxBuffer: 1_000_000`.
- Args werden nicht durchs Templating zusammengebaut, sondern als
  Array-Form übergeben — kein Command-Injection-Risiko.

## 5. Frontend-Anbindung

Neue Komponentenstruktur:

```
admin-console/src/pages/agent-chat/
  WorkspaceBrowser.jsx        ← orchestriert Tree- und Diff-Modus
  workspace/
    Tree.jsx                  ← extrahierter Tree-Inhalt (heute inline)
    DiffView.jsx              ← neu: Liste + Detail-Pane
    DiffList.jsx              ← neu: flache File-Liste
    DiffPane.jsx              ← neu: Header + Unified/Split Renderer
    DiffRenderer.jsx          ← neu: hüllt react-diff-view ein
    RepoSelector.jsx          ← neu: Dropdown wenn >1 Repo
```

Für MVP-1 reicht es, `DiffView.jsx` und `DiffRenderer.jsx` zu bauen — die
übrigen Dateien sind Refactoring-Kandidaten und lösen das „1000-Zeilen-File“-
Problem, das `WorkspaceBrowser.jsx` heute schon hat.

State im `WorkspaceBrowser`:

```js
const [mode, setMode]         = useState('tree' | 'diff');   // localStorage
const [selectedRepo, setRepo] = useState(null);              // erste dirty Repo
const [diffStatus, setDiffStatus] = useState(null);          // Result von /git-status
const [selectedDiff, setSelectedDiff] = useState(null);      // { repo, path }
```

Die bestehenden Tree-States (`dirCache`, `expanded`, `selectedFile`) bleiben
unangetastet — Diff-Modus nutzt sie nicht.

## 6. Performance & Limits

| Operation | Limit | Verhalten bei Überschreitung |
|---|---|---|
| `git status` Timeout | 5 s | 504-ähnlicher Hinweis im UI |
| Diff-Output pro Datei | 1 MB | `truncated: true`, Banner im UI |
| Diff-Zeilen im UI gerendert | 2 000 | Confirm-Banner „Anzeigen?“ |
| Anzahl Files in der Liste | unbegrenzt | virtualisiert via `react-window`, falls Liste >200 |

`react-window` ist hier „nice-to-have“; in der Praxis wird ein Agent-Workspace
selten dreistellige Change-Counts haben.

## 7. Lieferpaket / Phasen

**MVP-1** (1–2 Tage)
- Backend: `git-status` + `git-diff` Endpoints, Multi-Repo-fähig.
- Frontend: Mode-Switch im Workspace, flache Liste, Unified-Diff,
  einfacher Header, Empty States.
- Read-only, kein Side-by-Side.

**MVP-2** (+1 Tag)
- Side-by-Side-Renderer (`react-diff-view` einziehen).
- Modal-Vollbild-Diff (analog FileViewer).
- Tastatur-Navigation in der Liste.

**Später / nice-to-have**
- Staged-Modus per Toggle.
- „Open file in tree“-Sprung.
- SSE-Live-Updates nach Agent-Edits.
- Hunk-weise Kollabieren in großen Diffs.
- Branch-Vergleich (HEAD vs. `origin/main`) — nützlich für die Frage
  „was hat dieser Agent in *dieser Sitzung* geschafft?“.

## 8. Offene Fragen

1. **Welcher Vergleichsmodus ist für Mainframe-Migration nützlicher** —
   Working Tree gegen HEAD (Default-Vorschlag) oder gegen den Stand bei
   Agent-Start? Letzteres würde einen Snapshot-Mechanismus brauchen
   (z. B. `git stash create` zum Session-Start).
2. **Branch-Vergleich auch im MVP?** Oft will man die Summe aller Änderungen
   gegen `origin/main` sehen, nicht nur den uncommitteten Stand. Wäre
   denkbar als zusätzlicher Mode-Wert (`mode=branch&base=origin/main`).
3. **Gilt der Diff-Modus auch im BP-Explorer?** — out of scope hier, aber
   die `git-status`-Endpoint-Form ließe sich dorthin spiegeln, wenn die
   gleichen Repos auch dort browseable wären.
