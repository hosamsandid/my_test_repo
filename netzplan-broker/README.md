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
| `plan-store.js` | The thin fs adapter over `plan-doc.js`: one board per scope on the `AEE_PLUGIN_STATE_DIR` state volume (§4.8), atomic writes, autonomy-gated mutate, teardown. Unit-tested. |
| `viewer-headers.js` | A copy of the §4.8 signed-viewer-header scheme (`admin-console/api/plugin-ui-proxy.js`) so the broker verifies the console-signed identity + role on the UI path. |
| `server.js` | Wiring: the MCP tool surface for `aee-plan`, the served board UI, and the SDK health / teardown routes. Lazy-requires the MCP SDK so the pure modules test with no deps. |
| `ui/` | The served board (`index.html` + `app.js` — view + tick) and `/admin` (`admin.html` + `admin.js` — the autonomy ladder). |

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
   team-admin).

## Env contract (`broker-sdk/broker-config.js`, §4.8 / #1547)

`AEE_PLUGIN_PORT`, `AEE_PLUGIN_SIGNING_SECRET`, `AEE_PLUGIN_STATE_DIR` (documents
live here — **not** the audit mount), `AEE_PLUGIN_AUDIT_DIR`,
`AEE_PLUGIN_QUOTA_MAX_OBJECTS`. Platform-set; a manifest's own `sidecar.env` can
never override them. `NETZPLAN_*` fallbacks exist for standalone development.

## Tests & CI

`node --test` runs the dependency-free pure modules (`plan-doc` / `plan-store` /
`viewer-headers`) with no install step — the `netzplan-broker` CI job. `server.js`
is not exercised in CI (needs the MCP SDK + a live sidecar), same as
`test-mgmt-broker` / `podman-mcp`; the CLI contract for `aee-plan` is enforced in
`orchestrator/plugin-cli-contract.test.js`.

`make plugin-images` builds this image (`localhost/aee-plugin-netzplan:latest`).

## Deferred to the Phase-3 completion step

`server.js`/`ui/` ship a **minimal** served board — read the board and tick
milestones, plus the `/admin` autonomy setting — so the board is usable on Podman
end-to-end. The rich **swimlane editor** the concept describes (direct
manipulation, a selection inspector à la `ProcessCanvas` `NodeInspector`, colour
pickers, reorder, requirement-target-by-click, bounded undo/redo) builds on the
same `plan-doc.js` mutations and is the completion step (see the PR). The `graph`
/ `bipartite` / `blocks` primitives and panel add/remove/reorder are Phase 4
(#1564).
