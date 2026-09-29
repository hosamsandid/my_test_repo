'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  planMerge,
  requiredPermission,
  permitMerge,
  sourceNames,
  buildMergedFrom,
  planGrantMigration,
  isCarriedFile,
  planFileMerge,
  mergeProvenance,
  refKey,
} = require('./skill-merge');

// A pair of valid team sources + a team target, reused across planMerge tests.
function twoTeamSources() {
  return [
    { tier: 'team', teamId: 'squad-a', name: 'jcl-tips' },
    { tier: 'team', teamId: 'squad-a', name: 'jcl-conversion' },
  ];
}

// ---------------------------------------------------------------------------
// planMerge — validation
// ---------------------------------------------------------------------------

test('planMerge: rejects fewer than two sources', () => {
  const r = planMerge({ sources: [{ tier: 'team', teamId: 'squad-a', name: 'x' }], target: { tier: 'team', teamId: 'squad-a', name: 't' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /at least two sources/);
});

test('planMerge: a single-source fold into a different target is allowed only with fold:true (#2592)', () => {
  const src = { tier: 'team', teamId: 'squad-a', name: 'x' };
  const ok = planMerge({ sources: [src], target: { tier: 'team', teamId: 'squad-a', name: 't' }, fold: true });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.sources.length, 1);
  const self = planMerge({ sources: [src], target: { tier: 'team', teamId: 'squad-a', name: 'x' }, fold: true });
  assert.strictEqual(self.ok, false);
  assert.match(self.error, /different from its source/);
  const none = planMerge({ sources: [], target: { tier: 'team', teamId: 'squad-a', name: 't' }, fold: true });
  assert.strictEqual(none.ok, false);
});

test('planMerge: rejects a bad source tier', () => {
  const r = planMerge({
    sources: [{ tier: 'nope', name: 'x' }, { tier: 'global', name: 'y' }],
    target: { tier: 'team', teamId: 'squad-a', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /source 0: tier must be one of/);
});

test('planMerge: rejects an invalid source skill name', () => {
  const r = planMerge({
    sources: [{ tier: 'global', name: 'bad name!' }, { tier: 'global', name: 'ok' }],
    target: { tier: 'global', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /source 0: invalid skill name/);
});

test('planMerge: team source requires a teamId', () => {
  const r = planMerge({
    sources: [{ tier: 'team', name: 'x' }, { tier: 'global', name: 'y' }],
    target: { tier: 'global', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /source 0: teamId required/);
});

test('planMerge: agent source requires an agentId', () => {
  const r = planMerge({
    sources: [{ tier: 'agent', name: 'x' }, { tier: 'global', name: 'y' }],
    target: { tier: 'global', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /source 0: agentId required/);
});

test('planMerge: rejects two sources that resolve to the same skill', () => {
  const r = planMerge({
    sources: [
      { tier: 'team', teamId: 'squad-a', name: 'dup' },
      { tier: 'team', teamId: 'squad-a', name: 'dup' },
    ],
    target: { tier: 'team', teamId: 'squad-a', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /duplicate source: dup/);
});

test('planMerge: same skill name under different owners is NOT a duplicate', () => {
  const r = planMerge({
    sources: [
      { tier: 'team', teamId: 'squad-a', name: 'same' },
      { tier: 'team', teamId: 'squad-b', name: 'same' },
    ],
    target: { tier: 'global', name: 't' },
  });
  assert.strictEqual(r.ok, true);
});

test('planMerge: rejects an agent-tier target', () => {
  const r = planMerge({
    sources: twoTeamSources(),
    target: { tier: 'agent', agentId: 'a', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /target tier must be one of/);
});

test('planMerge: team target requires a teamId', () => {
  const r = planMerge({
    sources: twoTeamSources(),
    target: { tier: 'team', name: 't' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /teamId required for a team target/);
});

test('planMerge: rejects an invalid target skill name', () => {
  const r = planMerge({
    sources: twoTeamSources(),
    target: { tier: 'global', name: 'bad name!' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /invalid target skill name/);
});

// ---------------------------------------------------------------------------
// planMerge — draft gating + retireSources default + trimming
// ---------------------------------------------------------------------------

test('planMerge: draft is optional for the preview (requireDraft false)', () => {
  const r = planMerge({ sources: twoTeamSources(), target: { tier: 'global', name: 't' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.draft, '');
});

test('planMerge: committing merge requires a non-empty draft', () => {
  const r = planMerge(
    { sources: twoTeamSources(), target: { tier: 'global', name: 't' }, draft: '   ' },
    { requireDraft: true },
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /draft must be non-empty/);
});

test('planMerge: committing merge accepts a non-empty draft', () => {
  const r = planMerge(
    { sources: twoTeamSources(), target: { tier: 'global', name: 't' }, draft: '# Merged' },
    { requireDraft: true },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.draft, '# Merged');
});

test('planMerge: retireSources defaults ON', () => {
  const r = planMerge({ sources: twoTeamSources(), target: { tier: 'global', name: 't' } });
  assert.strictEqual(r.retireSources, true);
});

test('planMerge: retireSources honours explicit false + the "false" string', () => {
  const r1 = planMerge({ sources: twoTeamSources(), target: { tier: 'global', name: 't' }, retireSources: false });
  assert.strictEqual(r1.retireSources, false);
  const r2 = planMerge({ sources: twoTeamSources(), target: { tier: 'global', name: 't' }, retireSources: 'false' });
  assert.strictEqual(r2.retireSources, false);
  const r3 = planMerge({ sources: twoTeamSources(), target: { tier: 'global', name: 't' }, retireSources: 'true' });
  assert.strictEqual(r3.retireSources, true);
});

test('planMerge: trims whitespace from tiers/names/ids', () => {
  const r = planMerge({
    sources: [
      { tier: ' team ', teamId: ' squad-a ', name: ' jcl-tips ' },
      { tier: ' global ', name: ' jcl-conv ' },
    ],
    target: { tier: ' team ', teamId: ' squad-a ', name: ' merged ' },
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.sources[0], { tier: 'team', teamId: 'squad-a', name: 'jcl-tips' });
  assert.deepStrictEqual(r.sources[1], { tier: 'global', name: 'jcl-conv' });
  assert.deepStrictEqual(r.target, { tier: 'team', teamId: 'squad-a', name: 'merged' });
});

test('planMerge: cross-tier merge is allowed, permission is target-tier', () => {
  const r = planMerge({
    sources: [
      { tier: 'agent', agentId: 'cobol-agent', name: 's1' },
      { tier: 'global', name: 's2' },
    ],
    target: { tier: 'team', teamId: 'squad-a', name: 'merged' },
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.permission, { needsSystemAdmin: false, teamAdminOf: ['squad-a'] });
});

// ---------------------------------------------------------------------------
// requiredPermission + permitMerge
// ---------------------------------------------------------------------------

test('requiredPermission: team target needs Team Admin of that team; global needs System Admin OR Team Admin of ANY team (#2307, not System-Admin-only)', () => {
  assert.deepStrictEqual(requiredPermission({ tier: 'team', teamId: 'squad-a' }), { needsSystemAdmin: false, teamAdminOf: ['squad-a'] });
  assert.deepStrictEqual(requiredPermission({ tier: 'global' }), { needsSystemAdmin: false, teamAdminOf: [], anyTeamAdmin: true });
});

test('permitMerge: System Admin passes everything', () => {
  assert.deepStrictEqual(permitMerge({ needsSystemAdmin: true, teamAdminOf: ['x'] }, { systemAdmin: true }), { ok: true });
});

test('permitMerge: a global target is refused for a caller who is Team Admin of no team', () => {
  const r = permitMerge({ needsSystemAdmin: false, teamAdminOf: [], anyTeamAdmin: true }, { systemAdmin: false, isTeamAdminOfAny: () => false });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /System Admin or Team Admin/);
});

test('permitMerge: a global target passes for a caller who is Team Admin of at least one team (#2307 AC4)', () => {
  const r = permitMerge({ needsSystemAdmin: false, teamAdminOf: [], anyTeamAdmin: true }, { systemAdmin: false, isTeamAdminOfAny: () => true });
  assert.deepStrictEqual(r, { ok: true });
});

test('permitMerge: team target passes with matching Team Admin', () => {
  const r = permitMerge(
    { needsSystemAdmin: false, teamAdminOf: ['squad-a'] },
    { systemAdmin: false, isTeamAdmin: (t) => t === 'squad-a' },
  );
  assert.deepStrictEqual(r, { ok: true });
});

test('permitMerge: team target refused for the wrong team', () => {
  const r = permitMerge(
    { needsSystemAdmin: false, teamAdminOf: ['squad-a'] },
    { systemAdmin: false, isTeamAdmin: (t) => t === 'squad-b' },
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Team Admin of 'squad-a'/);
});

// ---------------------------------------------------------------------------
// refKey + sourceNames + buildMergedFrom
// ---------------------------------------------------------------------------

test('refKey: distinguishes tier/owner/name', () => {
  assert.strictEqual(refKey({ tier: 'team', teamId: 'a', name: 'x' }), 'team:a:x');
  assert.strictEqual(refKey({ tier: 'agent', agentId: 'b', name: 'x' }), 'agent:b:x');
  assert.strictEqual(refKey({ tier: 'global', name: 'x' }), 'global:x');
});

test('sourceNames: unique names only', () => {
  assert.deepStrictEqual(
    sourceNames([
      { tier: 'team', teamId: 'a', name: 'x' },
      { tier: 'global', name: 'x' },
      { tier: 'global', name: 'y' },
    ]),
    ['x', 'y'],
  );
});

test('buildMergedFrom: records tier/owner + hash (null when missing)', () => {
  const sources = [
    { tier: 'team', teamId: 'squad-a', name: 'jcl-tips' },
    { tier: 'agent', agentId: 'cobol-agent', name: 'jcl-conv' },
    { tier: 'global', name: 'jcl-misc' },
  ];
  const hashOf = (s) => (s.name === 'jcl-tips' ? 'abc123' : null);
  const out = buildMergedFrom(sources, hashOf);
  assert.deepStrictEqual(out, [
    { name: 'jcl-tips', tier: 'team', teamId: 'squad-a', hash: 'abc123' },
    { name: 'jcl-conv', tier: 'agent', agentId: 'cobol-agent', hash: null },
    { name: 'jcl-misc', tier: 'global', hash: null },
  ]);
});

// ---------------------------------------------------------------------------
// planGrantMigration
// ---------------------------------------------------------------------------

test('planGrantMigration: team construct routed to teams; others to agents', () => {
  const constructs = [
    { id: 'squad-a', role: 'team', skills: ['jcl-tips', 'unrelated'] },
    { id: 'solo', role: 'agent', skills: ['jcl-conversion'] },
  ];
  const plan = planGrantMigration(constructs, {
    sources: [
      { tier: 'team', teamId: 'squad-a', name: 'jcl-tips' },
      { tier: 'team', teamId: 'squad-a', name: 'jcl-conversion' },
    ],
    target: { tier: 'team', teamId: 'squad-a', name: 'jcl-all' },
  });
  assert.deepStrictEqual(plan.teams, [{ id: 'squad-a', removes: ['jcl-tips'], addTarget: true }]);
  assert.deepStrictEqual(plan.agents, [{ id: 'solo', removes: ['jcl-conversion'], addTarget: true }]);
});

test('planGrantMigration: inheriting team-member (no own list) is skipped', () => {
  const constructs = [
    { id: 'squad-a', role: 'team', skills: ['jcl-tips'] },
    { id: 'squad-a-dev', role: 'team-member', parentTeamId: 'squad-a' }, // inherits, no own list
  ];
  const plan = planGrantMigration(constructs, {
    sources: [
      { tier: 'team', teamId: 'squad-a', name: 'jcl-tips' },
      { tier: 'global', name: 'jcl-conversion' },
    ],
    target: { tier: 'team', teamId: 'squad-a', name: 'jcl-all' },
  });
  assert.deepStrictEqual(plan.teams, [{ id: 'squad-a', removes: ['jcl-tips'], addTarget: true }]);
  assert.deepStrictEqual(plan.agents, []);
});

test('planGrantMigration: override member routed via agents on its skillsOverride', () => {
  const constructs = [
    { id: 'squad-a-dev', role: 'team-member', skillsOverride: ['jcl-tips', 'keep'] },
  ];
  const plan = planGrantMigration(constructs, {
    sources: [
      { tier: 'team', teamId: 'squad-a', name: 'jcl-tips' },
      { tier: 'global', name: 'jcl-conversion' },
    ],
    target: { tier: 'team', teamId: 'squad-a', name: 'jcl-all' },
  });
  assert.deepStrictEqual(plan.agents, [{ id: 'squad-a-dev', removes: ['jcl-tips'], addTarget: true }]);
  assert.deepStrictEqual(plan.teams, []);
});

test('planGrantMigration: removes only the granted subset; addTarget false when already present', () => {
  const constructs = [
    { id: 'solo', role: 'agent', skills: ['jcl-tips', 'jcl-all', 'other'] },
  ];
  const plan = planGrantMigration(constructs, {
    sources: [
      { tier: 'global', name: 'jcl-tips' },
      { tier: 'global', name: 'jcl-conversion' }, // not granted by solo
    ],
    target: { tier: 'global', name: 'jcl-all' }, // already granted
  });
  assert.deepStrictEqual(plan.agents, [{ id: 'solo', removes: ['jcl-tips'], addTarget: false }]);
});

test('planGrantMigration: constructs granting no source produce no step', () => {
  const plan = planGrantMigration(
    [{ id: 'solo', role: 'agent', skills: ['unrelated'] }],
    { sources: [{ tier: 'global', name: 'a' }, { tier: 'global', name: 'b' }], target: { tier: 'global', name: 't' } },
  );
  assert.deepStrictEqual(plan, { teams: [], agents: [] });
});

test('AC3 (#781 consolidation): grant swap is ATOMIC — target added before members removed', () => {
  // The consolidation migration accepts a domain playbook by merging N micro-skills
  // into a domain-named target with retireSources. The grant swap is achieved by
  // add-before-remove ordering: planGrantMigration carries BOTH addTarget:true and the
  // removed member names for the team that granted them, and migrateGrantsForMerge (in
  // api.js) activates the target FIRST, then deactivates each source — so no member
  // ever loses skill access in the gap.
  const teamCfg = {
    id: 'agent-studio', role: 'team',
    skills: ['dev-workflow-branching', 'commit-conventions-dev', 'unrelated'],
  };
  const merge = {
    sources: [
      { tier: 'team', teamId: 'agent-studio', name: 'dev-workflow-branching' },
      { tier: 'team', teamId: 'agent-studio', name: 'commit-conventions-dev' },
    ],
    target: { tier: 'team', teamId: 'agent-studio', name: 'dev-workflow' },
    retireSources: true,
  };
  const plan = planGrantMigration([teamCfg], merge);
  assert.equal(plan.teams.length, 1);
  const step = plan.teams[0];
  assert.equal(step.id, 'agent-studio');
  assert.equal(step.addTarget, true, 'target grant added');
  assert.deepStrictEqual(step.removes.sort(), ['commit-conventions-dev', 'dev-workflow-branching'], 'only member grants removed');
  // Coverage invariant across the whole swap. Apply add-before-remove and check the
  // intermediate set (after add, before any remove) plus the final set both cover the
  // domain skill; the unrelated grant is preserved throughout.
  let grants = new Set(teamCfg.skills);
  if (step.addTarget) grants.add(merge.target.name);
  assert.ok(grants.has('dev-workflow'), 'target present immediately after add');
  for (const name of step.removes) {
    grants.delete(name);
    assert.ok(grants.has('dev-workflow'), `domain skill still granted while removing ${name}`);
  }
  assert.deepStrictEqual([...grants].sort(), ['dev-workflow', 'unrelated']);
});

// ---------------------------------------------------------------------------
// isCarriedFile
// ---------------------------------------------------------------------------

test('isCarriedFile: excludes regenerated sidecars at top level', () => {
  assert.strictEqual(isCarriedFile('SKILL.md'), false);
  assert.strictEqual(isCarriedFile('skill.json'), false);
  assert.strictEqual(isCarriedFile('provenance.json'), false);
});

test('isCarriedFile: nested file named like a sidecar IS content', () => {
  assert.strictEqual(isCarriedFile('reference/SKILL.md'), true);
  assert.strictEqual(isCarriedFile('files/skill.json'), true);
});

test('isCarriedFile: excludes _archive dirs and traversal', () => {
  assert.strictEqual(isCarriedFile('_archive/old/SKILL.md'), false);
  assert.strictEqual(isCarriedFile('../escape.txt'), false);
  assert.strictEqual(isCarriedFile(''), false);
});

test('isCarriedFile: carries ordinary extra files', () => {
  assert.strictEqual(isCarriedFile('reference.md'), true);
  assert.strictEqual(isCarriedFile('scripts/run.sh'), true);
});

// ---------------------------------------------------------------------------
// planFileMerge
// ---------------------------------------------------------------------------

test('planFileMerge: a path in one source only stays at its original location', () => {
  const { copies, collisions } = planFileMerge([
    { name: 'jcl-tips', files: ['reference.md', 'SKILL.md'] },
    { name: 'jcl-conv', files: ['guide.md'] },
  ]);
  assert.deepStrictEqual(collisions, []);
  assert.deepStrictEqual(copies.sort((a, b) => a.to.localeCompare(b.to)), [
    { sourceName: 'jcl-tips', from: 'reference.md', to: 'reference.md' },
    { sourceName: 'jcl-conv', from: 'guide.md', to: 'guide.md' },
  ].sort((a, b) => a.to.localeCompare(b.to)));
});

test('planFileMerge: a path in >1 source is namespaced for EVERY copy', () => {
  const { copies, collisions } = planFileMerge([
    { name: 'jcl-tips', files: ['notes.md'] },
    { name: 'jcl-conv', files: ['notes.md'] },
  ]);
  assert.deepStrictEqual(collisions, ['notes.md']);
  const byName = Object.fromEntries(copies.map((c) => [c.sourceName, c.to]));
  assert.strictEqual(byName['jcl-tips'], 'files/jcl-tips/notes.md');
  assert.strictEqual(byName['jcl-conv'], 'files/jcl-conv/notes.md');
});

test('planFileMerge: sidecars are excluded, mixed collision + unique handled', () => {
  const { copies, collisions } = planFileMerge([
    { name: 'a', files: ['shared.md', 'a-only.md', 'SKILL.md', 'skill.json'] },
    { name: 'b', files: ['shared.md', 'b-only.md', 'provenance.json'] },
  ]);
  assert.deepStrictEqual(collisions, ['shared.md']);
  const tos = copies.map((c) => c.to).sort();
  assert.deepStrictEqual(tos, ['a-only.md', 'b-only.md', 'files/a/shared.md', 'files/b/shared.md']);
});

test('planFileMerge: dedups a path listed twice within one source', () => {
  const { copies } = planFileMerge([
    { name: 'a', files: ['x.md', 'x.md'] },
    { name: 'b', files: ['y.md'] },
  ]);
  assert.strictEqual(copies.filter((c) => c.sourceName === 'a').length, 1);
});

// ---------------------------------------------------------------------------
// mergeProvenance
// ---------------------------------------------------------------------------

test('mergeProvenance: unions entryIds/originAgents/sourceRefs/sessions', () => {
  const out = mergeProvenance({
    sourceProvs: [
      {
        entryIds: ['e1', 'e2'],
        originAgents: ['cobol-agent'],
        sourceRefs: [{ kind: 'session', ref: 's1' }],
        sessions: [{ agentId: 'cobol-agent', correlationId: 'c1' }],
      },
      {
        entryIds: ['e2', 'e3'],
        originAgents: ['jcl-agent'],
        sourceRefs: [{ kind: 'session', ref: 's1' }, { kind: 'pr', ref: 'p9' }],
        sessions: [{ agentId: 'jcl-agent', correlationId: 'c2' }],
      },
    ],
    target: { tier: 'team', teamId: 'squad-a', name: 'merged' },
    mergedFrom: [{ name: 'a', tier: 'global', hash: 'h1' }],
    mergedBy: 'operator:alice',
    now: '2026-07-16T00:00:00.000Z',
  });
  assert.deepStrictEqual(out.entryIds, ['e1', 'e2', 'e3']);
  assert.strictEqual(out.canonicalId, 'e1');
  assert.deepStrictEqual(out.originAgents, ['cobol-agent', 'jcl-agent']);
  assert.deepStrictEqual(out.sourceRefs, [{ kind: 'session', ref: 's1' }, { kind: 'pr', ref: 'p9' }]);
  assert.deepStrictEqual(out.sessions, [
    { agentId: 'cobol-agent', correlationId: 'c1' },
    { agentId: 'jcl-agent', correlationId: 'c2' },
  ]);
  assert.strictEqual(out.fromTier, 'merge');
  assert.strictEqual(out.toTier, 'team');
  assert.strictEqual(out.teamId, 'squad-a');
  assert.strictEqual(out.mergedBy, 'operator:alice');
  assert.strictEqual(out.mergedAt, '2026-07-16T00:00:00.000Z');
  assert.deepStrictEqual(out.mergedFrom, [{ name: 'a', tier: 'global', hash: 'h1' }]);
});

test('mergeProvenance: convergence falls back to originAgents when absent', () => {
  const out = mergeProvenance({
    sourceProvs: [{ entryIds: ['e1'], originAgents: ['a1'] }],
    target: { tier: 'global', name: 'merged' },
  });
  assert.deepStrictEqual(out.convergence, ['a1']);
});

test('mergeProvenance: tolerates null/empty source provenances', () => {
  const out = mergeProvenance({
    sourceProvs: [null, {}, undefined],
    target: { tier: 'team', teamId: 'squad-a', name: 'merged' },
  });
  assert.deepStrictEqual(out.entryIds, []);
  assert.strictEqual(out.canonicalId, null);
  assert.strictEqual(out.mergedBy, 'operator');
  assert.strictEqual(typeof out.mergedAt, 'string');
});
