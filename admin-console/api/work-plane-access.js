'use strict';

// Work-plane tenant isolation (#1459 §2) — GOV-ACCESS-3 / GOV-PLATFORM-4.
//
// The *config* plane of an agent (prompt, model, triggers, repositories, …) has
// been scope-gated since #302. Its *work* plane never was: until this module,
// every route under `/api/agents/:agentId/{workspace,session,sessions,context,
// commands,git-info,chat-upload}` and every `/api/matrix/*` room route
// authorized nothing beyond the id's shape. Any authenticated user could read
// or delete any agent's files, run `git discard` in its checkout, read any
// agent's session log, and post into any agent's chat room as the admin token.
// `docs/governance-concept.md:196-201` calls that "the widest live hole".
//
// ── Why a mount list and not 34 in-handler checks ──────────────────────────
//
// GOV-ACCESS-3 asks for *one* `:agentId`-keyed middleware, and the reason is
// the failure mode: a missing gate is invisible. The route still returns the
// right answer to the caller who is allowed — and to everyone else too. A gate
// repeated 34 times is 34 chances to forget it, and the 35th route added next
// quarter will have none.
//
// api.js turns out to already draw exactly the line we need, in its parameter
// names: every work-plane route is keyed `:agentId`, every config-plane route
// (which carries its own #302 gate) is keyed `:id`. So the mount list below is
// not a hand-curated subset of the route table — it is *all* of the `:agentId`
// family, and `work-plane-access.test.js` re-derives it from api.js's source
// and fails if a route ever falls outside it.
//
// ── Why one predicate, and a uniform 404 ──────────────────────────────────
//
// This closes the **tenant** boundary, and only that. GOV-ACCESS-3 words the
// rule as "reads require `visibleAgent` (404 on miss — don't leak existence),
// writes require membership in the agent's team", which is also #1459's own
// acceptance criterion — and with the two roles that exist today those two
// halves are the *same test*: `visibleAgent` → `visibleTeam` → the caller's
// membership set. Writing them as separate branches would put an unreachable
// condition in the tree and a guard no mutation could falsify, so the gate is
// one predicate — and the equivalence is *pinned by a test* over the full
// user × agent × method cross-product rather than asserted in this comment.
//
// THE HALVES DO DIVERGE, and the successor is already designed: #2041 **D9**
// (`docs/decentralised-access-concept.md` §6) rules that a Team Member may read
// and chat but that workspace writes — delete/move/upload and `git-action`
// (commit/push) — are **Team Admin only** (`canManageAgent`), and §11.2 assigns
// that split to **P2**. #1459 is a P1 ticket, so it is deliberately not done
// here: it is a behaviour change *inside* a team (a member who can commit from
// the console today would lose it), and it cannot be a method-based rule
// because posting a chat message, opening a DM room, attaching a file and
// stopping your own run are all writes that D9 explicitly *allows* a member.
// Classifying all ~34 routes into read / chat / manage is that ticket's work.
// When it lands, `authorizeWorkPlane` is the single place it happens.
//
// The refusal is 404 for both, never 403: a private agent's *existence* is the
// thing being protected, and 403-vs-404 is exactly how an enumeration probe
// tells "not yours" from "not there". This follows the `model-options` /
// `resolveAgentRepoAccess` precedent in api.js and `draft-access.js`'s AC7.
// (The P2 split's refusal is a different question — a caller who is refused a
// *write* on an agent they can see already knows it exists, so 403 is right
// there, exactly as `denyUnlessCanManageAgent` already answers elsewhere.)
//
// Pure (no fs, no express, no api.js): the express middlewares below are built
// from injected lookups, which is what makes them reachable from a real-HTTP
// test — api.js boots two servers on require and cannot be exercised directly
// (#651).

/** A refusal that is indistinguishable from "no such agent". Frozen so a
 *  caller cannot mutate the shared instance. */
const NOT_FOUND = Object.freeze({ ok: false, status: 404, error: 'Agent not found' });

const ALLOWED = Object.freeze({ ok: true, status: 200 });

/**
 * Express `app.use` mount paths covering the whole `:agentId` work plane.
 *
 * Each entry ends on a complete path segment, which is what keeps the gate off
 * the neighbouring config plane: path-to-regexp compiles an `app.use` path with
 * a segment-boundary lookahead, so `/api/agents/:agentId/context` matches
 * `…/context/tree` but NOT `…/context-mount`, and `/api/agents/:agentId/session`
 * does not match `…/sessions/history`. Both of those are asserted over a real
 * express app in the sibling test, because "it should match by segment" is
 * precisely the kind of claim that is wrong in one framework version.
 *
 * `/api/agents/statuses` and `/api/agents/orphans` are likewise untouched: they
 * have no second segment for any of these prefixes to match (the shadowing
 * hazard `orphan-routes.test.js` guards).
 */
