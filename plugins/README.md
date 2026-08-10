# Reference plugins

Governed capability extensions beyond the agent container
(`docs/plugin-system-concept.md`). A plugin pairs a privilege-holding **broker
sidecar** with a **dependency-free CLI facade** seeded into the agent workspace.
All security lives server-side in the broker; the CLI is a privilege-less
client.

Each `plugins/<id>/` is a reference plugin shipped in the repo:

```
plugins/<id>/
  plugin.json     # the manifest (pluginVersion: 1) — see admin-console/api/plugin-manifest.js
  bin/            # the CLI script(s), seeded into a granted agent's .agent-studio/bin/
```

`make seed-plugins` (chained from `make seed-pool`) copies these into the pool
volume at `/pool/plugins/<id>/`, which surfaces to operators as the plugin
registry at `/workspace/plugins/<id>/`. Registering/installing a plugin from
the registry **grants nothing** to any agent — grants are a separate, Team-Admin
action (Phase 2).

## Manifest

Validated by the pure `admin-console/api/plugin-manifest.js` (the
`process-template.js` discipline). Key fields:

- `sidecar.capabilities` — a **closed enum** (`podman-socket`, `egress`,
  `host-mount:<path>`); a plugin cannot request an arbitrary mount.
- `scopes` — the scope granularities the broker honours (`["team"]` or
  `["team","agent"]`); bounds what a grant may choose (Phase 2).
- `ui.routes[].minRole` — role-gated UI routes; **validated and reserved** in
  Phase 1, the proxy/enforcement lands in Phase 5.

- `scopes` — the scope granularities the broker honours (`["team"]` or
  `["team","agent"]`); bounds what a grant may choose (Phase 2). A manifest may
  also declare `defaultScopeGranularity` (within `scopes`) — the grant default
  when the admin does not choose one; absent, the platform default is `team`.
- `quota` — `{ maxObjects, ttlSeconds? }`, the **per-scope** resource cap for a
  resource-creating plugin (§4.6), so agent granularity on an n-member squad
  costs n× the footprint (stated as a ceiling in the grant UI).

## `dummy-echo`

A no-op reference plugin used to exercise the core machinery end to end (sidecar
lifecycle, grant-driven network attachment, uninstall reconciliation) before a
real broker (Phase 3) exists. Its CLI echoes its arguments back.

## `podman-sandbox` (plugin #1)

The first real broker (Phase 3, #1519): a governed container sandbox — PR
#1287's `podman-mcp` broker reworked onto the plugin machinery. Agents drive
containers with the `aee-podman` CLI: `aee-podman run <image>` for a single
container (no compose file; pure CLI sugar over `compose up`, inheriting all
broker guarantees; #1550), or `aee-podman compose up -f compose.yml` for
multi-service stacks. The broker holds the libpod socket and scopes every
container to the caller. Declares `defaultScopeGranularity: "agent"` (the §10
decision) and a per-scope `quota`. See `podman-sandbox/README.md`.

## `test-mgmt` (plugin #2)

Test management (Phase 5, #1521): a granted agent creates test cases, triggers
test runs (submit→poll) and manages test data in an external test-management
system (Xray/Zephyr/qTest) with the `aee-test` CLI. Its broker
(`../test-mgmt-broker/`) is built on the Broker SDK (`../broker-sdk/`) — the
proof a credential-backed broker is thin: the vendor token lives only in the
sidecar. It is the first plugin to use scope granularity for **authorisation**,
not just isolation (manifest `policy`: create-case is restricted to the
flow-final agent whose cross-checks passed) and the first real
`requiresApproval` flow (destructive `data-delete` waits for human confirm). See
`test-mgmt/README.md`.

## `netzplan` (plugin #3)

Network Plan (epic #1554, Phase 3, #1563): an editable team **planning board** —
zones, lanes, milestones, owners and requirement lines — served from its own
sidecar and iframed into the console through the §4.8 UI-extension stack (#1562).
The first **UI-bearing** plugin and the first that holds no privilege at all
(`capabilities: []`, `credentials: []`, `scopes: ["team"]`). Its broker
(`../netzplan-broker/`) is built on the Broker SDK and keeps one board **document
per team** on the generic state volume (`AEE_PLUGIN_STATE_DIR`), so state is
server-side (two browser profiles see the same board; it survives a sidecar
restart) rather than in a viewer's `localStorage`. The load-bearing model
decision (concept §4): statuses and requirement targets key on **milestone ids,
never array indices**, so inserting or reordering a milestone shifts nothing
else. Agent write access is an explicit ladder off by default
(`settings.agentAutonomy` 0/1/2, §8): agents read with `aee-plan show` at level 0,
tick milestones at 1, edit structure at 2 — enforced broker-side and audited
under the calling agent's id. See `netzplan/../netzplan-broker/README.md`.
