'use strict';

// #2560: what the console may show of a team's EFFECTIVE baseline GitHub
// identity — which GitHub token / SSH key its agents' containers are started
// with, and on whose behalf.
//
// The DECISION is not made here. The orchestrator's
// `credentialResolution.describeBaselineCredential` (the same function the
// spawn-time bake uses, so display and runtime cannot drift) returns
// `{ source, credentialId, ownerId, personalPresent, personalOrphaned,
// sharedCredentialId, globalServiceCredentialId }` per credential kind. This
// module only REDACTS that for a given caller:
//
//   - A personal credential is shown as its owner's display name + the
//     credential kind. Its id and name reach only its owner — nobody else ever
//     sees any metadata of another person's personal credential (AC3; the
//     fingerprint / token preview never leave the server at all).
//   - The environment's own ("team") credential keeps its id and name — the
//     settings panel already shows it — plus whether it is actually in use or
//     overridden by the Team Admin's personal credential (AC2).
//   - A global service credential is reported as a tier only.
//   - An orphaned personal credential (its owner is no longer a user) is a
//     problem state, not a healthy "personal" one — the runtime already fell
//     back past it, and `source` says to what.

const KIND_LABELS = { github: 'GitHub token', ssh: 'SSH key' };

/**
 * @param {object|null} described  one kind's `describeBaselineCredential` result
 * @param {object} opts
 * @param {'github'|'ssh'} opts.kind
 * @param {string|null} opts.callerUserId
 * @param {(userId: string) => string|null} opts.userLabel
 * @param {(credentialId: string) => string|null} opts.credentialName
 */
function presentBaselineCredential(described, { kind, callerUserId = null, userLabel, credentialName } = {}) {
  const labelOf = typeof userLabel === 'function' ? userLabel : () => null;
  const nameOf = typeof credentialName === 'function' ? credentialName : () => null;
  const d = described && typeof described === 'object' ? described : {};
  const source = ['personal', 'team', 'global', 'none'].includes(d.source) ? d.source : 'none';
  const ownerId = d.ownerId ? String(d.ownerId) : null;
  const orphaned = !!d.personalOrphaned;
  const isYou = !!(ownerId && callerUserId && ownerId === String(callerUserId));

  // The Team Admin is named only when their personal credential is involved —
  // in use, or present but orphaned. A Team Admin with no personal credential
  // is not "the identity" of anything.
  const owner = ownerId && (source === 'personal' || orphaned)
    ? { label: labelOf(ownerId) || (orphaned ? 'a deleted user' : 'the Team Admin'), isYou }
    : null;

  let credential = null;
  if (source === 'personal' && isYou && d.credentialId) {
    credential = { id: String(d.credentialId), name: nameOf(String(d.credentialId)) };
  } else if (source === 'team' && d.credentialId) {
    credential = { id: String(d.credentialId), name: nameOf(String(d.credentialId)) };
  }

  const teamCredential = d.sharedCredentialId
    ? {
        id: String(d.sharedCredentialId),
        name: nameOf(String(d.sharedCredentialId)),
        inUse: source === 'team',
        overridden: source === 'personal',
      }
    : null;

  return {
    kind,
    kindLabel: KIND_LABELS[kind] || kind,
    source,
    problem: orphaned ? 'orphaned' : null,
    owner,
    credential,
    teamCredential,
  };
}

/**
 * #2938: the commit-SIGNING key the team's commits are signed with (or none —
 * then they are unsigned, as before). Same redaction as above: another
 * person's personal key is shown as its owner only — never its id, name or
 * commit email; a team key keeps its id/name; a global key is a tier plus the
 * commit identity it signs as (a service identity, not personal data).
 * @param {object|null} described  the orchestrator's `describeSigning` result
 */
function presentSigning(described, { callerUserId = null, userLabel, credentialName } = {}) {
  const labelOf = typeof userLabel === 'function' ? userLabel : () => null;
  const nameOf = typeof credentialName === 'function' ? credentialName : () => null;
  const d = described && typeof described === 'object' ? described : {};
  const source = ['personal', 'team', 'global'].includes(d.source) && d.keyId ? d.source : 'none';
  if (source === 'none') return { kind: 'signing', kindLabel: 'Signing key', source, owner: null, credential: null, identity: null };
  const ownerId = d.ownerId ? String(d.ownerId) : null;
  const isYou = !!(ownerId && callerUserId && ownerId === String(callerUserId));
  const shown = source !== 'personal' || isYou;
  const id = String(d.keyId);
  const ident = d.identity && typeof d.identity === 'object' && d.identity.email
    ? { name: String(d.identity.name || ''), email: String(d.identity.email) }
    : null;
  return {
    kind: 'signing',
    kindLabel: 'Signing key',
    source,
    owner: source === 'personal' ? { label: labelOf(ownerId) || 'the Team Admin', isYou } : null,
    credential: shown && source !== 'global' ? { id, name: nameOf(id) || d.name || null } : null,
    identity: shown ? ident : null,
  };
}

/**
 * Both kinds for one team, as the console's `GET /api/agents/:id/effective-credentials` returns them.
 * @param {{ github?: object, ssh?: object }} described
 * @param {object} opts  { callerUserId, userLabel, githubName, sshName }
 */
function presentEffectiveIdentity(described, { callerUserId = null, userLabel, githubName, sshName } = {}) {
  const d = described || {};
  return {
    github: presentBaselineCredential(d.github, { kind: 'github', callerUserId, userLabel, credentialName: githubName }),
    ssh: presentBaselineCredential(d.ssh, { kind: 'ssh', callerUserId, userLabel, credentialName: sshName }),
    signing: presentSigning(d.signing, { callerUserId, userLabel, credentialName: sshName }),
  };
}

module.exports = { KIND_LABELS, presentBaselineCredential, presentSigning, presentEffectiveIdentity };
