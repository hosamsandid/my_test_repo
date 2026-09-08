'use strict';

// The Team Member boundary on the work plane (#2080, epic #2076 P2 / AC7b).
// Design of record: `docs/decentralised-access-concept.md` D9 (§6 matrix) and
// §11.2; #2041 §7.
//
// D9 in one line: **a Team Member may read and chat, but may not change any
// agent or team setting.** `canManageAgent` (`scope.js`) has meant *team-admin
// of the owning team* since #989 and was re-pointed onto the Agent Team by
// #2078, so most mutation routes are already gated correctly. This module
// carries the part that was not: the work plane (§11.2), where reads and writes
// share a route prefix and therefore cannot be told apart by a mount path.
//
// ── Why this is a separate module from `work-plane-access.js` ───────────────
//
// #1459 §2 closes the **tenant** boundary over the same family with one
// `app.use` mount list: may this caller touch this agent *at all*. Its own
// header states the split and hands this half over — *"THE HALVES DO DIVERGE …
// §11.2 assigns that split to P2 … Classifying all ~34 routes into read / chat
// / manage is that ticket's work."* This module is that classification plus the
// second, stronger predicate; the two compose rather than overlap:
//
//   tenant gate (#1459 §2)  → visibleAgent  → 404, "is it yours at all"
//   member boundary (here)  → canManageAgent → 403, "may you change it"
//
// They are deliberately NOT merged into one predicate. `app.use` cannot
// discriminate by method, and D9's line is not a method line either — posting a
// chat message, opening a DM room, attaching a file and stopping your own run
// are all writes D9 explicitly *allows* a member. So the tenant half stays a
// prefix mount and this half is per-route, keyed on the §6 matrix below.
//
// ── Why the refusal is 403 here and 404 there ──────────────────────────────
//
// A 404 protects an agent's *existence*: 403-vs-404 is exactly how an
// enumeration probe tells "not yours" from "not there". But a caller refused a
// **write** on an agent they can already see and chat with has learned nothing
// new, so 403 is right — and it is the honest answer, because "you may read
// this but not change it" is the whole content of D9. `authorizeAgentMutation`
// therefore answers 404 while the agent is invisible and only then 403,
// matching `denyUnlessCanManageAgent`/`resolveAgentRepoAccess` in api.js.
//
// Pure (no fs, no express, no api.js): the predicates and the request-shaped
// lookups are injected, which is what makes the real middleware drivable from a
// test — api.js has no exports and binds port 4000 on require (#651), and
// express is not installed in every environment this suite runs in.

/**
 * The three classes D9 sorts the work plane into. `read` and `chat` are both
 * **allowed** for a Team Member and are kept apart anyway, because they are
 * allowed for different reasons and a later phase may treat them differently
 * (a chat message is an attributable act; a file read is not).
 */
const MUTATION_CLASS = Object.freeze({
  READ: 'read',
  CHAT: 'chat',
  MANAGE: 'manage',
});

/** A refusal indistinguishable from "no such agent" (the tenant boundary). */
const NOT_FOUND = Object.freeze({ ok: false, status: 404, error: 'Agent not found' });

/**
 * The D9 refusal: the caller can see this agent, so its existence is not a
 * secret — what they lack is team-admin rights. Shape and wording are copied
 * verbatim from `denyUnlessCanManageAgent` so a client cannot tell which of the
 * two gates answered.
 */
const FORBIDDEN = Object.freeze({ ok: false, status: 403, error: 'forbidden', code: 'forbidden' });

const ALLOWED = Object.freeze({ ok: true, status: 200 });

/**
 * §6 of the concept, as data — the three route families whose rows this ticket
 * enforces, every route in them, and the class D9 puts it in.
 *
 * This table is the contract, and `team-member-boundary.test.js` drives it in
 * both directions: every entry must be a route api.js really registers, and
 * every route api.js registers in these families must have an entry. That
 * second direction is the point. A gate is invisible when it goes missing, and
 * a *new* route is worse than a changed one — it ships with no gate and no
 * failing test. Adding `POST /api/agents/:id/triggers/:triggerId/run` next
 * quarter fails this table until someone classifies it, and §6 has already
 * decided the answer (`manage` — see MANUAL_FIRE_RULE).
 *
 * `path` is the express route string verbatim, including the `:id`-vs-`:agentId`
 * split. That split is not cosmetic: api.js keys every work-plane route
 * `:agentId` and every config-plane route `:id`, which is how the #1459 mount
 * list stays off the config plane — so recording the real parameter name is
 * what lets the source scan match on an exact string rather than a fuzzy one.
 */
