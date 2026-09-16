// Pure view helpers: which Working Environments reference a given credential
// (#1141). The credential pages (SshKeys.jsx / GithubTokens.jsx) previously told
// the user "Working Environments using this key must remove it first" without
// ever naming WHICH environments — forcing a hunt through every environment.
//
// These helpers mirror the server's in-use checks in api.js exactly, so the
// "Used by" column and the delete dialog agree with what the DELETE route will
// actually block on:
//   - sshKeyInUse(keyId):   any of an environment's `repositories[].sshKeyId`
//   - githubTokenInUse(id):  the environment's top-level `githubTokenId`
//
// Kept pure (no React, no fetch) so they are unit-tested in
// credential-usage.test.js and shared by both pages. Input is the array from
// GET /api/environments (already caller-scoped by the server).

function envLabel(env) {
  return (env && (env.name || env.id)) || '';
}

function sortByName(list) {
  return list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

// Environments that reference `keyId` through any repository's `sshKeyId`.
// Returns [{ id, name }] sorted by display name. Mirrors api.js sshKeyInUse.
export function environmentsUsingSshKey(environments, keyId) {
  if (!keyId) return [];
  const out = [];
  for (const env of Array.isArray(environments) ? environments : []) {
    const repos = Array.isArray(env?.repositories) ? env.repositories : [];
    if (repos.some(r => r?.sshKeyId === keyId)) out.push({ id: env.id, name: envLabel(env) });
  }
  return sortByName(out);
}

// Environments that reference `tokenId` via their top-level githubTokenId.
// Returns [{ id, name }] sorted by display name. Mirrors api.js githubTokenInUse.
export function environmentsUsingGithubToken(environments, tokenId) {
  if (!tokenId) return [];
  const out = [];
  for (const env of Array.isArray(environments) ? environments : []) {
    if (env?.githubTokenId === tokenId) out.push({ id: env.id, name: envLabel(env) });
  }
  return sortByName(out);
}

// Short cell label for the "Used by" table column: "None" | "1 environment" |
// "N environments".
export function usageCountLabel(envs) {
  const n = Array.isArray(envs) ? envs.length : 0;
  if (n === 0) return 'None';
  return `${n} environment${n === 1 ? '' : 's'}`;
}

// Multi-line tooltip body listing the environments by name (one per line), or a
// friendly note for the zero case.
export function usageTooltip(envs) {
  const list = Array.isArray(envs) ? envs : [];
  if (list.length === 0) return 'Not used by any environment';
  return list.map(e => e.name || e.id).join('\n');
}
