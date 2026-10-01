import React, { useState, useCallback } from 'react';
import { Plus, Trash2, RotateCcw, AlertTriangle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import SidePanel from '../components/SidePanel';
import PageHelpButton from '../components/PageHelpButton';
import { usePageActions } from '../context/PageActionsContext';
import { ROLE_TEMPLATES_HELP_SECTIONS } from './role-templates-help-sections.js';
import { useHelpSubject } from '../context/HelperChatContext.jsx';
import { OVERLAY_AGENT_TEMPLATE } from '../context/page-help-view.js';

// Keys the structured form owns directly; everything else on a template
// (triggers, ports, patternRole, stageAffinity, github, skills, …) is edited
// in the Advanced JSON area so the full definition stays editable (AC-2).
// icon and envSuffix are intentionally excluded: icon is display-only (derived
// from the built-in definition, not user-editable); envSuffix is dead code.
const FORM_SCALAR_KEYS = ['id', 'displayName', 'description', 'category', 'sessionPolicy'];
const PROMPT_KEYS = ['prompt', 'promptTemplate'];

const btn = (variant, disabled) => ({
  padding: '5px 14px',
  borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  fontFamily: 'inherit',
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  ...(variant === 'primary'
    ? { border: 'none', background: disabled ? 'var(--eb-border-default)' : 'var(--eb-accent-primary)', color: disabled ? 'var(--eb-text-muted)' : 'var(--eb-text-inverted)' }
    : variant === 'danger'
      ? { border: '1px solid var(--eb-status-error)', background: 'transparent', color: 'var(--eb-status-error)' }
      : { border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)' }),
});

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

const labelStyle = {
  display: 'block',
  fontSize: 'var(--eb-text-xs)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)',
  marginBottom: 'var(--eb-space-1)',
};

const ORIGIN_BADGE = {
  default:  { label: 'Built-in',  bg: 'var(--eb-bg-elevated)',   fg: 'var(--eb-text-secondary)' },
  user:     { label: 'Custom',    bg: 'var(--eb-accent-muted)',  fg: 'var(--eb-accent-primary)' },
  override: { label: 'Edited',    bg: 'var(--eb-accent-muted)',  fg: 'var(--eb-accent-primary)' },
};

function OriginBadge({ origin }) {
  const b = ORIGIN_BADGE[origin] || ORIGIN_BADGE.default;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      background: b.bg, color: b.fg,
    }}>{b.label}</span>
  );
}

