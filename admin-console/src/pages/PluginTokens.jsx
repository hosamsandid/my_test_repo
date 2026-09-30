import React, { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import ConfirmDialog from '../components/ConfirmDialog';
import PageHelpButton from '../components/PageHelpButton';
import WhenCell from '../components/WhenCell';
import {
  describePluginTokenStatus, teamConnectionNote, initialFormValues, valuesToSubmit, submitBlockers,
} from './plugin-tokens-view.js';

// #2562: the caller's OWN credential for plugins that act as a person (Jira).
// Always self-service — the API takes the user from the session, so this page
// can only ever show or change the signed-in member's own entry.

const inputStyle = {
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

const cardStyle = {
  padding: 'var(--eb-space-4)',
  background: 'var(--eb-bg-surface, var(--eb-bg-elevated))',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
};

const primaryButtonStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit',
};

const secondaryButtonStyle = {
  ...primaryButtonStyle,
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
};

const STATE_COLOR = {
  set: 'var(--eb-status-success)',
  incomplete: 'var(--eb-status-warning)',
  unset: 'var(--eb-text-muted)',
};

function PluginTokenCard({ plugin, onChanged }) {
  const [form, setForm] = useState(() => initialFormValues(plugin));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = describePluginTokenStatus(plugin);
  const connectionNote = teamConnectionNote(plugin);
  const blockers = submitBlockers(plugin, form);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const updated = await apiCall('PUT', `/api/me/plugin-credentials/${encodeURIComponent(plugin.pluginId)}`, { values: valuesToSubmit(plugin, form) });
      setForm(initialFormValues(updated));
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false); setError(null);
    try {
      const updated = await apiCall('DELETE', `/api/me/plugin-credentials/${encodeURIComponent(plugin.pluginId)}`);
      setForm(initialFormValues(updated));
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <section aria-label={`${plugin.name} personal credential`} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <KeyRound size={16} />
        <strong style={{ fontSize: 'var(--eb-text-md)' }}>{plugin.name}</strong>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: STATE_COLOR[status.state] }}>{status.label}</span>
        {status.setAt && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            · saved <WhenCell iso={status.setAt} />
          </span>
        )}
      </div>

      {connectionNote && (
        <div style={{
          marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-3)',
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-warn-fg, #8a6d00)',
          background: 'var(--eb-warn-bg, rgba(138,109,0,0.08))',
          border: '1px solid var(--eb-warn-fg, #8a6d00)', borderRadius: 'var(--eb-radius-sm)',
        }}>
          {connectionNote}
        </div>
      )}

      {plugin.credentials.map((c) => {
        const meta = plugin.keys && plugin.keys[c.key];
        return (
          <label key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)', fontSize: 'var(--eb-text-sm)' }}>
            <span>
              {c.label || c.key}{c.required ? ' *' : ''}
              {c.secret && meta && meta.set && (
                <span style={{ marginLeft: 'var(--eb-space-2)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
                  stored: {meta.preview}
                </span>
              )}
            </span>
            <input
              type={c.secret ? 'password' : 'text'}
              autoComplete="off"
              value={form[c.key] || ''}
              placeholder={c.secret && meta && meta.set ? 'Leave empty to keep the stored value' : ''}
              onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}
              style={inputStyle}
            />
            {c.description && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{c.description}</span>}
          </label>
        );
      })}

      {error && <div role="alert" style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
        <button onClick={save} disabled={saving || blockers.length > 0} style={{ ...primaryButtonStyle, opacity: saving || blockers.length > 0 ? 0.5 : 1 }}>
          {saving ? 'Saving…' : status.state === 'unset' ? 'Save' : 'Update'}
        </button>
        {status.state !== 'unset' && (
          <button onClick={() => setConfirmDelete(true)} style={secondaryButtonStyle}>
            <Trash2 size={14} /> Delete
          </button>
        )}
        {blockers.length > 0 && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            Required: {blockers.join(', ')}
          </span>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          open
          title={`Delete your ${plugin.name} credential?`}
          message={`Chat turns that use ${plugin.name} will be refused until you add a new one. Automated runs are not affected.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}

export default function PluginTokens() {
  const { data, loading, error, refetch } = useApi('/api/me/plugin-credentials');
  const plugins = (data && Array.isArray(data.plugins)) ? data.plugins : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', maxWidth: 720 }}>
      <p style={{
        margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        <span>
          Your own credentials for plugins that act as you. When you chat with an agent, the plugin uses these — never the team's service account. Only you can see or change them.
        </span>
        <PageHelpButton label="How are plugin tokens used?" size={14} style={{ padding: 0, flexShrink: 0 }} />
      </p>

      {loading && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Loading…</div>}
      {error && <div role="alert" style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>Could not load your plugin tokens: {error}</div>}
      {!loading && !error && plugins.length === 0 && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          No installed plugin needs a personal credential.
        </div>
      )}
      {plugins.map((p) => <PluginTokenCard key={p.pluginId} plugin={p} onChanged={refetch} />)}
    </div>
  );
}
