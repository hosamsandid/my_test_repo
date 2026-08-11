# test-mgmt-broker — plugin #2 broker sidecar

The broker for the **test-mgmt** plugin (epic #1516, Phase 5, #1521), built on
the **Broker SDK** (`../broker-sdk/`). It is the proof the concept wanted from
Phase 5: a credential-backed broker that is *thin*. Almost everything here is
wiring — the security obligations come from the SDK.

## What the SDK provides (imported, not re-implemented)

- `verifyScopeToken` — bearer `{pluginId, scopeId}`, granularity-agnostic.
- `authorizeAction` — per-scope action policy (via `broker-policy.js`).
- `approvalHoldingPen` — destructive ops parked for a human's DM confirmation.
- `scopeFilter` / owner labels — every artifact carries `aee.plugin.owner=<scopeId>`.
- `auditWriter` — one JSONL line per call.
- `maskSecretsOrDefault` — the vendor credential is redacted from responses.
- `healthEndpoint` / `teardownScopeEndpoint` — the two REST routes the
  orchestrator calls on every broker.

## What this broker adds

- **`vendor-client.js`** — the ONLY place the vendor API (Xray/Zephyr/qTest) and
  its credential are named. The token lives here, never reaching the agent.
  Request-shaping + response-parsing are pure and dependency-free.
- **`broker-policy.js`** — wires the SDK `authorizeAction`/`needsApproval` to
  the tool vocabulary. It **embeds a copy** of the manifest's `policy` /
  `requiresApproval` and enforces it as the SECOND defense line (§4.8 "the
  plugin enforces it again"; the console/orchestrator enforce the first).
- **`server.js`** — the MCP tool surface + the two SDK REST routes, plus:
  - `PUT /internal/scope-registry` — the orchestrator pushes the scope list
    (§4.8: which scopeId is a team vs an agent, and — for flow-position rules —
    whether an agent is the flow-final one whose cross-checks passed). The
    broker **fails closed** on an unregistered scope.
  - `POST /internal/approvals/:id/resolve` — the orchestrator resolves a parked
    destructive op after a human's DM confirmation (v1 DM-confirm gate).

## Authorization by granularity (the first of its kind)

`create-case` is `{ scopes: ["agent"], requiresFlowFinal: true }`: a team-scoped
token cannot run it at all, and among agent-scoped callers only the flow-final
agent whose cross-checks have passed succeeds. This is per-agent *authorisation*,
not just isolation — the distinction plugin #1 (podman-sandbox) did not need.

## CI

Like `podman-mcp/`, this broker dir has **no CI job** — the live tool surface
needs `@modelcontextprotocol/sdk` and a live sidecar. The reusable decision is
CI-covered in `broker-sdk/` (`authz.test.js`); the broker-specific glue is
reference-tested here (`vendor-client.test.js`, `broker-policy.test.js`,
dependency-free).

## Live-stack remainder (deferred, same discipline as Phases 1–3)

The orchestrator wiring that mints this broker's scope tokens, pushes the scope
registry, starts/stops the sidecar, forwards approval confirmations over DM, and
(if the product decision calls for it) proxies the UI at `/plugins/test-mgmt/ui`
is the live-stack completion step. The decidable core it will call —
`broker-sdk/authz.js`, `admin-console/api/plugin-ui-proxy.js` — ships now and is
unit-tested.
