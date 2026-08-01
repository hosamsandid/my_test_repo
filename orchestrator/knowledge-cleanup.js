'use strict';

// Team-knowledge cleanup pure core (#532).
//
// When a squad (`role: "team"` agent) is deleted, its team-scoped knowledge must
// be torn down too — otherwise a later same-name team, whose id is the same
// deterministic slug, silently re-adopts the dead team's KB (a data-isolation
// leak). This module owns the *decision* of which local, team-scoped stores to
// remove and how to rewrite the shared live feed; the actual fs IO lives in
// orchestrator.js (repo convention: test the pure core, keep IO thin).
//
// Fail-closed: an unsafe team id yields a null plan, so the caller removes
// nothing rather than risking a traversal or an over-broad wipe. The team
// segment is validated by `safeTeamSegment` — the same guard the read/write
// paths already use to key every store.

const path = require('path');
const { safeTeamSegment } = require('./knowledge-feed');

// Which local, team-scoped stores to remove for a deleted squad. `roots` injects
// the storage roots (the orchestrator's module-level constants) so this stays
// pure and unit-testable. Every root is optional: an omitted root just drops its
// target from the plan. Returns null for an unsafe team id (caller removes
// nothing), else { teamId, dirs: string[], files: string[], eventsFile }.
//
// Note the git-side canonical KB (the `agent-knowledge` branch in the team's
// repo) is deliberately NOT in this plan — repo-shared knowledge is the
// sanctioned, wanted sharing channel, not a leak, so team deletion never
// modifies or pushes it (#532 AC6). This plan covers only the local,
// non-repo, per-team stores on the shared volume.
function planTeamKnowledgePurge(teamId, roots = {}) {
  const seg = safeTeamSegment(teamId);
  if (!seg) return null;

  const { cloneRoot, teamsDir, suggestionsDir, archivedDir, reviewDir, retrievalDir, eventsFile } = roots;

  const dirs = [];
  // Canonical KB clone: <cloneRoot>/<teamId>/ (mirrors canonicalClonePath).
  if (cloneRoot) dirs.push(path.join(cloneRoot, seg));
  // Squad skill pool ONLY: <teamsDir>/<teamId>/skills/ (mirrors teamSkillsDir,
  // skill-source.js). Scoped to the skills subdir — not the whole id-named dir —
  // so any future non-knowledge per-team state under <teamsDir>/<teamId>/ is
  // left intact. The human tenant Team registry lives in sibling files
  // (<teamsDir>/index.json, users/, memberships/), never under this subdir.
  if (teamsDir) dirs.push(path.join(teamsDir, seg, 'skills'));

  const files = [];
  // One JSON-per-team store each (see _candidatesPath/_archivedPath/_reviewPath).
  if (suggestionsDir) files.push(path.join(suggestionsDir, `${seg}.json`));
  if (archivedDir) files.push(path.join(archivedDir, `${seg}.json`));
  if (reviewDir) files.push(path.join(reviewDir, `${seg}.json`));
  // Read-side retrieval aggregate (#915) — per-team telemetry dies with the team.
  if (retrievalDir) files.push(path.join(retrievalDir, `${seg}.json`));

  return { teamId: seg, dirs, files, eventsFile: eventsFile || null };
}

// Rewrite the shared live-feed (events.jsonl) dropping every event scoped to the
// deleted team. The feed is a single append-only file shared by all teams, so it
// is filtered rather than deleted. Preserves all other lines verbatim; an
// unparseable line is KEPT (never lose another team's history to one bad line).
// Blank lines are dropped on rewrite. Returns { kept: string[], removed }.
function filterEventsForTeam(content, teamId) {
  const seg = safeTeamSegment(teamId);
  const lines = Array.isArray(content)
    ? content
    : String(content == null ? '' : content).split('\n');

  const kept = [];
  let removed = 0;
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw : '';
    if (line.trim() === '') continue;
    if (seg) {
      let obj = null;
      try { obj = JSON.parse(line); } catch { obj = null; }
      if (obj && typeof obj === 'object' && obj.teamId === seg) {
        removed++;
        continue;
      }
    }
    kept.push(line);
  }
  return { kept, removed };
}

module.exports = { planTeamKnowledgePurge, filterEventsForTeam };
