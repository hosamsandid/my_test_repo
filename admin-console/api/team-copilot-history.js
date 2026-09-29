'use strict';

// Live-team Flow Copilot chat history (#2556, AC11/AC16).
//
// A draft keeps its Copilot conversation on the draft bundle itself
// (`copilot.messages`, #1071). A live team has no bundle to carry it, and its
// config.json is the wrong home: every PUT of it can re-derive triggers or
// respawn members, and a chat turn must never do either. So the history lives
// in a sibling file on the TEAM agent's directory — the team agent hosts no
// container of its own, the file goes away with the team, and it is shared by
// everyone who may edit the team (AC16) rather than being per-user.
//
// Same retention and whitelist as the draft copy: `sanitizeCopilotHistory`
// (flow-copilot.js) keeps the known entry keys only, demotes an unreviewed
// `proposed` card to `superseded` (proposal bundles are never persisted), and
// caps the list at COPILOT_HISTORY_CAP.

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeCopilotHistory } = require('./flow-copilot');

const TEAM_COPILOT_HISTORY_FILE = 'copilot-history.json';

function historyFile(agentsDir, teamId) {
  return path.join(agentsDir, teamId, TEAM_COPILOT_HISTORY_FILE);
}

/**
 * Who may see / write a team's Copilot history. `canEdit` is the SAME
 * predicate every live-team write uses (canManageAgent on the team agent), so
 * the chat is shared among exactly the people who could apply its proposals;
 * a viewer without edit rights gets neither the history nor the composer.
 * Returns 'ok' | 'not-found' | 'forbidden'.
 */
function copilotHistoryAccess({ teamCfg, visible, canEdit }) {
  if (!teamCfg || teamCfg.role !== 'team') return 'not-found';
  if (!visible) return 'not-found';
  if (!canEdit) return 'forbidden';
  return 'ok';
}

/** The stored messages ([] when none / unreadable / malformed). */
function readTeamCopilotHistory(agentsDir, teamId) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(historyFile(agentsDir, teamId), 'utf8')); }
  catch { return []; }
  const clean = sanitizeCopilotHistory(raw);
  return clean ? clean.messages : [];
}

/**
 * Sanitize and persist `raw` ({messages:[…]}). Returns the stored messages, or
 * null when the body is not a history object (the route answers 400).
 * `writeJson(file, value)` is injected so the route keeps its atomic writer.
 */
function writeTeamCopilotHistory(agentsDir, teamId, raw, writeJson) {
  const clean = sanitizeCopilotHistory(raw);
  if (!clean) return null;
  writeJson(historyFile(agentsDir, teamId), clean);
  return clean.messages;
}

module.exports = {
  TEAM_COPILOT_HISTORY_FILE,
  copilotHistoryAccess,
  readTeamCopilotHistory,
  writeTeamCopilotHistory,
};
