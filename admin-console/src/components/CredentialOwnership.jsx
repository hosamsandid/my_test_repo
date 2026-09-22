import React from 'react';
import { creatableScopes, IDENTITY_OPTIONS, IDENTITY_HUMAN, IDENTITY_SERVICE } from '../pages/credential-scope-view';

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

export default function CredentialOwnership({ value, onChange, teams = [], isSysAdmin, adminTeamIds = [], disabled = false, v2 = false, isEdit = false }) {
  const own = value || { scope: 'team', teamId: '', assignedTeamIds: [] };
  const scopes = creatableScopes({ isSysAdmin });
  const teamOptionsV2 = isSysAdmin ? teams : teams.filter(t => adminTeamIds.includes(t.id));

  // ── Unified model (#2360): the identity + scope PAIR replaces the raw scope
  // tabs. A `human` secret is Personal-only; a `service` one may also be team- or
  // system-shared (the durable, personnel-independent tiers). `identity` is
  // immutable once set, so on edit it is shown read-only. This branch is only
  // taken when the caller passes v2 (the AEE_RESOURCE_ACCESS_V2 flag) — off it,
  // the legacy scope tabs below are byte-identical to before.
  if (v2) {
    const identity = own.identity === IDENTITY_HUMAN || own.identity === IDENTITY_SERVICE ? own.identity : IDENTITY_SERVICE;
    // Scopes a service credential may be created at (human → personal only).
    const serviceScopes = ['personal', ...scopes]; // personal + team (+ system for sysadmin)

    const setIdentity = (next) => {
      if (next === IDENTITY_HUMAN) {
        onChange({ scope: 'personal', teamId: null, assignedTeamIds: [], identity: IDENTITY_HUMAN });
      } else {
        // Default a freshly-service credential to team-owned (the common shared
        // case), falling back to personal when the caller administers no team.
        const canTeam = isSysAdmin || teamOptionsV2.length > 0;
        onChange(canTeam
          ? { scope: 'team', teamId: own.teamId || teamOptionsV2[0]?.id || '', assignedTeamIds: [], identity: IDENTITY_SERVICE }
          : { scope: 'personal', teamId: null, assignedTeamIds: [], identity: IDENTITY_SERVICE });
      }
    };
    const setScopeV2 = (scope) => {
      if (scope === 'personal') onChange({ scope: 'personal', teamId: null, assignedTeamIds: [], identity });
      else if (scope === 'system') onChange({ scope: 'system', teamId: null, assignedTeamIds: own.assignedTeamIds || [], identity });
      else onChange({ scope: 'team', teamId: own.teamId || teamOptionsV2[0]?.id || '', assignedTeamIds: [], identity });
    };
    const toggleAssignedV2 = (id) => {
      const set = new Set(own.assignedTeamIds || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      onChange({ ...own, scope: 'system', assignedTeamIds: [...set], identity });
    };
    const scopeLabelV2 = { personal: 'Personal (private to you)', team: 'Team-owned', system: 'System (assign to teams)' };

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
                <ScopeTab key={s} active={own.scope === s} onClick={() => !disabled && setScopeV2(s)}>{scopeLabelV2[s]}</ScopeTab>
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
                    <input type="checkbox" disabled={disabled} checked={(own.assignedTeamIds || []).includes(t.id)} onChange={() => toggleAssignedV2(t.id)} />
                    {t.name || t.id}
                  </label>
                ))}
              </div>
            ) : own.scope === 'team' ? (
              <select value={own.teamId || ''} disabled={disabled}
                onChange={e => onChange({ scope: 'team', teamId: e.target.value, assignedTeamIds: [], identity })}
                style={selectStyle}>
                {!own.teamId && <option value="">Select a team…</option>}
                {teamOptionsV2.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Private to you — a personal service credential (e.g. a private bot key/token).</div>
            )}
          </div>
        )}
      </div>
    );
  }
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
        <>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-1)' }}>
            Scope controls who can see and use this credential. System-scoped is visible to all admins (and any teams you assign); Team-owned is limited to one team.
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
