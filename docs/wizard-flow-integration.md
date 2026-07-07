# Team wizard × Flow Designer — process-first team creation (#419–#424)

The Team-Setup wizard and the Flow Designer used to be two separate worlds that
both fed `POST /api/teams`: the wizard picked *flat role lists* from the
agent-template catalog (hard-wired to the dispatcher pattern), while the
Process Canvas offered full free-form flow authoring with no guidance and no
gap protection. This feature line is the bridge: **one artifact — a
`processTemplateVersion: 1` bundle — with three entry levels**, all feeding the
existing materialisation pipeline. There is deliberately no second
materialisation path.

| Level | For whom | UX |
|---|---|---|
| **1 — Template** | "just get me started" | Gallery of curated process templates + saved drafts → one click → team |
| **2 — Composition** | "I want *my* process" | Stages + 1–3 roles per stage from the catalog → the **Flow-Weaver** wires everything |
| **3 — Free-form** | "I want full control" | Custom roles (LLM-assisted) + fine-tuning in the Flows canvas (draft round-trip) |

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

Agent templates gain an additive, backwards-compatible composition surface so
the weaver can bind them into any process (see
`docs/process-template-format.md` → *Catalog v2* for the schema):

- `patternRole`: `scout | author | companion | intake | standalone` — the
  role's place in the per-stage pattern
  **Scout (gap + evidence) → Author → Companion (review, feedback routing, escalation)**.
- `stageAffinity`: grouping hint for the wizard picker.
- `ports.consumes` with abstract slots (`stage-entry`, `stage-author`) and
  `ports.produces` (defaulting from the `github` flags).
- Trigger-level `intrinsic: true`: part of the role's essence (Issue Triage's
  `issues.opened`, self-curation crons) — kept by the weaver. Non-intrinsic
  triggers (the dispatcher's `assigned:{{agentId}}` wiring) are dropped when
  composing; the legacy roles-array path is unaffected.
- Generic pattern trio ships as catalog entries `scout`, `stage-author`,
  `stage-companion` (`category: "pattern"`), with `{{stageName}}` tokens
  resolved at weave time.

Normalisation: `admin-console/api/catalog-ports.js`.

### 3. Flow-Weaver (#421)

`admin-console/api/flow-weaver.js` — a **deterministic, pure** wiring engine
(deliberately not an LLM: wiring must be reproducible and guaranteeable; the
LLM only drafts prompts/suggestions).

Input: ordered stages, each with selected roles (catalog templates or inline
custom roles). Output: a complete bundle plus `notes[]` explaining every
applied gap rule. Exposed as `POST /api/process/weave`
(`{ name, stages: [{ name, roles: [{templateId}|{inline:true,…}] }], options }`).

Wiring rules:

1. **Stage chain** — the exit of stage *n* (a hand-over issue) feeds the entry
   of the next consuming stage via an issue channel labelled
   `<prefix(n)>:approved`, **human-gated by default**
   (`options.humanGates[stageName] = false` opts a boundary out).
2. **Intra-stage pattern** — Scout → `<prefix>:author-go` → Author → PR channel
   → Companion; escalation loop Author → `<prefix>:escalate` → Companion →
   `<prefix>:author-go`. Every Author gets a rework-on-review trigger, every
   Companion the human-feedback trigger (`from: humans`).
3. **Gap rules** (the "no gaps, no stalling" guarantee):
   - no Companion → review/feedback/escalation duties merge into the Author's
     prompt (marker-delimited *Wiring notes* block); no escalate loop.
   - no Scout → the readiness check becomes the Author's step 1.
   - the stage exit needs an issue producer: Companions (and, without one,
     Authors) gain `producesIssue` + the hand-over duty **only when a
     downstream stage consumes it**; intake roles' issues *are* the hand-over.
   - passive stages (standalone roles only) are skipped by the chain; later
     stages connect around them.
   - per-invocation roles get auto-staggered weekly self-curation crons.
4. **Contract:** the woven bundle validates and renders with **zero error and
   zero warning lints** (info allowed) — asserted across all pattern
   combinations in `flow-weaver.test.js`. The lints are thereby not just
   diagnostics but the weaver's acceptance criterion.

### 4. Wizard Process step (#422)

The wizard's step 4 (create mode) is the **Process** step
(`admin-console/src/pages/team-setup/StepProcess.jsx`):

- Three entry cards: *Use a template* / *Compose a process* / *Start blank in
  the canvas* (creates an empty draft, jumps to `/flows?proc=draft:<id>`).
- Composer: stage columns (add/remove/reorder), Scout/Author/Companion slot
  dropdowns filtered by `patternRole`, additional intake/standalone roles,
  per-stage human-gate toggle. Every change re-weaves (debounced) via
  `POST /api/process/weave`.
- Inline **flow preview** (SVG: stage columns, channel + label edges, human
  gates) plus **authoritative lint badges** from `POST /api/flows/graph`;
  error lints block submission. Weaver `notes` are shown as
  "auto-compensations" so the user sees what the gap rules did.
- Exits: **Create team** (bundle → `POST /api/teams/stream`, which now has
  full `processTemplate`/`customRoles` parity with `POST /api/teams`) and
  **Save as draft** (→ canvas fine-tuning; materialise later via the existing
  round-trip).
- Review step renders the final graph + role list grouped by stage.

### 5. Custom roles (#423)

"＋ Custom role" per stage column: name + notes → LLM-drafted prompt
(`POST /api/agent-prompt/generate`) and a suggested wiring surface
(`POST /api/agent-ports/suggest` → patternRole / sessionPolicy / produce
flags; one stateless LLM call via `resolveGenerationTarget`, keyword heuristic
in `admin-console/api/port-suggestion.js` as offline fallback). Suggestions are
**never applied silently** — the dialog shows them as editable fields. A
confirmed custom role rides the weave request inline and is wired exactly like
a catalog role.

## Extend mode & the legacy roles path

- **Create mode** builds teams exclusively through the Process step — the flat
  role-checkbox list is retired there.
- **Extend mode** (`/team-setup?team=<id>&mode=extend`, and the collision
  recovery flow) keeps the role-card UI: adding *instances* of catalog roles
  (`count` steppers) is a roles-array concept that a process bundle does not
  express. A collision hit while submitting a bundle stays on the bundle path:
  the collision card re-submits the same bundle with `mode: "extend"`, adding
  only the missing members.
- `POST /api/teams` (and `/stream`) continue to accept plain `roles` +
  `customRoles` for API compatibility — the retirement is UI-only.

## Follow-ups (deliberately out of scope)

- Dispatcher pattern as a weaver *block* (multi-instance roles + coordinator
  workflow inside a composed process).
- "Promote custom role to catalog" (analogous to skill promotion, #306/#173).
- Stage-affine skill packs per role (`skillsOverride` slots exist).
