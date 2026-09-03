'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyMemberResidue, decideTeamCreate } = require('./team-residue');

const TEAM = 'acme';
const memberCfg = (extra = {}) => ({ role: 'team-member', parentTeamId: TEAM, ...extra });

// ─── classifyMemberResidue ─────────────────────────────────────────────────
describe('classifyMemberResidue', () => {
  it('ignores dirs that do not exist', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: false, config: null },
    ], TEAM);
    assert.deepEqual(r, { existingMembers: [], orphanMembers: [], conflictMembers: [] });
  });

  it('classes a readable team-member of this team as existing', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: memberCfg() },
    ], TEAM);
    assert.deepEqual(r.existingMembers, ['acme-dev']);
    assert.deepEqual(r.orphanMembers, []);
    assert.deepEqual(r.conflictMembers, []);
  });

  it('classes a dir with NO readable config as an adoptable orphan (the #1525 residue)', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: null },
    ], TEAM);
    assert.deepEqual(r.orphanMembers, ['acme-dev']);
    assert.deepEqual(r.existingMembers, []);
  });

  it('classes a _provisioning stub as an adoptable orphan', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: memberCfg({ _provisioning: true }) },
    ], TEAM);
    assert.deepEqual(r.orphanMembers, ['acme-dev']);
    assert.deepEqual(r.existingMembers, []);
  });

  it('classes a non-object / malformed config as an adoptable orphan', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: 'not-json' },
    ], TEAM);
    assert.deepEqual(r.orphanMembers, ['acme-dev']);
  });

  it('classes an unrelated agent squatting the id as a conflict', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: { role: 'team' } },
    ], TEAM);
    assert.deepEqual(r.conflictMembers, [{ memberId: 'acme-dev', role: 'team' }]);
    assert.deepEqual(r.existingMembers, []);
    assert.deepEqual(r.orphanMembers, []);
  });

  // #1962 removed the BriefingPack roles but epic #1961's decision R2 leaves
  // existing configs on disk untouched, so a leftover `orchestrator` /
  // `bp-instance` can still be sitting on a member id an operator now wants for
  // a team. It must read as a CONFLICT (hands the id back to the human) and
  // never be mistaken for a reusable member of this team.
  it('classes a leftover retired-role config squatting the id as a conflict', () => {
    for (const role of ['orchestrator', 'bp-instance']) {
      const r = classifyMemberResidue([
        { memberId: 'acme-dev', exists: true, config: { role } },
      ], TEAM);
      assert.deepEqual(r.conflictMembers, [{ memberId: 'acme-dev', role }]);
      assert.deepEqual(r.existingMembers, []);
      assert.deepEqual(r.orphanMembers, []);
    }
  });

  it('classes a team-member of ANOTHER team as a conflict', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: { role: 'team-member', parentTeamId: 'other' } },
    ], TEAM);
    assert.deepEqual(r.conflictMembers, [{ memberId: 'acme-dev', role: 'team-member' }]);
    assert.deepEqual(r.existingMembers, []);
  });

  it('separates a mixed residue set', () => {
    const r = classifyMemberResidue([
      { memberId: 'acme-dev', exists: true, config: memberCfg() },
      { memberId: 'acme-rev', exists: true, config: null },
      { memberId: 'acme-qa', exists: true, config: memberCfg({ _provisioning: true }) },
      { memberId: 'acme-doc', exists: true, config: { role: 'agent' } },
      { memberId: 'acme-new', exists: false, config: null },
    ], TEAM);
    assert.deepEqual(r.existingMembers, ['acme-dev']);
    assert.deepEqual(r.orphanMembers, ['acme-rev', 'acme-qa']);
    assert.deepEqual(r.conflictMembers, [{ memberId: 'acme-doc', role: 'agent' }]);
  });
});

// ─── decideTeamCreate ───────────────────────────────────────────────────────
describe('decideTeamCreate', () => {
  const emptyResidue = { existingMembers: [], orphanMembers: [], conflictMembers: [] };

  it('surfaces a teamId held by an unrelated agent', () => {
    const d = decideTeamCreate({ mode: 'create', teamExists: false, teamIdTakenByOther: true, residue: emptyResidue });
    assert.equal(d.type, 'conflict-team');
  });

  it('surfaces a memberId held by an unrelated agent', () => {
    const d = decideTeamCreate({
      mode: 'create', teamExists: false, teamIdTakenByOther: false,
      residue: { existingMembers: [], orphanMembers: [], conflictMembers: [{ memberId: 'acme-dev', role: 'agent' }] },
    });
    assert.equal(d.type, 'conflict-members');
    assert.deepEqual(d.members, [{ memberId: 'acme-dev', role: 'agent' }]);
  });

  // The core regression: teamExists === false && a leftover member dir. Under
  // the old asymmetric check this produced a collision → extend → 409 loop.
  it('CREATE: config-less leftover (teamExists=false) now PROCEEDS and adopts the orphan — no deadlock', () => {
    const d = decideTeamCreate({
      mode: 'create', teamExists: false, teamIdTakenByOther: false,
      residue: { existingMembers: [], orphanMembers: ['acme-dev'], conflictMembers: [] },
    });
    assert.equal(d.type, 'proceed');
    assert.deepEqual(d.orphansToClean, ['acme-dev']);
  });

  it('CREATE: a real existing member is still a collision', () => {
    const d = decideTeamCreate({
      mode: 'create', teamExists: false, teamIdTakenByOther: false,
      residue: { existingMembers: ['acme-dev'], orphanMembers: [], conflictMembers: [] },
    });
    assert.equal(d.type, 'collision');
    assert.deepEqual(d.existingMembers, ['acme-dev']);
  });

  it('CREATE: an existing team is still a collision', () => {
    const d = decideTeamCreate({ mode: 'create', teamExists: true, teamIdTakenByOther: false, residue: emptyResidue });
    assert.equal(d.type, 'collision');
  });

  it('CREATE: clean slate proceeds with nothing to clean', () => {
    const d = decideTeamCreate({ mode: 'create', teamExists: false, teamIdTakenByOther: false, residue: emptyResidue });
    assert.equal(d.type, 'proceed');
    assert.deepEqual(d.orphansToClean, []);
  });

  it('EXTEND: with no team is refused (extend-missing-team) even when a leftover member dir exists', () => {
    const d = decideTeamCreate({
      mode: 'extend', teamExists: false, teamIdTakenByOther: false,
      residue: { existingMembers: [], orphanMembers: ['acme-dev'], conflictMembers: [] },
    });
    assert.equal(d.type, 'extend-missing-team');
  });

  it('EXTEND: with a real team proceeds and cleans orphan leftovers first', () => {
    const d = decideTeamCreate({
      mode: 'extend', teamExists: true, teamIdTakenByOther: false,
      residue: { existingMembers: ['acme-dev'], orphanMembers: ['acme-rev'], conflictMembers: [] },
    });
    assert.equal(d.type, 'proceed');
    assert.deepEqual(d.orphansToClean, ['acme-rev']);
  });
});
