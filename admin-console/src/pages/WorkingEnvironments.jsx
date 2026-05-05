import React, { useState, useEffect } from 'react';
import { Edit, Trash2, Plus, GitBranch, Key, Github } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

const labelStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)',
  marginBottom: 'var(--eb-space-0-5)',
};

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

function SkillPicker({ allSkills, selected, onChange }) {
  const toggle = (name) => {
    if (selected.includes(name)) onChange(selected.filter(s => s !== name));
    else onChange([...selected, name]);
  };

  if (allSkills.length === 0) {
    return (
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        No skills in the central pool. Place skills in the pool volume under <code>skills/&lt;name&gt;/SKILL.md</code>.
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-1)',
      maxHeight: 240,
      overflowY: 'auto',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-2)',
      background: 'var(--eb-bg-elevated)',
    }}>
      {allSkills.map(name => (
        <label key={name} style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-1) var(--eb-space-2)',
          borderRadius: 'var(--eb-radius-sm)',
          cursor: 'pointer',
          fontSize: 'var(--eb-text-sm)',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <input
            type="checkbox"
            checked={selected.includes(name)}
            onChange={() => toggle(name)}
          />
          <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
            {name}
          </span>
        </label>
      ))}
    </div>
  );
}

function EnvironmentForm({ initial, onSave, onCancel, saving, error, isEdit }) {
  const [form, setForm] = useState(() => ({
    id: initial?.id || '',
    name: initial?.name || '',
    description: initial?.description || '',
    skills: initial?.skills || [],
    additionalContext: initial?.additionalContext || '',
    repoEnabled: !!initial?.repository?.url,
    repoUrl: initial?.repository?.url || '',
    repoBranch: initial?.repository?.branch || '',
    sshKeyId: initial?.repository?.sshKeyId || '',
    githubTokenId: initial?.githubTokenId || '',
  }));

  const { data: skillsData } = useApi('/api/skills');
  const { data: keysData } = useApi('/api/ssh-keys');
  const { data: tokensData } = useApi('/api/github-tokens');

  const poolSkills = (skillsData || []).filter(s => s.source === 'pool').map(s => s.name);
  const sshKeys = keysData || [];
  const ghTokens = tokensData || [];

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const submit = () => {
    onSave({
      id: form.id,
      name: form.name,
      description: form.description,
      skills: form.skills,
      additionalContext: form.additionalContext,
      repository: form.repoEnabled && form.repoUrl ? {
        url: form.repoUrl,
        branch: form.repoBranch || null,
        sshKeyId: form.sshKeyId || null,
      } : null,
      githubTokenId: form.githubTokenId || null,
    });
  };

  const canSubmit = form.id && form.name && (!form.repoEnabled || form.repoUrl);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <div>
        <div style={labelStyle}>ID <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
        <input
          style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)', opacity: isEdit ? 0.6 : 1 }}
          value={form.id}
          disabled={isEdit}
          onChange={e => update('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="e.g. cobol-migration"
        />
      </div>

      <FormInput label="Name *" value={form.name} onChange={v => update('name', v)} placeholder="COBOL Migration" />

      <div>
        <div style={labelStyle}>Description</div>
        <textarea
          value={form.description}
          onChange={e => update('description', e.target.value)}
          placeholder="What is this working environment used for?"
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>

      <div>
        <div style={labelStyle}>Skills (from the central pool)</div>
        <SkillPicker
          allSkills={poolSkills}
          selected={form.skills}
          onChange={v => update('skills', v)}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          {form.skills.length} selected
        </div>
      </div>

      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.repoEnabled}
            onChange={e => update('repoEnabled', e.target.checked)}
          />
          <GitBranch size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            Clone Git repository
          </span>
        </label>

        {form.repoEnabled && (
          <>
            <div>
              <div style={labelStyle}>Repository URL <span style={{ color: 'var(--eb-status-error)' }}>*</span></div>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
                value={form.repoUrl}
                onChange={e => update('repoUrl', e.target.value)}
                placeholder="git@github.com:org/repo.git"
              />
            </div>
            <div>
              <div style={labelStyle}>Branch (optional)</div>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--eb-font-mono)' }}
                value={form.repoBranch}
                onChange={e => update('repoBranch', e.target.value)}
                placeholder="main"
              />
            </div>
            <div>
              <div style={labelStyle}>SSH key</div>
              <select
                value={form.sshKeyId}
                onChange={e => update('sshKeyId', e.target.value)}
                style={inputStyle}
              >
                <option value="">— no key (HTTPS only) —</option>
                {sshKeys.map(k => (
                  <option key={k.id} value={k.id}>{k.name} ({k.id})</option>
                ))}
              </select>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
                Manage SSH keys on the SSH Keys page.
              </div>
            </div>
          </>
        )}
      </div>

      <div style={{
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-3)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Github size={14} />
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            GitHub token (gh CLI / HTTPS push)
          </span>
        </div>
        <select
          value={form.githubTokenId}
          onChange={e => update('githubTokenId', e.target.value)}
          style={inputStyle}
        >
          <option value="">— no token —</option>
          {ghTokens.map(t => (
            <option key={t.id} value={t.id}>{t.name} ({t.preview})</option>
          ))}
        </select>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Exposed to agents in this environment as <code>GH_TOKEN</code> / <code>GITHUB_TOKEN</code>. Manage tokens on the GitHub Tokens page.
        </div>
      </div>

      <div>
        <div style={labelStyle}>Additional context (CLAUDE.md)</div>
        <textarea
          value={form.additionalContext}
          onChange={e => update('additionalContext', e.target.value)}
          placeholder="Optional instructions passed to every agent in this environment..."
          rows={4}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
        />
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={submit}
          disabled={saving || !canSubmit}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !canSubmit) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create environment')}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
            cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function WorkingEnvironments() {
  const { data: envs, loading, error, refetch } = useApi('/api/environments');
  const [panelMode, setPanelMode] = useState(null);
  const [selected, setSelected] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    {
      key: 'skills',
      label: 'Skills',
      sortable: false,
      render: v => Array.isArray(v) && v.length > 0 ? (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v.length} Skill{v.length === 1 ? '' : 's'}</span>
      ) : <span style={{ color: 'var(--eb-text-muted)' }}>—</span>,
    },
    {
      key: 'repository',
      label: 'Repository',
      sortable: false,
      render: v => v?.url ? (
        <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <GitBranch size={12} /> {v.url.split('/').pop().replace(/\.git$/, '')}
        </span>
      ) : <span style={{ color: 'var(--eb-text-muted)' }}>—</span>,
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <ActionBtn icon={Edit} label="Edit" onClick={() => { setSelected(row); setPanelMode('edit'); setFormError(null); }} />
          <ActionBtn icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />
        </div>
      ),
    },
  ];

  async function handleSave(form) {
    setSaving(true); setFormError(null);
    try {
      if (panelMode === 'edit') {
        await apiCall('PUT', `/api/environments/${selected.id}`, form);
      } else {
        await apiCall('POST', '/api/environments', form);
      }
      setPanelMode(null); setSelected(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/environments/${deleteTarget.id}`);
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
          Working Environments
        </h1>
        <button
          onClick={() => { setPanelMode('create'); setSelected(null); setFormError(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={15} /> New Environment
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
        A Working Environment defines what an agent gets in its workspace: selected skills from the pool, optionally a Git repository (with SSH key), and additional context for CLAUDE.md.
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={envs ?? []}
        emptyText="No Working Environments yet. Click 'New Environment' to create the first one."
      />

      <SidePanel
        open={panelMode === 'create' || panelMode === 'edit'}
        onClose={() => { setPanelMode(null); setSelected(null); }}
        title={panelMode === 'edit' ? `Edit: ${selected?.name || selected?.id}` : 'New Environment'}
        width="560px"
      >
        {(panelMode === 'create' || (panelMode === 'edit' && selected)) && (
          <EnvironmentForm
            initial={panelMode === 'edit' ? selected : null}
            isEdit={panelMode === 'edit'}
            onSave={handleSave}
            onCancel={() => { setPanelMode(null); setSelected(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Working Environment"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Agents using this environment must be removed first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ActionBtn({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      title={label}
      style={{
        display: 'flex', alignItems: 'center',
        padding: 'var(--eb-space-1) var(--eb-space-2)',
        background: 'var(--eb-bg-elevated)',
        border: `1px solid ${danger ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-md)',
        color: danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
        cursor: 'pointer', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
      }}
    >
      <Icon size={13} />
    </button>
  );
}
