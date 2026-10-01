import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for the Token Usage page-level Team filter (#2694,
// #651). The option list itself is unit-tested in token-usage-view.test.js
// (agentTeamFilterOptions); what cannot be tested there is that TokenUsage.jsx
// sources the select from Agent Teams. The failure is silent: pointing it back
// at the legacy access-scope collection offers only "Default Team", which never
// matches a usage record's teamId and always narrows to 0, while the real Agent
// Teams become unselectable.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'TokenUsage.jsx'), 'utf8');

const CHECKS = {
  // The options come from the agent list, through the pure helper.
  'team-options-sourced-from-agent-teams'(src) {
    return /useApi\('\/api\/agents'\)/.test(src)
      && /agentTeamFilterOptions\(agentsData\)/.test(src)
      && /<TeamFilter teams=\{teams\}/.test(src);
  },
  // The legacy human access-scope team collection is not fetched at all.
  'legacy-team-collection-not-fetched'(src) {
    return !/useApi\(\s*'\/api\/admin\/teams'/.test(src);
  },
  // Options render the helper's name + id label, not a bare `name`.
  'option-renders-name-and-id-label'(src) {
    return /<option key=\{t\.id\} value=\{t\.id\}>\{t\.label\}<\/option>/.test(src);
  },
};

function runCheck(src) {
  for (const [name, fn] of Object.entries(CHECKS)) {
    let ok = false;
    try { ok = fn(src); } catch { return name; }
    if (!ok) return name;
  }
  return null;
}

test('#2694: the Token Usage Team filter is sourced from Agent Teams', () => {
  assert.equal(runCheck(SRC), null);
});

const MUTATIONS = [
  ['team-options-sourced-from-agent-teams',
    'agentTeamFilterOptions(agentsData)', '(Array.isArray(agentsData) ? agentsData : [])'],
  ['legacy-team-collection-not-fetched',
    "  const teams = useMemo(", "  useApi('/api/admin/teams');\n  const teams = useMemo("],
  ['option-renders-name-and-id-label',
    '{t.label}</option>', '{t.name || t.id}</option>'],
];

test('#2694: every wiring check is proven by a mutation that makes exactly it fire', () => {
  const fired = new Set();
  for (const [expected, find, replace] of MUTATIONS) {
    const hits = SRC.split(find).length - 1;
    assert.equal(hits, 1, `mutation anchor for ${expected} matches ${hits}x (must be exactly 1): ${find.slice(0, 60)}`);
    const mutated = SRC.replace(find, replace);
    assert.notEqual(mutated, SRC, `mutation for ${expected} did not change the source`);
    assert.equal(runCheck(mutated), expected, `mutation for ${expected} fired the wrong check`);
    fired.add(expected);
  }
  assert.deepEqual([...Object.keys(CHECKS)].filter((k) => !fired.has(k)), []);
});
