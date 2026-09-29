// ─── A team-member's own MCP servers (#2289) ─────────────────────────────────
//
// The pure half of the agent edit form's "MCP Servers" field for a
// `team-member`: Inherit (no `mcpServersOverride` key — the environment's set
// applies) or Custom (the override replaces that set verbatim; an empty list is
// a deliberate "no MCP servers"). The Custom rows are the same form rows the
// team's MCP servers tab edits (working-env-mcp-view.js) and render through the
// same picker (components/McpServerRows.jsx); this module adds only what is
// specific to the member side. React-free, so `node --test` covers it (#651).

import { initialMcpRows, mcpWireRows, mcpServerLabel } from '../working-env-mcp-view.js';
import { describeMcpRowBlockers } from '../working-env-submit-state.js';

/**
 * The rows the member currently inherits — its environment's set, as form rows.
 *
 * @param env  the environment record (GET /api/environments/:id), or null
 */
export function inheritedMcpRows(env) {
  return initialMcpRows(env);
}

/**
 * What the Inherit preview says (AC4): the inherited server/credential pairs by
 * name, not just the environment id.
 *
 * @param {object} args
 * @param {?object} args.env          the environment record, or null
 * @param {boolean} [args.loading]    the environment is still loading
 * @param {Array} [args.servers]      rows from GET /api/mcp-servers
 * @param {Array} [args.credentials]  rows from GET /api/mcp-credentials
 * @returns {string}
 */
export function inheritedMcpPreview({ env, loading = false, servers = [], credentials = [] } = {}) {
  if (!env) return loading ? 'Loading the team environment’s MCP servers…' : 'The agent has no environment, so it inherits no MCP servers.';
  const rows = inheritedMcpRows(env).filter(r => r.serverId);
  if (rows.length === 0) return 'The team’s environment has no MCP servers.';
  const creds = Array.isArray(credentials) ? credentials : [];
  return rows.map(r => {
    const server = mcpServerLabel(r.serverId, servers);
    if (!r.credentialId) return `${server} · no credential`;
    const cred = creds.find(c => c && c.id === r.credentialId);
    return `${server} · credential: ${cred?.name || r.credentialId}`;
  }).join('\n');
}

/**
 * Toggle Inherit/Custom on a form (D1). Switching to Custom starts from a copy
 * of what is in effect — the inherited set — never from an empty list: the
 * override replaces the set, so a blank start would silently strip the agent's
 * servers. Switching back to Inherit leaves the rows alone (they are not sent),
 * so flipping back and forth does not lose an edit.
 *
 * @param form     the edit-form state (`inheritMcp`, `mcpRows`)
 * @param inherit  the mode chosen
 * @param env      the environment record the member inherits from
 */
export function switchMcpMode(form, inherit, env) {
  const f = form || {};
  if (Boolean(inherit) === Boolean(f.inheritMcp)) return f;
  if (inherit) return { ...f, inheritMcp: true };
  return { ...f, inheritMcp: false, mcpRows: inheritedMcpRows(env) };
}

/**
 * The `mcpServersOverride` value to send: null (inherit — the API clears the
 * key) or the wire refs. An empty Custom set stays `[]` (AC8). Refs to a server
 * the editor cannot see are kept as they are, so a save never drops them.
 */
export function memberMcpSubmitValue(inheritMcp, rows) {
  return inheritMcp ? null : mcpWireRows(rows);
}

/**
 * Why the Custom set cannot be saved yet (AC5) — the same two reasons as the
 * team surface: a row with no server chosen, a server listed twice. Inherit
 * has nothing to block on.
 *
 * @returns {Array<{field: string, message: string}>}
 */
export function memberMcpBlockers(inheritMcp, rows) {
  return inheritMcp ? [] : describeMcpRowBlockers(rows);
}

/** Two form row lists, compared exactly (order and blanks count). */
export function sameMcpRows(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length
    && x.every((r, i) => (r?.serverId ?? '') === (y[i]?.serverId ?? '')
      && (r?.credentialId ?? '') === (y[i]?.credentialId ?? ''));
}

export default {
  inheritedMcpRows,
  inheritedMcpPreview,
  switchMcpMode,
  memberMcpSubmitValue,
  memberMcpBlockers,
  sameMcpRows,
};
