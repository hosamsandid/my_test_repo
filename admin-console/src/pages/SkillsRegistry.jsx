import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Trash2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';

/* ─── Skill name validation (mirrors SKILL_NAME_RE in api.js) ─────────── */
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;

const FILTER_OPTIONS = ['All', 'Pool', 'Agent'];

/* ─── Full markdown renderer (same pipeline as the chat UI) ───────────── */

const PRETTY_CODE_OPTIONS = {
  theme: { light: 'github-light', dark: 'github-dark' },
  keepBackground: true,
  defaultLang: 'plaintext',
};

const PRETTY_CODE_DATA_ATTRS = [
  'data-line', 'data-language', 'data-theme',
  'data-rehype-pretty-code-figure', 'data-rehype-pretty-code-fragment',
  'data-rehype-pretty-code-title', 'data-highlighted-line',
  'data-highlighted-line-id', 'data-highlighted-chars', 'data-chars-id',
  'data-line-numbers', 'data-line-numbers-max-digits', 'data-word', 'data-word-id',
];

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes || {}),
    span:   [...((defaultSchema.attributes?.span)   || []), 'style', 'className', ...PRETTY_CODE_DATA_ATTRS],
    code:   [...((defaultSchema.attributes?.code)   || []), 'style', 'className', ...PRETTY_CODE_DATA_ATTRS],
    pre:    [...((defaultSchema.attributes?.pre)    || []), 'style', 'className', ...PRETTY_CODE_DATA_ATTRS],
    figure: [...((defaultSchema.attributes?.figure) || []), 'style', 'className', ...PRETTY_CODE_DATA_ATTRS],
    div:    [...((defaultSchema.attributes?.div)    || []), 'style', 'className', ...PRETTY_CODE_DATA_ATTRS],
  },
};

const MD_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  code: ({ node, className, children, ...rest }) => {
    const isBlock = typeof className === 'string' && /language-/.test(className);
    if (isBlock) return <code className={className} {...rest}>{children}</code>;
    return (
      <code className={className} style={{
        background: 'var(--eb-bg-elevated)', padding: '1px 6px',
        borderRadius: 'var(--eb-radius-sm)', fontSize: '0.9em',
        fontFamily: 'var(--eb-font-mono)', border: '1px solid var(--eb-border-default)',
      }} {...rest}>{children}</code>
    );
  },
};

class SkillMarkdown extends React.Component {
  constructor(props) { super(props); this.state = { fallback: false }; }
  static getDerivedStateFromError() { return { fallback: true }; }
  render() {
    const { content } = this.props;
    const rehypePlugins = this.state.fallback
      ? [[rehypeSanitize, SANITIZE_SCHEMA]]
      : [[rehypePrettyCode, PRETTY_CODE_OPTIONS], [rehypeSanitize, SANITIZE_SCHEMA]];
    return (
      <div className="skill-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={MD_COMPONENTS}>
          {content || '*(empty)*'}
        </ReactMarkdown>
        <style>{`
          .skill-md p { margin: 0; }
          .skill-md p + p { margin-top: var(--eb-space-2); }
          .skill-md ul, .skill-md ol { padding-left: 1.4em; margin: var(--eb-space-1) 0; }
          .skill-md li { margin: 2px 0; }
          .skill-md table { border-collapse: collapse; margin: var(--eb-space-2) 0; font-size: var(--eb-text-sm); display: block; max-width: 100%; overflow-x: auto; }
          .skill-md th, .skill-md td { border: 1px solid var(--eb-border-default); padding: 4px 8px; }
          .skill-md th { background: var(--eb-bg-elevated); }
          .skill-md blockquote { margin: var(--eb-space-2) 0; padding-left: var(--eb-space-3); border-left: 3px solid var(--eb-border-default); color: var(--eb-text-secondary); }
          .skill-md h1, .skill-md h2, .skill-md h3, .skill-md h4 { margin: var(--eb-space-3) 0 var(--eb-space-1); font-weight: var(--eb-font-semibold); }
          .skill-md h1 { font-size: var(--eb-text-lg); }
          .skill-md h2 { font-size: var(--eb-text-md); }
          .skill-md h3 { font-size: var(--eb-text-md); color: var(--eb-text-secondary); }
          .skill-md hr { border: none; border-top: 1px solid var(--eb-border-default); margin: var(--eb-space-3) 0; }
          .skill-md a { color: var(--eb-accent-primary); }
          .skill-md pre { margin: var(--eb-space-2) 0; border: 1px solid var(--eb-border-default); border-radius: var(--eb-radius-md); overflow-x: auto; padding: var(--eb-space-3); font-family: var(--eb-font-mono); font-size: var(--eb-text-sm); }
        `}</style>
      </div>
    );
  }
}

