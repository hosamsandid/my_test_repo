'use strict';

// Three-tier skill resolution (#306 two-tier; agent tier added by the
// Shared Agent Learning & Knowledge Flow, Phase 0).
//
// A skill name can be served from three pools, most specific first:
//   - the agent's own pool     — <workspace>/agents/<id>/skills/<name>   (that agent only)
//   - the owning team's pool    — <workspace>/teams/<teamId>/skills/<name> (the team)
//   - the global pool           — <templateWorkspace>/skills/<name>        (all teams)
//
// At agent seeding the most specific copy wins: an agent's private skill shadows
// the team's, and the team's shadows the global one — so a team (or an agent) can
// add or override skills without leaking them upward. When a tier has no skill of
// that name, resolution falls through to the next, so:
//   - a team with no own pool behaves exactly as the global-only pre-#306 setup;
//   - callers that pass no agentId get the identical two-tier behaviour as before.
//
// The agent tier mirrors T0 memory (already agent-private) and is the bottom rung
// of the Agent -> Team -> Global skill pool. In Phase 0 the on-disk agent pool is
// not materialised (no agent has that directory yet), so resolution falls through
// to team/global exactly as today; the tier is wired for Phase 3 promotion.
//
// Pure (apart from the injected fs.existsSync), so it is unit-testable without
// booting the orchestrator service.

const fs = require('fs');
const path = require('path');

function makeSkillSourceResolver({ workspace, templateWorkspace, defaultTeamId = 'default' } = {}) {
  if (!workspace || !templateWorkspace) {
    throw new Error('makeSkillSourceResolver: { workspace, templateWorkspace } are required');
  }

  function agentSkillsDir(agentId) {
    return path.join(workspace, 'agents', agentId, 'skills');
  }

  function teamSkillsDir(teamId) {
    return path.join(workspace, 'teams', teamId || defaultTeamId, 'skills');
  }

  function globalSkillsDir() {
    return path.join(templateWorkspace, 'skills');
  }

  // Returns the absolute source dir for a skill name, resolving agent-first (when
  // an agentId is given), then team, then global — or null when no tier has it.
  function resolveSkillSourceDir(skillName, teamId, { agentId = null, existsSync = fs.existsSync } = {}) {
    if (agentId) {
      const agentSrc = path.join(agentSkillsDir(agentId), skillName);
      if (existsSync(agentSrc)) return agentSrc;
    }
    const teamSrc = path.join(teamSkillsDir(teamId), skillName);
    if (existsSync(teamSrc)) return teamSrc;
    const globalSrc = path.join(globalSkillsDir(), skillName);
    if (existsSync(globalSrc)) return globalSrc;
    return null;
  }

  return { agentSkillsDir, teamSkillsDir, globalSkillsDir, resolveSkillSourceDir };
}

// Extract the one-line `description` from a SKILL.md's YAML frontmatter, so the
// composed CLAUDE.md Skills section can advertise "when to reach for this"
// alongside each granted skill name (#617). Pure (string in, string out).
//
// Handles the three shapes skill authors use:
//   - inline scalar:      `description: Do the thing`  (optionally quoted)
//   - folded/literal block: `description: >-` (or `|`) followed by indented lines
//   - plain multi-line:   an empty value followed by indented continuation lines
// A folded/multi-line value is whitespace-collapsed to a single line (AC8).
// Returns null when there is no frontmatter, no `description` key, or an empty
// value — the caller then lists the skill by name only (fail-soft, AC7).
function parseSkillDescription(skillMd) {
  const text = String(skillMd == null ? '' : skillMd);
  const fm = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^description[ \t]*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    // Block scalar indicator (>, |, with optional chomping/indent) or an empty
    // value → gather the following indented continuation lines.
    if (inline === '' || /^[|>][+-]?\d*$/.test(inline)) {
      const collected = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '' || /^[ \t]/.test(line)) collected.push(line.trim());
        else break; // a new, non-indented key ends the block
      }
      const joined = collected.join(' ').replace(/\s+/g, ' ').trim();
      return joined || null;
    }
    // Inline scalar, possibly wrapped in matching quotes.
    const unquoted = inline.replace(/^(['"])([\s\S]*)\1$/, '$2');
    const joined = unquoted.replace(/\s+/g, ' ').trim();
    return joined || null;
  }
  return null;
}

module.exports = { makeSkillSourceResolver, parseSkillDescription };
