'use strict';

// ─── Environment-wide CLAUDE.md rebuild (#2688) ──────────────────────────────
//
// An environment's `additionalContext` is written into each bound agent's
// CLAUDE.md (prompt-assembly.js). CLAUDE.md is only assembled at seed time and
// on an explicit prompt rebuild, so without a fan-out an edit to that text
// reached newly created agents only — while the console promised "every
// member". These are the pure decisions of that fan-out; the orchestrator runs
// the per-agent rebuild itself (rebuildAgentPrompt).

/**
 * Which agents an environment's prompt-relevant change reaches. Same scope as
 * the MCP fan-out (mcp-seed.planEnvironmentMcpApply): bound to the environment
 * and not the team record itself (a `role: 'team'` agent has no workspace).
 *
 *   pending — not materialized yet; its CLAUDE.md is built at its first seed
 *   rebuild — gets a rebuilt CLAUDE.md now
 *
 * @param {Array<{id: string, cfg: object|null}>} agents
 */
function planEnvironmentPromptRebuild(agents, envId) {
  const plan = [];
  for (const { id, cfg } of Array.isArray(agents) ? agents : []) {
    if (!cfg || cfg.environmentId !== envId || cfg.role === 'team') continue;
    plan.push({ id, action: cfg.token ? 'rebuild' : 'pending' });
  }
  return plan;
}

/**
 * Fold per-agent outcomes (`{ id, status: 'rebuilt'|'pending'|'failed', detail? }`)
 * into the report the API returns — every agent lands in exactly one bucket.
 */
function summarizePromptRebuild(outcomes) {
  const out = { rebuilt: [], pending: [], failed: [] };
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || !o.id) continue;
    if (o.status === 'rebuilt') out.rebuilt.push(o.id);
    else if (o.status === 'pending') out.pending.push(o.id);
    else out.failed.push({ id: o.id, error: o.detail || 'failed' });
  }
  return out;
}

module.exports = {
  planEnvironmentPromptRebuild,
  summarizePromptRebuild,
};
