'use strict';

/*
 * The chat rail's roster (`GET /api/matrix/agents`) as two pure halves (#566).
 *
 * Every visible console tab polls the roster every 5 s. It used to sweep the
 * whole fleet on Filestore per request (every config.json, then a dm-room.json
 * and an uncached environment.json per visible agent), so N tabs meant N full
 * sweeps every 5 s on the console's one event loop. Now, like
 * `/api/agents/statuses`:
 *
 *   - `buildRosterEntries` reads the fleet ONCE, unscoped and with the widest
 *     admission (disabled + stubs), memoising each environment and each team's
 *     pool-waiting record per build. api.js keeps the result behind a short
 *     single-flight TTL cache, so the sweep runs at most once per TTL however
 *     many tabs are polling.
 *   - `projectRoster` is the per-request half: the caller's own admission
 *     options, visibility scope and the caller-specific fields
 *     (`canManage`/`canChat`/`canManageTeam`). No filesystem access.
 *
 * File reads and scope predicates are injected, so this module stays
 * dependency-free and `node --test`-covered (the #651 convention); api.js is
 * the thin adapter.
 */

const { admitsToChatList } = require('./matrix-agent-list');
const { ttlMsFromEnv } = require('./ttl-cache');

// The build is shared by every query variant, so it admits the widest set and
// `projectRoster` narrows it per request.
const WIDEST_ADMISSION = { includeDisabled: true, includeStubs: true };

// #2789: roster fields for a pool instance waiting on an open PR. Only a
// record for THIS spawn counts (a recycled instance id must not inherit an
// earlier instance's state); primitives only, the roster diff is shallow.
function poolWaitingFields(waitingMap, id, spawnedAt) {
  const rec = waitingMap && typeof waitingMap === 'object' ? waitingMap[id] : null;
  if (!rec || typeof rec !== 'object' || rec.waiting !== true) return {};
  if ((rec.spawnedAt || null) !== (spawnedAt || null)) return {};
  const prs = Array.isArray(rec.prs) ? rec.prs.filter((n) => Number.isInteger(n) && n > 0) : [];
  return { poolWaiting: true, poolWaitingPr: prs.length ? Math.min(...prs) : null };
}

/**
 * Read the fleet once into caller-independent entries.
 *
 * An entry is the caller-independent part of the row, never the config itself:
 * the cache is shared by every user for a whole TTL, so it must not hold the
 * agent's Matrix access token or its prompt templates (#566). What it keeps:
 *
 *   - `admission` — exactly the fields `admitsToChatList` / `isStubMember` read
 *     (`token` collapsed to a boolean), so each request can still apply its
 *     own `includeDisabled`/`includeStubs` through the one admission rule;
 *   - `meta` — the scope meta (`agentMetaForScope`), computed once;
 *   - `head`/`tail` — the response fields before and after the caller-specific
 *     ones, so the projection keeps the pre-#566 key order.
 *
 * One agent's bad config (e.g. a non-string `environmentId` that makes the
 * environment read throw) skips that agent only and is reported through
 * `onEntryError`; it must not fail the shared build and 500 the rail for every
 * user.
 *
 * @param {string[]} ids                       agent dir names
 * @param {object}   deps
 * @param {(id: string) => object|null} deps.readConfig        config.json or null
 * @param {(id: string) => string|null} deps.readDmRoomId      dm-room.json's roomId or null
 * @param {(envId: string) => string|null} deps.readEnvironmentName  environment.json's name or null
 * @param {(teamId: string) => object|null} deps.readPoolWaiting  the team's pool-waiting.json
 * @param {(cfg: object) => object} deps.agentMetaForScope     the scope meta of one config
 * @param {(id: string, err: Error) => void} [deps.onEntryError]  a skipped agent
 * @returns {{id: string, meta: object, isTeam: boolean, admission: object, head: object, tail: object}[]}
 */
