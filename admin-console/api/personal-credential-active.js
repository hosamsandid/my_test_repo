'use strict';

// Which of a human's personal credentials of one kind (GitHub token / SSH key)
// the runtime actually uses, and when a change to them must restart the
// owner's running agents (#2655).
//
// A human may hold several personal tokens/keys of one kind, but the
// orchestrator resolves exactly one: `findPersonalCredentialState`
// (orchestrator/credential-resolution.js) takes the FIRST `scope: 'personal'`
// entry of that owner in index order — the one added first. This module
// mirrors that rule on the console side so the GitHub Tokens / SSH Keys pages
// can mark the active one, and so adding or replacing a personal credential
// only respawns the owner's agents when what they resolve actually changes.
// Pure — no fs, no fetch.

function isPersonalOf(entry, userId) {
  return !!(entry && entry.scope === 'personal' && entry.userId && userId
    && String(entry.userId) === String(userId));
}

/** Id of the personal credential the runtime resolves for `userId`, or null. */
function activePersonalCredentialId(index, userId) {
  if (!Array.isArray(index) || !userId) return null;
  const hit = index.find(e => isPersonalOf(e, userId));
  return hit ? String(hit.id) : null;
}

/**
 * Must the owner's running agents be respawned after a personal-credential
 * change? Create: only when the resolved credential moved (`before` → `after`).
 * Rotate (`rotatedId` set): only when the rotated credential is the resolved
 * one — replacing an inactive token's value changes nothing an agent holds.
 */
function ownerRespawnNeeded({ before, after, userId, rotatedId } = {}) {
  if (!userId) return false;
  const now = activePersonalCredentialId(after, userId);
  if (rotatedId) return now !== null && now === String(rotatedId);
  return now !== activePersonalCredentialId(before, userId);
}

/**
 * `activePersonal: true|false` on every personal row (the full `index` decides,
 * so a filtered list still marks correctly); other rows pass through untouched.
 */
function markActivePersonal(rows, index) {
  const active = new Map();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || row.scope !== 'personal' || !row.userId) return row;
    const uid = String(row.userId);
    if (!active.has(uid)) active.set(uid, activePersonalCredentialId(index, uid));
    return { ...row, activePersonal: active.get(uid) === String(row.id) };
  });
}

module.exports = { activePersonalCredentialId, ownerRespawnNeeded, markActivePersonal };
