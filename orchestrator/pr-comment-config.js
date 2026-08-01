'use strict';

// Per-team opt-in for the PR-merge token comment (#678, AC4 — OFF by default).
//
// The concept (§ "deliberately later") says the feature ships dark and is switched
// on per team only once the numbers have earned trust internally. Granularity is
// per-team (open-question 2 recommendation), mirroring the per-team knowledge
// config mechanism (orchestrator.js loadTeamKnowledgeOverrides): a small JSON file
// under the team's workspace dir, traversal-guarded, defaulting to OFF when the
// file (or key) is absent — so an upgrade changes nothing until an operator opts in.
//
// Kept as its own file rather than folded into knowledge-config.json: this is a
// telemetry/reporting switch, not a knowledge-autonomy dial — separate concern,
// separate file, independently readable by the poller's thin merge hook.

const fs = require('fs');
const path = require('path');

const { safeTeamSegment } = require('./knowledge-feed');

const CONFIG_FILENAME = 'token-telemetry-config.json';
const OPT_IN_KEY = 'prMergeComment';

function configPath(workspaceDir, teamId) {
  const seg = safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(workspaceDir, 'teams', seg, CONFIG_FILENAME);
}

function loadConfig(workspaceDir, teamId) {
  const p = configPath(workspaceDir, teamId);
  if (!p || !fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// True only when the team has an explicit opt-in on file. Absent file / absent key
// / any non-true value / unsafe team id → OFF (AC4). Never throws.
function isPrMergeCommentEnabled(workspaceDir, teamId) {
  return loadConfig(workspaceDir, teamId)[OPT_IN_KEY] === true;
}

// Merge-write the opt-in flag for one team; returns the full config after the write.
// Coerces to a strict boolean so only `true` ever enables the feature.
function setPrMergeCommentEnabled(workspaceDir, teamId, enabled) {
  const p = configPath(workspaceDir, teamId);
  if (!p) throw new Error(`pr-comment-config: refusing unsafe team id '${teamId}'`);
  const next = { ...loadConfig(workspaceDir, teamId), [OPT_IN_KEY]: enabled === true };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

module.exports = {
  CONFIG_FILENAME,
  OPT_IN_KEY,
  configPath,
  loadConfig,
  isPrMergeCommentEnabled,
  setPrMergeCommentEnabled,
};