function buildRosterEntries(ids, {
  readConfig, readDmRoomId, readEnvironmentName, readPoolWaiting, agentMetaForScope, onEntryError,
}) {
  const envNames = new Map();
  const poolWaitingByTeam = new Map();
  const entries = [];
  for (const id of ids || []) {
    try {
      const cfg = readConfig(id);
      if (!cfg) continue;
      if (!admitsToChatList(cfg, WIDEST_ADMISSION)) continue;
      let environmentName = null;
      if (cfg.environmentId) {
        if (!envNames.has(cfg.environmentId)) envNames.set(cfg.environmentId, readEnvironmentName(cfg.environmentId));
        environmentName = envNames.get(cfg.environmentId);
      }
      let poolWaiting = {};
      if (cfg.poolInstance && cfg.parentTeamId) {
        if (!poolWaitingByTeam.has(cfg.parentTeamId)) {
          poolWaitingByTeam.set(cfg.parentTeamId, readPoolWaiting(cfg.parentTeamId));
        }
        poolWaiting = poolWaitingFields(poolWaitingByTeam.get(cfg.parentTeamId), id, cfg.poolSpawnedAt);
      }
      // Read for every admitted row, tokenless ones included, as before #566:
      // a team record or a stub can still carry a dm-room.json (a standalone
      // agent converted into its team of one keeps its room), and the rail
      // opens and deep-links rooms off those rows too.
      const dmRoomId = readDmRoomId(id);
      entries.push({
        id,
        meta: agentMetaForScope(cfg),
        isTeam: cfg.role === 'team',
        admission: {
          role: cfg.role,
          enabled: cfg.enabled,
          token: !!cfg.token,
          parentTeamId: cfg.parentTeamId,
        },
        head: {
          id,
          displayName: cfg.displayName || id,
          role: cfg.role || 'agent',
          userId: cfg.userId || `@${id}:local`,
          enabled: cfg.enabled !== false,
          // Whether the agent has ever been provisioned — never the token itself.
          // Lets the shared `agentState()` tell "paused" from "stub"; since #1957
          // it identifies the stub rows `?includeStubs=1` admits.
          hasToken: !!cfg.token,
        },
        tail: {
          dmRoomId: dmRoomId || null,
          environmentId: cfg.environmentId || null,
          environmentName: environmentName || cfg.environmentId || null,
          parentTeamId: cfg.parentTeamId || null,
          parentOrchestratorId: cfg.parentOrchestratorId || null,
          // Pool instance markers (#2297): `poolOf` lets the rail nest the
          // instance under its role template (`agent-list-model.js` `buildGroups`).
          ...(cfg.poolInstance ? {
            poolInstance: true,
            poolOf: cfg.poolOf || null,
            poolItem: cfg.poolItem != null ? cfg.poolItem : null,
            poolSpawnedAt: cfg.poolSpawnedAt || null,
            // #2789: idle and kept alive for its open PR.
            ...poolWaiting,
          } : {}),
          // #2760 AC5: a pooled role TEMPLATE's "Max parallel instances" cap
          // (`null` = no per-role cap); absent on every non-pooled row.
          ...(!cfg.poolInstance && cfg.pool && typeof cfg.pool === 'object' && cfg.pool.enabled === true ? {
            poolMaxInstances: Number.isInteger(cfg.pool.maxInstances) && cfg.pool.maxInstances >= 1 ? cfg.pool.maxInstances : null,
          } : {}),
        },
      });
    } catch (err) {
      if (typeof onEntryError === 'function') onEntryError(id, err);
    }
  }
  return entries;
}

/**
 * Project the shared entries for one caller. Field order and presence are
 * the pre-#566 response shape.
 *
 * @param {object[]} entries   `buildRosterEntries` output
 * @param {object}   scope     the caller's `getScope(req)`
 * @param {{includeDisabled?: boolean, includeStubs?: boolean}} options
 * @param {object}   access    `{ visibleAgent, canManageAgent, canChatAgent, canManageTeam }`
 */
function projectRoster(entries, scope, options, access) {
  const out = [];
  for (const { id, meta, isTeam, admission, head, tail } of entries || []) {
    if (!admitsToChatList(admission, options)) continue;
    if (!access.visibleAgent(scope, meta)) continue; // team + visibility scoping (#302)
    out.push({
      ...head,
      // Whether THIS caller may run management actions (#989) — the boundary
      // the mutating routes enforce, so the lifecycle menu can disable them.
      canManage: access.canManageAgent(scope, meta),
      // Whether THIS caller may WRITE in the agent's chat (#2713) — false only
      // for a System Admin outside the agent's team.
      canChat: access.canChatAgent(scope, meta),
      // Whether THIS caller may change the team's MEMBER LIST — the predicate
      // `POST`/`DELETE /api/admin/memberships` enforce (#2082). Separate from
      // `canManage` on purpose (#2041 §7.1); only on team rows, so a caller
      // cannot read its absence as "not permitted".
      ...(isTeam ? { canManageTeam: access.canManageTeam(scope, id) } : {}),
      ...tail,
    });
  }
  return out;
}

