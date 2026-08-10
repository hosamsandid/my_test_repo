import React, { useMemo } from 'react';
import { pluginGrantRow } from '../pages/plugin-grant-view.js';

// Plugin grant picker (#1547) — the sibling of SkillPicker, and deliberately
// the same shape: one row per installed plugin, a checkbox for the grant, and
// the grant lives on the agent construct (never on the environment).
//
// What a plugin adds over a skill is the SCOPE GRANULARITY selector: "team"
// gives a squad one shared broker-side pool, "agent" gives each member its own.
// That choice multiplies the per-scope quota, so the resulting ceiling is
// stated before the toggle rather than discovered later as a full disk.
//
// Every decision here (which granularities are offered, whether the selector is
// live, the ceiling text, the platform match) comes from the pure
// plugin-grant-view.js; this file only renders. The server re-enforces
// grantability — the UI bound is a courtesy, not the control.

const selectStyle = {
  padding: '2px 6px',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  color: 'var(--eb-text-primary)',
};

const GRANULARITY_LABEL = { team: 'Shared per team', agent: 'Per agent' };

export default function PluginGrantPicker({
  plugins,          // installed registry entries: [{ id, ok, manifest }]
  grants,           // resolved grant: [{ id, scopeGranularity }]
  onToggle,         // (pluginId, active, scopeGranularity) => void
  onGranularity,    // (pluginId, granularity) => void
  memberCount = 1,
  stackRuntime = 'podman',
  disabled = false,
  emptyHint,
}) {
  const granted = Array.isArray(grants) ? grants : [];
  const rows = useMemo(() => (plugins || [])
    .filter((p) => p && p.ok && p.manifest)
    .map((p) => pluginGrantRow(
      p.manifest,
      granted.find((g) => g.id === p.id) || null,
      { memberCount, stackRuntime },
    )), [plugins, granted, memberCount, stackRuntime]);

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        {emptyHint || 'No plugins installed. A System Admin installs them on the Plugins page.'}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      {rows.map((row) => (
        <div
          key={row.id}
          style={{
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: row.granted ? 'var(--eb-bg-elevated)' : 'transparent',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', cursor: disabled ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={row.granted}
              disabled={disabled}
              onChange={(e) => onToggle(row.id, e.target.checked, row.granularity)}
              style={{ marginTop: 3, flex: '0 0 auto' }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 500 }}>{row.name}</span>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginLeft: 'var(--eb-space-2)' }}>{row.id}</span>
              {row.description && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 2 }}>
                  {row.description}
                </div>
              )}
              {!row.platform.ok && (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-warn-fg, #8a6d00)', marginTop: 2 }}>
                  {row.platform.message}
                </div>
              )}
            </span>
          </label>

          {row.granted && (
            <div style={{ marginTop: 'var(--eb-space-2)', marginLeft: 24, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Scope</span>
              <select
                value={row.selector.value}
                disabled={disabled || row.selector.disabled}
                onChange={(e) => onGranularity(row.id, e.target.value)}
                style={selectStyle}
                title={row.selector.hint}
              >
                {row.selector.options.map((o) => (
                  <option key={o} value={o}>{GRANULARITY_LABEL[o] || o}</option>
                ))}
              </select>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                {row.quota.label}
              </span>
            </div>
          )}
          {row.granted && row.selector.hint && (
            <div style={{ marginTop: 2, marginLeft: 24, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              {row.selector.hint}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
