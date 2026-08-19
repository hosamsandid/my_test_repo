'use strict';

// ─── Broker SDK (plugin system Phase 4, #1520) ───────────────────────────────
//
// A small, dependency-free Node module a plugin's broker sidecar imports so it
// doesn't re-implement — and re-break — the obligations every broker shares
// (docs/plugin-system-concept.md §4.6/§4.9): token verification, scope
// filtering, audit, secret masking, the health + teardown routes, and the
// approval holding pen. Extracted from plugin #1's broker (podman-mcp/), not
// designed on paper — its podman-token.js / owner-scope.js / mask-env.js and
// teardown endpoint are the adversarially-tested seeds.
//
// SDK use is strongly recommended, not enforced: the platform verifies the
// WIRE contract, not the implementation. A broker that skips it must still
// implement the same routes and checks. The reference plugins all use it.
//
// Mirrors the pure-module discipline of process-template.js / prompt-assembly
// .js — no framework, no dependencies, unit-tested in isolation.

const { mint, verify, verifyScopeToken } = require('./scope-token');
const { OWNER_LABEL_KEY, ownerLabelArg, isOwned, filterOwned, scopeFilter } = require('./scope-filter');
const {
  OUTCOMES,
  buildPluginAuditLine,
  serializeAuditLine,
  parseAuditLines,
  pruneAuditLines,
  auditWriter,
} = require('./audit');
const {
  REDACTION,
  maskEnvValues,
  maskSecretValues,
  maskSecrets,
  maskSecretsOrDefault,
} = require('./mask-secrets');
const { healthEndpoint, teardownScopeEndpoint } = require('./endpoints');
const { needsApproval, approvalHoldingPen, parkForApproval } = require('./approval');
const { authorizeAction, isActionPermitted } = require('./authz');
const { brokerConfig, quotaExceeded, positiveInt } = require('./broker-config');

module.exports = {
  // token verification (§4.6)
  mint,
  verify,
  verifyScopeToken,
  // scope filtering (§4.6 ownership labels)
  OWNER_LABEL_KEY,
  ownerLabelArg,
  isOwned,
  filterOwned,
  scopeFilter,
  // audit (§4.7)
  OUTCOMES,
  buildPluginAuditLine,
  serializeAuditLine,
  parseAuditLines,
  pruneAuditLines,
  auditWriter,
  // secret masking (§4.9)
  REDACTION,
  maskEnvValues,
  maskSecretValues,
  maskSecrets,
  maskSecretsOrDefault,
  // platform routes (§4.9)
  healthEndpoint,
  teardownScopeEndpoint,
  // approval holding pen (§4.9)
  needsApproval,
  approvalHoldingPen,
  parkForApproval,
  // per-scope action authorization (§4.6 — first used by plugin #2, #1521)
  authorizeAction,
  isActionPermitted,
  // sidecar runtime config + per-scope quota (§4.6 — the orchestrator's env
  // contract for every broker it starts, #1547)
  brokerConfig,
  quotaExceeded,
  positiveInt,
};
