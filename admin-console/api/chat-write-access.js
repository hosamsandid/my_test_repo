'use strict';

// Read-only agent chat for System Admins outside the team (#2713).
//
// A System Admin sees every team's chats (`scope.all`), and until this module
// every chat gate only asked "may the caller SEE the agent?" — so the same
// person could also post into any team's chat, join its Matrix room and start
// a run there. The rule now is `canChatAgent` (scope.js): a System Admin writes
// only in teams they are a member of, or in a standalone agent they own.
//
// This module is the server half: two per-route express middlewares for the
// two routes the composer writes through —
//
//   • POST /api/matrix/rooms/:roomId/messages   (send, quick-reply answers,
//     dictation and meeting transcripts all post here)
//   • POST /api/agents/:agentId/chat-upload     (composer attachments)
//
// Both run AFTER the #1459 work-plane gates (which answer 404 for an agent the
// caller cannot see) and BEFORE the route body, so a refused send neither
// joins the caller into the room nor reaches the agent, and a refused upload is
// rejected before multer reads the files.
//
// The refusal is 403, not 404: only a System Admin can be refused here, and
// they can already see the agent, so its existence is no secret. The body
// carries a stable `code` so the composer can tell this from other errors.
//
// Pure (no fs, no express, no api.js): lookups are injected, so the gates are
// reachable from a real-HTTP test (api.js boots two servers on require, #651).

const CHAT_READ_ONLY = 'chat-read-only';
const CHAT_READ_ONLY_MESSAGE =
  "You're viewing this chat as a System Admin. To write here, add yourself to the team.";

const FORBIDDEN = Object.freeze({ ok: false, status: 403, error: CHAT_READ_ONLY_MESSAGE, code: CHAT_READ_ONLY });
const ALLOWED = Object.freeze({ ok: true, status: 200 });

/**
 * THE decision for one request. `agent` is `agentMetaForScope(cfg)` of the
 * agent whose chat is being written to, or `null` when none could be resolved
 * (a room no agent owns, an unknown agent id) — that case is passed through:
 * it is not an agent chat, and the work-plane gate and the route already
 * answer for it.
 */
function authorizeChatWrite(scope, agent, { canChatAgent } = {}) {
  if (typeof canChatAgent !== 'function') {
    throw new TypeError('authorizeChatWrite requires the canChatAgent predicate');
  }
  if (!agent) return ALLOWED;
  return canChatAgent(scope, agent) ? ALLOWED : FORBIDDEN;
}

/**
 * @param {object} deps
 * @param {(req) => object} deps.getScope
 * @param {(id) => object|null} deps.loadAgentMeta       agent id → meta | null
 * @param {(roomId) => object|null} deps.loadRoomAgentMeta  room id → owning agent's meta | null
 * @param {(id) => boolean} deps.isValidAgentId
 * @param {Function} deps.canChatAgent                   scope.js's predicate
 */
function createChatWriteGates({
  getScope,
  loadAgentMeta,
  loadRoomAgentMeta,
  isValidAgentId,
  canChatAgent,
} = {}) {
  for (const [name, fn] of Object.entries({
    getScope, loadAgentMeta, loadRoomAgentMeta, isValidAgentId, canChatAgent,
  })) {
    if (typeof fn !== 'function') throw new TypeError(`createChatWriteGates needs ${name}`);
  }

  function refuse(res, decision) {
    return res.status(decision.status).json({ error: decision.error, code: decision.code });
  }

  // Only a System Admin can be refused (every other caller's write right is
  // its visibility, which the work-plane gate already checked), so everyone
  // else passes before any disk read — the room lookup scans every agent dir.
  function agentChatGate(req, res, next) {
    const scope = getScope(req);
    if (!scope || scope.systemAdmin !== true) return next();
    const agentId = String((req.params && req.params.agentId) || '');
    if (!isValidAgentId(agentId)) return next();
    const decision = authorizeChatWrite(scope, loadAgentMeta(agentId), { canChatAgent });
    return decision.ok ? next() : refuse(res, decision);
  }

  function roomChatGate(req, res, next) {
    const scope = getScope(req);
    if (!scope || scope.systemAdmin !== true) return next();
    const roomId = String((req.params && req.params.roomId) || '');
    const decision = authorizeChatWrite(scope, loadRoomAgentMeta(roomId), { canChatAgent });
    return decision.ok ? next() : refuse(res, decision);
  }

  return { agentChatGate, roomChatGate };
}

module.exports = {
  CHAT_READ_ONLY,
  CHAT_READ_ONLY_MESSAGE,
  FORBIDDEN,
  ALLOWED,
  authorizeChatWrite,
  createChatWriteGates,
};
