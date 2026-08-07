'use strict';

// #933: loop-trigger verifier gate support (concept §4.2 / §4.6 decision 1).
//
// Two small, pure building blocks used by the orchestrator's loop-verify HTTP
// endpoints. They live here — not inline in orchestrator.js — so the logic is
// unit-testable (this repo tests pure module cores, not the HTTP server):
//
//   - `computeTeamRoster`  — the sibling roster a team loop agent's runtime
//     reads to enforce a *different* verifier ("an agent must not grade its own
//     work"); the actual pick is the runtime's `_select_sibling_verifier`.
//   - `createVerdictStore` — the in-memory rendezvous for the agent-form
//     verifier (AC2): a requester loop enqueues a verify request to the target
//     agent and polls this store for the verdict the target posts back.

// Project the sibling roster for `agentId` from a list of agent configs.
//
// Siblings are the *other* `team-member` agents under the SAME `parentTeamId`
// (the agent squad — deliberately NOT the broader human `teamId`, since two
// unrelated squads can share `teamId: "default"`). A standalone agent (no
// `parentTeamId`) has no siblings. Deterministically sorted by id so a caller
// that must break a tie does so stably.
function computeTeamRoster(agentId, configs) {
  const list = Array.isArray(configs) ? configs : [];
  const self = list.find((c) => c && c.id === agentId);
  const teamId =
    self && typeof self.parentTeamId === 'string' && self.parentTeamId
      ? self.parentTeamId
      : null;
  const siblings = [];
  if (teamId) {
    for (const c of list) {
      if (!c || c.id === agentId) continue;
      if (c.role !== 'team-member') continue;
      if (c.parentTeamId !== teamId) continue;
      siblings.push({
        agentId: c.id,
        role: typeof c.role === 'string' ? c.role : null,
        displayName:
          typeof c.displayName === 'string' && c.displayName ? c.displayName : c.id,
      });
    }
    siblings.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
  return { found: Boolean(self), teamId, siblings };
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h — long enough for any single loop iteration

// A tiny token→verdict store with TTL pruning. Injected `now` keeps it testable
// without real time. A never-collected verdict (the requesting loop died) is
// pruned once it ages past `ttlMs`, so the map can't leak unboundedly.
function createVerdictStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const map = new Map(); // token -> { passed, output, ts }

  function prune(t) {
    for (const [k, v] of map) {
      if (t - v.ts > ttlMs) map.delete(k);
    }
  }

  return {
    set(token, passed, output, t = now()) {
      if (typeof token !== 'string' || !token) {
        throw new Error('token required');
      }
      prune(t);
      map.set(token, {
        passed: Boolean(passed),
        output: typeof output === 'string' ? output : '',
        ts: t,
      });
    },
    get(token, t = now()) {
      prune(t);
      const v = map.get(token);
      if (!v) return { found: false };
      return { found: true, passed: v.passed, output: v.output };
    },
    size() {
      return map.size;
    },
  };
}

module.exports = { computeTeamRoster, createVerdictStore, DEFAULT_TTL_MS };
