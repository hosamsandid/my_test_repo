import React, { useState, useEffect, useCallback, useRef } from 'react';
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

/* ─── File helpers ─────────────────────────────────────────────────────── */
function isMarkdownPath(p) { return /\.md$/i.test(p || ''); }

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Plain monospace renderer for non-markdown text files.
function CodeBlock({ content }) {
  return (
    <pre style={{
      margin: 0, padding: 'var(--eb-space-3)',
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-bg-elevated)', overflowX: 'auto',
      fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)',
      whiteSpace: 'pre', color: 'var(--eb-text-primary)',
    }}>
      <code>{content || ''}</code>
    </pre>
  );
}

/* ─── Skill viewer / inline editor ────────────────────────────────────── */
function SkillViewer({ skill, onDeleted, onPromoted, poolNames, installableAgents, agentSkills }) {
  const isPool = skill.source === 'pool';
  const inPool = poolNames?.has(skill.name);
  const skillKey = `${skill.source}:${skill.agentId ?? ''}:${skill.name}`;

  // File listing for the skill directory.
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState(null);
  const [selectedFile, setSelectedFile] = useState('SKILL.md');

  // Content of the currently selected file.
  const [fileData, setFileData] = useState(null); // { content, binary, truncated, size }
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(null);

  // Per-file editing (pool skills only).
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [installTarget, setInstallTarget] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);
  const [installMsg, setInstallMsg] = useState(null);
  const [confirmInstallOverwrite, setConfirmInstallOverwrite] = useState(false);

  // Load the file list whenever the selected skill changes.
  useEffect(() => {
    let cancelled = false;
    setFilesLoading(true); setFilesError(null); setFiles([]); setEditing(false);
    const params = new URLSearchParams({ source: skill.source });
    if (skill.agentId) params.set('agentId', skill.agentId);
    fetch(`/api/skills/${encodeURIComponent(skill.name)}/files?${params}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => {
        if (cancelled) return;
        const list = Array.isArray(d.files) ? d.files : [];
        setFiles(list);
        const hasSkillMd = list.some(f => f.path === 'SKILL.md');
        setSelectedFile(hasSkillMd ? 'SKILL.md' : (list[0]?.path || ''));
      })
      .catch(e => { if (!cancelled) setFilesError(e.message); })
      .finally(() => { if (!cancelled) setFilesLoading(false); });
    return () => { cancelled = true; };
  }, [skillKey]);

  // Load the selected file's content.
  useEffect(() => {
    if (!selectedFile) { setFileData(null); return; }
    let cancelled = false;
    setFileLoading(true); setFileError(null); setFileData(null); setEditing(false);
    const params = new URLSearchParams({ source: skill.source, file: selectedFile });
    if (skill.agentId) params.set('agentId', skill.agentId);
    fetch(`/api/skills/${encodeURIComponent(skill.name)}/file?${params}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setFileData(d); })
      .catch(e => { if (!cancelled) setFileError(e.message); })
      .finally(() => { if (!cancelled) setFileLoading(false); });
    return () => { cancelled = true; };
  }, [skillKey, selectedFile]);

  const fileEditable = isPool && fileData && !fileData.binary && !fileData.truncated;

  function exportSkill() {
    const params = new URLSearchParams({ source: skill.source });
    if (skill.agentId) params.set('agentId', skill.agentId);
    window.open(`/api/skills/${encodeURIComponent(skill.name)}/export?${params}`, '_blank');
  }

  async function install(overwrite) {
    if (!installTarget) return;
    setInstalling(true);
    setInstallError(null);
    setInstallMsg(null);
    try {
      const res = await fetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: installTarget, name: skill.name, overwrite }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.exists) {
          setConfirmInstallOverwrite(true);
          setInstalling(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfirmInstallOverwrite(false);
      setInstallMsg(`Installed into "${installTarget}".`);
    } catch (e) {
      setInstallError(e.message);
    } finally {
      setInstalling(false);
    }
  }

  // Agents that already carry this skill in their workspace, for an inline hint.
  const agentsWithSkill = new Set(
    (agentSkills ?? [])
      .filter(s => s.source === 'agent' && s.name === skill.name && s.agentId)
      .map(s => s.agentId),
  );

  async function promote(overwrite) {
    setPromoting(true);
    setPromoteError(null);
    try {
      const res = await fetch('/api/skills/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: skill.agentId, name: skill.name, overwrite }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.exists) {
          setConfirmOverwrite(true);
          setPromoting(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfirmOverwrite(false);
      onPromoted?.(data);
    } catch (e) {
      setPromoteError(e.message);
    } finally {
      setPromoting(false);
    }
  }

  async function handleSaveFile() {
    setSaving(true);
    setError(null);
    try {
      const params = new URLSearchParams({ source: skill.source, file: selectedFile });
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}/file?${params}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFileData(fd => ({ ...(fd || {}), content: editContent }));
      setEditing(false);
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
        {!editing && (
          <button onClick={exportSkill} style={secondaryBtnStyle} title="Download the whole skill directory as a ZIP">
            Export ZIP
          </button>
        )}
        {isPool && !editing && (
          <>
            <button
              onClick={() => { setEditing(true); setEditContent(fileData?.content ?? ''); setPreview(false); setError(null); }}
              disabled={!fileEditable}
              title={fileEditable ? undefined : 'This file cannot be edited here (binary or too large)'}
              style={fileEditable ? secondaryBtnStyle : { ...secondaryBtnStyle, cursor: 'not-allowed', opacity: 0.5 }}
            >
              Edit {files.length > 1 ? 'file' : ''}
            </button>
            <button onClick={() => { setDeleteError(null); setConfirmDelete(true); }} style={dangerBtnStyle}>
              Delete skill
            </button>
          </>
        )}
        {isPool && editing && (
          <>
            {isMarkdownPath(selectedFile) && (
              <button
                type="button"
                onClick={() => setPreview(p => !p)}
                style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {preview ? 'Edit' : 'Preview'}
              </button>
            )}
            <button onClick={handleSaveFile} disabled={saving} style={primaryBtnStyle(saving)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setError(null); }} disabled={saving} style={secondaryBtnStyle}>
              Cancel
            </button>
          </>
        )}
        {!isPool && (
          <>
            <button onClick={() => promote(false)} disabled={promoting} style={primaryBtnStyle(promoting)}>
              {promoting ? 'Promoting…' : (inPool ? 'Update pool copy' : 'Promote to pool')}
            </button>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
              Agent skills are read-only here. Promoting copies the whole skill directory (scripts included) into the shared pool.
            </span>
          </>
        )}
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</div>
      )}
      {promoteError && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{promoteError}</div>
      )}

      {/* Install pool skill into an existing agent (no full workspace reset) */}
      {isPool && !editing && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
          padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
        }}>
          <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
            Install into agent
          </span>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={installTarget}
              onChange={e => { setInstallTarget(e.target.value); setInstallMsg(null); setInstallError(null); }}
              style={{
                padding: '5px 10px', borderRadius: 'var(--eb-radius-sm)',
                border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
                color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                minWidth: 180,
              }}
            >
              <option value="">Select an agent…</option>
              {(installableAgents ?? []).map(a => (
                <option key={a.id} value={a.id}>
                  {a.displayName}{agentsWithSkill.has(a.id) ? ' (already installed)' : ''}
                </option>
              ))}
            </select>
            <button onClick={() => install(false)} disabled={!installTarget || installing} style={primaryBtnStyle(!installTarget || installing)}>
              {installing ? 'Installing…' : (installTarget && agentsWithSkill.has(installTarget) ? 'Reinstall' : 'Install')}
            </button>
            {installMsg && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)' }}>{installMsg}</span>
            )}
          </div>
          {(installableAgents ?? []).length === 0 && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
              No active agents available. Enable an agent first.
            </span>
          )}
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
            Copies the whole skill directory (scripts included) into the agent. It picks the skill up on its next message. Note: a later workspace reset re-seeds only the skills listed in the agent's environment.
          </span>
          {installError && (
            <span role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{installError}</span>
          )}
        </div>
      )}

      {/* File list — only shown when the skill bundles more than SKILL.md */}
      {files.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
            Files ({files.length})
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1)' }}>
            {files.map(f => {
              const active = f.path === selectedFile;
              return (
                <button
                  key={f.path}
                  onClick={() => setSelectedFile(f.path)}
                  title={`${f.path} · ${formatBytes(f.size)}`}
                  style={{
                    padding: '3px 10px', borderRadius: 'var(--eb-radius-sm)',
                    fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
                    border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                    background: active ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
                    color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
                    cursor: 'pointer', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {f.path}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* content area */}
      {filesLoading ? (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading files…</div>
      ) : filesError ? (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load files: {filesError}</div>
      ) : fileLoading ? (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading {selectedFile}…</div>
      ) : fileError ? (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load file: {fileError}</div>
      ) : editing && !(preview && isMarkdownPath(selectedFile)) ? (
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
      ) : fileData?.binary ? (
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', fontStyle: 'italic' }}>
          Binary file ({formatBytes(fileData.size)}) — not shown.
        </div>
      ) : isMarkdownPath(selectedFile) ? (
        <SkillMarkdown content={editing ? editContent : (fileData?.content ?? '')} />
      ) : (
        <CodeBlock content={fileData?.content ?? ''} />
      )}

      {!filesLoading && !fileLoading && fileData?.truncated && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
          File truncated at 512 KB — shown content is partial and read-only.
        </div>
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
            `Delete "${skill.name}"? This removes the entire skill directory permanently.`
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

      {/* Overwrite confirmation (pool already has a skill with this name) */}
      <ConfirmDialog
        open={confirmOverwrite}
        title="Skill already in pool"
        variant="danger"
        message={`A pool skill named "${skill.name}" already exists. Overwrite it with the version from agent "${skill.agentId}"? This replaces the entire pool skill directory.`}
        confirmLabel={promoting ? 'Overwriting…' : 'Overwrite'}
        onConfirm={() => promote(true)}
        onCancel={() => setConfirmOverwrite(false)}
      />

      {/* Reinstall confirmation (agent already has a skill with this name) */}
      <ConfirmDialog
        open={confirmInstallOverwrite}
        title="Skill already installed"
        variant="danger"
        message={`Agent "${installTarget}" already has a skill named "${skill.name}". Overwrite it with the pool version? This replaces the entire skill directory in that agent.`}
        confirmLabel={installing ? 'Overwriting…' : 'Overwrite'}
        onConfirm={() => install(true)}
        onCancel={() => setConfirmInstallOverwrite(false)}
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
  const { data: allAgents } = useApi('/api/agents');
  const [filter, setFilter] = useState('All');
  const [showNewForm, setShowNewForm] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState(null);
  // row-level delete state (separate from the side-panel delete flow)
  const [rowDeleteTarget, setRowDeleteTarget] = useState(null);
  const [rowDeleteError, setRowDeleteError] = useState(null);
  const [rowDeleting, setRowDeleting] = useState(false);
  // import (.zip / .skill upload → pool skill)
  const importFileRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);

  const filteredSkills = (allSkills ?? []).filter(s => {
    if (filter === 'Pool') return s.source === 'pool';
    if (filter === 'Agent') return s.source === 'agent';
    return true;
  });

  // The SkillViewer fetches its own file list + content; opening just selects.
  const openSkill = useCallback((row) => {
    setSelectedSkill(row);
  }, []);

  function handleCreated(skill) {
    setShowNewForm(false);
    refetch?.();
    openSkill({ ...skill });
  }

  function handleDeleted() {
    setSelectedSkill(null);
    refetch?.();
  }

  function handlePromoted(skill) {
    refetch?.();
    openSkill({ name: skill.name, source: 'pool' });
  }

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = '';
    if (!file) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/skills/import', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setImportSuccess(`Skill '${data.name}' imported into the pool.`);
      refetch?.();
      openSkill({ name: data.name, source: 'pool' });
    } catch (e) {
      setImportError(e.message);
    } finally {
      setImporting(false);
    }
  }

  const poolNames = new Set((allSkills ?? []).filter(s => s.source === 'pool').map(s => s.name));
  // Only materialized, enabled agents can receive a skill in-place (a stub has
  // no workspace yet and would be re-seeded from its environment on enable).
  const installableAgents = (allAgents ?? [])
    .filter(a => a.enabled !== false && a.token && a.role !== 'team' && a.role !== 'orchestrator')
    .map(a => ({ id: a.id, displayName: a.displayName || a.id }));

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
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <input
            ref={importFileRef}
            type="file"
            accept=".zip,.skill,application/zip,application/octet-stream"
            onChange={handleImport}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
            style={secondaryBtnStyle}
            title="Upload a skill packaged as a .zip or .skill archive and add it to the pool"
          >
            {importing ? 'Importing…' : 'Import skill'}
          </button>
          <button onClick={() => setShowNewForm(f => !f)} style={primaryBtnStyle(false)}>
            {showNewForm ? 'Cancel' : '+ New Skill'}
          </button>
        </div>
      </div>

      {/* Intro / explanation */}
      <div style={{
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        lineHeight: 1.5,
      }}>
        <p style={{ margin: '0 0 var(--eb-space-2)' }}>
          Skills are reusable instruction packages (a <code style={{ fontFamily: 'var(--eb-font-mono)' }}>SKILL.md</code> plus
          any helper scripts or assets) that agents load to perform domain-specific tasks. This page shows every skill in
          the shared <strong>pool</strong> as well as the copies living inside individual <strong>agents</strong>.
        </p>
        <p style={{ margin: 0 }}>
          <strong>Pool</strong> skills can be edited here and attached to Working Environments so new agents receive them.
          <strong> Agent</strong> skills are read-only — use <em>Promote to pool</em> to lift one back into the pool, or{' '}
          <em>Install into agent</em> to push a pool skill into a running agent. Click a skill to browse its files;
          use <em>Export ZIP</em> to download a skill directory, or <em>Import skill</em> to add one to the pool
          from a <code>.zip</code> or <code>.skill</code> archive.
        </p>
      </div>

      {/* Import feedback */}
      {importError && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
          Import failed: {importError}
        </div>
      )}
      {importSuccess && (
        <div role="status" style={{ color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)' }}>
          {importSuccess}
        </div>
      )}

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
        {selectedSkill && (
          <SkillViewer
            key={`${selectedSkill.source}:${selectedSkill.agentId ?? ''}:${selectedSkill.name}`}
            skill={selectedSkill}
            onDeleted={handleDeleted}
            onPromoted={handlePromoted}
            poolNames={poolNames}
            installableAgents={installableAgents}
            agentSkills={allSkills ?? []}
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
