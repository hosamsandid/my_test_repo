'use strict';

// ─── Internal-transport removal migration (#2578) ───────────────────────────
//
// The `transport: 'internal'` delivery model (a label hand-off woken by the
// `aee-emit` CLI instead of the GitHub poller) was removed: every labelled
// hand-off is now an ordinary poller-delivered `github-event` trigger. Agents
// created before the removal may still carry the dead field in two places:
//
//   - config.json `channels[]` — the consumer's declarative channel port;
//   - triggers.json entries    — the derived (or hand-authored) listener.
//
// Nothing reads the field any more, so it is harmless at runtime, but a stale
// `## Outcomes` prompt block may still tell the producer to run `aee-emit`
// (a CLI that no longer exists). The startup sweep in api.js therefore drops the
// field and re-renders every affected team's derived listeners + Outcomes block.
//
// This module is the pure half: given every agent's current state it decides
// what changes. The caller does the I/O (writes, putTriggers, reconcilers).
// Idempotent by construction — a second run over the written result plans
// nothing, so the sweep is safe to run on every start.

const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// A copy without `transport`, or the same object when it carries none.
function withoutTransport(x) {
  if (!has(x, 'transport')) return x;
  const out = { ...x };
  delete out.transport;
  return out;
}

// The derived `## Outcomes` block's markers (process-template.js
// OUTCOMES_MARK_START/END — the block is rendered only between them).
const OUTCOMES_MARK_START = '<!-- outcomes:start -->';
const OUTCOMES_MARK_END = '<!-- outcomes:end -->';

// A GENERATED Outcomes block still instructing the removed CLI. Catches a team
// whose fields were already cleaned by an earlier, interrupted sweep but whose
// block was never re-rendered (the field sweep and the prompt re-render are
// separate writes), so a rerun still repairs it. Only the derived block counts:
// authored prompt text outside the markers is the author's, and matching it
// would re-reconcile that team on every start.
function mentionsRemovedEmit(text) {
  if (typeof text !== 'string') return false;
  let from = 0;
  for (;;) {
    const start = text.indexOf(OUTCOMES_MARK_START, from);
    if (start === -1) return false;
    const end = text.indexOf(OUTCOMES_MARK_END, start);
    const block = text.slice(start, end === -1 ? text.length : end);
    if (block.includes('aee-emit')) return true;
    if (end === -1) return false;
    from = end + OUTCOMES_MARK_END.length;
  }
}

// The team whose derived wiring an agent participates in: a member's
// `parentTeamId`, or a team lead's own id. A standalone agent has none.
function teamOf(id, cfg) {
  if (cfg && typeof cfg.parentTeamId === 'string' && cfg.parentTeamId) return cfg.parentTeamId;
  if (cfg && cfg.role === 'team') return id;
  return null;
}

/**
 * Plan the migration.
 *
 * @param {Array<{id: string, cfg: object|null, triggers?: any, prompt?: string|null}>} agents
 *   every agent's config.json, triggers.json array and AGENT-PROMPT.md text
 *   (`prompt` optional — without it only the fields decide).
 * @returns {{
 *   configs: Array<{id: string, cfg: object}>,       // config.json to rewrite
 *   triggers: Array<{id: string, triggers: object[]}>, // triggers.json to rewrite
 *   teamIds: string[],                                 // teams to re-reconcile, sorted
 * }}
 */
function planInternalTransportMigration(agents) {
  const configs = [];
  const triggers = [];
  const teamIds = new Set();
  for (const a of (Array.isArray(agents) ? agents : [])) {
    if (!a || typeof a.id !== 'string' || !a.id) continue;
    const cfg = a.cfg && typeof a.cfg === 'object' ? a.cfg : null;
    let affected = false;

    if (cfg && Array.isArray(cfg.channels) && cfg.channels.some(c => has(c, 'transport'))) {
      configs.push({ id: a.id, cfg: { ...cfg, channels: cfg.channels.map(withoutTransport) } });
      affected = true;
    }

    const list = Array.isArray(a.triggers) ? a.triggers : [];
    if (list.some(t => has(t, 'transport'))) {
      triggers.push({ id: a.id, triggers: list.map(withoutTransport) });
      affected = true;
    }

    if (mentionsRemovedEmit(a.prompt) || mentionsRemovedEmit(cfg && cfg.systemPrompt)) affected = true;

    if (affected) {
      const team = teamOf(a.id, cfg);
      if (team) teamIds.add(team);
    }
  }
  return { configs, triggers, teamIds: [...teamIds].sort() };
}

module.exports = { planInternalTransportMigration, withoutTransport };
