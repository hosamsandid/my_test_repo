'use strict';

const crypto = require('crypto');

// Input validation for the SSH-key and GitHub-token create/rotate routes
// (#2654). Pure and dependency-free so it unit-tests under `node --test`;
// api.js keeps the inline SSH_KEY_ID_RE / GH_TOKEN_ID_RE checks in front of
// every fs sink (CodeQL path-injection sanitizer) — these helpers only add the
// stricter create-time rules on top.

// A credential display name must be a non-blank string. Returns the trimmed
// name, or null when it is missing, blank or not a string (e.g. `123`).
function credentialName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed || null;
}

// A NEW credential id: hyphen-separated runs of [a-z0-9] — no leading/trailing
// hyphen, no `--`, not `-` alone. Existing ids are still looked up with the
// looser SSH_KEY_ID_RE / GH_TOKEN_ID_RE so a legacy id like `foo-` stays
// manageable (rename, rotate, delete).
const NEW_CREDENTIAL_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isValidNewCredentialId(id) {
  return typeof id === 'string' && NEW_CREDENTIAL_ID_RE.test(id);
}

const OPENSSH_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const OPENSSH_END = '-----END OPENSSH PRIVATE KEY-----';
const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0', 'utf8');

// Structurally parse an OpenSSH-format private key (PROTOCOL.key). Returns
// null when it is well-formed, else a short reason. An unencrypted key is
// checked down to its private section (the two check-ints must match and each
// private key type must match its public key); an encrypted key can only be
// checked up to the encrypted blob without the passphrase.
function opensshKeyProblem(text) {
  const start = text.indexOf(OPENSSH_BEGIN);
  const end = text.indexOf(OPENSSH_END, start + OPENSSH_BEGIN.length);
  if (start === -1 || end === -1) return 'missing BEGIN/END OPENSSH PRIVATE KEY lines';
  const body = text.slice(start + OPENSSH_BEGIN.length, end).replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return 'key body is not base64';
  const buf = Buffer.from(body, 'base64');
  if (buf.length < OPENSSH_MAGIC.length || !buf.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    return 'key body is not an OpenSSH key';
  }
  let off = OPENSSH_MAGIC.length;
  const readUint32 = (b) => {
    if (off + 4 > b.length) throw new Error('truncated');
    const v = b.readUInt32BE(off); off += 4;
    return v;
  };
  const readString = (b) => {
    const len = readUint32(b);
    if (off + len > b.length) throw new Error('truncated');
    const out = b.subarray(off, off + len); off += len;
    return out;
  };
  const keyType = (blob) => {
    if (blob.length < 4) throw new Error('truncated');
    const len = blob.readUInt32BE(0);
    if (4 + len > blob.length || len === 0) throw new Error('truncated');
    return blob.subarray(4, 4 + len).toString('latin1');
  };
  try {
    const cipher = readString(buf).toString('latin1');
    readString(buf); readString(buf);                       // kdfname, kdfoptions
    const numKeys = readUint32(buf);
    if (numKeys < 1 || numKeys > 16) return 'key contains no usable key';
    const pubTypes = [];
    for (let i = 0; i < numKeys; i++) pubTypes.push(keyType(readString(buf)));
    const priv = readString(buf);
    if (off !== buf.length) return 'unexpected data after the key';
    if (cipher !== 'none') return null;                    // encrypted — nothing more to check
    if (priv.length === 0 || priv.length % 8 !== 0) return 'private section is malformed';
    off = 0;
    const check1 = readUint32(priv);
    const check2 = readUint32(priv);
    if (check1 !== check2) return 'private section is corrupt';
    const privType = keyType(priv.subarray(off));
    if (privType !== pubTypes[0]) return 'private key does not match its public key';
    return null;
  } catch {
    return 'key is truncated';
  }
}

// Validate a pasted SSH private key (#2654 item 1). Returns null when the key
// parses, else a human-readable error. A marker-only check let arbitrary text
// between BEGIN/END through; the key then only failed when an agent cloned.
// Legacy PEM formats (RSA/EC/PKCS#8) are parsed with Node's crypto; a
// passphrase-protected PEM is accepted unparsed, like an encrypted OpenSSH
// key (the passphrase is not ours to check).
function sshPrivateKeyError(privateKey) {
  const hint = 'paste the whole private key file, including the BEGIN and END lines';
  if (typeof privateKey !== 'string' || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    return `This is not an SSH private key — ${hint}.`;
  }
  const text = privateKey.trim();
  if (text.includes(OPENSSH_BEGIN)) {
    const problem = opensshKeyProblem(text);
    return problem ? `This is not a valid SSH private key (${problem}) — ${hint}.` : null;
  }
  // Detected from the armour, not from createPrivateKey's error: OpenSSL
  // reports a missing passphrase with version-dependent error codes.
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /^Proc-Type:\s*4,ENCRYPTED/m.test(text)) {
    return null;
  }
  try {
    crypto.createPrivateKey({ key: text, format: 'pem' });
    return null;
  } catch {
    return `This is not a valid SSH private key (it could not be parsed) — ${hint}.`;
  }
}

module.exports = {
  credentialName,
  NEW_CREDENTIAL_ID_RE,
  isValidNewCredentialId,
  sshPrivateKeyError,
};
