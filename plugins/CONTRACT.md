# Plugin CLI contract (§4.5)

Every platform plugin (`docs/plugin-system-concept.md`) ships a **dependency-free
CLI facade** that is seeded into a granted agent's workspace at `.agent-studio/bin/<cli.name>`
(on `PATH` via the entrypoint) and reads its endpoint + per-agent scope token
from `.agent-studio/plugins/<pluginId>.json` (mode `0600`, written at seed time). The CLI
is the *only* surface the agent touches; all privilege and all backend
credentials live server-side in the broker sidecar the CLI talks to.

A plugin's CLI **must** obey this contract — it is enforced, not advisory
(`orchestrator/plugin-cli-contract.test.js` drives the reference plugin
`dummy-echo` through every clause):

## Rules

1. **Dependency-free single file.** Only the runtimes already present in the
   agent image (`python3` / `node` / `bash`, per `cli.runtime`) and their
   standard libraries — no `pip`/`npm` install, no compiled binaries.
2. **`--json` on every subcommand.** The form is `<cli> <subcommand> --json`
   (define it via a shared parent parser, not a top-level flag — a top-level
   `--json` is silently dropped after the subcommand). `--json` emits a single
   machine-readable JSON object on stdout.
3. **Exit codes.**

   | code | meaning |
   |------|---------|
   | `0`  | ok |
   | `1`  | domain error (the broker reached, the request refused on its merits) |
   | `2`  | usage error (bad arguments / no subcommand) |
   | `3`  | broker unreachable (not granted, sidecar down, network path absent) |

4. **`--help`** carries the full agent-readable docs (all subcommands).
5. **Long-running operations** use a **submit → poll** shape (submit returns a
   handle; a `status`/`poll` subcommand reports progress) rather than blocking —
   the broker owns the work, the CLI is a thin client.

## Config file (`.agent-studio/plugins/<pluginId>.json`)

Written at seed time by the orchestrator (`orchestrator/plugin-sync.js`), read
by the CLI at startup:

```json
{ "pluginId": "…", "scopeId": "…", "endpoint": "http://aee-plugin-<id>:<port>", "token": "…", "cliName": "…" }
```

`scopeId` is resolved per agent under the grant's granularity
(`orchestrator/plugin-scope.js`); `token` is an HMAC `{pluginId, scopeId}` scope
token (`orchestrator/plugin-scope-token.js`) the broker verifies on every call.
The file is absent until the plugin is granted and removed on revoke — a CLI
that finds no config reports `not-granted` and exits `3`.
