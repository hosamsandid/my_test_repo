"use strict";

// Pure planner for the identity-LEND binding sweep (unified resource access
// model §10 E1 / §12.6, epic #2361 PR5 #2358).
//
// Binding a human's PERSONAL resource (a subscription seat / personal api-key
// provider, a personal GitHub PAT, a user SSH key) to a team is a LEND of their
// identity for the duration of their membership — never a transfer of ownership
// (concept §2). So the instant they leave the team, every team binding that
// pointed at one of their personal resources is dead and must be reset to
// INHERIT (env default / .env / a global service credential — decision §12.6),
// NOT left "set but dead". The resource itself is KEPT (still theirs, still
// usable in their other teams); only the BINDING is thrown out.
//
// This module answers, PURELY, *which* bindings to reset. The impure half — the
// membership lookup, the resource-index reads, the file writes, the respawns and
// the event-log line — is the `sweepMembershipBindings` method in
// orchestrator.js, exactly the "pure core + live wiring" split
// credential-resolution.js / agent-pool.js follow.
//
// Inputs (all already-loaded; no IO here):
//   teamId          — the Agent Team the human just left (membership.teamId).
//   environments    — [{ envId, env }] to examine: the team's agents' envs.
//   agents          — [{ id, cfg }] to examine: the team's agents (for the
//                     per-agent llmEndpointOverride).
//   personalOwnerOf(kind, id) -> ownerUserId | null
//                     kind ∈ 'provider' | 'github-token' | 'ssh-key'. Returns the
//                     PERSONAL owner of that resource, or null when the resource
//                     is not personal / unknown (a team/system/global resource is
//                     never a lend, so it is never swept).
//   isMemberOfTeam(userId, teamId) -> bool
//                     CURRENT membership, read AFTER the removal — so the human
//                     who just left answers false and their lends are collected.
//
// A binding is swept iff it references a resource `personalOwnerOf` reports as
// personal AND that owner is NOT a current member of `teamId`. Expressed against
// "any non-member owner", not just the departed user, so a binding left stale by
// an earlier gap is healed by the same pass.
//
// Returns { envResets, agentResets, affectedEnvIds, affectedAgentIds }:
//   envResets   — [{ envId, field: 'llmEndpointId'|'githubTokenId'|'repositories.sshKeyId',
//                   repoIndex?, repoUrl?, from }]
//   agentResets — [{ agentId, field: 'llmEndpointOverride', from }]
function planMembershipRemovalSweep({ teamId, environments = [], agents = [], personalOwnerOf, isMemberOfTeam } = {}) {
  const envResets = [];
  const agentResets = [];
  if (!teamId || typeof personalOwnerOf !== "function" || typeof isMemberOfTeam !== "function") {
    return { envResets, agentResets, affectedEnvIds: [], affectedAgentIds: [] };
  }

  // Is `id` a personal resource of this kind whose owner has left the team?
  const isDeadLend = (kind, id) => {
    if (!id) return false;
    const owner = personalOwnerOf(kind, id);
    return !!(owner && !isMemberOfTeam(owner, teamId));
  };

  for (const entry of Array.isArray(environments) ? environments : []) {
    const envId = entry && entry.envId;
    const env = entry && entry.env;
    if (!envId || !env || typeof env !== "object") continue;
    if (isDeadLend("provider", env.llmEndpointId)) {
      envResets.push({ envId, field: "llmEndpointId", from: env.llmEndpointId });
    }
    if (isDeadLend("github-token", env.githubTokenId)) {
      envResets.push({ envId, field: "githubTokenId", from: env.githubTokenId });
    }
    const repos = Array.isArray(env.repositories) ? env.repositories : [];
    repos.forEach((repo, repoIndex) => {
      if (repo && isDeadLend("ssh-key", repo.sshKeyId)) {
        envResets.push({
          envId,
          field: "repositories.sshKeyId",
          repoIndex,
          repoUrl: repo.url || null,
          from: repo.sshKeyId,
        });
      }
    });
  }

  for (const entry of Array.isArray(agents) ? agents : []) {
    const agentId = entry && entry.id;
    const cfg = entry && entry.cfg;
    if (!agentId || !cfg || typeof cfg !== "object") continue;
    if (isDeadLend("provider", cfg.llmEndpointOverride)) {
      agentResets.push({ agentId, field: "llmEndpointOverride", from: cfg.llmEndpointOverride });
    }
  }

  const affectedEnvIds = [...new Set(envResets.map((r) => r.envId))];
  const affectedAgentIds = [...new Set(agentResets.map((r) => r.agentId))];
  return { envResets, agentResets, affectedEnvIds, affectedAgentIds };
}

// Build a `personalOwnerOf(kind, id)` from the three already-loaded resource
// indexes. A resource is a lend candidate only when `scope === 'personal'` and
// it carries a `userId`; every other tier returns null (never swept). Kept here
// (not in the planner) so the planner takes no shape assumptions about the
// stores. `providerIndex` entries are LLM endpoints; the token/key indexes are
// the credential stores.
function buildPersonalOwnerLookup({ providerIndex = [], githubTokenIndex = [], sshKeyIndex = [] } = {}) {
  const byKind = {
    provider: indexPersonalOwners(providerIndex),
    "github-token": indexPersonalOwners(githubTokenIndex),
    "ssh-key": indexPersonalOwners(sshKeyIndex),
  };
  return (kind, id) => {
    if (!id) return null;
    const map = byKind[kind];
    return map ? (map.get(String(id)) || null) : null;
  };
}

function indexPersonalOwners(index) {
  const map = new Map();
  for (const e of Array.isArray(index) ? index : []) {
    if (e && e.id && e.scope === "personal" && e.userId) {
      map.set(String(e.id), String(e.userId));
    }
  }
  return map;
}

module.exports = {
  planMembershipRemovalSweep,
  buildPersonalOwnerLookup,
  indexPersonalOwners,
};
