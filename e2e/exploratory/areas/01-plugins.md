# 01 — Plugins

**Scope:** `/plugins` (registry, install, uninstall), `/plugins/:id/view` (plugin
UIs), plugin grant on a team (Agent Chat → Settings → Plugins, wizard Knowledge
step), "Plugin service accounts" (per-team plugin credentials), plugin health.
End-to-end Jira use is in `../workflows/jira-end-to-end.md`.

**Preconditions:** a `uitest-` team with one member agent. Installing a plugin is
system-wide → only with approval for the pass; prefer plugins already installed.

## Persona matrix

| Action | Member | Team Admin | Outsider | System Admin |
|---|---|---|---|---|
| See `/plugins` list | read? | read | read? | full |
| Install / uninstall | denied, explained | denied, explained | denied | allowed |
| Grant to team | denied | allowed (own team) | denied | allowed |
| Set team plugin credential | denied | allowed (own team) | denied | allowed |
| Open plugin UI (`ui.routes[].minRole`) | per `minRole` | per `minRole` | 404 | allowed |

## Probes

- Install a plugin, watch status until healthy; what does the UI show while the
  broker starts / if it fails to start? Uninstall and re-install.
- Grant → check the member's workspace received the CLI (Workspace tab) without a
  respawn; revoke → CLI removed; toggle quickly several times.
- Grant to a team whose members are disabled/stubs; add a member afterwards —
  does the new member receive the plugin (materialisation at creation)?
- Plugin service account form: empty fields, invalid site (`acme`, full URL,
  trailing slash, `http://`), very long values; is the secret ever shown back?
  Change and clear it again.
- Plugin UI views: role gating per `minRole`, deep link as Outsider, reload,
  broker down (what does the proxy page show?).
- Degraded sync: a failed plugin sync must surface as a warning (add-member
  response, GitHub Event Log) — never silently.

## Risk spots

- `orchestrator/plugin-grants.js`, `plugin-sync.js` (`planCliRefresh`),
  `plugin-reconcile.js` (backoff), `plugin-credential-store.js`.
- Plugin UI proxy role pre-check (flat max role) vs broker's per-team check.

## Cleanup

Revoke grants on the `uitest-` team, remove plugin credentials set on it,
uninstall only plugins installed in this pass.
