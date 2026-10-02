import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OWN_TEAM_OPTION_LABEL, importConflictSeed, importSuccessNotice } from './import-agent-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const forms = fs.readFileSync(path.join(here, 'AgentLifecycleForms.jsx'), 'utf8');
const host = fs.readFileSync(path.join(here, '..', 'agent-chat', 'RailLifecycleHost.jsx'), 'utf8');

// ── importConflictSeed (#2684 AC3) ──────────────────────────────────────────

test('on a conflict the server-suggested free id is seeded, not a blind `<id>-2`', () => {
  const seed = importConflictSeed({ agentId: 'solo', suggestedId: 'solo-3', displayName: 'Solo' }, '', '');
  assert.equal(seed.newId, 'solo-3');
});

test('an older server without a suggestion still gets the `<id>-2` fallback', () => {
  assert.equal(importConflictSeed({ agentId: 'solo' }, '', '').newId, 'solo-2');
});

test('what the user already typed is never overwritten', () => {
  const seed = importConflictSeed({ agentId: 'solo', suggestedId: 'solo-3', displayName: 'Solo' }, 'mine', 'My Name');
  assert.deepEqual(seed, { newId: 'mine', displayName: 'My Name' });
});

test('the name is seeded distinguishable from the source, like Clone does', () => {
  assert.equal(importConflictSeed({ agentId: 'solo', displayName: ' Solo ' }, '', '').displayName, 'Solo (Copy)');
  assert.equal(importConflictSeed({ agentId: 'solo' }, '', '').displayName, '');
});

// ── importSuccessNotice ─────────────────────────────────────────────────────

test('the success notice says a no-team import became its own team', () => {
  assert.equal(
    importSuccessNotice({ agentId: 'solo', parentTeamId: 'solo-team', teamOfOne: true }),
    "Agent 'solo' imported as its own team and started.",
  );
  assert.equal(
    importSuccessNotice({ agentId: 'solo', parentTeamId: 'alpha' }),
    "Agent 'solo' imported into team 'alpha' and started.",
  );
  assert.match(importSuccessNotice({ agentId: 'solo', warnings: ['x'] }), /Warning: x\./);
});

// ── wiring (#651: the JSX itself stays uncovered, its call sites are pinned) ─

test('neither dialog offers the invisible "Standalone agent (no team)" any more (AC1)', () => {
  assert.doesNotMatch(forms, /Standalone agent \(no team\)/);
  assert.equal((forms.match(/<option value="">\{OWN_TEAM_OPTION_LABEL\}<\/option>/g) || []).length, 2);
  assert.match(OWN_TEAM_OPTION_LABEL, /team of one/);
});

test('the import dialog copy no longer points at agent cards (AC2)', () => {
  assert.doesNotMatch(forms, /card afterwards/);
  assert.doesNotMatch(forms, /from its card/);
});

test('the import dialog seeds id + name from the conflict and submits the name (AC3)', () => {
  assert.match(forms, /const seed = importConflictSeed\(data, newId, displayName\);/);
  assert.doesNotMatch(forms, /setNewId\(`\$\{data\.agentId\}-2`\)/);
  assert.match(forms, /displayName: \(newId\.trim\(\) && displayName\.trim\(\)\) \|\| undefined/);
  assert.match(host, /if \(displayName\) formData\.append\('displayName', displayName\);/);
  assert.match(host, /setNotice\(importSuccessNotice\(data\) \+ \(hidden \|\| ''\)\);/);
});

test('the clone dialog prefers the server-suggested free id on a conflict', () => {
  assert.match(forms, /setNewId\(data\.suggestedId \|\| suggestCloneId\(trimmedId, existingIds\)\)/);
});
