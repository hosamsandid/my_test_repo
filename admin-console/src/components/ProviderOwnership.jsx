import React from 'react';

// Radio-card Ownership control for Model Providers (#2360). ONE axis —
// Personal / Team(s) / Global — replacing the old "Global checkbox + System(assign
// to teams) / Team-owned" pair. "Team(s)" is a co-owned SET of agent teams: a
// provider can serve several teams without being duplicated, and cloning a team
// appends the clone to the set (server-side). The option list (enabled/
// disabledReason) is computed by provider-ownership-view.js and passed in.
//
// `value` is { scope: 'personal'|'team'|'global', teamIds: string[] }; `onChange`
// receives the next state. `teams` is the ALREADY-FILTERED selectable team set
// (the agent teams the caller may assign, each { id, name }).

const labelStyle = {
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)',
};
const hintStyle = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' };
const selectStyle = {
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', boxSizing: 'border-box',
};
const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
  padding: '2px var(--eb-space-2)', borderRadius: 'var(--eb-radius-sm)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)',
};

export default function ProviderOwnership({ value, onChange, options = [], teams = [], disabled = false }) {
  const own = value || { scope: 'personal', teamIds: [] };
  const teamIds = Array.isArray(own.teamIds) ? own.teamIds : [];
  const nameOf = (id) => (teams.find(t => t.id === id)?.name) || `${id} (legacy)`;
  const available = teams.filter(t => !teamIds.includes(t.id));

  const pick = (scope) => {
    if (scope === 'team') onChange({ scope: 'team', teamIds: teamIds.length ? teamIds : [] });
    else onChange({ scope, teamIds: [] });
  };
  const addTeam = (id) => { if (id && !teamIds.includes(id)) onChange({ scope: 'team', teamIds: [...teamIds, id] }); };
  const removeTeam = (id) => onChange({ scope: 'team', teamIds: teamIds.filter(t => t !== id) });

  return (
    <div>
      <div style={labelStyle}>Ownership</div>
      <div style={hintStyle}>Who can use this provider?</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {options.map(opt => {
          const active = own.scope === opt.value;
          const off = disabled || !opt.enabled;
          return (
            <div key={opt.value}>
              <label style={{
                display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start',
                cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.55 : 1,
              }}>
                <input
                  type="radio"
                  name="provider-ownership"
                  disabled={off}
                  checked={active}
                  onChange={() => !off && pick(opt.value)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
                  <strong>{opt.label}</strong>
                  {opt.value === 'global' && !opt.enabled && !disabled && (
                    <span style={{ color: 'var(--eb-text-muted)' }}> — {opt.disabledReason}</span>
                  )}
                  <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                    {opt.enabled ? opt.hint : (opt.disabledReason || opt.hint)}
                  </span>
                </span>
              </label>

              {opt.value === 'team' && active && !off && (
                <div style={{ marginLeft: 'var(--eb-space-5)', marginTop: 'var(--eb-space-1)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Usable by these agent teams:</div>
                  {teamIds.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1)' }}>
                      {teamIds.map(id => (
                        <span key={id} style={chipStyle}>
                          {nameOf(id)}
                          <button
                            type="button"
                            onClick={() => removeTeam(id)}
                            title="Remove team"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-muted)', padding: 0, lineHeight: 1, fontSize: 'var(--eb-text-sm)' }}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  {available.length > 0 && (
                    <select
                      value=""
                      onChange={e => { addTeam(e.target.value); e.target.value = ''; }}
                      style={{ ...selectStyle, minWidth: 240, marginTop: 'var(--eb-space-1)' }}
                    >
                      <option value="">{teamIds.length ? '+ Add another team…' : 'Select a team…'}</option>
                      {available.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                    </select>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
