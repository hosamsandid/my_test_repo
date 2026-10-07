// Run: node --test admin-console/src/pages/provider-deleted-team-label.test.js
//
// #2691 AC2 — wiring guard for the Models page's team labels (JSX stays
// uncovered per #651; the label rule itself is tested in
// provider-ownership-view.test.js). The edit dialog used to render any team id
// outside the caller's selectable list as "<id> (legacy)", which made a deleted
// team look like an old-style one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OWNERSHIP = readFileSync(join(here, '../components/ProviderOwnership.jsx'), 'utf8');
const REGISTRY = readFileSync(join(here, 'ModelRegistry.jsx'), 'utf8');

test('ProviderOwnership labels set members through providerTeamName, never "(legacy)"', () => {
  assert.doesNotMatch(OWNERSHIP, /\(legacy\)/);
  assert.match(OWNERSHIP, /providerTeamName\(id, names, deletedTeamIds\)/);
});

test('ModelRegistry passes every known team name and the server-flagged deleted ids to the dialog', () => {
  assert.match(REGISTRY, /<ProviderOwnership[\s\S]*?names=\{names\}[\s\S]*?deletedTeamIds=\{endpoint\?\.deletedTeamIds\}/);
  const forms = REGISTRY.match(/<EndpointForm[\s\S]*?\/>/g) || [];
  assert.equal(forms.length, 2);
  for (const f of forms) assert.match(f, /names=\{names\}/);
});
