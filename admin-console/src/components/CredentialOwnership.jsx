import React from 'react';
import { creatableScopes } from '../pages/credential-scope-view';

// Ownership selector shared by the SSH Keys and GitHub Tokens create/edit forms
// (#798). A System Admin picks between a system-scoped credential (assigned to
// 0..n teams) and a team-scoped one (owned by a single team); a Team Admin only
// ever creates team-scoped credentials for a team they administer, so the scope
// switch collapses to a fixed "owned by team" picker restricted to their teams.
//
// `value` is an ownership state { scope, teamId, assignedTeamIds }; `onChange`
// receives the next state. Pure presentational — no fetch of its own.

const labelStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)',
  marginBottom: 'var(--eb-space-1)',
};

const selectStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function ScopeTab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        background: active ? 'var(--eb-bg-elevated)' : 'transparent',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
        cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

export default function CredentialOwnership({ value, onChange, teams = [], isSysAdmin, adminTeamIds = [], disabled = false }) {
  const own = value || { scope: 'team', teamId: '', assignedTeamIds: [] };
  const scopes = creatableScopes({ isSysAdmin });
  // A Team Admin may only own credentials in teams they administer; a System
  // Admin may target any team.
  const teamOptions = isSysAdmin ? teams : teams.filter(t => adminTeamIds.includes(t.id));

  function setScope(scope) {
    if (scope === 'system') onChange({ scope: 'system', teamId: null, assignedTeamIds: own.assignedTeamIds || [] });
    else onChange({ scope: 'team', teamId: own.teamId || teamOptions[0]?.id || '', assignedTeamIds: [] });
  }

  function toggleAssigned(id) {
    const set = new Set(own.assignedTeamIds || []);
    if (set.has(id)) set.delete(id); else set.add(id);
    onChange({ ...own, scope: 'system', assignedTeamIds: [...set] });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={labelStyle}>Ownership</div>

      {scopes.length > 1 && (
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <ScopeTab active={own.scope === 'system'} onClick={() => !disabled && setScope('system')}>
            System (assign to teams)
          </ScopeTab>
          <ScopeTab active={own.scope === 'team'} onClick={() => !disabled && setScope('team')}>
            Team-owned
          </ScopeTab>
        </div>
      )}

      {own.scope === 'system' ? (
        <div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-1)' }}>
            Assign to the teams whose Team Admins may use this credential. Assigning to no team keeps it visible to System Admins only.
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
            maxHeight: 180, overflowY: 'auto',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-2)',
          }}>
            {teams.length === 0 && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>No teams available.</div>
            )}
            {teams.map(t => (
              <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', cursor: disabled ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={(own.assignedTeamIds || []).includes(t.id)}
                  onChange={() => toggleAssigned(t.id)}
                />
                {t.name || t.id}
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <select
            value={own.teamId || ''}
            disabled={disabled}
            onChange={e => onChange({ scope: 'team', teamId: e.target.value, assignedTeamIds: [] })}
            style={selectStyle}
          >
            {!own.teamId && <option value="">Select a team…</option>}
            {teamOptions.map(t => (
              <option key={t.id} value={t.id}>{t.name || t.id}</option>
            ))}
          </select>
          {!isSysAdmin && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
              You can create credentials only for teams you administer.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
