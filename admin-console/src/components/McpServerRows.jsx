import React from 'react';
import { Plus, X, AlertTriangle } from 'lucide-react';
import IconButton from './IconButton';
import OptionList from './OptionList';
import OptionRow from './OptionRow';
import {
  mcpRowHint, mcpServerLabel, updateMcpRow, addMcpRow, removeMcpRow,
} from '../pages/working-env-mcp-view.js';

/**
 * The MCP server/credential picker (#2289) — one server select and one
 * credential select per row, the point-of-decision hint, remove and add.
 *
 * Extracted from Team Settings → MCP servers so a team-member's own MCP set
 * (the agent edit form's Custom mode) renders the SAME control instead of the
 * free-text "serverId:credentialId" field it used to have. Controlled: `rows`
 * are form rows (`{serverId: '', credentialId: ''}`, working-env-mcp-view.js)
 * and every edit is reported through `onChange(nextRows)`; the row edits
 * themselves are the pure helpers there.
 *
 * @param {object} props
 * @param {Array<{serverId: string, credentialId: string}>} props.rows
 * @param {(rows: Array) => void} props.onChange
 * @param {Array} props.servers      rows from GET /api/mcp-servers
 * @param {Array} props.credentials  rows from GET /api/mcp-credentials
 * @param {boolean} [props.loading]  the registry is still loading
 * @param {boolean} [props.disabled]
 */
export default function McpServerRows({ rows, onChange, servers, credentials, loading = false, disabled = false }) {
  const list = Array.isArray(rows) ? rows : [];
  const registry = Array.isArray(servers) ? servers : [];
  const creds = Array.isArray(credentials) ? credentials : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {list.length > 0 && (
        <OptionList>
          {list.map((row, idx) => {
            const hint = mcpRowHint(row, registry);
            const unknownServer = row.serverId && !registry.some(s => s.id === row.serverId);
            return (
              <OptionRow
                key={idx}
                expandedContent={hint ? <div>{hint.message}</div> : null}
                header={
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)' }}>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                        <div style={labelStyle}>Server</div>
                        <select
                          value={row.serverId}
                          onChange={e => onChange(updateMcpRow(list, idx, 'serverId', e.target.value))}
                          disabled={disabled}
                          style={inputStyle}
                        >
                          <option value="">— choose a server —</option>
                          {registry.map(s => <option key={s.id} value={s.id}>{mcpServerLabel(s.id, registry)}</option>)}
                          {unknownServer && <option value={row.serverId}>{mcpServerLabel(row.serverId, registry)}</option>}
                        </select>
                      </div>
                      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                        <div style={labelStyle}>Credential</div>
                        <select
                          value={row.credentialId}
                          onChange={e => onChange(updateMcpRow(list, idx, 'credentialId', e.target.value))}
                          disabled={disabled || !row.serverId}
                          style={{ ...inputStyle, opacity: row.serverId ? 1 : 0.5 }}
                        >
                          <option value="">— no credential —</option>
                          {creds.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name}{c.serverId === row.serverId ? ' (default for this server)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      {hint && (
                        <AlertTriangle
                          size={13}
                          title={hint.message}
                          style={{ flexShrink: 0, marginTop: 20, color: hint.tone === 'warn' ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)' }}
                        />
                      )}
                    </div>
                    <div style={{ flexShrink: 0, paddingTop: 18 }}>
                      <IconButton
                        icon={X}
                        label="Remove MCP server"
                        danger
                        disabled={disabled}
                        onClick={() => onChange(removeMcpRow(list, idx))}
                        size={12}
                      />
                    </div>
                  </div>
                }
              />
            );
          })}
        </OptionList>
      )}
      {loading ? (
        <div style={helpTextStyle}>Loading MCP servers…</div>
      ) : registry.length === 0 ? (
        <div style={helpTextStyle}>No MCP servers are registered yet.</div>
      ) : (
        <button type="button" onClick={() => onChange(addMcpRow(list))} disabled={disabled} style={dashedButtonStyle}>
          <Plus size={13} /> Add MCP server
        </button>
      )}
    </div>
  );
}

const labelStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)',
  marginBottom: 'var(--eb-space-0-5)',
};

const helpTextStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  marginTop: 'var(--eb-space-1)',
  lineHeight: '1.4',
};

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

const dashedButtonStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px dashed var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};
