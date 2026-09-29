import React from 'react';
import { IDENTITY_OPTIONS, IDENTITY_HUMAN, IDENTITY_SERVICE } from '../pages/credential-scope-view';

// Ownership selector shared by the SSH Keys and GitHub Tokens create/edit forms
// (#798, unified model #2360): the identity + scope PAIR. A `human` secret is
// Personal-only; a `service` one may also be team- or system-shared. A Team Admin
// only ever shares with a team they administer; a System Admin may also create a
// system-scoped credential assigned to 0..n teams.
//
// `value` is an ownership state { scope, teamId, assignedTeamIds, identity };
// `onChange` receives the next state. Pure presentational — no fetch of its own.

export const labelStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)',
  marginBottom: 'var(--eb-space-1)',
};

export const selectStyle = {
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

export function ScopeTab({ active, onClick, children }) {
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

export default function CredentialOwnership({ value, onChange, teams = [], isSysAdmin, adminTeamIds = [], disabled = false, isEdit = false }) {
  const own = value || { scope: 'team', teamId: '', assignedTeamIds: [] };
  const teamOptions = isSysAdmin ? teams : teams.filter(t => adminTeamIds.includes(t.id));

  const identity = own.identity === IDENTITY_HUMAN || own.identity === IDENTITY_SERVICE ? own.identity : IDENTITY_SERVICE;
  // Scopes a service credential may be created at (human → personal only).
  const serviceScopes = isSysAdmin ? ['personal', 'system', 'team'] : ['personal', 'team'];

  const setIdentity = (next) => {
    if (next === IDENTITY_HUMAN) {
      onChange({ scope: 'personal', teamId: null, assignedTeamIds: [], identity: IDENTITY_HUMAN });
    } else {
      // Default a freshly-service credential to team-owned (the common shared
      // case), falling back to personal when the caller administers no team.
      const canTeam = isSysAdmin || teamOptions.length > 0;
      onChange(canTeam
        ? { scope: 'team', teamId: own.teamId || teamOptions[0]?.id || '', assignedTeamIds: [], identity: IDENTITY_SERVICE }
        : { scope: 'personal', teamId: null, assignedTeamIds: [], identity: IDENTITY_SERVICE });
    }
  };
  const setScope = (scope) => {
    if (scope === 'personal') onChange({ scope: 'personal', teamId: null, assignedTeamIds: [], identity });
    else if (scope === 'system') onChange({ scope: 'system', teamId: null, assignedTeamIds: own.assignedTeamIds || [], identity });
    else onChange({ scope: 'team', teamId: own.teamId || teamOptions[0]?.id || '', assignedTeamIds: [], identity });
  };
  const toggleAssigned = (id) => {
    const set = new Set(own.assignedTeamIds || []);
    if (set.has(id)) set.delete(id); else set.add(id);
    onChange({ ...own, scope: 'system', assignedTeamIds: [...set], identity });
  };
  const scopeLabel = { personal: 'Personal (private to you)', team: 'Team-owned', system: 'System (assign to teams)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div>
        <div style={labelStyle}>Identity</div>
        {isEdit ? (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {IDENTITY_OPTIONS.find(o => o.value === identity)?.label}
            <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Identity is fixed once set — delete and recreate to reclassify.
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            {IDENTITY_OPTIONS.map(opt => (
              <label key={opt.value} style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start', cursor: disabled ? 'default' : 'pointer' }}>
                <input type="radio" name="cred-identity" disabled={disabled}
                  checked={identity === opt.value} onChange={() => !disabled && setIdentity(opt.value)}
                  style={{ marginTop: 3, flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
                  <strong>{opt.label}</strong>
                  <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {identity === IDENTITY_HUMAN ? (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          A personal identity is <strong>Personal</strong> — private to you. A team consumes it only as a lend while you are a member.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <div style={labelStyle}>Scope</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            {serviceScopes.map(s => (
              <ScopeTab key={s} active={own.scope === s} onClick={() => !disabled && setScope(s)}>{scopeLabel[s]}</ScopeTab>
            ))}
          </div>
          {own.scope === 'system' ? (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)', maxHeight: 180, overflowY: 'auto',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
            }}>
              {teams.length === 0 && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>No teams available.</div>}
              {teams.map(t => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', cursor: disabled ? 'default' : 'pointer' }}>
                  <input type="checkbox" disabled={disabled} checked={(own.assignedTeamIds || []).includes(t.id)} onChange={() => toggleAssigned(t.id)} />
                  {t.name || t.id}
                </label>
              ))}
            </div>
          ) : own.scope === 'team' ? (
            <select value={own.teamId || ''} disabled={disabled}
              onChange={e => onChange({ scope: 'team', teamId: e.target.value, assignedTeamIds: [], identity })}
              style={selectStyle}>
              {!own.teamId && <option value="">Select a team…</option>}
              {teamOptions.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
            </select>
          ) : (
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Private to you — a personal service credential (e.g. a private bot key/token).</div>
          )}
        </div>
      )}
    </div>
  );
}
