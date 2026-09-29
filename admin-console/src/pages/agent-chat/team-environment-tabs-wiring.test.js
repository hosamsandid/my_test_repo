// Source-reading drift guard (#651) for #2167 — the team Settings tab gains
// grouped tabs for the fields an environment holds today (repositories,
// model provider, toolchain, MCP servers, additional context), reusing the
// SAME field components the Working Environments form uses rather than a
// second, forkable copy.
//
// What this protects:
//
//  1. Both surfaces render the console's ONE shared RepositoryCard (#2067) —
//     never a re-implementation.
//  2. Both surfaces derive the MCP row / toolchain-select / submit-gate
//     decisions from the SAME pure modules — a fork here would let the two
//     forms silently disagree about what an empty row does, or what a
//     toolchain/provider change does to running agents.
//  3. The team surface renders NO ownership/team picker — the environment
//     already belongs to this team, and editing its content is not a re-tier
//     (#2083's own rule).
//  4. The team surface saves through `PUT /api/environments/:id`, never
//     through the agent's own `PUT /api/agents/:id` (whose body whitelist
//     carries no environment field at all).
//  5. AgentEditForm only renders it for a `role: 'team'` agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const panel = () => stripComments(read('TeamEnvironmentPanel.jsx'));
const envPage = () => stripComments(read('../EnvironmentTemplates.jsx'));
const editForm = () => stripComments(read('../agent-lifecycle/AgentEditForm.jsx'));

test('the team panel and the Working Environments form render the same shared RepositoryCard', () => {
  assert.match(panel(), /import RepositoryCard from '\.\.\/\.\.\/components\/RepositoryCard'/);
  assert.match(panel(), /<RepositoryCard\b/);
  assert.doesNotMatch(panel(), /function RepositoryCard\(/, 'must not re-implement the card');

  assert.match(envPage(), /import RepositoryCard from '\.\.\/components\/RepositoryCard'/);
  assert.match(envPage(), /<RepositoryCard\b/);
});

test('the team panel reuses the same pure decision modules the Working Environments form uses', () => {
  const src = panel();
  // Same modules, same exports — a fork of any one of these is exactly the
  // drift the shared-field-component discipline (#1928/#1929) exists to
  // prevent.
  assert.match(src, /from '\.\.\/toolchain-select-view\.js'/);
  assert.match(src, /toolchainOptions/);
  assert.match(src, /toolchainChangeWarning/);
  assert.match(src, /from '\.\.\/working-env-mcp-view\.js'/);
  assert.match(src, /mcpChangeNotice/);
  assert.match(src, /mcpApplySummary\(saved\?\.mcpApply\)/, 'the per-agent apply report is shown after a save (#2289)');
  // The rows themselves are the one shared picker (#2289), which carries the
  // per-row hint — the same control a team-member's own MCP set renders.
  assert.match(src, /import McpServerRows from '\.\.\/\.\.\/components\/McpServerRows'/);
  assert.match(src, /<McpServerRows\b/);
  assert.match(read('../../components/McpServerRows.jsx'), /mcpRowHint\(/);
  assert.match(src, /from '\.\.\/working-env-repo-diff\.js'/);
  assert.match(src, /classifyRepositoryChanges/);
  assert.match(src, /from '\.\.\/working-env-submit-state\.js'/);
  assert.match(src, /describeWorkingEnvSubmitState/);
});

test('the team panel renders no ownership/team picker', () => {
  const src = panel();
  assert.doesNotMatch(src, /CredentialOwnership/, 'the environment already belongs to this team — this is not a re-tier surface');
  assert.doesNotMatch(src, /ownershipPayload/);
  assert.doesNotMatch(src, /teamId/, 'no team-assignment field belongs on this surface');
});

test('the team panel saves through PUT /api/environments/:id, not the agent route', () => {
  const src = panel();
  assert.match(src, /apiCall\('PUT', `\/api\/environments\/\$\{encodeURIComponent\(baseline\.id\)\}`/);
  assert.doesNotMatch(src, /\/api\/agents\/\$\{[^}]+\}`,\s*body/, 'must not batch environment fields into the agent PUT');
});

test('AgentEditForm renders the team environment panel only for a team agent, on its own flat tab', () => {
  const src = editForm();
  assert.match(src, /import TeamEnvironmentPanel from '\.\.\/agent-chat\/TeamEnvironmentPanel'/);
  // #2236: the old boxed "Environment" section is gone — the panel is one of
  // the flat row's own tabs, gated on the tab id rather than wrapped in a
  // labelled box.
  assert.doesNotMatch(src, /<div style=\{labelStyle\}>Environment<\/div>/, 'the boxed Environment label must be gone (#2236)');
  assert.match(src, /isTeam && ENV_TAB_IDS\.has\(activeTab\) && \(\s*<TeamEnvironmentPanel agent=\{agent\} tab=\{activeTab\} \/>/);
});

test('the five field groups the issue names are all present as tabs', () => {
  const view = stripComments(read('team-environment-view.js'));
  for (const label of ['Repositories', 'Model provider', 'Toolchain', 'MCP servers', 'Additional context']) {
    assert.ok(view.includes(`label: '${label}'`), `missing tab: ${label}`);
  }
});
