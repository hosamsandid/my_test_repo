import React, { useState, useEffect } from 'react';
import { Trash2, Plus, Pencil, Check, X, RefreshCw, PlugZap } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

/* ───────────────────────── shared styles ───────────────────────── */

const buttonPrimary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const buttonSecondary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};

const buttonGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
};

/* ─────────────────── Sub: per-endpoint model editor ─────────────────── */

function ModelEditor({ models, onChange }) {
  const update = (i, patch) => {
    const next = models.map((m, idx) => idx === i ? { ...m, ...patch } : m);
    onChange(next);
  };
  const remove = (i) => onChange(models.filter((_, idx) => idx !== i));
  const add = () => onChange([...models, { id: '', displayName: '', kind: '' }]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 110px 32px',
        gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        <div>Model ID</div>
        <div>Display name</div>
        <div>Kind</div>
        <div></div>
      </div>

      {models.length === 0 && (
        <div style={{
          padding: 'var(--eb-space-3)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          background: 'var(--eb-bg-elevated)',
          borderRadius: 'var(--eb-radius-md)',
          textAlign: 'center',
        }}>
          No models yet. Add one or import from the proxy.
        </div>
      )}

      {models.map((m, i) => (
        <div key={i} style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 110px 32px',
          gap: 'var(--eb-space-2)',
          alignItems: 'center',
        }}>
          <input
            value={m.id || ''}
            onChange={e => update(i, { id: e.target.value })}
            placeholder="claude-sonnet-4-6"
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              outline: 'none',
            }}
          />
          <input
            value={m.displayName || ''}
            onChange={e => update(i, { displayName: e.target.value })}
            placeholder="Sonnet 4.6"
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              outline: 'none',
            }}
          />
          <select
            value={m.kind || ''}
            onChange={e => update(i, { kind: e.target.value || undefined })}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          >
            <option value="">—</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
          <button
            onClick={() => remove(i)}
            aria-label="Remove model"
            title="Remove"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32,
              background: 'transparent',
              border: '1px solid var(--eb-status-error)',
              color: 'var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        style={{ ...buttonGhost, alignSelf: 'flex-start' }}
      >
        <Plus size={13} /> Add model
      </button>
    </div>
  );
}

/* ─────────────────── Sub: endpoint form (create + edit) ─────────────────── */

