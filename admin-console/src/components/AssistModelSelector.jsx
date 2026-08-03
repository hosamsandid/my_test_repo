import React, { useEffect, useRef } from 'react';
import { Cpu, Check, AlertTriangle, ChevronDown } from 'lucide-react';
import { useModelSelection } from '../context/ModelSelectionContext';
import { selectionLabel } from '../context/assist-model-selection.js';

// Header control for the global assist model selector (#1212, concept §4.3).
// Sits in the Shell right-cluster left of the theme toggle. Compact button
// "<Provider> · <model>" opening a popover of provider groups + model radios;
// attention styling when unselected with ≥2 providers; read-only chips for the
// env-fallback and no-provider states.

const iconBtnBase = {
  background: 'none',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  maxWidth: 240,
  transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
};

// A non-interactive chip (env-fallback / no-provider states).
function Chip({ icon, text, title, muted }) {
  return (
    <span
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-1) var(--eb-space-2)',
        fontSize: 'var(--eb-text-sm)',
        color: muted ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
        cursor: 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </span>
  );
}

function ScopeBadge({ scope }) {
  const isSystem = scope === 'system';
  return (
    <span style={{
      fontSize: 'var(--eb-text-xs)',
      color: 'var(--eb-text-muted)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-sm)',
      padding: '0 var(--eb-space-1)',
      textTransform: 'capitalize',
    }}>
      {isSystem ? 'System' : 'Team'}
    </span>
  );
}

export default function AssistModelSelector() {
  const {
    providers, envFallbackActive, selection, attention,
    pickerOpen, openPicker, closePicker, select,
  } = useModelSelection();
  const wrapRef = useRef(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) closePicker(); };
    const onKey = (e) => { if (e.key === 'Escape') closePicker(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen, closePicker]);

  // Bootstrap install: zero providers registered but the .env fallback is live.
  if (envFallbackActive) {
    return (
      <Chip
        icon={<Cpu size={16} />}
        text="Built-in (.env)"
        title="No model providers registered — AI helpers use the built-in .env model."
        muted
      />
    );
  }

  // No selectable providers and no fallback: helpers stay visible but will fail
  // server-side until a provider the user's team can use is registered.
  if (!providers || providers.length === 0) {
    return (
      <Chip
        icon={<AlertTriangle size={16} />}
        text="No assist model available"
        title="None of the registered model providers are available to your teams. AI helpers will not run until one is."
        muted
      />
    );
  }

  const label = selection ? selectionLabel(selection, providers) : 'Select assist model';
  const buttonStyle = {
    ...iconBtnBase,
    ...(attention ? {
      border: '1px solid var(--eb-status-warning)',
      color: 'var(--eb-status-warning)',
      background: 'var(--eb-status-warning-bg)',
    } : {}),
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => (pickerOpen ? closePicker() : openPicker())}
        title={selection ? `Assist model: ${label}` : 'Select the model provider AI helpers bill against'}
        aria-label="Assist model selector"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        style={buttonStyle}
        onMouseEnter={e => { if (!attention) { e.currentTarget.style.background = 'var(--eb-bg-hover)'; e.currentTarget.style.color = 'var(--eb-text-primary)'; } }}
        onMouseLeave={e => { if (!attention) { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--eb-text-secondary)'; } }}
      >
        {attention ? <AlertTriangle size={16} /> : <Cpu size={16} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {pickerOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--eb-space-2))',
            right: 0,
            minWidth: 260,
            maxWidth: 340,
            maxHeight: '70vh',
            overflowY: 'auto',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            boxShadow: 'var(--eb-shadow-lg)',
            padding: 'var(--eb-space-2)',
            zIndex: 50,
          }}
        >
          <div style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            padding: 'var(--eb-space-1) var(--eb-space-2)',
          }}>
            Model AI helpers bill against
          </div>
          {providers.map(p => {
            const models = Array.isArray(p.models) ? p.models : [];
            return (
              <div key={p.id} style={{ marginTop: 'var(--eb-space-2)' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                  padding: 'var(--eb-space-1) var(--eb-space-2)',
                  fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-primary)',
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.id}</span>
                  <ScopeBadge scope={p.scope} />
                </div>
                {models.length === 0 && (
                  <div style={{
                    fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
                    padding: 'var(--eb-space-1) var(--eb-space-2)',
                  }}>
                    No models configured
                  </div>
                )}
                {models.map(m => {
                  const isDefault = m.id === p.defaultModelId;
                  const isSelected = selection && selection.endpointId === p.id && selection.modelId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={!!isSelected}
                      onClick={() => select(p.id, m.id)}
                      style={{
                        width: '100%',
                        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                        background: isSelected ? 'var(--eb-bg-hover)' : 'none',
                        border: 'none',
                        borderRadius: 'var(--eb-radius-sm)',
                        color: 'var(--eb-text-primary)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        padding: 'var(--eb-space-1) var(--eb-space-2)',
                        fontFamily: 'inherit',
                        fontSize: 'var(--eb-text-sm)',
                      }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'none'; }}
                    >
                      <Check size={14} style={{ flexShrink: 0, opacity: isSelected ? 1 : 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.displayName || m.id}
                      </span>
                      {isDefault && (
                        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
                          default
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
