# test-mgmt — plugin #2

Governed **test management** (epic #1516, Phase 5, #1521). A granted agent
creates test cases, triggers test runs (submit→poll) and manages test data in
an external test-management system (Xray/Zephyr/qTest) through a
credential-holding **broker sidecar** built on the Broker SDK (`broker-sdk/`,
Phase 4). It is the proof that a credential-backed broker is thin.

## Why a plugin and not a skill (concept §8 screening rule)

The vendor APIs are trivial to script, so this clears the bar explicitly, on
two counts:

1. **Credential containment** — a skill or a plain MCP wiring exposes the
   test-system token to the agent one way or another; the broker keeps it in
   the sidecar. The agent never sees it.
2. **Per-scope action restriction** — with agent granularity the broker can
   narrow *which* actions a caller may run: *"test cases may only be created by
   the last agent in the flow, once its cross-checks passed."* A team-scoped
   token cannot express that distinction at all. This is the **first plugin to
   use scope granularity for authorisation, not just isolation** (§4.6).

## Manifest (`plugin.json`)

Validated by `admin-console/api/plugin-manifest.js`:

- `sidecar.capabilities: ["egress"]` — the broker reaches the external
  test-management system; the agent container has no egress to it.
- `scopes: ["team", "agent"]`, `defaultScopeGranularity: "agent"` — per-agent
  authorisation is the point, so the grant defaults to `agent`.
- `quota: { maxObjects: 500, ttlSeconds }` — per-scope cap on artifacts the
  broker creates (§4.6).
- `requiresApproval: ["data-delete"]` — destructive test-data ops are parked
  for human confirmation (SDK approval pen, §4.9).
- `policy` — the **new** Phase-5 field: per-subcommand authorisation keyed on
  the calling scope (`broker-sdk/authz.js`):
  - `create-case: { scopes: ["agent"], requiresFlowFinal: true }` — only the
    flow-final agent, once its cross-checks have passed.
  - `data-delete: { scopes: ["agent"] }` — agent granularity only.
- `ui.routes` — three routes behind one mount, each with a `minRole`
  (working/runs pages team-member, `/admin` team-admin). Reserved + enforced by
  the pure UI-surface core (`admin-console/api/plugin-ui-proxy.js`); the live
  iframe proxy ships when the product decision (§4.8) calls for it.

## CLI facade (`bin/aee-test.py`)

Dependency-free single file (contract §4.5). Reads its endpoint + per-scope
token from `.agent-studio/plugins/test-mgmt.json` (0600, written by `plugin-sync.js`) and
speaks to the broker over the same Streamable-HTTP transport plugin #1 uses.

```
aee-test create-case --title "Login rejects empty password" --folder REGRESSION
aee-test trigger --plan REGRESSION --wait     # submit, then poll to a terminal state
aee-test run-status RUN-1234
aee-test data list
aee-test data set FIXTURE-1 '{"user":"alice"}'
aee-test data delete FIXTURE-9                # destructive → broker waits for human confirm
aee-test whoami                               # resolved scope identity
```

Exit codes: `0` ok / `1` broker/domain error (a policy refusal is a domain
error — the broker is reachable and answered) / `2` usage / `3` broker
unreachable (incl. not-granted). It is a **privilege-less client**: all security
lives in the broker.

## Broker sidecar (`./broker/`)

A thin broker on the SDK: it imports `broker-sdk/` for token verification, scope
filtering (`aee.plugin.owner=<scopeId>` ownership labels), audit, secret
masking, the health/teardown routes, and the approval pen — and adds only the
governance the concept asks for: `authorizeAction` (per-scope policy) and a
`vendor-client` that holds the one vendor credential. Built into the sidecar
image the manifest names (`localhost/aee-plugin-test-mgmt:latest`) from
`broker/Dockerfile`, which vendors `broker-sdk/` into the image the
same way plugin #1 does.
