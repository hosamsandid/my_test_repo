import React, { useMemo } from 'react';
import { pluginGrantRow, hasExpandableDetail } from '../pages/plugin-grant-view.js';
import OptionList from './OptionList';
import OptionRow from './OptionRow';

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
// live, the ceiling text, the platform match, whether there is anything to
// expand into) comes from the pure plugin-grant-view.js; this file only
// renders. The server re-enforces grantability — the UI bound is a courtesy,
// not the control.
//
// #2269: rows render on the shared OptionList/OptionRow shell (also used by
// SkillPicker and the MCP servers list) — a one-line description by default,
// the Scope selector/quota and any platform warning behind a per-row expand
// toggle, collapsed by default (D3).

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
    <OptionList>
      {rows.map((row) => (
        <OptionRow
          key={row.id}
          disabled={disabled}
          tinted={row.granted}
          summary={row.description || ''}
          expandedContent={hasExpandableDetail(row) ? (
            <>
              {row.description && <div>{row.description}</div>}
              {!row.platform.ok && (
                <div style={{ color: 'var(--eb-warn-fg, #8a6d00)' }}>{row.platform.message}</div>
              )}
              {row.granted && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
                  <span style={{ color: 'var(--eb-text-muted)' }}>Scope</span>
                  <select
                    value={row.selector.value}
                    disabled={disabled || row.selector.disabled}
                    onChange={(e) => onGranularity(row.id, e.target.value)}
                    style={selectStyle}
                  >
                    {row.selector.options.map((o) => (
                      <option key={o} value={o}>{GRANULARITY_LABEL[o] || o}</option>
                    ))}
                  </select>
                  <span style={{ color: 'var(--eb-text-muted)' }}>{row.quota.label}</span>
                </div>
              )}
              {row.granted && row.selector.hint && (
                <div style={{ color: 'var(--eb-text-muted)' }}>{row.selector.hint}</div>
              )}
            </>
          ) : null}
          header={
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
                {!row.platform.ok && (
                  <span
                    title={row.platform.message}
                    style={{
                      fontSize: 'var(--eb-text-xs)',
                      color: 'var(--eb-warn-fg, #8a6d00)',
                      border: '1px solid var(--eb-warn-fg, #8a6d00)',
                      borderRadius: 'var(--eb-radius-sm)',
                      padding: '0 6px',
                      marginLeft: 'var(--eb-space-2)',
                    }}
                  >platform mismatch</span>
                )}
              </span>
            </label>
          }
        />
      ))}
    </OptionList>
  );
}
