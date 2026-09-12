'use strict';

// Pure decision core for team cloning (#2171, epic #2166 A5). Cloning a team
// copies its Working Environment's STRUCTURE only — repository URLs/branches,
// mcpServers refs, model provider, toolchain and additional context — via the
// same `copyEnvironmentStructure` (#2170) every credential reference is
// already stripped from. This module adds the two decisions specific to
// cloning FROM A TEAM rather than from a curated template: which source
// config is even eligible, and what to tell the creator they still need to
// supply before the copy is usable (G2/H4a).

// Is `cfg` a valid clone source? A team clone reads a `role: 'team'` agent's
// bound environment — anything else (missing, a standalone agent, a member)
// is refused with a distinct reason so the caller can render the right
// message rather than a generic 400.
function validateCloneSource(cfg) {
  if (!cfg) return { error: 'not-found' };
  if (cfg.role !== 'team') return { error: 'not-a-team' };
  return { ok: true };
}

// What the copied structure still needs before it is fully usable. Every
// repository lost its `sshKeyId` and every MCP pairing lost its
// `credentialId` (copyEnvironmentStructure), and the GitHub token is never
// copied at all (it has no place in that structure to begin with) — so a
// team with at least one repository needs a token supplied, regardless of
// per-repo SSH keys, since either credential can service an HTTPS remote and
// only the creator can say which they intend to use.
function describeClonedCredentialNeeds(structure) {
  const repositories = Array.isArray(structure?.repositories) ? structure.repositories : [];
  const mcpServers = Array.isArray(structure?.mcpServers) ? structure.mcpServers : [];
  return {
    needsGithubToken: repositories.length > 0,
    repositories: repositories.map(r => ({ url: r.url, branch: r.branch || null })),
    mcpServers: mcpServers.map(m => ({ serverId: m.serverId })),
  };
}

module.exports = { validateCloneSource, describeClonedCredentialNeeds };
