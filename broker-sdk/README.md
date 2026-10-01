# Broker SDK

The obligations every plugin **broker sidecar** owes (`docs/plugin-system-concept.md` §4.6/§4.9), packaged as one small dependency-free Node module so each plugin author doesn't re-implement — and re-break — them.

Extracted from plugin #1's broker (`podman-mcp/`), not designed on paper: its `podman-token.js`, `owner-scope.js`, `mask-env.js` and teardown endpoint are the adversarially-tested seeds. Plugin #1 is retrofitted onto this SDK, so it has a live consumer from day one.

Using the SDK is **strongly recommended, not enforced** — the platform verifies the wire contract, not the implementation.

## API

```js
const sdk = require('broker-sdk');
```

| Export | Obligation |
|---|---|
| `verifyScopeToken(reqOrHeader, secret)` → `{pluginId, scopeId}` \| `null` | Verify the per-scope bearer token. **Granularity-agnostic** — the broker never learns whether `scopeId` is a team or a single agent, and must not branch on it. (`mint` / `verify` also exported for tests.) |
| `scopeFilter(scopeId)` → `{labelArg, owns, filter}` | Ownership-label helpers: stamp on create (`labelArg`), filter on list (`filter`), exact-match on operate (`owns`). Uses the platform owner label `aee.plugin.owner`. |
| `auditWriter(dir, {retentionMs, now})` → `{write, read, rotate}` | One JSONL line per call, retention-rotated on write. Wraps the pure `buildPluginAuditLine` core (byte-identical to `orchestrator/plugin-audit.js`). |
| `maskSecrets(output, secrets)` | Response redaction — masks explicit secret values plus the `-e/--env KEY=VALUE` values backends echo verbatim. |
| `healthEndpoint(extra?)` → `(req,res)` | The registry card's health probe (no auth). The body always carries `build: { commit, dirty, commitTime }` — the image's baked-in git identity (`buildInfoFromEnv`, #2646), which the Plugins page shows as the running broker's build. |
| `teardownScopeEndpoint(reap, {secret})` → `(req,res)` | Scope teardown on team/agent deletion, per `scopeId` (one implementation serves both). Resources are **reaped before the orchestrator invalidates the token**. |
| `internalPushEndpoint(handler, {secret, pluginId})` → `(req,res)` | Wraps a route only the **orchestrator** may call (a credential/registry push such as `PUT /internal/scope-credentials`): 401 unless the token names this plugin **and** the reserved `INTERNAL_SCOPE_ID` (`_internal`). Every granted agent's token shares the signing secret — without this, one team could wipe or repoint every other team's credential. The platform never derives `_internal` for an agent or team (`plugin-scope.js`), so only `plugin-runtime.mintInternalToken` produces it. |
| `parkForApproval(op)` / `approvalHoldingPen({requiresApproval})` | The `requiresApproval` holding pen (v1: DM confirm). |
| `selectFreshEvents` / `planBurstHandoffs` / `checkAndIncThrottle` / `computeBackoffDelayMs` / `passesHorizon` / `effectiveHorizon` (+ `loadThrottleState` / `saveThrottleState`) | Event-source polling primitives for a broker that polls an external system (`event-cursor.js`). A **copy** of `orchestrator/github-poller.js`'s seen-id cursor / burst collapse / hour-scoped throttle / exponential backoff — `github-poller.js` is untouched. First consumer: the Jira plugin broker. |

## Granularity opacity

`scopeId` is an opaque string. Every helper treats a team scope (`team-abc`, shared by all members) and an agent scope (`agent-aaaa`, one member) identically — that opacity is what keeps agent granularity from doubling every broker's code path. The tests exercise member-vs-member isolation alongside team-vs-team.

## Build-context note

A broker's Docker build context can't require across directories (the `podman-token.js` convention), so a broker either builds from a context that includes `broker-sdk/` (podman-mcp copies it into the image) or vendors a byte-identical copy. The token/audit cores here move together with `orchestrator/plugin-scope-token.js` / `orchestrator/plugin-audit.js`.
