'use strict';

// Human-message attribution for the Agent Chat (#2065) — server side.
//
// There is exactly one Matrix human identity (docs/multi-user-concept.md), so
// every console user's chat message arrives with the same `sender`. The acting
// human therefore has to be recorded on the message itself, and it has to be
// recorded HERE: the stamp is derived from the authenticated session, never
// from the request body, so a browser cannot attribute its message to somebody
// else (AC2). The send route strips `io.aee.author` out of its `io.aee.*`
// pass-through for the same reason.
//
// Only identity is stored, never the name: the stable user id plus the login
// subject. The display name is resolved at render time from the user directory,
// so a rename shows on messages that already exist (D3). The subject is kept
// alongside the id because the env single-admin credential has no user record
// and so has no id — without it, the operator's own messages would be
// unattributable (AC13).
//
// Pure (no IO, no express coupling) so it is unit-tested under `node --test`.

/** Matrix content key carrying the author stamp. Mirrors AUTHOR_FIELD in
 *  admin-console/src/pages/agent-chat/message-author.js — the two live in
 *  separate module systems (CommonJS vs. ESM), so the constant is duplicated. */
const CHAT_AUTHOR_FIELD = 'io.aee.author';

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build the author stamp for a chat message sent by an authenticated caller.
 *
 * @param {{userId?: string|null, username?: string|null}} identity
 *   `userId` is the user-store record id (`scope.userId`), absent for the env
 *   single-admin; `username` is the session subject (`req.user.username`).
 * @returns {{userId?: string, subject?: string}|null} `null` when the caller
 *   carries no usable identity at all — the message then stays un-attributed
 *   rather than being stamped with an empty author.
 */
function chatAuthorStamp({ userId, username } = {}) {
  const stamp = {};
  const id = trimmedString(userId);
  const subject = trimmedString(username);
  if (id) stamp.userId = id;
  if (subject) stamp.subject = subject;
  return (stamp.userId || stamp.subject) ? stamp : null;
}

module.exports = { CHAT_AUTHOR_FIELD, chatAuthorStamp };
