import React from 'react';

// Radio-card Ownership control for Model Providers (#2360). ONE axis —
// Personal / Team / Global — replacing the old "Global checkbox + System(assign
// to teams) / Team-owned" pair. The option list (with enabled/disabledReason) is
// computed by provider-ownership-view.js (`providerOwnershipOptions`) and passed
// in; this is a thin renderer. A disabled option stays VISIBLE with its reason
// (discoverability, e.g. "System Admins only"). When "Team" is the active,
// enabled choice, an inline team picker appears beneath it.
//
// `value` is { scope: 'personal'|'team'|'global', teamId }; `onChange` receives
// the next state. `teams` is the ALREADY-FILTERED selectable team set.

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

export default function ProviderOwnership({ value, onChange, options = [], teams = [], disabled = false }) {
  const own = value || { scope: 'personal', teamId: '' };
  const pick = (scope) => {
    if (scope === 'team') onChange({ scope: 'team', teamId: own.teamId || teams[0]?.id || '' });
    else onChange({ scope, teamId: '' });
  };

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
                <select
                  value={own.teamId || ''}
                  onChange={e => onChange({ scope: 'team', teamId: e.target.value })}
                  style={{ ...selectStyle, marginTop: 'var(--eb-space-1)', marginLeft: 'var(--eb-space-5)', minWidth: 240 }}
                >
                  {!own.teamId && <option value="">Select a team…</option>}
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