// The console mutations whose effect lands in a roster input (#566): an agent
// directory or its config.json, its dm-room.json, or the name of the
// environment it is bound to. Most of them are proxied to the orchestrator, so
// the cache cannot be cleared at the file write; it is cleared when the
// request succeeds instead. An ALLOWLIST, not a denylist: a route missing here
// shows its change one TTL late, while a denylist that misses a hot route (a
// chat upload, a copilot turn, a POST-shaped read) silently turns the cache off
// for the users it exists for.
//
// Not covered, by design: writes the orchestrator makes on its own (pool
// spawn/reap, idle reclaim/wake, its DM-room pre-create, a stub enable it
// drives) are in another process and surface within one TTL + one poll. The
// console's own DM-room write (`ensureAgentDmRoom`) clears the cache at the
// write site instead, so the idempotent `POST …/dm` does not.
const ROSTER_MUTATIONS = [
  ['POST', /^\/api\/agents$/], // create
  ['POST', /^\/api\/agents\/import$/],
  ['POST', /^\/api\/agents\/orphans\/cleanup$/],
  ['POST', /^\/api\/agents\/team-of-one-migration\/apply$/],
  ['PUT', /^\/api\/agents\/[^/]+$/], // rename, enable, environment, ports
  ['DELETE', /^\/api\/agents\/[^/]+$/],
  ['POST', /^\/api\/agents\/[^/]+\/(clone|deactivate|members)$/],
  ['POST', /^\/api\/teams$/],
  ['POST', /^\/api\/teams\/stream$/],
  ['POST', /^\/api\/teams\/[^/]+\/(enable|disable|force-dispatch)$/],
  ['POST', /^\/api\/teams\/[^/]+\/hill-climb\/cards\/[^/]+\/(apply|rollback)$/],
  ['PUT', /^\/api\/environments\/[^/]+$/], // the row carries the environment's name
  ['DELETE', /^\/api\/environments\/[^/]+$/],
  ['POST', /^\/api\/quickstart(\/llm)?$/],
  ['POST', /^\/api\/blueprints\/[^/]+\/instances$/],
  ['DELETE', /^\/api\/admin\/users\/[^/]+$/], // offboarding pauses the human's agents
  ['DELETE', /^\/api\/admin\/teams\/[^/]+$/],
];

// Strip trailing '/' with a linear scan. This runs on every /api request's
// URL, and a regex trim like `/\/+$/` backtracks O(n²) on a long run of
// slashes that is not anchored at the end (CodeQL js/polynomial-redos) — the
// same fix as api.js's trimTrailingSlashes (47 === '/').
function trimTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end -= 1;
  return s.slice(0, end);
}

/**
 * Does a SUCCESSFUL request invalidate the cached roster? Only the
 * roster-affecting routes above, so a create/rename/enable done in this console
 * shows on the very next fetch, not one TTL later; a refused or failed one
 * (`status >= 400`) changed nothing and leaves the cache alone.
 *
 * @param {string} method
 * @param {string} url      `req.originalUrl` (a query string is ignored)
 * @param {number} [status] the final response status, when known
 */
function mutationInvalidatesRoster(method, url, status) {
  if (Number.isFinite(status) && status >= 400) return false;
  const m = String(method || '').toUpperCase();
  const p = trimTrailingSlashes(String(url || '').split('?')[0]);
  return ROSTER_MUTATIONS.some(([rm, re]) => rm === m && re.test(p));
}

/**
 * The roster cache TTL from `AGENT_ROSTER_TTL_MS`. Unset or invalid ⇒ 2000 ms;
 * an explicit `0` turns caching off. With `0` every request runs its own full,
 * UNSCOPED sweep (the build is synchronous, so nothing is shared) — more work
 * per request than the pre-#566 scoped route, so it is a kill switch, not a
 * faithful "before" baseline.
 */
function rosterTtlMsFromEnv(env) {
  return ttlMsFromEnv(env && env.AGENT_ROSTER_TTL_MS, 2000);
}

module.exports = {
  buildRosterEntries,
  projectRoster,
  poolWaitingFields,
  mutationInvalidatesRoster,
  rosterTtlMsFromEnv,
};
