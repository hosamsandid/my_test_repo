'use strict';

// Pure decision helpers for team-derived assist-synthesis bindings (#1213).
//
// The orchestrator's autonomous synthesis features (curator auto-promotion,
// skill distillation) run with NO user session, so the header-selected assist
// model (#1210–#1212, `X-Assist-Model`) cannot apply. Correct billing there is
// *team*-derived: an optional `assistLlmEndpointId` on the team agent names the
// provider its synthesis calls must bill against. Unset → the `.env` fallback,
// byte-identical to pre-#1213 behaviour.
//
// This module owns the PURE filter — is a given endpoint record usable by that
// team? — so it can be unit-tested without touching the filesystem. It mirrors
// `credentialVisibleToTeam` in admin-console/api/scope.js (team-scoped owned by
// the team, or system-scoped assigned to it) plus the non-oauth exclusion that
// resolveAssistTarget already applies (oauth-token subscription seat credentials
// must never be spent on server-side /v1/messages calls, and carry no baseUrl).
// The caller (orchestrator.js) reads the token from `_keys/` and resolves the
// model — this module never sees a secret.

// Normalize the scope of a stored endpoint record the same way scope.js
// normalizeCredential does (pre-#798 records have no `scope` field).
function endpointScope(ep) {
  return ep && ep.scope === 'system' ? 'system' : 'team';
}

// Is endpoint `ep` usable by the (human tenant) team `teamId` for assist
// synthesis? Non-oauth AND (team-scoped owned by the team, or system-scoped
// assigned to it). A missing teamId collapses to the default team, mirroring
// credentialVisibleToTeam.
function endpointUsableByTeam(ep, teamId) {
  if (!ep || typeof ep !== 'object') return false;
  if (ep.authType === 'oauth-token') return false;
  // A GLOBAL provider (#2136) is usable by every team with no assignment. Inlined
  // rather than importing the admin-console `isGlobalProvider` (this module lives
  // in the orchestrator image, which does not carry `api/*.js`), but it enforces
  // the SAME three conditions: the oauth-token exclusion is the guard just above,
  // and `scope === 'system'` is required here (a `{ scope: 'team', global: true }`
  // record is not global — the rule reads the record, never a route invariant —
  // #2136 finding 1). Keep this in step with `admin-console/api/llm-endpoint-global.js`.
  if (ep.global === true && ep.scope === 'system') return true;
  const t = teamId || 'default';
  if (endpointScope(ep) === 'system') {
    const assigned = Array.isArray(ep.assignedTeamIds) ? ep.assignedTeamIds.map(String) : [];
    return assigned.includes(t);
  }
  return (ep.teamId || 'default') === t;
}

// Decide which endpoint record backs a team's assist synthesis, given the parsed
// llm-endpoints index. Returns { ep, reason }: `ep` is the matched record when
// selectable, else null with a machine reason:
//   'unset'          — no assistLlmEndpointId configured (use .env)
//   'not-found'      — the id names no registered provider (deleted?)
//   'oauth-excluded' — the provider is an oauth-token seat (never billable here)
//   'not-usable'     — the provider is not visible to this team
//   'ok'             — usable; `ep` returned
function pickAssistEndpoint(index, endpointId, teamId) {
  if (!endpointId) return { ep: null, reason: 'unset' };
  const list = Array.isArray(index) ? index : [];
  const ep = list.find((e) => e && e.id === endpointId) || null;
  if (!ep) return { ep: null, reason: 'not-found' };
  if (ep.authType === 'oauth-token') return { ep: null, reason: 'oauth-excluded' };
  if (!endpointUsableByTeam(ep, teamId)) return { ep: null, reason: 'not-usable' };
  return { ep, reason: 'ok' };
}

module.exports = { endpointScope, endpointUsableByTeam, pickAssistEndpoint };