function EndpointForm({ endpoint, onSave, onCancel, saving, error }) {
  const isEdit = Boolean(endpoint?.id);
  const [name, setName] = useState(endpoint?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '');
  const [authToken, setAuthToken] = useState('');         // empty = leave as-is on edit
  const [clearToken, setClearToken] = useState(false);
  const [models, setModels] = useState(endpoint?.models ?? []);

  // test / discover state — only meaningful for an existing (saved) endpoint
  const [probing, setProbing] = useState(null);            // 'test' | 'discover' | null
  const [probeMsg, setProbeMsg] = useState(null);          // { ok, text }
  const [discovered, setDiscovered] = useState(null);      // suggestion list pending merge

  const canSubmit = name.trim() && baseUrl.trim();

  async function runTest() {
    if (!isEdit) {
      setProbeMsg({ ok: false, text: 'Save the endpoint first, then run a test.' });
      return;
    }
    setProbing('test'); setProbeMsg(null);
    try {
      const r = await apiCall('POST', `/api/llm-endpoints/${endpoint.id}/test`);
      setProbeMsg({
        ok: r.ok,
        text: r.ok
          ? `OK (HTTP ${r.status}) — ${r.url}`
          : `Failed: ${r.error || 'HTTP ' + r.status} — ${r.url}`,
      });
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  async function runDiscover() {
    if (!isEdit) {
      setProbeMsg({ ok: false, text: 'Save the endpoint first, then discover models.' });
      return;
    }
    setProbing('discover'); setProbeMsg(null);
    try {
      const r = await apiCall('POST', `/api/llm-endpoints/${endpoint.id}/discover-models`);
      setDiscovered(r.models || []);
      setProbeMsg({ ok: true, text: `Found ${r.count ?? r.models?.length ?? 0} model(s) at ${r.url}` });
    } catch (e) {
      setProbeMsg({ ok: false, text: e.message });
    } finally {
      setProbing(null);
    }
  }

  function applyDiscovered(mode) {
    if (!discovered) return;
    if (mode === 'replace') {
      setModels(discovered);
    } else {
      // merge: keep existing rows by id, add unknown ones from suggestion
      const existingIds = new Set(models.map(m => m.id));
      const additions = discovered.filter(m => !existingIds.has(m.id));
      setModels([...models, ...additions]);
    }
    setDiscovered(null);
  }

  function submit() {
    const payload = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      models: models
        .filter(m => m.id && m.id.trim())
        .map(m => ({
          id: m.id.trim(),
          displayName: (m.displayName || m.id).trim(),
          ...(m.kind ? { kind: m.kind } : {}),
        })),
    };
    if (clearToken)        payload.authToken = '';
    else if (authToken.trim()) payload.authToken = authToken.trim();
    // else: undefined → server keeps existing token (only relevant on edit)
    onSave(payload);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <FormInput
        label="Name"
        required
        value={name}
        onChange={setName}
        placeholder="e.g. LiteLLM Prod"
      />

      <FormInput
        label="Base URL"
        required
        type="url"
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://litellm.example/v1"
      />

      {/* Token field — different copy for create vs edit */}
      <div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-1)',
        }}>
          Auth token {!isEdit && <span style={{ color: 'var(--eb-text-muted)', fontWeight: 'normal' }}>(optional)</span>}
        </div>
        {isEdit && endpoint.hasToken && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            marginBottom: 'var(--eb-space-2)',
            fontFamily: 'var(--eb-font-mono)',
          }}>
            Current: {endpoint.tokenPreview} · {endpoint.tokenFingerprint}
          </div>
        )}
        {isEdit && !endpoint.hasToken && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-status-warning)',
            marginBottom: 'var(--eb-space-2)',
          }}>
            No token stored — Test/Discover will hit the proxy unauthenticated. Paste the token below and save.
          </div>
        )}
        <textarea
          value={authToken}
          disabled={clearToken}
          onChange={e => setAuthToken(e.target.value)}
          rows={2}
          placeholder={
            isEdit
              ? endpoint.hasToken
                ? 'Leave empty to keep current token'
                : 'Paste auth token (sent as Bearer to the proxy)'
              : 'sk-… (sent as Bearer token to the proxy)'
          }
          style={{
            width: '100%',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-xs)',
            resize: 'vertical',
            outline: 'none',
            opacity: clearToken ? 0.5 : 1,
            boxSizing: 'border-box',
          }}
        />
        {isEdit && endpoint.hasToken && (
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)',
            marginTop: 'var(--eb-space-1)', cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={clearToken}
              onChange={e => setClearToken(e.target.checked)}
            />
            Remove stored token on save
          </label>
        )}
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Stored in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>/workspace/llm-endpoints/_keys/</code> (chmod 600). API never returns the raw value — only a preview and fingerprint.
        </div>
      </div>

      {/* Test + Discover */}
      <div style={{
        display: 'flex',
        gap: 'var(--eb-space-2)',
        flexWrap: 'wrap',
        alignItems: 'center',
        paddingTop: 'var(--eb-space-2)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button
          type="button"
          onClick={runTest}
          disabled={!isEdit || probing === 'test'}
          style={{ ...buttonGhost, opacity: !isEdit || probing === 'test' ? 0.6 : 1 }}
          title={isEdit ? 'Send GET /v1/models to verify connectivity' : 'Save first, then test'}
        >
          <PlugZap size={13} /> {probing === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          onClick={runDiscover}
          disabled={!isEdit || probing === 'discover'}
          style={{ ...buttonGhost, opacity: !isEdit || probing === 'discover' ? 0.6 : 1 }}
          title={isEdit ? 'Fetch /v1/models from the proxy' : 'Save first, then discover'}
        >
          <RefreshCw size={13} /> {probing === 'discover' ? 'Loading…' : 'Discover models'}
        </button>
        {(authToken.trim() || clearToken) && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>
            Unsaved token change — click "Save changes" first; Test/Discover use the persisted value.
          </span>
        )}
        {probeMsg && (
          <span style={{
            fontSize: 'var(--eb-text-xs)',
            color: probeMsg.ok ? 'var(--eb-status-success)' : 'var(--eb-status-error)',
          }}>{probeMsg.text}</span>
        )}
      </div>

      {discovered && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-accent-primary)',
          borderRadius: 'var(--eb-radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        }}>
          <div style={{ fontSize: 'var(--eb-text-sm)' }}>
            {discovered.length} model(s) returned by the proxy. Apply to the catalog below?
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => applyDiscovered('merge')} style={buttonPrimary}>
              <Check size={13} /> Merge into catalog
            </button>
            <button type="button" onClick={() => applyDiscovered('replace')} style={buttonSecondary}>
              Replace catalog
            </button>
            <button type="button" onClick={() => setDiscovered(null)} style={buttonSecondary}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-2)',
        }}>
          Models
        </div>
        <ModelEditor models={models} onChange={setModels} />
      </div>

      <div style={{
        display: 'flex',
        gap: 'var(--eb-space-2)',
        paddingTop: 'var(--eb-space-3)',
        borderTop: '1px solid var(--eb-border-default)',
      }}>
        <button
          onClick={submit}
          disabled={saving || !canSubmit}
          style={{ ...buttonPrimary, cursor: saving ? 'wait' : 'pointer', opacity: (saving || !canSubmit) ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create endpoint'}
        </button>
        <button onClick={onCancel} style={buttonSecondary}>Cancel</button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Page ───────────────────────────── */

export default function ModelRegistry() {
  const { data: endpoints, loading, error, refetch } = useApi('/api/llm-endpoints');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing]   = useState(null);    // endpoint object
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  // When the endpoint list refetches after a successful edit, sync the open
  // panel with the fresh masked record (token preview/fingerprint, etc.).
  useEffect(() => {
    if (!editing || !endpoints) return;
    const fresh = endpoints.find(e => e.id === editing.id);
    if (fresh && fresh !== editing) setEditing(fresh);
  }, [endpoints]); // eslint-disable-line react-hooks/exhaustive-deps

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'baseUrl', label: 'Base URL', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span> },
    {
      key: 'tokenPreview',
      label: 'Token',
      render: (v, row) => row.hasToken
        ? <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span>
        : <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>(none)</span>,
    },
    {
      key: 'models',
      label: 'Models',
      render: v => <span style={{ fontSize: 'var(--eb-text-xs)' }}>{Array.isArray(v) ? v.length : 0}</span>,
    },
    { key: 'createdAt', label: 'Added', render: v => v ? new Date(v).toLocaleString() : '—' },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <button
            aria-label="Edit"
            title="Edit"
            onClick={() => { setEditing(row); setFormError(null); }}
            style={{
              display: 'flex', alignItems: 'center',
              padding: 'var(--eb-space-1) var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer', fontSize: 'var(--eb-text-xs)',
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            aria-label="Delete"
            title="Delete"
            onClick={() => setDeleteTarget(row)}
            style={{
              display: 'flex', alignItems: 'center',
              padding: 'var(--eb-space-1) var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-status-error)',
              cursor: 'pointer', fontSize: 'var(--eb-text-xs)',
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ];

  async function handleCreate(payload) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/llm-endpoints', payload);
      setCreating(false);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(payload) {
    if (!editing) return;
    setSaving(true); setFormError(null);
    try {
      await apiCall('PUT', `/api/llm-endpoints/${editing.id}`, payload);
      setEditing(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/llm-endpoints/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {error}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Model Registry
        </h1>
        <button
          onClick={() => { setCreating(true); setFormError(null); }}
          style={{ ...buttonPrimary, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}
        >
          <Plus size={15} /> New Endpoint
        </button>
      </div>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        Anthropic-compatible LLM endpoints (typically a LiteLLM proxy). Working Environments pick one endpoint and a default model from its catalog; agents inherit both at startup.
      </div>

      {actionError && (
        <div role="alert" style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={endpoints ?? []}
        emptyText="No LLM endpoints registered yet."
        onRowClick={row => { setEditing(row); setFormError(null); }}
      />

      <SidePanel
        open={creating}
        onClose={() => setCreating(false)}
        title="New LLM endpoint"
        width="640px"
      >
        {creating && (
          <EndpointForm
            endpoint={null}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `Edit "${editing.name}"` : ''}
        width="640px"
      >
        {editing && (
          <EndpointForm
            endpoint={editing}
            onSave={handleUpdate}
            onCancel={() => setEditing(null)}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete LLM endpoint"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Working Environments using this endpoint must detach it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
