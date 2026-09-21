'use strict';

// The MASKED, identity-only projection of a personal secret-bearing resource for
// the System-Admin governance "Resources" view (unified resource access model
// §6 / §12.7, epic #2361 PR7 #2360).
//
// The verb matrix (§6) gives a System Admin a DELETE-only break-glass over a
// foreign personal resource (`canDeleteCredential` = owner || scope.all, PR3
// #2355) — but NEVER see-secret and NEVER use/select. So the governance list
// carries only what an admin needs to DECIDE to delete: name, owner, created,
// and a non-secret discriminator (an SSH fingerprint / a provider's auth type).
// It NEVER carries the token, private key or baseUrl. Pure so it is unit-tested;
// the route (api.js) supplies the store reads + the flag/System-Admin gate.
function maskPersonalResource(kind, r) {
  return {
    id: r.id,
    kind,
    name: r.name || r.id,
    ownerId: r.userId || null,
    createdAt: r.createdAt || null,
    identity: (r.identity === 'human' || r.identity === 'service') ? r.identity : null,
    // A non-secret discriminator per kind — enough to tell entries apart in the
    // list, never enough to use one. An SSH fingerprint is public by design; a
    // provider's auth type distinguishes a subscription seat from an api-key
    // gateway. No token, no private key, no baseUrl.
    ...(kind === 'ssh-key' || kind === 'github-token' ? { fingerprint: r.fingerprint || null } : {}),
    ...(kind === 'provider' ? { authType: r.authType === 'oauth-token' ? 'oauth-token' : 'api-key' } : {}),
  };
}

// Every PERSONAL resource across the three stores, masked. Team/system/global
// records are omitted — they are not personal and have their own management
// surfaces; this view exists specifically for the owner-only personal tier that
// an admin can otherwise neither see nor reach.
function listPersonalResources({ providers = [], sshKeys = [], githubTokens = [] } = {}) {
  const out = [];
  const scan = (list, kind) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (r && r.id && r.scope === 'personal') out.push(maskPersonalResource(kind, r));
    }
  };
  scan(providers, 'provider');
  scan(sshKeys, 'ssh-key');
  scan(githubTokens, 'github-token');
  return out;
}

module.exports = { maskPersonalResource, listPersonalResources };
