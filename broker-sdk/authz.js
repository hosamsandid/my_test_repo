'use strict';

// ─── Broker SDK: per-scope action authorization (plugin system Phase 5, #1521) ─
//
// Isolation (scope-filter.js, scope-token.js) answers *whose* resources a
// caller may touch. This module answers a different question the concept
// (docs/plugin-system-concept.md §4.6, catalog case 9) raises for the first
// time with plugin #2: *which* subcommands a caller may run at all, keyed on
// the granularity of its scope.
//
//   "test cases may only be created by the last agent in the flow, once its
//    cross-checks passed."
//
// A team-scoped token cannot express that distinction — it names a squad, not
// the agent within it — so this is the first governance rule that only agent
// granularity can carry (§4.1 "per-agent policy"). The manifest declares the
// rule (`policy`, validated in plugin-manifest.js); the broker resolves the
// caller's context (its granularity, and for flow-position rules whether it is
// the flow-final agent whose cross-checks passed) from the scope registry the
// orchestrator hands it, and calls `authorizeAction` before it ever touches the
// vendor credential.
//
// Pure and granularity-honest: it takes the *resolved* caller context, never
// the opaque scope token (the token is `{pluginId, scopeId}` and MUST stay so —
// scope-token.js). Where that context comes from (grant granularity + the flow
// graph) is the orchestrator's job; this is only the decision, unit-tested in
// isolation like every other SDK obligation.

// A caller context the broker resolves for the calling scopeId:
//   { kind: 'team' | 'agent',       // the granularity the scope was granted at
//     flowFinal?: boolean,          // agent-granularity: is this the flow's last agent?
//     crossChecksPassed?: boolean } // agent-granularity: have its cross-checks passed?
//
// A policy rule (normalized by plugin-manifest.js) for one subcommand:
//   { scopes?: ['agent'],           // granularities allowed to run it (default: any)
//     requiresFlowFinal?: true }    // only the flow-final agent, cross-checks passed

// Decide whether `caller` may run `subcommand` under `policy`. Returns
// `{ allowed: true }` or `{ allowed: false, code, reason }`. A subcommand with
// no policy rule is unrestricted (the podman-sandbox default — every rule is
// opt-in). Never throws: a malformed caller resolves to a denial, not a crash,
// so a broker fails closed.
function authorizeAction(policy, subcommand, caller) {
  const rule = policy && typeof policy === 'object' ? policy[subcommand] : null;
  if (!rule || typeof rule !== 'object') return { allowed: true };

  const kind = caller && typeof caller === 'object' ? caller.kind : undefined;

  // Scope-granularity restriction: e.g. an action only an agent-granularity
  // token may run. A team-granularity caller is refused because its token
  // cannot name the individual agent the rule is about.
  if (Array.isArray(rule.scopes) && rule.scopes.length) {
    if (!kind || !rule.scopes.includes(kind)) {
      return {
        allowed: false,
        code: 'scope-not-permitted',
        reason: `"${subcommand}" is restricted to ${rule.scopes.join('/')} scope; caller scope is ${kind || 'unknown'}`,
      };
    }
  }

  // Flow-position restriction (agent granularity only): only the flow's final
  // agent, and only once its cross-checks have passed.
  if (rule.requiresFlowFinal) {
    if (kind !== 'agent') {
      return {
        allowed: false,
        code: 'flow-position-inexpressible',
        reason: `"${subcommand}" is gated on flow position, which only agent granularity can express; caller scope is ${kind || 'unknown'}`,
      };
    }
    if (!caller.flowFinal) {
      return {
        allowed: false,
        code: 'not-flow-final',
        reason: `only the final agent in the flow may run "${subcommand}"`,
      };
    }
    if (!caller.crossChecksPassed) {
      return {
        allowed: false,
        code: 'cross-checks-pending',
        reason: `the final agent's cross-checks must pass before "${subcommand}"`,
      };
    }
  }

  return { allowed: true };
}

// Convenience boolean form for a broker that only needs the yes/no.
function isActionPermitted(policy, subcommand, caller) {
  return authorizeAction(policy, subcommand, caller).allowed;
}

module.exports = { authorizeAction, isActionPermitted };
