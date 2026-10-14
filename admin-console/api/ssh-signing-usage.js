'use strict';

// Which stored SSH keys the runtime SIGNS commits with (#2959) — the console
// mirror of orchestrator/commit-signing.js `resolveSigningKey`, so the SSH Keys
// page can say which key signs instead of only which key carries git transport.
//
// Signing is resolved independently of transport (#2938): personal → team →
// global over the keys that carry a valid `signing` identity —
//   - personal: the owner's FIRST personal key with a signing identity (index
//     order), whatever key their transport uses;
//   - team: per environment, a repo-bound non-personal signing key, else a
//     team-scoped signing key of the env's team, else a system key assigned to
//     that team (`selectTeamSigningKeyId`);
//   - global: the first global service key with a signing identity.
// The rules must stay in step with the orchestrator; ssh-signing-usage.test.js
// checks them against `resolveSigningKey` on shared fixtures.
//
// Pure — no fs, no fetch.

const NAME_MAX = 100;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// Same validation as orchestrator/commit-signing.js `signingIdentityOf`.
function hasSigningIdentity(entry) {
  const s = entry && typeof entry === 'object' ? entry.signing : null;
  if (!s || typeof s !== 'object') return false;
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  const email = typeof s.email === 'string' ? s.email.trim() : '';
  if (!name || name.length > NAME_MAX || /[\r\n<>]/.test(name)) return false;
  return !!email && email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

function signingKeys(index) {
  return (Array.isArray(index) ? index : []).filter(k => k && k.id && hasSigningIdentity(k));
}

// The personal signing keys of one owner, in resolution order.
function personalSigningKeyIds(keys, userId) {
  if (!userId) return [];
  return keys.filter(k => k.scope === 'personal' && k.userId && String(k.userId) === String(userId)).map(k => String(k.id));
}

// Mirror of `selectTeamSigningKeyId` (keys already signing-capable).
function teamSigningKeyId(keys, env) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  for (const r of repos) {
    if (!r || !r.sshKeyId) continue;
    const hit = keys.find(k => k.id === r.sshKeyId && k.scope !== 'personal');
    if (hit) return String(hit.id);
  }
  const teamId = env && env.teamId ? String(env.teamId) : null;
  if (!teamId) return null;
  const team = keys.find(k => k.scope === 'team' && String(k.teamId || '') === teamId);
  if (team) return String(team.id);
  const assigned = keys.find(k => k.scope === 'system' && k.global !== true
    && Array.isArray(k.assignedTeamIds) && k.assignedTeamIds.map(String).includes(teamId));
  return assigned ? String(assigned.id) : null;
}

// Mirror of `selectGlobalServiceCredentialId` over the signing-capable keys.
function globalSigningKeyId(keys) {
  const hit = keys.find(k => k.global === true && k.scope === 'system' && k.identity === 'service');
  return hit ? String(hit.id) : null;
}

/**
 * What signs an environment's commits when no personal signing key applies:
 * `{ source: 'team'|'global'|'none', keyId }`.
 */
function sharedSigningFor(index, env) {
  const keys = signingKeys(index);
  const teamId = teamSigningKeyId(keys, env);
  if (teamId) return { source: 'team', keyId: teamId };
  const globalId = globalSigningKeyId(keys);
  if (globalId) return { source: 'global', keyId: globalId };
  return { source: 'none', keyId: null };
}

/**
 * `signingUsage` on every row that carries a signing identity; other rows pass
 * through untouched. The full `index` decides (a filtered list still marks
 * correctly); `envs` are the environments the caller may see — only those are
 * named.
 *   personal → { tier: 'personal', active, signsFirstId, nextId }
 *     active: this is the owner's signing key; signsFirstId: the one that is;
 *     nextId: what signs instead once this one is deleted (null → shared tier).
 *   team/system → { tier: 'shared', environments: [{ id, name, source, fallback }] }
 *     the environments whose shared-tier signing key this is (unless a Team
 *     Admin's personal signing key takes precedence), and per environment what
 *     signs once this key is gone: `{ source, keyId, name }`.
 */
function markSigningUsage(rows, index, envs) {
  const keys = signingKeys(index);
  const nameOf = (id) => {
    const hit = (Array.isArray(index) ? index : []).find(k => k && String(k.id) === String(id));
    return hit && hit.name ? String(hit.name) : null;
  };
  const envList = (Array.isArray(envs) ? envs : []).filter(e => e && e.id);
  const shared = envList.map(env => ({ env, now: sharedSigningFor(keys, env) }));
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || !row.id || !hasSigningIdentity(row)) return row;
    const id = String(row.id);
    if (row.scope === 'personal') {
      const ids = personalSigningKeyIds(keys, row.userId);
      const signsFirstId = ids[0] || null;
      const active = signsFirstId === id;
      return { ...row, signingUsage: { tier: 'personal', active, signsFirstId, nextId: active ? (ids[1] || null) : null } };
    }
    const without = keys.filter(k => String(k.id) !== id);
    const environments = shared
      .filter(s => s.now.keyId === id)
      .map(({ env, now }) => {
        const fb = sharedSigningFor(without, env);
        return {
          id: String(env.id),
          name: env.name ? String(env.name) : String(env.id),
          source: now.source,
          fallback: { source: fb.source, keyId: fb.source === 'team' ? fb.keyId : null, name: fb.source === 'team' ? nameOf(fb.keyId) : null },
        };
      });
    return { ...row, signingUsage: { tier: 'shared', environments } };
  });
}

module.exports = { hasSigningIdentity, personalSigningKeyIds, teamSigningKeyId, globalSigningKeyId, sharedSigningFor, markSigningUsage };
