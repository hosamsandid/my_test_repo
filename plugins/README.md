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

## `dummy-echo`

A no-op reference plugin used to exercise the core machinery end to end (sidecar
lifecycle, grant-driven network attachment, uninstall reconciliation) before a
real broker (Phase 3) exists. Its CLI echoes its arguments back.
