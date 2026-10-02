import React from 'react';
import { ScopeTab, labelStyle, selectStyle } from './CredentialOwnership';
import { teamOptionsWithCurrent, teamOptionsWithAssigned } from './environment-ownership-view.js';

// Tier selector for an environment / MCP server (#2083) — the
// `{scope, teamId, assignedTeamIds}` triple without an identity axis (an
// environment is never personal, A3.2). A System Admin picks between a
// system-scoped (Shared) record assigned to 0..n teams and a team-owned one; a
// Team Admin only ever picks a team they administer. Credentials use the
// identity + scope pair in `CredentialOwnership` instead.
//
// `value` is an ownership state { scope, teamId, assignedTeamIds }; `onChange`
// receives the next state. Pure presentational — no fetch of its own.
export default function EnvironmentOwnership({ value, onChange, teams = [], isSysAdmin, adminTeamIds = [], disabled = false }) {
  const own = value || { scope: 'team', teamId: '', assignedTeamIds: [] };
  const scopes = isSysAdmin ? ['system', 'team'] : ['team'];
  // A Team Admin may only own records in teams they administer; a System
  // Admin may target any team.
  const teamOptions = isSysAdmin ? teams : teams.filter(t => adminTeamIds.includes(t.id));
  // #2695: a value the list does not offer is rendered as its own option, never
  // masked by the first one (which the browser would otherwise show).
  const selectOptions = teamOptionsWithCurrent(teamOptions, own.teamId);
  const assignableTeams = teamOptionsWithAssigned(teams, own.assignedTeamIds);

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
        <>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-1)' }}>
            Scope controls which teams can see and use this environment. System-scoped is visible to all admins (and any teams you assign); Team-owned is limited to one team.
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <ScopeTab active={own.scope === 'system'} onClick={() => !disabled && setScope('system')}>
              System (assign to teams)
            </ScopeTab>
            <ScopeTab active={own.scope === 'team'} onClick={() => !disabled && setScope('team')}>
              Team-owned
            </ScopeTab>
          </div>
        </>
      )}

      {own.scope === 'system' ? (
        <div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-1)' }}>
            Assign to the teams that may use this environment. Assigning to no team keeps it visible to System Admins only.
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
            maxHeight: 180, overflowY: 'auto',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-2)',
          }}>
            {assignableTeams.length === 0 && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>No teams available.</div>
            )}
            {assignableTeams.map(t => (
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
            {selectOptions.map(t => (
              <option key={t.id} value={t.id}>{t.name || t.id}</option>
            ))}
          </select>
          {!isSysAdmin && (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
              You can assign environments only to teams you administer.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
