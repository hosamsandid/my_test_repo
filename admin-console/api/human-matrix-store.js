'use strict';

// Server-side store for a human's Matrix credential (#1458, epic #2076 P1).
//
// docs/multi-user-concept.md §4 requires the per-human Matrix access token to
// live **server-side only** — "the browser never sees a Matrix token" is an
// existing property of the console (api.js hands out room ids, never tokens)
// and must survive the move to per-human identities.
//
// ── Why a separate file instead of a field on the user record ───────────────
// `teams-store.js` guards the one secret it already keeps on a user record —
// `passwordHash` — with a single `sanitizeUser()` applied at the store
// boundary. That is a *convention*, not a guarantee, and its own comment says
// so ("strip the password hash and any future secret"): it only holds as long
// as every path that lets a record leave the process remembers to call it.
//
// Two things make that a poor place for a second secret. `users/index.json` is
// also read *directly* by the admin-console, bypassing the store entirely
// (`getScope`, `describeAuthz`, the personal-credential owner check) — those
// only compute from the records today, but the file is the shared surface, and
// a route that serialises a projection of it is one feature away (the in-flight
// draft-sharing work adds exactly that for its user picker). And a token is
// worse than a hash: `passwordHash` leaking is a cracking problem, a live
// Matrix access token leaking is an immediate impersonation.
//
// So the credential goes into its own per-user file that nothing else reads,
// and the record carries only the non-secret `matrixUserId`. The leak becomes
// structurally impossible rather than review-dependent, and no future reader of
// the users index has to know this secret exists.
// `human-matrix-store.test.js` asserts the split.
//
//   <root>/users/matrix/<userId>.json   0600, dir 0700
//   { userId, matrixUserId, accessToken, provisionedAt }
//
// Same pure-factory shape as `teams-store.js` (`createHumanMatrixStore({root})`,
// no module state) so it unit-tests against a temp directory.

const fs = require('fs');
const path = require('path');

// User ids are `crypto.randomUUID()` (teams-store.js `createUser`). Validating
// the exact UUID shape before it reaches `path.join` is a path-injection
// sanitizer CodeQL recognises inline — the same posture as `AGENT_ID_RE` at the
// `path.join` sites in admin-console/api/matrix.js.
const USER_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Owner-only, on both the credential files and the directory holding them.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function createHumanMatrixStore({ root } = {}) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('createHumanMatrixStore: { root } is required');
  }

  const MATRIX_DIR = path.join(root, 'users', 'matrix');

  function credentialPath(userId) {
    if (!USER_ID_RE.test(String(userId))) {
      throw new Error(`Invalid user id: ${String(userId).slice(0, 80)}`);
    }
    // `path.basename` on an already-validated id is a no-op, but it is the call
    // CodeQL treats as the sanitizer at the join site.
    return path.join(MATRIX_DIR, `${path.basename(String(userId))}.json`);
  }

  // The stored credential for a user, or null when they have none yet.
  // Unreadable/corrupt files read as "no credential" so a damaged file
  // re-provisions rather than wedging the caller.
  function readIdentity(userId) {
    let p;
    try { p = credentialPath(userId); } catch { return null; }
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // Persist a credential atomically. The temp file is created with the final
  // restrictive mode *before* it holds the token, so the secret is never
  // world-readable even for the moment between write and rename.
  function writeIdentity(userId, { matrixUserId, accessToken, provisionedAt } = {}) {
    const p = credentialPath(userId);
    if (typeof matrixUserId !== 'string' || !matrixUserId) {
      throw new Error('writeIdentity: matrixUserId is required');
    }
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('writeIdentity: accessToken is required');
    }
    const record = {
      userId,
      matrixUserId,
      accessToken,
      provisionedAt: provisionedAt || new Date().toISOString(),
    };
    fs.mkdirSync(MATRIX_DIR, { recursive: true, mode: DIR_MODE });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: FILE_MODE });
    fs.renameSync(tmp, p);
    return record;
  }

  // Remove a user's credential. Idempotent — deleting a credential that is not
  // there is a success, so off-boarding can run twice without failing.
  function deleteIdentity(userId) {
    let p;
    try { p = credentialPath(userId); } catch { return { userId, deleted: false }; }
    try {
      fs.unlinkSync(p);
      return { userId, deleted: true };
    } catch {
      return { userId, deleted: false };
    }
  }

  // User ids that currently hold a credential. Used by the reconcile paths; it
  // deliberately returns ids only, never the tokens.
  function listProvisionedUserIds() {
    let entries;
    try {
      entries = fs.readdirSync(MATRIX_DIR);
    } catch {
      return [];
    }
    return entries
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length))
      .filter(id => USER_ID_RE.test(id));
  }

  return {
    readIdentity,
    writeIdentity,
    deleteIdentity,
    listProvisionedUserIds,
    MATRIX_DIR,
  };
}

module.exports = { createHumanMatrixStore, USER_ID_RE, FILE_MODE, DIR_MODE };
