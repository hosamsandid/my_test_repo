// Knowledge-page step library (#668, docs/journey-spec-concept.md §2.2).
//
// Covers F4 — activating a global skill on a team from the Knowledge page
// (/knowledge) and asserting per-member activation state, not just the team-
// level toggle (docs/e2e-testing-concept.md §2 F4). Activation is a synchronous
// additive file sync (orchestrator setTeamSkillActive → per-member workspace
// copy), so a materialised member flips straight to `active` — no respawn, no
// async settle to sleep on.
//
// The e2e global skill pool is empty by default (seed-skills only copies the
// external ACE `engineering` skill, absent in CI), so the test seeds its own
// global skill via the API first, then activates it through the UI.
//
// No data-testids exist — selectors verified against KnowledgeFlow.jsx
// (TeamSelector #kf-team-select, GlobalSkillPicker, SkillCard, MEMBER_STATE_CHIPS).
const { expect } = require('@playwright/test');

// Seed a global-pool skill (API fixture). Returns the created name.
async function createGlobalSkill(ctx, { name }) {
  const res = await ctx.request.post('/api/skills', {
    data: { name, content: `---\nname: ${name}\ndescription: e2e fixture skill (#668)\n---\n# ${name}\n` },
  });
  expect(
    res.ok(),
    `createGlobalSkill(${name}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  expect(body.source, 'skill created in the global pool').toBe('pool');
  return name;
}

// Idempotent teardown — delete the pool skill once the team (and its grant) is
// gone. Best-effort: a lingering reference (409) or an already-removed skill
// (404) must not fail the spec's cleanup.
async function deleteGlobalSkill(ctx, { name }) {
  await ctx.request.delete(`/api/skills/${encodeURIComponent(name)}`);
}

// Open the Knowledge page scoped to a team. The deep-link param preselects the
// team once the agent list loads; we also drive the select explicitly so the
// step is robust regardless of load ordering.
async function openTeam(ctx, { teamId }) {
  const { page } = ctx;
  await page.goto(`/knowledge?team=${encodeURIComponent(teamId)}`);
  const select = page.locator('#kf-team-select');
  await expect(select).toBeVisible();
  await select.selectOption(teamId);
  await expect(select).toHaveValue(teamId);
  // The "Add global skill…" picker anchors the Skills section — its presence
  // confirms the team graph has loaded.
  await expect(page.getByRole('button', { name: /Add global skill/ })).toBeVisible();
}

// Activate a global skill onto the selected team via the picker. The candidate
// row is a flex div holding the skill-name span + its Activate button; scope to
// the row by the (unique) skill name.
async function activateGlobalSkill(ctx, { skillName }) {
  const { page } = ctx;
  await page.getByRole('button', { name: /Add global skill/ }).click();
  const row = page.getByText(skillName, { exact: true }).locator('..');
  await expect(row.getByRole('button', { name: 'Activate' })).toBeVisible();
  await row.getByRole('button', { name: 'Activate' }).click();
}

// Assert member-level activation state through the UI: the node badge shows
// every member active (`active · n/n`), and expanding it reveals one `✓ active`
// chip per member — proving activation reached each workspace, not just that the
// team toggle flipped.
async function expectAllMembersActive(ctx, { memberCount }) {
  const { page } = ctx;
  const badge = page.getByText(new RegExp(`^active · ${memberCount}/${memberCount}$`));
  await expect(badge).toBeVisible();
  await badge.click(); // expand the per-member list
  await expect(page.getByText('✓ active', { exact: true })).toHaveCount(memberCount);
}

// API cross-check: the graph overlay is the source of truth for per-member
// activation state. Returns the skill node's `activation` block.
async function getActivation(ctx, { teamId, skillName }) {
  const res = await ctx.request.get(`/api/knowledge/graph?scope=team:${encodeURIComponent(teamId)}`);
  expect(res.ok(), `graph read expected 2xx, got HTTP ${res.status()}`).toBeTruthy();
  const graph = await res.json();
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const node = nodes.find((n) => n.kind === 'skill' && n.label === skillName);
  expect(node, `skill node '${skillName}' present in team graph`).toBeTruthy();
  return node.activation || null;
}

module.exports = {
  createGlobalSkill,
  deleteGlobalSkill,
  openTeam,
  activateGlobalSkill,
  expectAllMembersActive,
  getActivation,
};
