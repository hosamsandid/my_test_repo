import React from 'react';
import { Cpu, AlertTriangle } from 'lucide-react';
import { useModelSelection } from '../context/ModelSelectionContext';
import { selectionLabel, assistGroups } from '../context/assist-model-selection.js';
import { exclusionMessage } from '../context/assist-selector-exclusion.js';
import ModelSelectorPopover from './ModelSelectorPopover.jsx';

// Global assist model selector (#1212, concept §4.3). Lives in the Settings
// modal's Model section since #1805 (moved out of the Shell header). Since #1670 the
// popover itself is the shared ModelSelectorPopover, so it reads identically to
// the Agent-Chat runtime selector — this wrapper keeps the assist surface's own
// data (the per-user provider selection), its billing hint, its attention styling
// and its read-only chips for the env-fallback and no-provider states.

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

export default function AssistModelSelector() {
  const {
    providers, envFallbackActive, exclusionReason, selection, attention,
    pickerOpen, openPicker, closePicker, select,
  } = useModelSelection();

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
    const excl = exclusionMessage(exclusionReason);
    const chipTitle = excl
      ? `${excl.title} ${excl.detail}`
      : 'None of the registered model providers are available to your teams. AI helpers will not run until one is.';
    return (
      <Chip
        icon={<AlertTriangle size={16} />}
        text="No assist model available"
        title={chipTitle}
        muted
      />
    );
  }

  const label = selection ? selectionLabel(selection, providers) : 'Select assist model';

  return (
    <ModelSelectorPopover
      icon={attention ? <AlertTriangle size={16} /> : <Cpu size={16} />}
      label={label}
      title={selection ? `Assist model: ${label}` : 'Select the model provider AI helpers bill against'}
      ariaLabel="Assist model selector"
      tone={attention ? 'attention' : 'default'}
      open={pickerOpen}
      onOpenChange={(v) => (v ? openPicker() : closePicker())}
      hint="Model AI helpers bill against"
      groups={assistGroups(providers)}
      selection={selection}
      onSelect={(endpointId, modelId, close) => { select(endpointId, modelId); close(); }}
    />
  );
}
