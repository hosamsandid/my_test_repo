'use strict';

// ---------------------------------------------------------------------------
// Skill import — pure validator + planner (#628, concept
// docs/skill-lifecycle-concept.md §3.5).
//
// Import brings a skill *archive* into a pool tier with an identity round-trip:
// the caller picks a target tier (global | team) under the SAME permission rules
// as the transfer engine (Team Admin → own team pool, System Admin → global),
// a name collision is handled like a transfer (reject | overwrite | rename), the
// archive's SKILL.md must carry a non-empty `name` + `description`, and an
// embedded skill.json is honoured (its version chain continues, an `imported`
// event is appended, origin becomes {tier:"external"}; absent → stamped fresh).
//
// This module is **pure** (no fs, no network): it parses SKILL.md frontmatter,
// validates a target request, and states the permission the caller must hold.
// The api.js endpoint does the file work (unzip, zip-slip guard, containment,
// copy, stamp, feed event). Same "pure core + IO caller" discipline as
// skill-transfer.js / skill-deletion.js — and it reuses the deletion module's
// { needsSystemAdmin, teamAdminOf } permission shape so one permit helper serves
// import, deletion and transfer.
// ---------------------------------------------------------------------------

// #2307: the write-into-a-pool-tier rule is now shared with skill-transfer.js
// (create/edit reuse it too) so it cannot drift between paths again — see
// requiredPermission below.
const { requiredPoolWritePermission } = require('./skill-transfer');

const TIERS = ['global', 'team'];
const COLLISION_MODES = ['reject', 'overwrite', 'rename'];

// Mirror the api.js regexes so a validated request is always writable there.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;
const POOL_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Parse a single scalar/block field out of a SKILL.md's YAML frontmatter.
// A faithful mirror of orchestrator/skill-source.js's parseSkillDescription,
// generalised to any key (admin-console cannot cross-require the orchestrator
// module — same reason skill-manifest.js is mirrored, not imported). Handles the
// three shapes skill authors use:
//   - inline scalar:        `key: value`  (optionally quoted)
//   - folded/literal block: `key: >-` (or `|`) + indented continuation lines
//   - plain multi-line:     empty value + indented continuation lines
// A folded/multi-line value is whitespace-collapsed to one line. Returns null
// when there is no frontmatter, no such key, or an empty value.
function parseFrontmatterField(skillMd, key) {
  const text = String(skillMd == null ? '' : skillMd);
  const fm = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const keyRe = new RegExp('^' + key + '[ \\t]*:(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline === '' || /^[|>][+-]?\d*$/.test(inline)) {
      const collected = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '' || /^[ \t]/.test(line)) collected.push(line.trim());
        else break;
      }
      const joined = collected.join(' ').replace(/\s+/g, ' ').trim();
      return joined || null;
    }
    const unquoted = inline.replace(/^(['"])([\s\S]*)\1$/, '$2');
    const joined = unquoted.replace(/\s+/g, ' ').trim();
    return joined || null;
  }
  return null;
}

// Extract the identity metadata an import validates against.
function parseSkillMeta(skillMd) {
  return {
    name: parseFrontmatterField(skillMd, 'name'),
    description: parseFrontmatterField(skillMd, 'description'),
  };
}

// Validate an archive's SKILL.md content (AC2): frontmatter must parse with a
// non-empty `name` AND `description`. Returns { ok: true, name, description } or
// { ok: false, error }. `skillMd` is the raw file text the endpoint read off the
// extracted archive (null/'' when the file is missing → a clear error).
function validateSkillMd(skillMd) {
  if (typeof skillMd !== 'string' || skillMd.trim() === '') {
    return { ok: false, error: 'archive SKILL.md is missing or empty' };
  }
  const { name, description } = parseSkillMeta(skillMd);
  if (!name) return { ok: false, error: 'SKILL.md frontmatter is missing a non-empty "name"' };
  if (!description) return { ok: false, error: 'SKILL.md frontmatter is missing a non-empty "description"' };
  return { ok: true, name, description };
}

// Validate an import target request and produce a plan. `input` is the merged
// form/body of the import endpoint: { tier?, name, teamId?, onCollision? }.
// `tier` defaults to global (the historic import target). Returns
// { ok: false, error } or { ok: true, tier, name, teamId?, onCollision,
// permission }. Regexes are injectable so the endpoint can pass its own (kept in
// sync with the mirrored defaults above).
function planImport(input, opts = {}) {
  const skillNameRe = opts.skillNameRe || SKILL_NAME_RE;
  const teamIdRe = opts.teamIdRe || POOL_TEAM_ID_RE;
  const b = input && typeof input === 'object' ? input : {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || !skillNameRe.test(name)) return { ok: false, error: 'invalid skill name' };

  const raw = b.tier;
  const tier = raw == null || raw === '' ? 'global' : String(raw).trim();
  if (!TIERS.includes(tier)) return { ok: false, error: `tier must be one of ${TIERS.join('|')}` };

  const rawCol = typeof b.onCollision === 'string' ? b.onCollision.trim() : '';
  const onCollision = rawCol === '' ? 'reject' : rawCol;
  if (!COLLISION_MODES.includes(onCollision)) {
    return { ok: false, error: `onCollision must be one of ${COLLISION_MODES.join('|')}` };
  }

  const out = { ok: true, tier, name, onCollision };
  if (tier === 'team') {
    const teamId = typeof b.teamId === 'string' ? b.teamId.trim() : '';
    if (!teamIdRe.test(teamId)) return { ok: false, error: 'teamId required for a team tier' };
    out.teamId = teamId;
  }
  out.permission = requiredPermission(out);
  return out;
}

// The permission the caller must hold to import at a tier — the one
// global-entry rule (#2307, concept §3.5 / §3): Team Admin for a team pool,
// System Admin OR Team Admin of ANY team for the global pool (entering global
// is a Team-Admin act, not System-Admin-only — #2178/#2180). Returns the
// { needsSystemAdmin, teamAdminOf, anyTeamAdmin } shape skill-transfer's
// permitTransfer reads, so the endpoint reuses one permit helper.
function requiredPermission(plan) {
  return requiredPoolWritePermission(plan.tier, plan.teamId);
}

module.exports = {
  TIERS,
  COLLISION_MODES,
  SKILL_NAME_RE,
  POOL_TEAM_ID_RE,
  parseFrontmatterField,
  parseSkillMeta,
  validateSkillMd,
  planImport,
  requiredPermission,
};
