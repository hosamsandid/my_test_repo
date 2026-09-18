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
//   • A subscription (`oauth-token`) seat may be global ONLY as the single-user
//     escape hatch: an instance whose operator has confirmed single-user use
//     (complianceAck) may publish their subscription so every agent RUNTIME can
//     use it. It stays RUNTIME-only — assist/helper exclude oauth upstream, and
//     Anthropic rejects a subscription token on server-side /v1/messages anyway
//     (docs/unified-resource-access-concept.md §9). Without that ack, an oauth
//     provider can never be global.
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
function resolveGlobalFlag({ wantGlobal, currentGlobal = false, scopeAll, isOauth, hasSingleUserAck = false } = {}) {
  const cur = currentGlobal === true;
  // A subscription (oauth) seat may be global ONLY as the single-user escape
  // hatch (runtime-only — see the header note and isGlobalProvider below).
  const oauthGlobalOk = hasSingleUserAck === true;
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
    if (cur && isOauth && !oauthGlobalOk) return { global: false };
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
  if (want && isOauth && !oauthGlobalOk) {
    return {
      error: 'A subscription (oauth-token) provider can be global only in a confirmed single-user instance (complianceAck)',
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
//   • auth type — an api-key provider is global outright; a subscription
//                              (`oauth-token`) seat is global ONLY with the
//                              single-user `complianceAck` (the escape hatch),
//                              and even then RUNTIME-only (assistSelectableEndpoint
//                              excludes oauth before it consults this). Because the
//                              auth type is MUTABLE, this is re-checked here and not
//                              only at the write route: a provider published
//                              api-key-global and later switched to oauth WITHOUT
//                              the ack stops being global (#2136 finding 1).
//
// DELIBERATELY provider-specific and OUTSIDE scope.js / resource-tier.js: those
// generic credential predicates (`visibleCredential`, `credentialVisibleToTeam`)
// also gate SSH keys and GitHub tokens, so a `global: true` on one of THOSE must
// stay inert — the blast radius of a mistake there is a secret, not a model
// endpoint (#2136 finding 2). Callers compose this with the generic predicate at
// the provider call sites only (see api.js `providerVisible` / `providerUsableByTeam`).
function isGlobalProvider(ep) {
  if (!ep || ep.global !== true || ep.scope !== 'system') return false;
  if (ep.authType !== 'oauth-token') return true;
  // Single-user escape hatch: a subscription seat is global ONLY when the record
  // carries the single-user compliance acknowledgement. RUNTIME-only —
  // assistSelectableEndpoint excludes oauth before it ever consults this.
  return !!(ep.complianceAck && ep.complianceAck.singleUser === true);
}

module.exports = { resolveGlobalFlag, isGlobalProvider };
