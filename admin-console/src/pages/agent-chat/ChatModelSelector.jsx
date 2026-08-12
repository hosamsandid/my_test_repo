import React, { useState } from 'react';
import { Zap, Loader2, AlertTriangle } from 'lucide-react';
import ModelSelectorPopover from '../../components/ModelSelectorPopover.jsx';
import {
  CHAT_HINT,
  buildChatGroups,
  chatSelection,
  chatSelectable,
  chatTrigger,
  chatNotice,
  resolveChatSelectAction,
  chatResetAction,
} from './chat-model-selector.js';

// Agent-Chat toolbar model/provider selector (#1670). Replaces the old separate
// ProviderChip + native model <select>: one provider-grouped popover (the shared
// ModelSelectorPopover) that switches the agent's model live and its provider via
// a confirmation (a provider switch restarts the container). Network calls stay in
// ChatPanel and arrive here as callbacks:
//   onModel(modelId | null)                — PATCH /model (live)
//   onProvider(endpointId | null, modelId) — PATCH /provider (respawn) then, if a
//                                            non-default model was chosen, PATCH /model
//   onReset()                              — clear the per-agent override(s)
//   onOpen()                               — refetch options when the popover opens
export default function ChatModelSelector({ options, disabled, busy, onModel, onProvider, onReset, onOpen }) {
  const [pending, setPending] = useState(null); // { endpointId, modelId, providerName }

  if (!options) return null;

  const groups = buildChatGroups(options);
  const selection = chatSelection(options);
  const selectable = chatSelectable(options) && !disabled;
  const trig = chatTrigger(options);
  const notice = chatNotice(options);
  const reset = chatResetAction(options);

  const confirm = pending
    ? (close) => (
      <div style={{ padding: 'var(--eb-space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--eb-status-warning)', marginTop: 2 }} />
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.4 }}>
            Switch this agent to <strong>{pending.providerName}</strong>? This restarts the agent
            container to apply the new provider; the chat session is preserved.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end', marginTop: 'var(--eb-space-2)' }}>
          <button
            type="button"
            onClick={() => setPending(null)}
            disabled={busy}
            style={{
              background: 'none', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-text-secondary)',
              cursor: busy ? 'default' : 'pointer', padding: 'var(--eb-space-1) var(--eb-space-2)',
              fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              const p = pending;
              await onProvider(p.endpointId, p.modelId);
              setPending(null);
              close();
            }}
            disabled={busy}
            style={{
              background: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)',
              borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-text-inverted)',
              cursor: busy ? 'default' : 'pointer', padding: 'var(--eb-space-1) var(--eb-space-2)',
              fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            }}
          >
            {busy && <Loader2 size={13} className="kf-spin" />}
            Switch &amp; restart
          </button>
        </div>
      </div>
    )
    : null;

  const footer = (selectable && reset.kind !== 'none')
    ? (close) => (
      <button
        type="button"
        onClick={() => { onReset(); close(); }}
        disabled={busy}
        title="Clear the per-agent override and fall back to the environment default"
        style={{
          background: 'none', border: 'none', padding: 'var(--eb-space-1) var(--eb-space-2)',
          color: 'var(--eb-accent-primary)', cursor: busy ? 'default' : 'pointer',
          textDecoration: 'underline', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
        }}
      >
        Reset to environment default
      </button>
    )
    : (selectable
      ? () => (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4, padding: '0 var(--eb-space-2)' }}>
          Switching providers briefly restarts the agent container; the chat session is preserved.
        </div>
      )
      : null);

  return (
    <ModelSelectorPopover
      icon={busy ? <Loader2 size={16} className="kf-spin" /> : <Zap size={16} />}
      label={trig.label}
      title={trig.title}
      ariaLabel="Agent model and provider selector"
      tone={trig.tone}
      disabled={disabled}
      showOverrideDot={trig.showOverrideDot}
      onOpenChange={(open) => { if (open) { onOpen && onOpen(); } else { setPending(null); } }}
      hint={CHAT_HINT}
      notice={notice}
      groups={groups}
      selection={selection}
      selectable={selectable}
      onSelect={(gid, mid, close) => {
        const act = resolveChatSelectAction(options, gid, mid);
        if (act.kind === 'model') {
          onModel(act.modelId);
          close();
        } else {
          setPending({ endpointId: act.endpointId, modelId: act.modelId, providerName: act.providerName });
        }
      }}
      confirm={confirm}
      footer={footer}
    />
  );
}
