'use strict';

// SSH commit signing on stored SSH keys (#2938) — the admin-console half.
// A key becomes a SIGNING key by carrying `signing: { name, email }`: the commit
// identity it signs as. GitHub only shows a signature as Verified when that
// email is a VERIFIED email of the GitHub account the key is uploaded to (as a
// "Signing Key"). The runtime half lives in orchestrator/commit-signing.js; the
// identity rules below must stay in step with its `signingIdentityOf`.
// Pure and dependency-free so it unit-tests under `node --test`.

const NAME_MAX = 100;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// Parse the optional `signing` field of a create/PATCH body.
//   undefined          → { action: 'keep' }   (field absent: leave as is)
//   null / false       → { action: 'clear' }  (stop signing with this key)
//   { name, email }    → { action: 'set', signing } or { error }
function parseSigningInput(raw) {
  if (raw === undefined) return { action: 'keep' };
  if (raw === null || raw === false) return { action: 'clear' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'signing must be an object { name, email } or null' };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  if (!name) return { error: 'signing.name (the commit author name it signs as) is required' };
  if (name.length > NAME_MAX || /[\r\n<>]/.test(name)) {
    return { error: `signing.name must be at most ${NAME_MAX} characters, without line breaks or < >` };
  }
  if (!email) return { error: 'signing.email (the commit email it signs as) is required' };
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return { error: 'signing.email must be a valid email address' };
  }
  return { action: 'set', signing: { name, email } };
}

// Apply a parsed signing input to an index entry; returns a NEW entry.
function applySigning(entry, parsed) {
  if (!parsed || parsed.action === 'keep') return entry;
  const { signing: _drop, ...rest } = entry || {};
  if (parsed.action === 'clear') return rest;
  return { ...rest, signing: { ...parsed.signing } };
}

// `ssh-ed25519 AAAA…` (no comment) from an SSH public-key wire blob — the form
// to paste into GitHub. Null for an unreadable blob.
function publicKeyFromBlob(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len < 1 || 4 + len > blob.length) return null;
  const type = blob.subarray(4, 4 + len).toString('ascii');
  if (!/^[a-z0-9@.-]+$/i.test(type)) return null;
  return `${type} ${blob.toString('base64')}`;
}

module.exports = { parseSigningInput, applySigning, publicKeyFromBlob, EMAIL_RE };
