'use strict';

const { isAllowedTierCombo } = require('./resource-tier');

// Resolve the immutable `identity` stamp for an SSH key / GitHub token at create
// time (unified resource access model §4/§12.10, epic #2361 #2360).
//
// Default (PR3 #2355): a `personal` credential is one person's identity →
// `human`; a team/system one is a shared machine/deploy identity → `service`.
//
// A client MAY override the stamp — the
// "mark a personal credential as `service`" case (a private bot key / token,
// concept §12.10) — but ONLY to an identity that forms a LEGAL identity×tier
// combo (§4, `isAllowedTierCombo`): a `human` secret can only be personal, so a
// human-for-team request can never be honoured. An absent or illegal override
// falls back to the default (fail-safe — the server is the boundary; the form
// only offers the legal options).
//
// Model providers do NOT use this: their identity is fixed by auth type
// (oauth → human, api-key → service) and stamped directly at their route.
function resolveStampedIdentity({ scope, requestedIdentity } = {}) {
  const derived = scope === 'personal' ? 'human' : 'service';
  if ((requestedIdentity === 'human' || requestedIdentity === 'service')
      && isAllowedTierCombo({ identity: requestedIdentity, scope })) {
    return requestedIdentity;
  }
  return derived;
}

module.exports = { resolveStampedIdentity };
