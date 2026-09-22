'use strict';

// Pure policy for a PERSONAL model provider used as a team's shared default
// across the team-of-one → multi-user transition (unified resource access model
// §14 / edge case E10, #2360). fs-free and dependency-free so it is byte-identical
// on both sides (orchestrator + admin-console/api); the impure halves — reading
// the endpoint record and counting the squad's human members — live at the call
// sites. Its twin lives in admin-console/api/provider-lend-policy.js.
//
// A `provider` here is the minimal projection { scope, authType } of an LLM
// endpoint record (both fields are top-level on the record, as every provider
// call site already reads them — api.js `ep.scope === 'team'`,
// membership-sweep.js `e.scope === 'personal'`). `humanMemberCount` is the number
// of DISTINCT human members of the AGENT TEAM (squad) — memberships are keyed by
// the squad id (see `unified-resource-access-epic` memory + PR5).
//
// The rule (concept §2 + §9/E9 + §14):
//   - Personal is the natural home of a team-of-one; a team consuming a member's
//     personal provider LENDS it, it never owns it.
//   - A personal SUBSCRIPTION (oauth) seat is single-user under Anthropic Consumer
//     Terms: sharing it with a multi-human squad is FORBIDDEN (E9) → 'block'.
//   - A personal API-KEY (service) provider MAY back a multi-human squad, but the
//     lend is fragile (one member's bill/identity; reset by the E1 leave-sweep
//     when they go) → 'warn' (advisory, never blocking). No auto-convert.
//   - A team/global provider, or a single-human squad, is never a problem → null.

const OAUTH_AUTH_TYPE = 'oauth-token';

function isPersonalProvider(provider) {
  return !!(provider && provider.scope === 'personal');
}

function isPersonalOauthProvider(provider) {
  return isPersonalProvider(provider) && provider.authType === OAUTH_AUTH_TYPE;
}

function isPersonalApiKeyProvider(provider) {
  return isPersonalProvider(provider) && provider.authType !== OAUTH_AUTH_TYPE;
}

// Classify the risk of `provider` backing a squad's shared default once the squad
// has `humanMemberCount` distinct humans. Returns { level, identity } or null.
//   personal oauth   + ≥2 humans → { level: 'block', identity: 'oauth' }   (E9)
//   personal api-key + ≥2 humans → { level: 'warn',  identity: 'api-key' } (fragile)
//   otherwise                    → null
function personalDefaultTransitionRisk({ provider, humanMemberCount } = {}) {
  if (!isPersonalProvider(provider)) return null;
  if (!(Number(humanMemberCount) >= 2)) return null;
  return isPersonalOauthProvider(provider)
    ? { level: 'block', identity: 'oauth' }
    : { level: 'warn', identity: 'api-key' };
}

module.exports = {
  isPersonalProvider,
  isPersonalOauthProvider,
  isPersonalApiKeyProvider,
  personalDefaultTransitionRisk,
};