// `right` (#1996) is an optional slot beside the label — used for the two "?"
// affordances in the editor. Without it a PageHelpButton would have to sit inside
// the field body, above the control it is explaining.
function Field({ label, children, right }) {
  return (
    <div style={{ marginBottom: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
        <label style={labelStyle}>{label}</label>
        {right}
      </div>
      {children}
    </div>
  );
}

// Split a loaded template into { form scalars, prompt text, prompt-is-template
// flag, advanced-JSON string of the remaining fields }.
function splitTemplate(t) {
  const form = {};
  for (const k of FORM_SCALAR_KEYS) form[k] = t[k] != null ? String(t[k]) : '';
  const isTemplate = typeof t.promptTemplate === 'string';
  const promptText = isTemplate ? t.promptTemplate : (typeof t.prompt === 'string' ? t.prompt : '');
  const rest = { ...t };
  for (const k of [...FORM_SCALAR_KEYS, ...PROMPT_KEYS]) delete rest[k];
  const advancedJson = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '{}';
  return { form, promptText, isTemplate, advancedJson };
}

function Editor({ initial, origin, onSaved, onClose }) {
  // #1996: the editor is a shared SidePanel (backdrop 60 / panel 61) and now hosts
  // two "?". Publishing an overlay subject is what lifts the help panel above that
  // layer — this page had no useHelpSubject at all, which was harmless only while
  // the panel hosted no affordance. The key claims no topic of its own; resolution
  // falls through to `/role-templates`. Editor only mounts while the panel is open.
  useHelpSubject({ overlay: OVERLAY_AGENT_TEMPLATE, active: true });
  const creating = origin === 'new';
  const split = initial ? splitTemplate(initial) : { form: {}, promptText: '', isTemplate: true, advancedJson: '{}' };
  const [form, setForm] = useState(split.form);
  const [promptText, setPromptText] = useState(split.promptText);
  const [isTemplate, setIsTemplate] = useState(split.isTemplate);
  const [advancedJson, setAdvancedJson] = useState(split.advancedJson);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);
    let advanced;
    try {
      advanced = advancedJson.trim() ? JSON.parse(advancedJson) : {};
    } catch (e) {
      setError(`Advanced JSON is not valid: ${e.message}`);
      return;
    }
    if (advanced == null || typeof advanced !== 'object' || Array.isArray(advanced)) {
      setError('Advanced JSON must be a JSON object.');
      return;
    }
    const payload = { ...advanced };
    for (const k of FORM_SCALAR_KEYS) {
      const v = (form[k] || '').trim();
      if (v) payload[k] = v; else delete payload[k];
    }
    // Persist the prompt under exactly one key.
    delete payload.prompt;
    delete payload.promptTemplate;
    payload[isTemplate ? 'promptTemplate' : 'prompt'] = promptText;

    const id = (form.id || '').trim();
    const url = creating ? '/api/agent-templates' : `/api/agent-templates/${encodeURIComponent(id)}`;
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: creating ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {error && (
        <div role="alert" style={{
          marginBottom: 'var(--eb-space-4)', padding: 'var(--eb-space-3)',
          border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
        }}>{error}</div>
      )}

      {origin === 'default' && (
        <div style={{
          marginBottom: 'var(--eb-space-4)', padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)',
          display: 'flex', gap: 'var(--eb-space-2)',
        }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>This is a built-in template. Saving creates an editable override that shadows the built-in; you can reset it back to the default later.</span>
        </div>
      )}

      <Field label="ID (slug — lowercase letters, digits, hyphens)">
        <input
          style={{ ...inputStyle, opacity: creating ? 1 : 0.6 }}
          value={form.id || ''}
          onChange={e => setField('id', e.target.value)}
          disabled={!creating}
          placeholder="e.g. release-manager"
        />
      </Field>
      <Field label="Display name">
        <input style={inputStyle} value={form.displayName || ''} onChange={e => setField('displayName', e.target.value)} placeholder="e.g. Release Manager" />
      </Field>
      <Field label="Description">
        <input style={inputStyle} value={form.description || ''} onChange={e => setField('description', e.target.value)} />
      </Field>
      <Field label="Role type">
        <select style={inputStyle} value={form.category || ''} onChange={e => setField('category', e.target.value)}>
          <option value="">(unset)</option>
          <option value="chat">chat — always-on companion; responds to direct messages</option>
          <option value="reactive">reactive — event-driven; wakes on GitHub events or label triggers</option>
          <option value="pattern">pattern — scaffold role; excluded from the Team Setup "extra" slot</option>
        </select>
      </Field>
      <Field
        label="Invocation mode"
        right={(
          <PageHelpButton
            label="What per-invocation changes, and why it also marks the agent autonomous"
            size={13}
            style={{ padding: 0, flexShrink: 0 }}
            section={ROLE_TEMPLATES_HELP_SECTIONS.invocation}
          />
        )}
      >
        <select style={inputStyle} value={form.sessionPolicy || ''} onChange={e => setField('sessionPolicy', e.target.value)}>
          <option value="">(default: persistent)</option>
          <option value="persistent">persistent — triggered runs resume the last conversation</option>
          <option value="per-invocation">per-invocation — each triggered run starts fresh (no --resume)</option>
        </select>
        {/* E14 (#1888): the consequence of per-invocation (marked autonomous →
            trigger-management docs in the prompt, fresh invocation, lessons must
            go to memory) is in the role-templates topic. The option labels stay —
            they are the live choice. */}
      </Field>

      <Field label="Prompt">
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={isTemplate} onChange={e => setIsTemplate(e.target.checked)} />
          Contains {'{{variables}}'} (stored as promptTemplate, resolved per-member)
        </label>
        <textarea
          style={{ ...inputStyle, minHeight: 220, fontFamily: 'var(--eb-font-mono, monospace)', resize: 'vertical' }}
          value={promptText}
          onChange={e => setPromptText(e.target.value)}
          placeholder="The agent's system prompt…"
        />
      </Field>

      <Field
        label="Advanced (triggers, ports, github, skills, …) — raw JSON"
        right={(
          <PageHelpButton
            label="What belongs in the Advanced JSON, and how it merges with the fields above"
            size={13}
            style={{ padding: 0, flexShrink: 0 }}
            section={ROLE_TEMPLATES_HELP_SECTIONS.advanced}
          />
        )}
      >
        <textarea
          style={{ ...inputStyle, minHeight: 200, fontFamily: 'var(--eb-font-mono, monospace)', resize: 'vertical' }}
          value={advancedJson}
          onChange={e => setAdvancedJson(e.target.value)}
          spellCheck={false}
        />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end', marginTop: 'var(--eb-space-2)' }}>
        <button style={btn('secondary', saving)} onClick={onClose} disabled={saving}>Cancel</button>
        <button style={btn('primary', saving)} onClick={save} disabled={saving}>{saving ? 'Saving…' : (creating ? 'Create template' : 'Save changes')}</button>
      </div>
    </div>
  );
}

