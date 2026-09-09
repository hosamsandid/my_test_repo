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
  // Body did not mention `global` → leave whatever the record already carries,
  // EXCEPT when this request makes the flag unholdable: switching a global
  // provider to a subscription (`oauth-token`) seat must drop the flag, because a
  // subscription seat can never be global (Consumer-Terms single-user). Without
  // this a later `PUT { authType: 'oauth-token' }` that never mentions `global`
  // would carry `global: true` onto a record that no longer qualifies (#2136
  // finding 1). `isGlobalProvider` below fails closed on the same condition
  // regardless of the stored flag, so this only keeps the stored shape honest —
  // but keeping the two in step is what stops the flag rotting into a lie.
  if (wantGlobal === undefined || wantGlobal === null) {
    if (cur && isOauth) return { global: false };
    return { global: cur };
  }
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

// Is `ep` a GLOBAL model provider RIGHT NOW — reachable by every user and every
// agent with no team assignment (#2136)? This is the single predicate every
// provider-reachability call site must use; it re-reads ALL three preconditions
// on every call rather than trusting the stored `global` flag alone:
//
//   • `global === true`      — the System-Admin-only publish flag (resolveGlobalFlag);
//   • `scope === 'system'`   — a global provider carries no team assignment, so it
//                              is always system-scoped. A `{ scope: 'team', global: true }`
//                              record (only reachable by a hand edit / stale write)
//                              is NOT global — the predicate answers on the record,
//                              never on a route invariant.
//   • `authType !== 'oauth-token'` — a subscription seat is single-user
//                              (Consumer Terms) and can never be offered to a whole
//                              installation. Because the auth type is MUTABLE, this
//                              must be re-checked here and not only at the write
//                              route: a provider published api-key-global and later
//                              switched to oauth would otherwise stay reachable
//                              (#2136 finding 1).
//
// DELIBERATELY provider-specific and OUTSIDE scope.js / resource-tier.js: those
// generic credential predicates (`visibleCredential`, `credentialVisibleToTeam`)
// also gate SSH keys and GitHub tokens, so a `global: true` on one of THOSE must
// stay inert — the blast radius of a mistake there is a secret, not a model
// endpoint (#2136 finding 2). Callers compose this with the generic predicate at
// the provider call sites only (see api.js `providerVisible` / `providerUsableByTeam`).
function isGlobalProvider(ep) {
  return !!(ep
    && ep.global === true
    && ep.scope === 'system'
    && ep.authType !== 'oauth-token');
}

module.exports = { resolveGlobalFlag, isGlobalProvider };
