'use strict';

// #2325 (R1 for SSH keys, the SSH-side of the #2326 data-loss fix): pair a
// previous and next repository list by URL so a save can guard each repository's
// `sshKeyId` against a blind clear/swap — exactly as `credential-ref-guard`
// guards the env-level `githubTokenId`. A repository's SSH key is invisible to a
// caller who doesn't own it (personal tier), so its picker renders empty and a
// plain save would clear it; this pairing is what lets the route detect the
// change and protect it.
//
// Pure: matches on `url` (the stable identity of a repository row). Only URLs
// present in BOTH lists are paired — a URL that is new, removed or renamed has no
// prior `sshKeyId` to protect. A pair whose `sshKeyId` is unchanged is dropped,
// so the route only resolves visibility for real changes.
//
// Returns [{ url, prevSshKeyId, nextSshKeyId }] (ids normalized to null).
function pairRepositorySshKeyChanges(prevRepos, nextRepos) {
  const prev = new Map();
  for (const r of Array.isArray(prevRepos) ? prevRepos : []) {
    if (r && r.url) prev.set(r.url, r.sshKeyId || null);
  }
  const out = [];
  for (const r of Array.isArray(nextRepos) ? nextRepos : []) {
    if (!r || !r.url || !prev.has(r.url)) continue;
    const prevSshKeyId = prev.get(r.url);
    const nextSshKeyId = r.sshKeyId || null;
    if (prevSshKeyId !== nextSshKeyId) out.push({ url: r.url, prevSshKeyId, nextSshKeyId });
  }
  return out;
}

module.exports = { pairRepositorySshKeyChanges };