export default function RoleTemplates() {
  const { data, loading, error, refetch } = useApi('/api/agent-templates');
  const [editing, setEditing] = useState(null); // { template, origin } | { origin: 'new' }
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // summary row

  const templates = (data && data.templates) || [];

  const openEdit = useCallback(async (row) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/agent-templates/${encodeURIComponent(row.id)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setEditing({ template: d.template, origin: d.origin });
    } catch (e) {
      setActionError(e.message);
    }
  }, []);

  const doDelete = async (row) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent-templates/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setConfirmDelete(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const headerAction = usePageActions(
    <button style={btn('primary')} onClick={() => { setActionError(null); setEditing({ origin: 'new' }); }}>
      <Plus size={16} /> New template
    </button>
  );

  const cell = { padding: 'var(--eb-space-2) var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', borderBottom: '1px solid var(--eb-border-default)', textAlign: 'left' };
  const th = { ...cell, color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', fontSize: 'var(--eb-text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em' };

  return (
    <>
      {headerAction}
      <div style={{ maxWidth: 1100 }}>
      {/* The page has no <h1> of its own (the Shell header supplies it), so the
          one-line description + "?" is the body's first child — same header
          pattern as Token Usage / GitHub Event Log. The override-vs-built-in
          mechanics and the future-agents-only rule are the role-templates help
          topic (E14, #1888). */}
      <p style={{
        color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)',
        marginTop: 0, marginBottom: 'var(--eb-space-4)', maxWidth: 720,
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      }}>
        <span>Reusable agent definitions the Team-Setup wizard and the Flow editor build agents from.</span>
        <PageHelpButton
          label="What is an Agent Template?"
          size={14}
          style={{ padding: 0, flexShrink: 0 }}
          section={ROLE_TEMPLATES_HELP_SECTIONS.page}
        />
      </p>

      {actionError && (
        <div role="alert" style={{
          marginBottom: 'var(--eb-space-4)', padding: 'var(--eb-space-3)',
          border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
        }}>{actionError}</div>
      )}

      {loading && <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</div>}
      {error && <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load templates: {error}</div>}

      {!loading && !error && (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)' }}>
          <thead>
            <tr>
              <th style={th}>Agent</th>
              <th style={th}>ID</th>
              <th style={th}>Category</th>
              <th style={th}>Session</th>
              <th style={th}>Source</th>
              <th style={{ ...th, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map(t => (
              <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => openEdit(t)}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <td style={cell}>
                  <div style={{ fontWeight: 'var(--eb-font-medium)' }}>{t.displayName || t.id}</div>
                  {t.description && <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</div>}
                </td>
                <td style={{ ...cell, fontFamily: 'var(--eb-font-mono, monospace)', color: 'var(--eb-text-secondary)' }}>{t.id}</td>
                <td style={cell}>{t.category || '—'}</td>
                <td style={cell}>{t.sessionPolicy || 'persistent'}</td>
                <td style={cell}><OriginBadge origin={t.origin} /></td>
                <td style={{ ...cell, textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                  {t.origin === 'default' ? (
                    <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>read-only</span>
                  ) : (
                    <button
                      style={btn('danger')}
                      title={t.origin === 'override' ? 'Reset to built-in default' : 'Delete template'}
                      onClick={() => { setActionError(null); setConfirmDelete(t); }}
                    >
                      {t.origin === 'override' ? <><RotateCcw size={14} /> Reset</> : <><Trash2 size={14} /> Delete</>}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr><td style={{ ...cell, color: 'var(--eb-text-muted)' }} colSpan={6}>No agent templates yet. Use “New template” above to define a reusable role that agents can be created from.</td></tr>
            )}
          </tbody>
        </table>
      )}

      <SidePanel
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? (editing.origin === 'new' ? 'New agent template' : `Edit: ${editing.template.displayName || editing.template.id}`) : ''}
        width="640px"
      >
        {editing && (
          <Editor
            initial={editing.origin === 'new' ? null : editing.template}
            origin={editing.origin}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); refetch(); }}
          />
        )}
      </SidePanel>

      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'oklch(0 0 0 / 0.4)' }}
             onClick={() => !busy && setConfirmDelete(null)}>
          <div style={{ background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-5)', maxWidth: 460, boxShadow: 'var(--eb-shadow-xl)' }}
               onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)' }}>
              {confirmDelete.origin === 'override' ? 'Reset to default?' : 'Delete template?'}
            </h3>
            <p style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', marginTop: 'var(--eb-space-2)' }}>
              {confirmDelete.origin === 'override'
                ? <>This discards your edits to <strong>{confirmDelete.displayName || confirmDelete.id}</strong> and restores the built-in default.</>
                : <>This permanently removes the custom template <strong>{confirmDelete.displayName || confirmDelete.id}</strong>. Already-created agents are not affected; it only disappears from future selection.</>}
            </p>
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end', marginTop: 'var(--eb-space-4)' }}>
              <button style={btn('secondary', busy)} onClick={() => setConfirmDelete(null)} disabled={busy}>Cancel</button>
              <button style={btn('danger', busy)} onClick={() => doDelete(confirmDelete)} disabled={busy}>
                {busy ? 'Working…' : (confirmDelete.origin === 'override' ? 'Reset to default' : 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
