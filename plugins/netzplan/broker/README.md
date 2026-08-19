# netzplan-broker

Plugin #3's broker sidecar (epic #1554, Phase 3, #1563) — the server-side home
of the **Network Plan** planning board and the source of its UI.

Unlike plugins #1 (`podman-mcp`) and #2 (`test-mgmt-broker`) it holds **no
credential** and needs **no privilege** (`capabilities: []`): its whole job is to
keep one board document per team and serve that board into the console. Built on
the **Broker SDK** (`broker-sdk/`), so this directory is mostly the plan model
plus wiring.

## Layout

| File | Purpose |
|---|---|
| `plan-doc.js` | **Pure** document model — normalize / validate / migrate / mutate. The load-bearing rule (concept §4): statuses and requirement targets key on **ids, never array indices**, so insert / reorder / delete are non-destructive. Meaning-carrying swimlane helpers (`zoneSatisfiedAt` for OR zones). Unit-tested. |
| `plan-import.js` | **Pure** content migration (Phase 6, #1566): `legacyBoardToPlanDoc` (the **positional → id** converter) + `exportPlanDoc` / `importPlanDoc` (the round-trip pair). Unit-tested. See *Content migration* below. |
| `plan-store.js` | The thin fs adapter over `plan-doc.js`: one board per scope on the `AEE_PLUGIN_STATE_DIR` state volume (§4.8), atomic writes, autonomy-gated mutate, `import` (round-trip restore), teardown. Unit-tested. |
| `viewer-headers.js` | A copy of the §4.8 signed-viewer-header scheme (`admin-console/api/plugin-ui-proxy.js`) so the broker verifies the console-signed identity + role on the UI path. |
| `server.js` | Wiring: the MCP tool surface for `aee-plan`, the served board UI, and the SDK health / teardown routes. Lazy-requires the MCP SDK so the pure modules test with no deps. |
| `ui/` | The served board (`index.html` + `app.js`) — renders all four §5 primitives and, in **Edit** mode, adds / edits / reorders / removes panels and their contents through `/api/mutate`, plus an **Export** button; and `/admin` (`admin.html` + `admin.js` — the autonomy ladder + **Import a plan**). |

## Two request surfaces

1. **`/mcp`** — the agent CLI (`aee-plan`) over Streamable-HTTP MCP, bearer-authed
   with the `{pluginId, scopeId}` scope token. `plan_show` is always allowed;
   `plan_tick` / `plan_mutate` are gated by the board's **autonomy level**
   (`settings.agentAutonomy`, §8) — enforced in `plan-store.js`, so the refusal
   holds whether the call came through the CLI or straight at `/mcp`. Every agent
   write appends one audit line naming the **calling agent** (`agentId`, from the
   orchestrator's scope registry) distinct from the team `scopeId`.
2. **`/ui/*`** — the board UI + its data API, proxied by the console. Every
   request carries signed viewer headers; the broker verifies them and
   re-enforces the `ui.routes` `minRole` (`/` at team-member, `/admin` at
   team-admin). `/api/export` is a read (team-member); `/api/import` is a
   wholesale board replace and is **team-admin** like `/api/settings`.

## Content migration (Phase 6, #1566)

The plugin ships an **empty** board — **no engagement content lives in this repo**
(concept §12 non-goal). Phase 6 provides the machinery to bring an existing plan
in, not the plan itself:

- **Positional → id conversion** (`plan-import.js` `legacyBoardToPlanDoc`) is the
  substance of the phase. The board this replaces keys milestone statuses and
  requirement targets by **array index**; the target model keys them by milestone
  **id** (concept §4). The converter is the single place that alignment happens,
  and it fails **loud** — a `done` array whose length ≠ its lane's milestone
  count, a requirement target index out of range, an unknown zone/owner
  reference — rather than mapping the wrong milestone silently. The source's own
  comments (*"index shifted by +1"*) prove positional bookkeeping has drifted
  before, so the two shifted-index lanes are covered explicitly in
  `plan-import.test.js`.
- **Export / import round-trip** (`exportPlanDoc` / `importPlanDoc`, and the board
  UI's **Export** button + `/admin` **Import a plan**) make migration a
  *repeatable operation, not a script anyone keeps*. Both wrap the idempotent
  `normalizePlanDoc`, and `PlanStore.import` preserves timestamps + the board's
  current autonomy, so **export → import → export is byte-identical**.
- The **one-off** conversion of a specific plan runs off-repo: whoever owns the
  streams feeds the source constants to `legacyBoardToPlanDoc` once, then imports
  the resulting `PlanDoc` through the UI and keeps it in their own repo.
- The non-swimlane panels come across as the four §5 primitives #1564 introduced —
  a **normalisation** of the old bespoke renderers, not a pixel-identical
  restoration (concept §5 / §12), by design.

## Env contract (`broker-sdk/broker-config.js`, §4.8 / #1547)

`AEE_PLUGIN_PORT`, `AEE_PLUGIN_SIGNING_SECRET`, `AEE_PLUGIN_STATE_DIR` (documents
live here — **not** the audit mount), `AEE_PLUGIN_AUDIT_DIR`,
`AEE_PLUGIN_QUOTA_MAX_OBJECTS`. Platform-set; a manifest's own `sidecar.env` can
never override them. `NETZPLAN_*` fallbacks exist for standalone development.

## Tests & CI

`node --test` runs the dependency-free pure modules (`plan-doc` / `plan-store` /
`plan-import` / `viewer-headers`) with no install step — the `netzplan-broker` CI
job. `server.js`
is not exercised in CI (needs the MCP SDK + a live sidecar), same as
`test-mgmt-broker` / `podman-mcp`; the CLI contract for `aee-plan` is enforced in
`orchestrator/plugin-cli-contract.test.js`.

`make plugin-images` builds this image (`localhost/aee-plugin-netzplan:latest`).

## Deferred to the Phase-3 completion step

**Phase 4 (#1564) — done.** All four §5 primitives (`swimlane` from #1563, plus
`graph` / `bipartite` / `blocks`) are in `plan-doc.js` with full id-keyed
normalize / mutate / referential repair, and `panels[]` is composed (`add-panel`
/ `delete-panel` / `reorder-panels` / `set-panel-title`). The served board renders
every primitive and its **Edit** mode adds / edits / reorders / removes panels and
their contents. `graph` hover-highlight is computed from the pure `graphNeighbors`
helper; the `bipartite` muted flag survives edits; a `blocks` panel expresses the
cover / KPI-tiles / callout / cards originals as flexible typed blocks.

The controls are compact (inline buttons + `prompt()` entry) — the *capability*
is complete; the **direct-manipulation polish** the concept sketches (drag
reorder, colour pickers, click-a-milestone to set a requirement target, bounded
undo/redo — undo/redo is just a stack of the immutable documents `applyMutation`
returns) is a UI refinement over these same mutations. See the PR.
