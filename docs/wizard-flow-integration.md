# Team wizard × Flow Designer — process-first team creation (#419–#424, #428)

> **Update (#1190): the "Compose a process" option and the Flow-Weaver backend
> were removed.** The stage-column composer, the custom-role dialog, and the
> deterministic `POST /api/process/weave` engine (`admin-console/api/flow-weaver.js`)
> no longer exist.
>
> **Update (#1703): the three-card chooser was removed — the Process step now
> lands directly on the template/draft gallery.** *Describe the flow* (Flow
> Copilot) and *Start blank in the canvas* moved to the unified **"+ Create"
> launcher** (`/create`, #1665) now that it offers equally-ranked describe/blank
> tiles, so the wizard's only remaining job is building a team from a ready-made
> template/flow. The step keeps a lightweight "need a custom flow? use + Create"
> pointer (and an empty-state link to `/create` when no templates/drafts exist);
> the "Choose a different entry" back-to-chooser control is gone. The rows below
> for *Describe the flow* / *Start blank* are retained only as history — those
> entries no longer exist **inside the wizard** (the capabilities themselves are
> unchanged, reachable via the launcher and the Flows editor). The template
> registry (#419) and catalog v2 (#420) survive because they still back the
> template gallery and the wiring-suggestion feature.

The Team-Setup wizard and the Flow Designer used to be two separate worlds that
both fed `POST /api/teams`: the wizard picked *flat role lists* from the
agent-template catalog (hard-wired to the dispatcher pattern), while the
Process Canvas offered full free-form flow authoring with no guidance and no
gap protection. This feature line is the bridge: **one artifact — a
`processTemplateVersion: 1` bundle — with several entry paths**, all feeding the
existing materialisation pipeline. There is deliberately no second
materialisation path.

| Entry | For whom | UX |
|---|---|---|
| **Template** | "just get me started" | Gallery of curated process templates + saved drafts → one click → team |
| **Describe the flow** | "describe it in words" | Plain-language description → the Flow Copilot (`POST /api/process/copilot`) generates a validated bundle |
| **Start blank** | "I want full control" | Empty draft + free-form authoring in the Flows canvas (draft round-trip) |

## Building blocks

### 1. Process-template registry (#419)

Curated, git-versioned whole-process bundles — the process-level analogue of
`agent-templates/`:

- Source of truth: `orchestrator/skill-pool/process-templates/*.json`
  (`core-sdlc`, `extended-sdlc`), seeded into the pool volume via
  `make seed-process-templates` (chained from `make seed-pool`).
- API: `GET /api/process-templates` (gallery summary: id, name, description,
  roleCount, stages) and `GET /api/process-templates/:id` (full bundle).
  Module: `admin-console/api/process-template-registry.js`.
- CI guard (`process-template-registry.test.js`): every curated template must
  validate and render **lint-clean** (zero error/warning lints).

The **Extended SDLC** template is the reference process: four stages
(Requirements → Design → Build → Release) instantiating the reduced per-stage
pattern with human gates on every stage boundary.

### 2. Catalog v2 — typed ports on agent templates (#420)

Agent templates carry an additive, backwards-compatible composition surface
(see `docs/process-template-format.md` → *Catalog v2* for the schema). It
originally let the Flow-Weaver bind roles into a process; with the weaver
removed (#1190) it now backs the **wiring-suggestion** feature
(`POST /api/agent-ports/suggest`, `port-suggestion.js`) used by the Flow Editor
and the Add-role dialog:

- `patternRole`: `scout | author | companion | intake | standalone` — the
  role's place in the per-stage pattern
  **Scout (gap + evidence) → Author → Companion (review, feedback routing, escalation)**.
- `stageAffinity`: grouping hint.
- `ports.consumes` with abstract slots (`stage-entry`, `stage-author`) and
  `ports.produces` (defaulting from the `github` flags).
- Trigger-level `intrinsic: true`: part of the role's essence (Issue Triage's
  `issues.opened`, self-curation crons). The legacy roles-array path is
  unaffected.

Normalisation: `admin-console/api/catalog-ports.js`.

### 3. Flow-Weaver (#421) — REMOVED (#1190)

> The deterministic wiring engine (`admin-console/api/flow-weaver.js`) and its
> `POST /api/process/weave` route were removed with the "Compose a process"
> option. The description below is kept only as history.

It was a **deterministic, pure** wiring engine (deliberately not an LLM: wiring
must be reproducible and guaranteeable) that took ordered stages with selected
roles and produced a complete bundle plus `notes[]` explaining every applied
gap rule: a human-gated stage chain (`<prefix>:approved` issue channels), an
intra-stage Scout → Author → Companion pattern with escalation/rework loops, and
gap rules that merged missing duties into the Author so the woven bundle always
rendered **lint-clean**.

### 4. Wizard Process step (#422, moved to the front by #428)

The wizard's **step 1** (create mode) is the **Process** step
(`admin-console/src/pages/team-setup/StepProcess.jsx`). The process choice is
the entry decision — *what kind of team am I building?* — and the remaining
steps qualify it: **Process → Working Environment → Team → Knowledge
(optional) → Review** (#428; before that, Process was step 4 and the
blank-canvas exit threw away the configuration entered in steps 1–3):

- Three entry cards: *Use a template* / *Describe the flow* / *Start blank in
  the canvas* (creates an empty draft, jumps to `/flows?proc=draft:<id>` —
  loss-free, since as step 1 nothing has been entered yet). *(The former
  *Compose a process* card + composer were removed by #1190.)*
- **Describe the flow** (#1070): a plain-language description is streamed to the
  Flow Copilot (`POST /api/process/copilot`, the same endpoint the Flows editor
  panel uses); an `ok:true` bundle lands on the form, an unappliable one keeps
  the form untouched and surfaces the error lints for the user to refine.
- **Name binding:** the team name isn't known while the bundle is selected (it
  is entered two steps later), so the bundle carries a placeholder name; the
  wizard overwrites `bundle.name` with the team name at submit time, so the
  materialised bundle name always equals the team name.
- Inline **flow preview** (SVG: stage columns, channel + label edges, human
  gates) plus **authoritative lint badges** from `POST /api/flows/graph`;
  error lints block submission.
- Exits: **Create team** (bundle → `POST /api/teams/stream`, which has full
  `processTemplate` parity with `POST /api/teams`) and **Save as draft** (→
  canvas fine-tuning; materialise later via the existing round-trip).
- Review step renders the final graph + role list grouped by stage.

## Create-only wizard & the legacy roles path

- The wizard is **create-only**: it builds teams exclusively through the Process
  step, and the flat role-checkbox list is retired.
- The **Extend Team UI has been removed** (#588) — growing an existing team now
  happens in the Flow Editor (Edit-as-draft → Create team…). Old
  `/team-setup?team=<id>&mode=extend` deep links redirect to
  `/flows?proc=<team>`.
- The backend `mode: "extend"` path is **retained**. The wizard still uses it in
  one place: an id collision hit while submitting a bundle stays on the bundle
  path, and the collision card re-submits the *same* bundle with
  `mode: "extend"`, adding only the missing members. The Flow Editor's
  Create-team round-trip drives the same path.
- `POST /api/teams` (and `/stream`) continue to accept plain `roles` +
  `customRoles` for API compatibility — the retirement is UI-only.

## Follow-ups (obsolete after #1190)

The original follow-ups (a dispatcher *weaver block*, "promote custom role to
catalog", stage-affine skill packs) all presupposed the Compose/Flow-Weaver
path and are moot now that it has been removed.
