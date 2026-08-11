'use strict';

// ─── test-mgmt broker: policy glue (plugin system Phase 5, #1521) ────────────
//
// The governance the concept asks plugin #2 to prove (§4.6): the broker narrows
// WHICH actions a caller may run, keyed on the granularity of its scope, and
// parks destructive ops for human confirmation. The reusable decision lives in
// broker-sdk/authz.js + broker-sdk/approval.js; this module wires them to the
// broker's tool vocabulary and to the scope registry the orchestrator supplies.
//
// The broker embeds a copy of the manifest's `policy` / `requiresApproval` and
// enforces it here (the SECOND of the two defense lines the console also runs —
// §4.8 "the plugin enforces it again"). Dependency-free + pure so it is
// unit-testable without a live sidecar.

const { authorizeAction } = require('../../../broker-sdk/authz');
const { needsApproval } = require('../../../broker-sdk/approval');

// The broker's tool name → the manifest's policy/approval subcommand token.
const TOOL_SUBCOMMAND = Object.freeze({
  test_case_create: 'create-case',
  test_run_submit: 'trigger',
  test_run_status: 'run-status',
  test_data_list: 'data-list',
  test_data_set: 'data-set',
  test_data_delete: 'data-delete',
});

// Mirrors plugins/test-mgmt/plugin.json (defense-in-depth — the console also
// validates the manifest and enforces the same rules). Keep the two in sync.
const POLICY = Object.freeze({
  'create-case': { scopes: ['agent'], requiresFlowFinal: true },
  'data-delete': { scopes: ['agent'] },
});
const REQUIRES_APPROVAL = Object.freeze(['data-delete']);

// Resolve the calling scope's authorization context from the registry the
// orchestrator maintains (the §4.8 scope list, extended with the flow-position
// facts only the control plane knows). FAIL CLOSED: an unregistered scope
// resolves to an unknown-kind caller, which every policy-gated action refuses.
function resolveCaller(registry, scopeId) {
  const entry = registry && typeof registry.get === 'function'
    ? registry.get(scopeId)
    : (registry && registry[scopeId]);
  if (!entry || typeof entry !== 'object') return { kind: 'unknown' };
  return {
    kind: entry.kind === 'agent' ? 'agent' : (entry.kind === 'team' ? 'team' : 'unknown'),
    flowFinal: entry.flowFinal === true,
    crossChecksPassed: entry.crossChecksPassed === true,
  };
}

// The full per-call decision for a tool invocation:
//   { allow, code?, reason?, needsApproval, subcommand }
// `allow=false` → the broker returns an MCP isError (a domain error, exit 1 at
// the CLI). `needsApproval=true` on an allowed op → the broker parks it in the
// SDK holding pen and returns a "pending confirmation" result instead of
// running it.
function decide(toolName, scopeId, registry) {
  const subcommand = TOOL_SUBCOMMAND[toolName] || toolName;
  const caller = resolveCaller(registry, scopeId);
  const authz = authorizeAction(POLICY, subcommand, caller);
  if (!authz.allowed) {
    return { allow: false, code: authz.code, reason: authz.reason, needsApproval: false, subcommand };
  }
  return {
    allow: true,
    needsApproval: needsApproval(subcommand, REQUIRES_APPROVAL),
    subcommand,
  };
}

module.exports = { TOOL_SUBCOMMAND, POLICY, REQUIRES_APPROVAL, resolveCaller, decide };
