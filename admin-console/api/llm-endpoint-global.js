'use strict';

// Pure gate for publishing a model provider as GLOBAL (#2136).
//
// A global provider is reachable by every user and every agent with no team
// assignment at all (the "usable by all, assigned to nobody" case the shared
// tier could not express). Two authority rules, both enforced here so the create
// and update routes cannot drift:
//
//   • Only a System Admin (`scope.all`) may CHANGE a provider's global flag —
//     publish one or retract one (AC5). Access opens to everyone; the authority
//     to publish stays centralised (cost & governance, D7).
//   • A subscription (`oauth-token`) seat can NEVER be global — Anthropic's
//     Consumer Terms make it single-user, so it must not be offered to a whole
//     installation (edge case / Open Question 2).
//
// Deliberately a NO-OP when the flag does not change: a Team Admin editing an
// already-global provider's model list (they can see it, `canManageCredential`
// is the separate gate) must not be refused for a change they did not make. Only
// a real transition is gated — which is also what keeps the flag idempotent on
// an ordinary re-save.
//
// Inputs:
//   wantGlobal    — request intent: `true`/`false`, or undefined/null when the
//                   body does not mention `global` (→ keep the current value).
//   currentGlobal — the record's present flag (false on create).
//   scopeAll      — `scope.all` (a full-visibility System Admin / env admin).
//   isOauth       — the provider's EFFECTIVE auth type after this request.
//
// Returns { global } with the resolved flag to persist, or
// { error, status, code } to refuse.
function resolveGlobalFlag({ wantGlobal, currentGlobal = false, scopeAll, isOauth } = {}) {
  const cur = currentGlobal === true;
  // Body did not mention `global` → leave whatever the record already carries.
  if (wantGlobal === undefined || wantGlobal === null) return { global: cur };
  // Only a literal boolean `true` publishes; anything else reads as "not global"
  // so a stray value can never silently open a provider to the whole platform.
  const want = wantGlobal === true;
  if (want === cur) return { global: cur };
  if (!scopeAll) {
    return {
      error: 'Only a System Admin may publish or retract a global model provider',
      status: 403,
      code: 'global-system-admin-only',
    };
  }
  if (want && isOauth) {
    return {
      error: 'A subscription (oauth-token) provider cannot be made global — a subscription seat is single-user only',
      status: 400,
      code: 'global-oauth-unsupported',
    };
  }
  return { global: want };
}

module.exports = { resolveGlobalFlag };
