import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for the Skills page "Install into agent" selector
// (#2836, #651). The grouping/sorting is unit-tested in
// skill-install-target-view.test.js; what cannot be tested there is that the
// JSX renders those groups as <optgroup>s, keeps the placeholder ungrouped and
// feeds the helper the team membership and the Scope column's name map.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'SkillsRegistry.jsx'), 'utf8');

test('install selector renders groupInstallTargets as optgroups after the ungrouped placeholder (#2836 AC1/AC5/AC8)', () => {
  const placeholder = SRC.indexOf('<option value="">Select an agent…</option>');
  const grouped = SRC.indexOf('groupInstallTargets(installableAgents, teamNames)');
  assert.ok(placeholder > 0, 'placeholder option present');
  assert.ok(grouped > placeholder, 'groups follow the placeholder');
  assert.match(SRC.slice(grouped, grouped + 600), /<optgroup key=\{g\.key\} label=\{g\.label\}>/);
  assert.match(SRC.slice(grouped, grouped + 600), /\(already installed\)/);
});

test('installable agents carry parentTeamId and the viewer gets the teamNames map (#2836 AC1/AC2)', () => {
  assert.match(SRC, /parentTeamId: a\.parentTeamId \|\| null/);
  assert.match(SRC, /teamNames=\{teamNames\}/);
  assert.match(SRC, /function SkillViewer\(\{[^}]*teamNames[^}]*\}\)/);
});