const WORK_PLANE_ROUTES = Object.freeze([
  // ── Workspace reads — "allowed": reading (§6 row 2) ──────────────────────
  { method: 'get', path: '/api/agents/:agentId/workspace/tree', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/workspace/file', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/workspace/image', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/workspace/download', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/workspace/git-status', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/workspace/git-diff', cls: MUTATION_CLASS.READ },

  // ── Workspace writes — "Team Admin only" (§6 row 3) ─────────────────────
  // Destructive and outward-facing. A member can still *ask the agent* to do
  // it, which leaves an attributable trace in the chat — that is the whole
  // rationale, and it is why refusing here costs a member nothing they need.
  { method: 'delete', path: '/api/agents/:agentId/workspace/file', cls: MUTATION_CLASS.MANAGE },
  { method: 'post', path: '/api/agents/:agentId/workspace/move', cls: MUTATION_CLASS.MANAGE },
  { method: 'post', path: '/api/agents/:agentId/workspace/upload', cls: MUTATION_CLASS.MANAGE },
  { method: 'post', path: '/api/agents/:agentId/workspace/git-action', cls: MUTATION_CLASS.MANAGE },

  // ── Context-folder reads — "allowed", same reason as workspace reads ─────
  { method: 'get', path: '/api/agents/:agentId/context/status', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/context/tree', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/context/file', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/context/image', cls: MUTATION_CLASS.READ },
  { method: 'get', path: '/api/agents/:agentId/context/download', cls: MUTATION_CLASS.READ },

  // ── Context-folder writes — "Team Admin only" ───────────────────────────
  // §6's row names "delete/move/upload file"; these are those three operations
  // on a read-write host mount, and §11.2 lists them in the same ungated
  // family. They are if anything the stronger case: the bytes land on the
  // HOST, outside the container boundary the workspace routes stay inside.
  { method: 'delete', path: '/api/agents/:agentId/context/file', cls: MUTATION_CLASS.MANAGE },
  { method: 'post', path: '/api/agents/:agentId/context/move', cls: MUTATION_CLASS.MANAGE },
  { method: 'post', path: '/api/agents/:agentId/context/upload', cls: MUTATION_CLASS.MANAGE },

  // ── Triggers — viewing allowed, editing Team-Admin-only (§6 rows 4+5) ────
  { method: 'get', path: '/api/agents/:id/triggers', cls: MUTATION_CLASS.READ },
  { method: 'post', path: '/api/agents/:id/triggers', cls: MUTATION_CLASS.MANAGE },
  { method: 'put', path: '/api/agents/:id/triggers/:triggerId', cls: MUTATION_CLASS.MANAGE },
  { method: 'delete', path: '/api/agents/:id/triggers/:triggerId', cls: MUTATION_CLASS.MANAGE },
]);

/**
 * The route-family prefixes `WORK_PLANE_ROUTES` claims to cover completely.
 * The source scan derives its route set from these, so the table's second
 * direction ("no unclassified route in these families") means something precise
 * rather than "no route we happened to think of".
 *
 * Bounded to the three families §6's rows name. The chat/session family is
 * `chat`-class throughout — allowed for a member, and left ungated by this
 * ticket because its tenant half is #1459 §2's and its D9 half is a no-op —
 * so scanning it would add ~20 entries that assert nothing this ticket changes.
 */
const SCANNED_FAMILIES = Object.freeze(['workspace', 'context', 'triggers']);

/**
 * AC3's rule, recorded rather than implemented: **there is no manual
 * trigger-firing route in api.js today.** Verified across the whole file —
 * nothing under `/api/agents/:id/triggers/*` fires a trigger, and the only
 * `…/run` route is the hill-climb pass. §6 states the rule pre-emptively, and
 * the reason it must be pre-emptive is a real asymmetry: firing a trigger
 * produces an autonomous run that reads as system-initiated, whereas the same
 * work requested in chat stays attributable to the person who asked.
 *
 * So the deliverable for AC3 is not a gate on a route that does not exist — it
 * is that the route cannot arrive ungated. `WORK_PLANE_ROUTES` is the ratchet
 * (a new triggers-family route fails the completeness test until classified)
 * and this predicate is the classification such a route must receive.
 */
const MANUAL_FIRE_RULE = Object.freeze({
  cls: MUTATION_CLASS.MANAGE,
  why: 'Firing a trigger produces an autonomous run that reads as system-initiated; '
     + 'the same work requested in chat stays attributable to the person who asked.',
});

/** Does this path name a trigger-firing action? Any verb-shaped tail segment on
 *  a single trigger is a fire, and must be `manage` per MANUAL_FIRE_RULE. */
function isTriggerFiringRoute(path) {
  return /^\/api\/agents\/:(?:id|agentId)\/triggers\/:[A-Za-z]+\/(run|fire|run-now|execute|trigger)$/
    .test(String(path || ''));
}

/**
 * The class D9 puts a route in, or `null` when the table does not know it.
 * `null` is the ratchet's failure signal — never a default, because defaulting
 * an unknown mutation to `read` is how a gate goes missing silently and
 * defaulting it to `manage` would break a chat route nobody classified.
 */
function classifyWorkPlaneRoute(method, path) {
  const m = String(method || '').toLowerCase();
  const p = String(path || '');
  const hit = WORK_PLANE_ROUTES.find(r => r.method === m && r.path === p);
  if (hit) return hit.cls;
  if (isTriggerFiringRoute(p)) return MANUAL_FIRE_RULE.cls;
  return null;
}

/** Every `manage`-class route in the table — what the wiring guard must find a
 *  gate on, and what the count assertions are keyed on. */
function manageRoutes() {
  return WORK_PLANE_ROUTES.filter(r => r.cls === MUTATION_CLASS.MANAGE);
}

/**
 * THE decision. Two predicates in order, and the order is the security
 * property: visibility first so an invisible agent is refused as absent, then
 * management so a visible one is refused as read-only.
 *
 * `agent` is the minimal `{ teamId, ownerId }` shape both predicates consume —
 * api.js's `agentMetaForScope(cfg)`, i.e. the **resolved access boundary**
 * (`resolveAgentTeam`), never a raw `config.json`. That distinction is
 * load-bearing and easy to get wrong: a raw config carries `teamId` = the
 * *credential tenant* stamp (`'default'` on this installation), so passing one
 * to `visibleAgent` asks "is the caller in the access scope" instead of "is the
 * caller in the Agent Team" — and for a **standalone** agent it turns a truthy
 * `'default'` into a team check, bypassing D8's owner-only rule entirely.
 * Injecting the predicates rather than the config is what keeps that mistake
 * out of this module; the test pins it by driving a raw config through and
 * asserting the two disagree.
 *
 * @param {{all: boolean, teamIds: Set<string>, roles: Map, userId: string|null}} scope
 * @param {{teamId: string|null, ownerId?: string}|null} agent  resolved meta, or
 *   null when no agent could be loaded (missing dir, unreadable config → fail
 *   closed as absent rather than guessing a tenant).
 * @param {{visibleAgent: Function, canManageAgent: Function}} deps  scope.js's
 *   predicates, injected so this file stays out of api.js's require graph.
 */
function authorizeAgentMutation(scope, agent, { visibleAgent, canManageAgent } = {}) {
  if (typeof visibleAgent !== 'function' || typeof canManageAgent !== 'function') {
    throw new TypeError('authorizeAgentMutation requires the visibleAgent and canManageAgent predicates');
  }
  if (!scope) return NOT_FOUND;
  if (!agent) return NOT_FOUND;
  if (!visibleAgent(scope, agent)) return NOT_FOUND;
  if (!canManageAgent(scope, agent)) return FORBIDDEN;
  return ALLOWED;
}

/**
 * Build the per-route express middleware from injected lookups.
 *
 * Per-route rather than an `app.use` mount, because within one prefix
 * (`…/workspace/`) the reads must stay open and the writes must not — which is
 * exactly the discrimination `app.use` cannot make.
 *
 * @param {object} deps
 * @param {(req) => object} deps.getScope         api.js's `getScope`
 * @param {(id) => object|null} deps.loadAgentMeta  agent id → `agentMetaForScope(cfg)` | null
 * @param {(id) => boolean} deps.isValidAgentId    api.js's `AGENT_ID_RE` test
 * @param {Function} deps.visibleAgent             scope.js's `visibleAgent`
 * @param {Function} deps.canManageAgent           scope.js's `canManageAgent`
 */
function createAgentManageGate({
  getScope,
  loadAgentMeta,
  isValidAgentId,
  visibleAgent,
  canManageAgent,
} = {}) {
  for (const [name, fn] of Object.entries({
    getScope, loadAgentMeta, isValidAgentId, visibleAgent, canManageAgent,
  })) {
    if (typeof fn !== 'function') throw new TypeError(`createAgentManageGate needs ${name}`);
  }

  return function requireAgentManage(req, res, next) {
    const scope = getScope(req);
    // Short-circuit `scope.all` BEFORE touching the disk (D5). Not only a
    // saving: on a single-operator install (`AUTH_ENABLED=false`, the shipped
    // default — auth-mode.js) every caller is `all: true`, so the gate must add
    // exactly zero reads and zero behaviour to the path it guards.
    if (scope && scope.all) return next();

    const agentId = (req.params && (req.params.agentId || req.params.id)) || '';
    // A malformed id matches no agent, so there is nothing to protect and
    // nothing to leak — hand it to the route, which already answers 400. This
    // keeps the gate from changing any existing error for a bad request.
    if (!isValidAgentId(String(agentId))) return next();

    const decision = authorizeAgentMutation(scope, loadAgentMeta(String(agentId)), {
      visibleAgent, canManageAgent,
    });
    if (decision.ok) return next();
    const body = { error: decision.error };
    if (decision.code) body.code = decision.code;
    return res.status(decision.status).json(body);
  };
}

module.exports = {
  MUTATION_CLASS,
  NOT_FOUND,
  FORBIDDEN,
  ALLOWED,
  WORK_PLANE_ROUTES,
  SCANNED_FAMILIES,
  MANUAL_FIRE_RULE,
  isTriggerFiringRoute,
  classifyWorkPlaneRoute,
  manageRoutes,
  authorizeAgentMutation,
  createAgentManageGate,
};