/* ─── Button styles ────────────────────────────────────────────────────── */
const primaryBtnStyle = (disabled) => ({
  padding: '5px 14px',
  borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  border: 'none',
  cursor: disabled ? 'not-allowed' : 'pointer',
  background: disabled ? 'var(--eb-border-default)' : 'var(--eb-accent-primary)',
  color: disabled ? 'var(--eb-text-muted)' : '#fff',
});

const secondaryBtnStyle = {
  padding: '5px 14px',
  borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  border: '1px solid var(--eb-border-default)',
  background: 'var(--eb-bg-surface)',
  color: 'var(--eb-text-primary)',
  cursor: 'pointer',
};

const dangerBtnStyle = {
  padding: '5px 14px',
  borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  border: '1px solid var(--eb-status-error)',
  background: 'transparent',
  color: 'var(--eb-status-error)',
  cursor: 'pointer',
};

/* ─── New skill form ───────────────────────────────────────────────────── */
function NewSkillForm({ onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const nameValid = SKILL_NAME_RE.test(name);

  async function handleCreate(e) {
    e.preventDefault();
    if (!nameValid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onCreated(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div>
        <label style={{ display: 'block', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', marginBottom: 4 }}>
          Skill name (slug)
        </label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. my-skill"
          style={{
            width: '100%', padding: '6px 10px',
            border: `1px solid ${name && !nameValid ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
            borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-surface)',
            color: 'var(--eb-text-primary)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-sm)',
            boxSizing: 'border-box',
          }}
        />
        {name && !nameValid && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
            Only letters, digits, hyphens, underscores, dots, and colons allowed.
          </span>
        )}
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <label style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
            Content (Markdown)
          </label>
          <button
            type="button"
            onClick={() => setPreview(p => !p)}
            style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {preview ? 'Edit' : 'Preview'}
          </button>
        </div>
        {preview ? (
          <div style={{
            minHeight: 160, padding: 'var(--eb-space-3)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-elevated)',
          }}>
            <SkillMarkdown content={content} />
          </div>
        ) : (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={8}
            style={{
              width: '100%', padding: '6px 10px',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-surface)',
              color: 'var(--eb-text-primary)',
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-sm)',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        )}
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} disabled={saving} style={secondaryBtnStyle}>Cancel</button>
        <button type="submit" disabled={saving || !nameValid} style={primaryBtnStyle(saving || !nameValid)}>
          {saving ? 'Creating…' : 'Create skill'}
        </button>
      </div>
    </form>
  );
}

/* ─── Skill viewer / inline editor ────────────────────────────────────── */
function SkillViewer({ skill, content, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [error, setError] = useState(null);

  const isPool = skill.source === 'pool';

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const params = new URLSearchParams({ source: skill.source });
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}?${params}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEditing(false);
      onSaved(editContent);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const params = new URLSearchParams({ source: skill.source });
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}?${params}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.environments) {
          setDeleteError(`Skill is in use by: ${data.environments.join(', ')}`);
          setDeleting(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfirmDelete(false);
      onDeleted(skill.name);
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', height: '100%' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {isPool && !editing && (
          <>
            <button onClick={() => { setEditing(true); setEditContent(content); setPreview(false); setError(null); }} style={secondaryBtnStyle}>
              Edit
            </button>
            <button onClick={() => { setDeleteError(null); setConfirmDelete(true); }} style={dangerBtnStyle}>
              Delete
            </button>
          </>
        )}
        {isPool && editing && (
          <>
            <button
              type="button"
              onClick={() => setPreview(p => !p)}
              style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
            <button onClick={handleSave} disabled={saving} style={primaryBtnStyle(saving)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setError(null); }} disabled={saving} style={secondaryBtnStyle}>
              Cancel
            </button>
          </>
        )}
        {!isPool && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
            Agent skills are read-only here. Promote via the skill propagation flow to edit.
          </span>
        )}
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</div>
      )}

      {/* content area */}
      {editing && !preview ? (
        <textarea
          value={editContent}
          onChange={e => setEditContent(e.target.value)}
          style={{
            flex: 1, minHeight: 300, padding: '8px 10px',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-surface)',
            color: 'var(--eb-text-primary)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-sm)',
            resize: 'vertical',
            boxSizing: 'border-box',
            width: '100%',
          }}
        />
      ) : (
        <SkillMarkdown content={editing ? editContent : content} />
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete skill"
        variant="danger"
        message={
          deleteError ? (
            <span><strong>Cannot delete:</strong> {deleteError}</span>
          ) : (
            `Delete "${skill.name}"? This removes the SKILL.md file permanently.`
          )
        }
        confirmLabel={deleteError ? undefined : (deleting ? 'Deleting…' : 'Delete')}
        alertOnly={!!deleteError}
        onConfirm={deleteError
          ? () => { setConfirmDelete(false); setDeleteError(null); }
          : handleDelete
        }
        onCancel={() => { setConfirmDelete(false); setDeleteError(null); }}
      />
    </div>
  );
}

/* ─── Source badge ─────────────────────────────────────────────────────── */
function SourceBadge({ value: v }) {
  return (
    <span style={{
      padding: '1px 8px',
      borderRadius: 'var(--eb-radius-sm)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      background: v === 'pool' ? 'var(--eb-accent-muted)' : 'var(--eb-status-info-bg)',
      color: v === 'pool' ? 'var(--eb-accent-primary)' : 'var(--eb-status-info)',
      border: `1px solid ${v === 'pool' ? 'var(--eb-accent-primary)' : 'var(--eb-status-info)'}`,
    }}>
      {v}
    </span>
  );
}

function makeColumns(onDeleteRow) {
  return [
    { key: 'name', label: 'Skill Name' },
    { key: 'source', label: 'Source', render: v => <SourceBadge value={v} /> },
    { key: 'agentId', label: 'Agent', render: v => v
      ? <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span>
      : <span style={{ color: 'var(--eb-text-muted)' }}>—</span>
    },
    {
      key: '_del',
      label: '',
      sortable: false,
      render: (_, row) => row.source === 'pool' ? (
        <button
          onClick={e => { e.stopPropagation(); onDeleteRow(row); }}
          title="Delete skill"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-status-error)', padding: '2px', display: 'flex', alignItems: 'center' }}
        >
          <Trash2 size={14} />
        </button>
      ) : null,
    },
  ];
}

/* ─── Main page ────────────────────────────────────────────────────────── */
export default function SkillsRegistry() {
  const { data: allSkills, loading, error, refetch } = useApi('/api/skills');
  const [filter, setFilter] = useState('All');
  const [showNewForm, setShowNewForm] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [skillContent, setSkillContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(null);
  // row-level delete state (separate from the side-panel delete flow)
  const [rowDeleteTarget, setRowDeleteTarget] = useState(null);
  const [rowDeleteError, setRowDeleteError] = useState(null);
  const [rowDeleting, setRowDeleting] = useState(false);

  const filteredSkills = (allSkills ?? []).filter(s => {
    if (filter === 'Pool') return s.source === 'pool';
    if (filter === 'Agent') return s.source === 'agent';
    return true;
  });

  const openSkill = useCallback(async (row) => {
    setSelectedSkill(row);
    setSkillContent(null);
    setContentError(null);
    setContentLoading(true);
    try {
      const params = new URLSearchParams({ source: row.source });
      if (row.agentId) params.set('agentId', row.agentId);
      const res = await fetch(`/api/skills/${encodeURIComponent(row.name)}/content?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkillContent(data.content);
    } catch (e) {
      setContentError(e.message);
    } finally {
      setContentLoading(false);
    }
  }, []);

  function handleCreated(skill) {
    setShowNewForm(false);
    refetch?.();
    openSkill({ ...skill });
  }

  function handleSaved(newContent) {
    setSkillContent(newContent);
  }

  function handleDeleted() {
    setSelectedSkill(null);
    setSkillContent(null);
    refetch?.();
  }

  async function confirmRowDelete() {
    if (!rowDeleteTarget) return;
    setRowDeleting(true);
    setRowDeleteError(null);
    try {
      const params = new URLSearchParams({ source: rowDeleteTarget.source });
      const res = await fetch(`/api/skills/${encodeURIComponent(rowDeleteTarget.name)}?${params}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.environments) {
          setRowDeleteError(`Skill is in use by: ${data.environments.join(', ')}`);
          setRowDeleting(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (selectedSkill?.name === rowDeleteTarget.name && selectedSkill?.source === 'pool') {
        setSelectedSkill(null);
        setSkillContent(null);
      }
      setRowDeleteTarget(null);
      refetch?.();
    } catch (e) {
      setRowDeleteError(e.message);
    } finally {
      setRowDeleting(false);
    }
  }

  const columns = makeColumns(row => { setRowDeleteError(null); setRowDeleteTarget(row); });

  if (loading) {
    return <div aria-busy="true" style={{ height: 300, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }

  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load skills: {error}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--eb-space-3)' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Skills Registry
        </h1>
        <button onClick={() => setShowNewForm(f => !f)} style={primaryBtnStyle(false)}>
          {showNewForm ? 'Cancel' : '+ New Skill'}
        </button>
      </div>

      {/* New skill inline form */}
      {showNewForm && (
        <div style={{
          padding: 'var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
        }}>
          <h2 style={{ fontSize: 'var(--eb-text-base)', fontWeight: 'var(--eb-font-semibold)', margin: '0 0 var(--eb-space-3)' }}>
            Create pool skill
          </h2>
          <NewSkillForm onCreated={handleCreated} onCancel={() => setShowNewForm(false)} />
        </div>
      )}

      {/* Source filter strip */}
      <div style={{ display: 'flex', gap: 'var(--eb-space-1)', alignItems: 'center' }}>
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt}
            onClick={() => setFilter(opt)}
            style={{
              padding: '4px 14px',
              borderRadius: 'var(--eb-radius-sm)',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              border: `1px solid ${filter === opt ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
              background: filter === opt ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
              color: filter === opt ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {opt}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={filteredSkills}
        onRowClick={openSkill}
        emptyText="No skills found."
        getRowKey={row => `${row.source}:${row.agentId ?? ''}:${row.name}`}
      />

      <SidePanel
        open={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        title={selectedSkill ? `${selectedSkill.name} (${selectedSkill.source})` : ''}
        width="560px"
      >
        {contentLoading && (
          <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>
        )}
        {contentError && (
          <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            Failed to load skill content: {contentError}
          </div>
        )}
        {skillContent != null && !contentLoading && selectedSkill && (
          <SkillViewer
            skill={selectedSkill}
            content={skillContent}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
          />
        )}
      </SidePanel>

      {/* Row-level delete confirmation */}
      <ConfirmDialog
        open={!!rowDeleteTarget}
        title="Delete skill"
        variant="danger"
        message={
          rowDeleteError ? (
            <span><strong>Cannot delete:</strong> {rowDeleteError}</span>
          ) : (
            `Delete "${rowDeleteTarget?.name}"? This removes the SKILL.md file permanently.`
          )
        }
        confirmLabel={rowDeleteError ? undefined : (rowDeleting ? 'Deleting…' : 'Delete')}
        alertOnly={!!rowDeleteError}
        onConfirm={rowDeleteError
          ? () => { setRowDeleteTarget(null); setRowDeleteError(null); }
          : confirmRowDelete
        }
        onCancel={() => { setRowDeleteTarget(null); setRowDeleteError(null); }}
      />
    </div>
  );
}
