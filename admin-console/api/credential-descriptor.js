'use strict';

// #2325 (R2 enrichment): a metadata-only descriptor for a credential referenced
// by a shared resource (an env's githubTokenId, a repo's sshKeyId), so the
// read-only chip can name the OWNER and TIER of a credential the caller cannot
// see. Carries NO secret — only `{ id, kind, tier, ownerLabel, visibleToCaller }`.
//
// Pure: the route supplies the normalized credential (its `scope`/`userId`/
// `teamId`), whether the caller can see it (`visibleCredential`), and label
// resolvers (userId → name, teamId → name). A missing resolver / unknown owner
// degrades to a generic label rather than leaking an id or throwing.
function buildCredentialDescriptor({ cred, kind, visibleToCaller, userLabel, teamLabel } = {}) {
  if (!cred || !cred.id) return null;
  const tier = (cred.scope === 'personal' || cred.scope === 'system') ? cred.scope : 'team';
  let ownerLabel;
  if (tier === 'personal') {
    ownerLabel = (cred.userId && userLabel && userLabel(cred.userId)) || 'another user';
  } else if (tier === 'system') {
    ownerLabel = 'System';
  } else {
    ownerLabel = (cred.teamId && teamLabel && teamLabel(cred.teamId)) || 'a team';
  }
  return {
    id: cred.id,
    kind: kind || null,
    tier,
    ownerLabel,
    visibleToCaller: !!visibleToCaller,
  };
}

module.exports = { buildCredentialDescriptor };
