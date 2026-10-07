'use strict';

// Pure assembly + cache-freshness helpers for GET /api/agents/statuses (#1677).
//
// The endpoint is polled on a 5s beat by several console surfaces (the Shell
// nav badge, the Agent-Chat list, Maintenance Mode). Keeping the per-agent
// status shape and the TTL freshness decision here (the api/*.js pure-module
// discipline) lets the api.js handler stay a thin fs/fetch adapter that reads
// each agent's config.json exactly once per request, and lets this logic be
// unit-tested without an Express app or a live orchestrator.

// Build one agent's status object from already-resolved inputs. The caller
// resolves `running` (from the orchestrator process list) and — only for an
// enabled, running agent — the `status.json` payload, `dm-room.json` payload
// and whether the session-pointer file exists; a disabled/offline agent needs
// none of those, so the adapter can skip those reads entirely.
//
//   cfg                 parsed config.json (never null — caller drops those)
//   running             is the agent's container currently up?
//   status              parsed status.json | null
//   dmRoom              parsed dm-room.json | null
//   sessionFileExists   does <roomId>.current.json exist?
function buildAgentStatus({ id, cfg, running, status, dmRoom, sessionFileExists }) {
  const displayName = (cfg && cfg.displayName) ?? id;
  // Intentionally turned off — kept distinct from 'offline' so the UI can tell
  // "just enable it" from "investigate a down container" (#1119).
  if (cfg && cfg.enabled === false) {
    return { id, displayName, activityState: 'disabled', hasSession: false };
  }
  // Container not running / crashed.
  if (!running) {
    return { id, displayName, activityState: 'offline', hasSession: false };
  }
  const hasSession = !!(dmRoom && dmRoom.roomId && sessionFileExists);
  return {
    id,
    displayName,
    activityState: status && status.state === 'busy' ? 'busy' : 'idle',
    lastResponseAt: (status && status.lastResponseAt) ?? null,
    hasSession,
  };
}

module.exports = { buildAgentStatus };
