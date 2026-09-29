// ─── MCP server/credential pairing for the Working Environment form (#2051) ──
//
// `environment.json` has always carried `mcpServers: [{ serverId, credentialId }]`
// and both `POST /api/environments` and `PUT /api/environments/:id` normalize it
// (api.js normalizeMcpServersInput). What was missing was any way to *choose* a
// pair: the field was written only by the Agent Team Wizard or by hand against
// the API, while the wizard's own Knowledge step pointed at "Working
// Environments →" for changes — a page with no such control.
//
// This module is the pure half of the picker EnvironmentTemplates.jsx now
// renders: the form ⇄ wire conversions, the "did the user actually touch it"
// gate, the per-row hints that mirror the seeder's two silent-drop rules, the
// change notice, and — since #2289, where the same rows also back a
// team-member's own MCP set (components/McpServerRows.jsx) — the row edits and
// the per-agent report of what a save applied. Kept React-free so it is unit-tested directly
// (working-env-mcp-view.test.js), the same split as toolchain-select-view.js
// and working-env-submit-state.js beside it.
//
// Two shapes, deliberately distinct:
//
//   form row  { serverId: '', credentialId: '' }        — strings, because both
//                                                         are <select> values
//   wire ref  { serverId: 'wiki', credentialId: null }  — what the API stores
//
// ── Why submitting is gated on a change (AC2) ────────────────────────────────
//
// `PUT /api/environments/:id` only writes `mcpServers` when the key is present
// (`if (mcpServers !== undefined)`), so until now an unrelated save preserved a
// wizard-written set *by omission*. A picker that always sends the field takes
// that guarantee away: normalization re-emits every entry as the full
// `{serverId, credentialId}` pair, so a hand-written ref with no `credentialId`
// key would silently gain `"credentialId": null` just because someone renamed
// the environment. `mcpSubmitValue()` therefore returns `undefined` — omit the
// key — whenever the selection is unchanged, which keeps the stored value
// byte-identical after an unrelated save and makes the form authoritative only
// for a pairing the user actually edited.

// Server and credential ids are `/^[a-z0-9-]+$/` on both sides of the wire
// (MCP_SERVER_ID_RE / MCP_CREDENTIAL_ID_RE in api.js), so ':' cannot occur
// inside one and is a safe join for the comparison key.
const KEY_SEP = ':';

const asId = v => String(v ?? '').trim();

/**
 * Form rows for an environment being edited. An absent/blank `credentialId`
 * becomes '' (the "— no credential —" option), never the string "null".
 *
 * @param initial  the environment record being edited, or null when creating
 * @returns {Array<{serverId: string, credentialId: string}>}
 */
export function initialMcpRows(initial) {
  const refs = Array.isArray(initial?.mcpServers) ? initial.mcpServers : [];
  return refs
    .filter(r => r && typeof r === 'object')
    .map(r => ({ serverId: asId(r.serverId), credentialId: asId(r.credentialId) }));
}

/**
 * Form rows → the wire shape the API stores. Mirrors normalizeMcpServersInput:
 * a row with no server chosen is dropped (it is what an "Add MCP server" click
 * leaves behind), and a blank credential becomes an explicit null.
 */
export function mcpWireRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object' && asId(r.serverId))
    .map(r => ({ serverId: asId(r.serverId), credentialId: asId(r.credentialId) || null }));
}

/**
 * Do two pairings mean the same thing? Order is significant — the seeder walks
 * the array in order and a later entry for the same server wins — so this is a
 * sequence comparison, not a set comparison. Entries with no serverId are
 * ignored on both sides because the API drops them too.
 */
