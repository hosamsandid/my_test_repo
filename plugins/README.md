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
  bin/            # the CLI script(s), seeded into a granted agent's .aee/bin/
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
their own compose stacks with the `aee-podman` CLI (`aee-podman compose up -f
compose.yml`); the broker holds the libpod socket and scopes every container to
the caller. Declares `defaultScopeGranularity: "agent"` (the §10 decision) and a
per-scope `quota`. See `podman-sandbox/README.md`.

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
