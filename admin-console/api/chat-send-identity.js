'use strict';

// Which Matrix account a human's chat send goes out as (#2721).
//
// #2173 sent as the acting human's own account when one was provisioned and
// otherwise fell back to the shared admin token — so every human without an
// identity (the bootstrap System Admin, users created before #2173, anyone
// whose one background attempt failed) chatted as the shared admin, and the
// agent runtime could not tell those people apart.
//
// This resolver has no fallback. It returns the acting human's own
// credential, provisioning it on demand when it is missing, or `null` — and
// the caller refuses the send on `null` (fail closed, AC5). It never names the
// shared admin account.
//
// Who is acting comes only from the authenticated server session (`userId`
// from the user-store scope, `username` the login subject) — never from the
// request body (#2065 AC2).
//
//   userId set                 → that user record's identity
//                                (`provisionUser(userId)` on a miss).
//   no userId, `operator`      → the single-operator principal (env admin, no
//                                user record, AC9): its own identity keyed by
//                                its login subject (`provisionOperator`).
//   anything else              → null (nobody to send as).
//
// Pure: the store and both provisioners are injected, so this is unit-tested
// per #651 (chat-send-identity.test.js).

const CHAT_IDENTITY_NOT_READY = 'chat-identity-not-ready';
const CHAT_IDENTITY_NOT_READY_MESSAGE =
  'Your chat identity is not ready yet. Please try again in a moment — your message was not sent.';

// A personal identity is `@u-<16 hex>:<server>` (human-matrix-identity.js).
// Anything else — the shared admin, an agent — is never sent as on a person's
// behalf, even if a stale store record names it.
const PERSONAL_MATRIX_ID_RE = /^@u-[0-9a-f]{16}:[^\s]+$/;

function usableIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  if (typeof identity.accessToken !== 'string' || !identity.accessToken) return null;
  if (typeof identity.matrixUserId !== 'string' || !PERSONAL_MATRIX_ID_RE.test(identity.matrixUserId)) return null;
  return identity;
}

// Read; on a miss ask the orchestrator to provision now (it joins any attempt
// already running, so concurrent first sends create one account), then read
// again. A provisioning error is not rethrown — the re-read decides.
async function readOrProvision(read, provision) {
  const existing = usableIdentity(read());
  if (existing) return existing;
  try {
    await provision();
  } catch { /* fall through to the re-read; null there refuses the send */ }
  return usableIdentity(read());
}

async function resolveChatSendIdentity({
  userId,
  username,
  operator = false,
  store,
  provisionUser,
  provisionOperator,
} = {}) {
  if (!store) throw new Error('resolveChatSendIdentity: store is required');
  if (userId) {
    return readOrProvision(
      () => store.readIdentity(userId),
      () => provisionUser(userId),
    );
  }
  if (operator && typeof username === 'string' && username.trim()) {
    return readOrProvision(
      () => store.readOperatorIdentity(username),
      () => provisionOperator(username),
    );
  }
  return null;
}

module.exports = {
  CHAT_IDENTITY_NOT_READY,
  CHAT_IDENTITY_NOT_READY_MESSAGE,
  PERSONAL_MATRIX_ID_RE,
  usableIdentity,
  resolveChatSendIdentity,
};