export function sameMcpSelection(a, b) {
  const key = list => (Array.isArray(list) ? list : [])
    .filter(r => r && typeof r === 'object' && asId(r.serverId))
    .map(r => `${asId(r.serverId)}${KEY_SEP}${asId(r.credentialId)}`);
  const x = key(a);
  const y = key(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The value to put in the PUT/POST body for `mcpServers` — or `undefined` to
 * leave the key out entirely when nothing changed (see the header note).
 *
 * @param initial  the environment record being edited, or null when creating
 * @param rows     current form rows
 */
export function mcpSubmitValue(initial, rows) {
  const wire = mcpWireRows(rows);
  if (sameMcpSelection(initial?.mcpServers, wire)) return undefined;
  return wire;
}

/**
 * The point-of-decision hint for one row, or null when the pair is unremarkable.
 *
 * These are the two outcomes the orchestrator's seeder decides *silently*, long
 * after this form is closed: a `${credential}` placeholder with nothing bound
 * makes it drop that key from the agent's stanza (the server is still seeded,
 * just unauthenticated), and a credential bound to a template that never
 * mentions `${credential}` is ignored. `GET /api/mcp-servers` already publishes
 * `requiresCredential` (derived from the template on every read), so both are
 * knowable here — at the moment the pair is chosen rather than at seed time.
 *
 * @param row      a form row
 * @param servers  rows from GET /api/mcp-servers
 * @returns {{tone: 'warn'|'info', message: string} | null}
 */
export function mcpRowHint(row, servers) {
  const serverId = asId(row?.serverId);
  if (!serverId) return null;
  const server = (Array.isArray(servers) ? servers : []).find(s => s && s.id === serverId);
  if (!server) {
    return {
      tone: 'warn',
      message: `No MCP server '${serverId}' is registered — it may have been removed, or `
        + 'it is not visible to you. Saving keeps the entry, but an agent is only given '
        + 'servers that are registered, so it is skipped until it is registered again.',
    };
  }
  const hasCredential = Boolean(asId(row?.credentialId));
  if (server.requiresCredential && !hasCredential) {
    return {
      tone: 'warn',
      message: 'This server\'s template needs a credential. Without one the keys that '
        + 'reference it are dropped and the server is seeded unauthenticated.',
    };
  }
  if (!server.requiresCredential && hasCredential) {
    return {
      tone: 'info',
      message: 'This server\'s template has no ${credential} placeholder, so the '
        + 'credential is not substituted anywhere and will be ignored.',
    };
  }
  return null;
}

/**
 * The change notice (AC3 of #2051), shown only once the selection actually
 * differs from what is stored — the same "warn before the click, not after"
 * shape as toolchainChangeWarning, and for the same reason: a warning that is
 * always on screen stops being read.
 *
 * Since #2289 a save re-applies the set to every agent bound to the
 * environment (the orchestrator rewrites the agent's `.mcp.json`, read afresh
 * on its next turn — no recreate, no restart), except a member that carries its
 * own MCP servers. So the notice says what will happen, not what the operator
 * has to do; the per-agent outcome follows the save (mcpApplySummary).
 *
 * @returns {string|null}
 */
export function mcpChangeNotice({ isEdit = false, initial = null, rows = [], agentCount = 0 } = {}) {
  if (!isEdit) return null;
  if (sameMcpSelection(initial?.mcpServers, mcpWireRows(rows))) return null;
  const n = Number(agentCount) || 0;
  if (n > 0) {
    return `Saving applies the new set to the ${n} agent${n === 1 ? '' : 's'} using this environment `
      + 'from ' + (n === 1 ? 'its' : 'their') + ' next turn — no restart. A member with its own '
      + 'MCP servers keeps them.';
  }
  return 'Saving stores the new set. Agents that use this environment get it when they are created.';
}

// ── Row edits (#2289) ────────────────────────────────────────────────────────
//
// The same three edits on every surface that renders the picker. Choosing a
// different server clears the credential: a credential is chosen FOR a server,
// and keeping one across a server change would silently pair it with another.

export function updateMcpRow(rows, idx, key, val) {
  const next = (Array.isArray(rows) ? rows : []).slice();
  if (idx < 0 || idx >= next.length) return next;
  next[idx] = key === 'serverId'
    ? { serverId: val, credentialId: '' }
    : { ...next[idx], [key]: val };
  return next;
}

export function addMcpRow(rows) {
  return [...(Array.isArray(rows) ? rows : []), { serverId: '', credentialId: '' }];
}

export function removeMcpRow(rows, idx) {
  return (Array.isArray(rows) ? rows : []).filter((_, i) => i !== idx);
}

/**
 * What a save applied, from the `mcpApply` report `PUT /api/agents/:id` and
 * `PUT /api/environments/:id` return when the MCP set changed (#2289 AC10).
 * Every agent the change concerned is named in exactly one line; nothing is
 * summarised away.
 *
 * @param mcpApply  the report, or undefined when the save did not touch MCP
 * @returns {{tone: 'ok'|'warn', lines: string[]} | null}
 */
export function mcpApplySummary(mcpApply) {
  if (!mcpApply || typeof mcpApply !== 'object') return null;
  if (mcpApply.ok === false) {
    return {
      tone: 'warn',
      lines: [`The MCP change was saved but not applied: ${mcpApply.error || 'unknown error'}. Save again to retry.`],
    };
  }
  const list = v => (Array.isArray(v) ? v : []);
  const names = ids => ids.join(', ');
  const lines = [];
  const applied = list(mcpApply.applied);
  const stored = list(mcpApply.stored);
  const pending = list(mcpApply.pending);
  const kept = list(mcpApply.keptOverride);
  const failed = list(mcpApply.failed).filter(f => f && f.id);
  if (applied.length) lines.push(`MCP servers applied to ${names(applied)} — in effect from the next turn.`);
  if (stored.length) lines.push(`Not running: ${names(stored)} — the new set is in place for when it next starts.`);
  if (pending.length) lines.push(`Not created yet: ${names(pending)} — gets the new set when it is created.`);
  if (kept.length) lines.push(`Kept its own MCP servers: ${names(kept)}.`);
  for (const f of failed) lines.push(`Not applied to ${f.id}: ${f.error || 'failed'}.`);
  if (!lines.length) return null;
  return { tone: failed.length ? 'warn' : 'ok', lines };
}

/**
 * Label for a server option. Falls back to the bare id for a server that is no
 * longer in the registry, so an unknown ref stays visible (and removable)
 * instead of silently rendering as an empty select.
 */
export function mcpServerLabel(serverId, servers) {
  const id = asId(serverId);
  const server = (Array.isArray(servers) ? servers : []).find(s => s && s.id === id);
  if (!server) return `${id} (not registered)`;
  const name = server.name || server.id;
  return name === server.id ? server.id : `${name} (${server.id})`;
}

export default {
  initialMcpRows,
  mcpWireRows,
  sameMcpSelection,
  mcpSubmitValue,
  mcpRowHint,
  mcpChangeNotice,
  mcpServerLabel,
  updateMcpRow,
  addMcpRow,
  removeMcpRow,
  mcpApplySummary,
};