const WORK_PLANE_AGENT_PREFIXES = Object.freeze([
  '/api/agents/:agentId/chat-upload',
  '/api/agents/:agentId/commands',
  '/api/agents/:agentId/context',
  '/api/agents/:agentId/git-info',
  '/api/agents/:agentId/pool-archive',
  '/api/agents/:agentId/github-events',
  '/api/agents/:agentId/session',
  '/api/agents/:agentId/sessions',
  '/api/agents/:agentId/workspace',
  // The one `/api/matrix/*` route that names its agent directly.
  '/api/matrix/agents/:agentId',
]);

/**
 * The Matrix chat routes key on a room, not an agent — `GET|POST|DELETE
 * /api/matrix/rooms/:roomId/messages` and `/stream`. They are the *same*
 * resource as the session log by another door (the console's chat panel reads
 * an agent's transcript through them), so leaving them ungated would answer
 * "can a colleague read another team's chat?" with yes no matter what the
 * `:agentId` gate says. GOV-ACCESS-3 names this explicitly: "resolve room →
 * agent before posting with the admin token".
 */
const WORK_PLANE_ROOM_PREFIX = '/api/matrix/rooms/:roomId';

/**
 * THE decision. `agent` is the minimal `{ teamId, ownerId }` shape `visibleAgent`
 * consumes (api.js's `agentMetaForScope`), where `teamId` is the RESOLVED access
 * boundary (`resolveAgentTeam`: `null` for a standalone `role: 'agent'`, whose
 * privacy is then decided by `ownerId` — #2078 D8) rather than the raw config's
 * tenant stamp; or `null` when no agent could be resolved for the request.
 *
 * A `null` agent is refused rather than passed through. That covers three cases
 * that must not be distinguishable from each other: the agent does not exist,
 * its directory exists but carries no `config.json` (so its tenant is unknown —
 * fail closed rather than guess `default`), and the room in the URL belongs to
 * no agent at all.
 *
 * @param {{all: boolean, teamIds: Set<string>, userId: string|null}} scope
 * @param {{teamId: string|null, ownerId?: string}|null} agent
 * @param {{visibleAgent: Function}} deps  scope.js's predicate, injected so this
 *   file stays free of the require graph api.js drags in.
 */
function authorizeWorkPlane(scope, agent, { visibleAgent } = {}) {
  if (typeof visibleAgent !== 'function') {
    throw new TypeError('authorizeWorkPlane requires the visibleAgent predicate');
  }
  if (!scope) return NOT_FOUND;
  if (!agent) return NOT_FOUND;
  if (!visibleAgent(scope, agent)) return NOT_FOUND;
  return ALLOWED;
}

/**
 * Build the two express middlewares from injected lookups.
 *
 * @param {object} deps
 * @param {(req) => object} deps.getScope        api.js's `getScope`
 * @param {(id) => object|null} deps.loadAgentMeta   agent id → `agentMetaForScope(cfg)` | null
 * @param {(roomId) => object|null} deps.loadRoomAgentMeta  room id → the owning agent's meta | null
 * @param {(id) => boolean} deps.isValidAgentId  api.js's `AGENT_ID_RE` test
 * @param {Function} deps.visibleAgent           scope.js's `visibleAgent`
 */
function createWorkPlaneGates({
  getScope,
  loadAgentMeta,
  loadRoomAgentMeta,
  isValidAgentId,
  visibleAgent,
} = {}) {
  for (const [name, fn] of Object.entries({
    getScope, loadAgentMeta, loadRoomAgentMeta, isValidAgentId, visibleAgent,
  })) {
    if (typeof fn !== 'function') throw new TypeError(`createWorkPlaneGates needs ${name}`);
  }

  // Both gates short-circuit on `scope.all` BEFORE touching the disk. That is
  // not only a saving: on a single-operator install (`AUTH_ENABLED=false`, the
  // shipped default — auth-mode.js) every caller is `all: true`, so the gate
  // must add exactly zero reads and zero behaviour to the request path it is
  // mounted in front of. Without it, the room gate would scan every agent
  // directory on each chat poll and SSE reconnect.
  function agentGate(req, res, next) {
    const scope = getScope(req);
    if (scope && scope.all) return next();

    const agentId = req.params && req.params.agentId;
    // A malformed id can match no agent, so there is nothing to protect and
    // nothing to leak — hand it to the route, which already answers 400. This
    // keeps the gate from changing any existing error for a bad request.
    if (!isValidAgentId(String(agentId || ''))) return next();

    const decision = authorizeWorkPlane(scope, loadAgentMeta(agentId), { visibleAgent });
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    return next();
  }

  function roomGate(req, res, next) {
    const scope = getScope(req);
    if (scope && scope.all) return next();

    const roomId = req.params && req.params.roomId;
    const decision = authorizeWorkPlane(scope, loadRoomAgentMeta(String(roomId || '')), { visibleAgent });
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    return next();
  }

  return { agentGate, roomGate };
}

module.exports = {
  NOT_FOUND,
  ALLOWED,
  WORK_PLANE_AGENT_PREFIXES,
  WORK_PLANE_ROOM_PREFIX,
  authorizeWorkPlane,
  createWorkPlaneGates,
};
