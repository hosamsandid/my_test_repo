"use strict";

// Agent → human tenant resolution.
//
// An agent's `teamId` names its human **Team** — the tenant every ownership and
// credential-scoping decision is keyed on. A `team-member` also carries
// `parentTeamId`, which is the id of its **Agent Team** construct (a
// `role: "team"` agent). Those are two different namespaces (see CLAUDE.md
// "Teams"), and reading `parentTeamId` as a tenant only appears to work while an
// Agent Team happens to share its id with a human Team; otherwise it names a
// team that does not exist and every team-scoped lookup fails closed on an
// empty result.
//
// Per docs/teams-data-model.md a team-member inherits its parent Agent Team's
// `teamId`, so resolve the parent and read *its* tenant — one hop, since a team
// agent never carries a `parentTeamId` of its own. Falls back to the member's
// own stamp when the parent is missing or unstamped.
//
// Pure: `loadAgentConfig(id) -> config | null` is injected. Mirrored by
// resolveAgentTenant in admin-console/api/scope.js (separate images, so the
// logic is duplicated rather than shared).
//
// NOTE — this is deliberately NOT used for the usage/PR-event records, which
// group by Agent Team on purpose (metrics are per squad, not per tenant).

const DEFAULT_TEAM_ID = "default";

function resolveAgentTenant(cfg, loadAgentConfig) {
  const parentId = cfg && cfg.parentTeamId;
  if (parentId && typeof loadAgentConfig === "function") {
    const parent = loadAgentConfig(parentId);
    if (parent && parent.teamId) return parent.teamId;
  }
  return (cfg && cfg.teamId) || DEFAULT_TEAM_ID;
}

// Which team-members disagree with their parent Agent Team's tenant? Returns
// `[{ id, from, to }]` — the plan the startup backfill applies so the on-disk
// `teamId` matches what resolveAgentTenant already reports. Agents without a
// parent, with an unstamped/unknown parent, or already in sync are omitted.
function planTenantBackfill(configsById) {
  const map = configsById && typeof configsById === "object" ? configsById : {};
  const plan = [];
  for (const [id, cfg] of Object.entries(map)) {
    if (!cfg || cfg.role !== "team-member" || !cfg.parentTeamId) continue;
    const parent = map[cfg.parentTeamId];
    if (!parent || !parent.teamId) continue;
    const own = cfg.teamId || DEFAULT_TEAM_ID;
    if (own === parent.teamId) continue;
    plan.push({ id, from: cfg.teamId === undefined ? null : cfg.teamId, to: parent.teamId });
  }
  return plan;
}

module.exports = { resolveAgentTenant, planTenantBackfill, DEFAULT_TEAM_ID };
