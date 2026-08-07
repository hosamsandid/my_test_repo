'use strict';

// Team-create residue classification & routing (#1525).
//
// A failed team creation can leave directories behind under
// `/workspace/agents/`. Both team-create handlers (POST /api/teams and
// POST /api/teams/stream) inspect that residue to decide whether to create,
// route to `extend`, or refuse. The original code derived two flags with
// DIFFERENT strictness:
//
//   teamExists      — the team dir has a readable config.json with role 'team'
//   existingMembers — a member dir merely EXISTS (bare `existsSync`, no config,
//                     no role check)
//
// That asymmetry produced an unrecoverable deadlock: a leftover member
// directory with no readable config (the exact shape a partial rollback leaves)
// gave `teamExists === false && existingMembers.length > 0`, so a `create`
// retry emitted a collision suggesting `extend`, while `extend` rejected with
// "team does not exist yet" — a loop with no UI escape (the config-less dir is
// also invisible on the Agents page). See issue #1525.
//
// This module makes the two checks symmetric and gives `create` a recovery
// path, mirroring the env-orphan precedent already in the handlers: a
// config-less / provisioning-stub member dir is an ADOPTABLE ORPHAN (deleted +
// recreated in place), not a collision. Both handlers share one pure decision
// so their behaviour cannot drift.

/**
 * Classify each planned member id against its on-disk state.
 *
 * @param {Array<{memberId: string, exists: boolean, config: object|null}>} entries
 *        One entry per planned member. `config` is the parsed config.json, or
 *        null when the dir is absent OR has no readable/parseable config.
 * @param {string} teamId The team id being created/extended.
 * @returns {{
 *   existingMembers: string[],
 *   orphanMembers: string[],
 *   conflictMembers: Array<{memberId: string, role: string}>
 * }}
 *   - existingMembers: genuine members of THIS team (readable team-member
 *     config with matching parentTeamId) — a real collision the user resolves
 *     via extend.
 *   - orphanMembers: config-less or `_provisioning`-stub leftovers — adoptable
 *     (cleaned up + recreated in place), never a collision.
 *   - conflictMembers: the id is held by an unrelated agent (a readable config
 *     that is not a team-member of this team) — a hard id conflict.
 */
function classifyMemberResidue(entries, teamId) {
  const existingMembers = [];
  const orphanMembers = [];
  const conflictMembers = [];
  for (const e of entries || []) {
    if (!e || !e.exists) continue;
    const cfg = e.config;
    if (!cfg || typeof cfg !== 'object' || cfg._provisioning === true) {
      // No readable config, or a half-provisioned stub reserved by a prior
      // aborted create — either way there is no usable agent here.
      orphanMembers.push(e.memberId);
    } else if (cfg.role === 'team-member' && cfg.parentTeamId === teamId) {
      existingMembers.push(e.memberId);
    } else {
      conflictMembers.push({ memberId: e.memberId, role: cfg.role });
    }
  }
  return { existingMembers, orphanMembers, conflictMembers };
}

/**
 * Decide how a team-create request routes given the classified residue.
 * Pure and shared by both handlers.
 *
 * @param {object} o
 * @param {'create'|'extend'} o.mode
 * @param {boolean} o.teamExists         team dir has a readable role:'team' config
 * @param {boolean} o.teamIdTakenByOther team dir has a readable config of another role
 * @param {ReturnType<typeof classifyMemberResidue>} o.residue
 * @returns {{type: string, [k: string]: any}} one of:
 *   - {type:'conflict-team'}                     the teamId is an unrelated agent
 *   - {type:'conflict-members', members}         a memberId is an unrelated agent
 *   - {type:'collision', existingMembers}        create mode, real team/members exist
 *   - {type:'extend-missing-team'}               extend mode, no team to extend
 *   - {type:'proceed', orphansToClean}           go ahead; delete these leftover dirs first
 */
function decideTeamCreate({ mode, teamExists, teamIdTakenByOther, residue }) {
  const { existingMembers, orphanMembers, conflictMembers } = residue;
  if (teamIdTakenByOther) return { type: 'conflict-team' };
  if (conflictMembers.length) return { type: 'conflict-members', members: conflictMembers };
  if (mode === 'extend') {
    if (!teamExists) return { type: 'extend-missing-team' };
    // The team exists; orphan member dirs (config-less leftovers) among the
    // roles we're about to add must be cleaned so their recreate doesn't
    // collide with dead residue.
    return { type: 'proceed', orphansToClean: orphanMembers };
  }
  // create: a real team or real member is a genuine collision the user
  // resolves via extend. Orphans never trigger this — they are adopted.
  if (teamExists || existingMembers.length) {
    return { type: 'collision', existingMembers };
  }
  return { type: 'proceed', orphansToClean: orphanMembers };
}

module.exports = { classifyMemberResidue, decideTeamCreate };
