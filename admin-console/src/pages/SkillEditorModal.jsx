import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FilePlus, FolderPlus, Upload, MoreVertical, Lock,
} from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import RowContextMenu from '../components/RowContextMenu';
import SkillMarkdown from '../components/SkillMarkdown';
import SkillVersionDiffModal from './SkillVersionDiffModal.jsx';
import {
  SKILL_MD, MAX_UPLOAD_BYTES, MAX_SAVE_BYTES, READ_CAP_BYTES,
  createModel, buildFileTree, visibleRows, isDir, isMarkdownPath, baseName, parentDir, isUnder,
  validateName, editFile, createFile, createFolder, renamePath, deletePath, uploadFile, uploadConflicts,
  compileChanges, listChanges, changeMarks, saveBytes, targetFolder, splitFrontmatter, looksBinary,
} from './skill-editor-model.js';
import { versionLabel, planEditFromVersion, decodeVersionFile, applyVersionPlan } from './skill-version-view.js';

/*
 * SkillEditorModal — the full-screen skill editor (#2837).
 *
 * Folder tree on the left, preview / edit / split view on the right, file
 * operations (new file/folder, rename/move, delete, upload) — all kept as
 * pending changes in the pure model (skill-editor-model.js) until one Save
 * sends them to POST /api/skills/:name/files/batch, which applies them
 * atomically as ONE new version. `readOnly` renders the same editor without
 * any edit control (agent-tier copies, missing write permission).
 *
 * `version` ({hash, entry}) opens an OLD version read-only (#2839): the tree and
 * files come from the version snapshot, a banner says so, and the header offers
 * Compare with current, Restore this version (confirmed; the server records a new
 * `restored` version) and Edit from this version (loads the old content into the
 * normal editor as pending changes — one Save records one version).
 *
 * Visual pattern follows Agent Chat's FileViewerModal (portaled, 90vw × 90vh).
 */

const MD_MODES = [
  { key: 'preview', label: 'Preview' },
  { key: 'edit', label: 'Edit' },
  { key: 'split', label: 'Split view' },
];
const TEXT_MODES = MD_MODES.slice(0, 2);

const CHANGE_LABEL = {
  added: 'new', modified: 'modified', renamed: 'renamed', 'folder-added': 'new folder', contains: 'contains changes',
};

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function base64ToBytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

const btn = (disabled, primary) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '5px 12px', borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', fontFamily: 'inherit',
  border: primary ? 'none' : '1px solid var(--eb-border-default)',
  background: primary ? (disabled ? 'var(--eb-bg-elevated)' : 'var(--eb-accent-primary)') : 'var(--eb-bg-surface)',
  color: primary ? (disabled ? 'var(--eb-text-muted)' : 'var(--eb-text-inverted)') : 'var(--eb-text-secondary)',
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
});

const toolBtn = (disabled) => ({
  ...btn(disabled, false), padding: '3px 8px', border: '1px solid transparent', background: 'none',
});

/* ─── content views ──────────────────────────────────────────────────── */

// Markdown preview with YAML frontmatter shown as a distinct metadata block
// instead of a run-on paragraph (AC6). Also used by the side panel preview.
export function MarkdownWithFrontmatter({ content }) {
  const { frontmatter, body } = splitFrontmatter(content);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {frontmatter != null && (
        <div
          aria-label="Frontmatter"
          style={{
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            background: 'var(--eb-bg-elevated)', overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '4px var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
            color: 'var(--eb-text-secondary)', borderBottom: '1px solid var(--eb-border-default)',
          }}>
            Metadata (frontmatter)
          </div>
          <pre style={{
            margin: 0, padding: 'var(--eb-space-3)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {frontmatter}
          </pre>
        </div>
      )}
      <SkillMarkdown content={body} />
    </div>
  );
}

function PlainText({ content }) {
  return (
    <pre style={{
      margin: 0, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)',
      color: 'var(--eb-text-primary)', whiteSpace: 'pre', overflow: 'auto',
    }}>
      {content || ''}
    </pre>
  );
}

// Monospaced multi-line editor with a line-number gutter (AC8). No soft wrap,
// so gutter rows line up with text rows; the gutter follows the scroll.
function LineNumberedEditor({ value, onChange, label }) {
  const gutterRef = useRef(null);
  const lines = useMemo(() => {
    const n = (value.match(/\n/g) || []).length + 1;
    return Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }, [value]);
  const shared = {
    margin: 0, padding: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)',
    fontSize: 'var(--eb-text-sm)', lineHeight: '1.5',
  };
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden' }}>
      <pre
        ref={gutterRef}
        aria-hidden="true"
        style={{
          ...shared, overflow: 'hidden', textAlign: 'right', userSelect: 'none', minWidth: 44,
          color: 'var(--eb-text-muted)', background: 'var(--eb-bg-elevated)', borderRight: '1px solid var(--eb-border-default)',
        }}
      >
        {lines}
      </pre>
      <textarea
        aria-label={label}
        value={value}
        wrap="off"
        spellCheck={false}
        onChange={e => onChange(e.target.value)}
        onScroll={e => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
        style={{
          ...shared, flex: 1, minWidth: 0, border: 'none', outline: 'none', resize: 'none',
          background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)', whiteSpace: 'pre', overflow: 'auto',
        }}
      />
    </div>
  );
}

// Text field shown inside a ConfirmDialog (new file / folder / rename). Focus
// is taken one frame late — ConfirmDialog focuses its confirm button on open.
function NameField({ label, value, onChange, error, onSubmit, hint }) {
  const ref = useRef(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select(); });
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
      <label style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
        {label}
        <input
          ref={ref}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !error) { e.preventDefault(); onSubmit(); } }}
          aria-invalid={!!error}
          style={{
            display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '6px 8px',
            fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)',
            border: `1px solid ${error ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
            borderRadius: 'var(--eb-radius-sm)', background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
          }}
        />
      </label>
      {hint && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{hint}</span>}
      {error && <span role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{error}</span>}
    </div>
  );
}

/* ─── tree ───────────────────────────────────────────────────────────── */

function TreeRow({ row, selected, focused, expanded, mark, readOnly, onSelect, onToggle, onMenu, rowRef }) {
  const isFolder = row.type === 'dir';
  const Icon = isFolder ? (expanded ? FolderOpen : Folder) : FileText;
  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={isFolder ? expanded : undefined}
      tabIndex={focused ? 0 : -1}
      data-path={row.path}
      title={`${row.path}${isFolder ? '/' : ` · ${formatBytes(row.size)}`}${mark ? ` · ${CHANGE_LABEL[mark] || 'changed'}` : ''}`}
      onClick={() => { onSelect(row); if (isFolder) onToggle(row.path); }}
      onContextMenu={e => { if (readOnly) return; e.preventDefault(); onMenu(row, { x: e.clientX, y: e.clientY }); }}
      className="skill-editor-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px',
        paddingLeft: 6 + row.depth * 14, cursor: 'pointer', borderRadius: 'var(--eb-radius-sm)',
        fontSize: 'var(--eb-text-sm)', whiteSpace: 'nowrap',
        background: selected ? 'var(--eb-accent-muted)' : 'transparent',
        color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-primary)',
      }}
    >
      <span style={{ width: 14, display: 'inline-flex', flexShrink: 0 }}>
        {isFolder && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </span>
      <Icon size={14} style={{ flexShrink: 0, color: isFolder ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{row.name}</span>
      {row.path === SKILL_MD && <Lock size={11} aria-label="pinned" style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />}
      {mark && (
        <span
          aria-label={CHANGE_LABEL[mark] || 'changed'}
          style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: mark === 'contains' ? 'var(--eb-text-muted)' : 'var(--eb-status-warning)',
          }}
        />
      )}
      {!readOnly && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Actions for ${row.path}`}
          className="skill-editor-kebab"
          onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(row, { x: r.left, y: r.bottom }); }}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--eb-text-muted)', display: 'inline-flex', flexShrink: 0 }}
        >
          <MoreVertical size={13} />
        </button>
      )}
    </div>
  );
}

/* ─── modal ──────────────────────────────────────────────────────────── */

export default function SkillEditorModal({
  skill, tierLabel, readOnly: readOnlyProp = false, readOnlyReason: readOnlyReasonProp, version = null, versionPermission = null, onClose, onSaved,
}) {
  const [versionView, setVersionView] = useState(version && version.hash ? version : null);
  const [currentHash, setCurrentHash] = useState(null);  // live content hash while viewing an old version
  const [versionBusy, setVersionBusy] = useState(false);
  const pendingPlanRef = useRef(null);                   // edit-from-version plan applied on the next load
  const readOnly = readOnlyProp || !!versionView;
  const readOnlyReason = versionView ? 'old version' : readOnlyReasonProp;
  const [listing, setListing] = useState(null);         // last server listing {files, dirs}
  const [model, setModel] = useState(null);
  const [baseHash, setBaseHash] = useState(null);
  const [listError, setListError] = useState(null);
  const [cache, setCache] = useState({});                // base path → {content, binary, truncated, size} | {error}
  const [selected, setSelected] = useState(SKILL_MD);
  const [focusPath, setFocusPath] = useState(SKILL_MD);
  const [expanded, setExpanded] = useState(() => new Set());
  const [mode, setMode] = useState('preview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);      // {text, conflict?, file?}
  const [notice, setNotice] = useState(null);            // {ok, text}
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);                // {row, anchor}
  const [treeWidth, setTreeWidth] = useState(300);
  const [dropActive, setDropActive] = useState(false);

  const containerRef = useRef(null);
  const treeRef = useRef(null);
  const rowRefs = useRef(new Map());
  const uploadInputRef = useRef(null);
  const uploadDirRef = useRef('');
  const openerRef = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  const closingRef = useRef(false);

  const scopeParams = useCallback((extra = {}) => {
    const p = new URLSearchParams({ source: skill.source, ...extra });
    if (skill.agentId) p.set('agentId', skill.agentId);
    if (skill.teamId) p.set('teamId', skill.teamId);
    return p;
  }, [skill.source, skill.agentId, skill.teamId]);
  const skillUrl = `/api/skills/${encodeURIComponent(skill.name)}`;

  const changes = useMemo(() => (model ? listChanges(model) : []), [model]);
  const marks = useMemo(() => (model ? changeMarks(model) : new Map()), [model]);
  const pending = changes.length;
  const pendingRef = useRef(0);
  pendingRef.current = pending;
  const modelRef = useRef(null);                       // latest model for async callers (uploads)
  modelRef.current = model;
  const tree = useMemo(() => (model ? buildFileTree(model) : []), [model]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  /* load ------------------------------------------------------------------ */

  const applyListing = useCallback((d, keepSelection) => {
    const l = { files: Array.isArray(d.files) ? d.files : [], dirs: Array.isArray(d.dirs) ? d.dirs : [] };
    const m = createModel(l);
    setListing(l);
    setModel(m);
    setBaseHash(d.hash || null);
    setCache({});
    const sel = keepSelection && (m.files[keepSelection] || isDir(m, keepSelection)) ? keepSelection : SKILL_MD;
    setSelected(sel);
    setFocusPath(sel);
  }, []);

  const getJson = useCallback(async (url, init) => {
    const r = await fetch(url, init);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status, body: d });
    return d;
  }, []);

  const versionHash = versionView ? versionView.hash : null;
  const load = useCallback(() => {
    setListError(null);
    setSaveError(null);
    if (versionHash) {
      return Promise.all([
        getJson(`${skillUrl}/versions/${encodeURIComponent(versionHash)}/files?${scopeParams()}`),
        getJson(`${skillUrl}/files?${scopeParams()}`),
      ])
        .then(([v, cur]) => {
          applyListing(v, null);
          setCurrentHash(cur.hash || null);
          if (v.entry) setVersionView(prev => (prev && prev.hash === versionHash ? { ...prev, entry: v.entry } : prev));
        })
        .catch(e => setListError(e.body && e.body.unavailable ? 'The content of this version is not available.' : e.message));
    }
    return getJson(`${skillUrl}/files?${scopeParams()}`)
      .then(d => {
        applyListing(d, null);
        setCurrentHash(null);
        const planned = pendingPlanRef.current;
        pendingPlanRef.current = null;
        if (!planned) return;
        if (d.hash !== planned.expectHash) {
          setNotice({ ok: false, text: 'The skill changed while the old version was being loaded — open the version again to retry.' });
          return;
        }
        const listingNow = { files: Array.isArray(d.files) ? d.files : [], dirs: Array.isArray(d.dirs) ? d.dirs : [] };
        const r = applyVersionPlan(createModel(listingNow), planned.plan, planned.contents);
        setModel(r.state);
        setNotice(r.errors.length
          ? { ok: false, text: `Loaded ${planned.label} with problems: ${r.errors.join('; ')}` }
          : { ok: true, text: `Loaded ${planned.label} as pending changes — review them and Save to record a new version.` });
      })
      .catch(e => setListError(e.message));
  }, [skillUrl, scopeParams, applyListing, getJson, versionHash]);

  useEffect(() => { load(); }, [load]);

  // Fetch a base file's content when the selection needs it.
  const selEntry = model?.files[selected];
  const needOrigin = selEntry && selEntry.content === undefined && selEntry.base64 === undefined ? selEntry.origin : null;
  useEffect(() => {
    if (!needOrigin || cache[needOrigin]) return;
    let cancelled = false;
    setCache(c => ({ ...c, [needOrigin]: { loading: true } }));
    const fileUrl = versionHash
      ? `${skillUrl}/versions/${encodeURIComponent(versionHash)}/file?${scopeParams({ file: needOrigin })}`
      : `${skillUrl}/file?${scopeParams({ file: needOrigin })}`;
    fetch(fileUrl)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setCache(c => ({ ...c, [needOrigin]: d })); })
      .catch(e => { if (!cancelled) setCache(c => ({ ...c, [needOrigin]: { error: e.message } })); });
    return () => { cancelled = true; };
    // `cache` is read only as a guard; listing it would refetch on every update.
  }, [needOrigin, skillUrl, scopeParams, versionHash]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the right pane shows for the selected file.
  const view = useMemo(() => {
    if (!selEntry) return null;
    const origin = selEntry.origin ? cache[selEntry.origin] : null;
    const baseText = origin && typeof origin.content === 'string' ? origin.content : undefined;
    if (selEntry.content !== undefined) return { text: selEntry.content, baseText, size: selEntry.size };
    if (selEntry.base64 !== undefined) {
      const bytes = base64ToBytes(selEntry.base64);
      if (looksBinary(bytes)) return { binary: true, size: selEntry.size };
      return { text: new TextDecoder().decode(bytes), baseText, size: selEntry.size };
    }
    if (!origin || origin.loading) return { loading: true };
    if (origin.error) return { error: origin.error };
    if (origin.binary) return { binary: true, size: origin.size };
    return { text: origin.content || '', baseText, truncated: !!origin.truncated, size: origin.size };
  }, [selEntry, cache]);

  const isMd = isMarkdownPath(selected);
  const editable = !readOnly && !!view && !view.loading && !view.error && !view.binary && !view.truncated;
  const effectiveMode = editable ? (mode === 'split' && !isMd ? 'edit' : mode) : 'preview';

  /* close / guards ---------------------------------------------------------- */

  const finishClose = useCallback(() => {
    closingRef.current = true;
    if (typeof window !== 'undefined' && window.history.state && window.history.state.aeeSkillEditor) window.history.back();
    onClose();
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (pendingRef.current > 0) {
      setDialog({ kind: 'confirm-close' });
      return;
    }
    finishClose();
  }, [finishClose]);

  // Browser back while open: close, or ask first when there are pending changes
  // (AC14). The modal owns one history entry for its lifetime.
  useEffect(() => {
    window.history.pushState({ ...(window.history.state || {}), aeeSkillEditor: true }, '');
    const onPop = () => {
      if (closingRef.current) return;
      if (pendingRef.current > 0) {
        window.history.pushState({ ...(window.history.state || {}), aeeSkillEditor: true }, '');
        setDialog({ kind: 'confirm-close' });
      } else {
        closingRef.current = true;
        onClose();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onClose]);

  // Reload / tab close with pending changes.
  useEffect(() => {
    if (pending === 0) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pending]);

  // Focus returns to the control that opened the editor (AC26).
  useEffect(() => {
    const opener = openerRef.current;
    return () => { if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus(); };
  }, []);

  /* save -------------------------------------------------------------------- */

  const save = useCallback(async () => {
    if (readOnly || saving || !model || pendingRef.current === 0) return;
    if (saveBytes(model) > MAX_SAVE_BYTES) {
      setSaveError({ text: `These changes exceed the ${MAX_SAVE_BYTES / (1024 * 1024)} MB limit for one save — save in smaller steps.` });
      return;
    }
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const res = await fetch(`${skillUrl}/files/batch?${scopeParams()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseHash, ...compileChanges(model) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError({ text: d.error || `HTTP ${res.status}`, conflict: !!d.conflict, file: d.file });
        return;
      }
      applyListing(d, selected);
      setNotice({ ok: true, text: d.version != null ? `Saved as version ${d.version}.` : 'Saved.' });
      onSaved?.();
    } catch (e) {
      setSaveError({ text: e.message });
    } finally {
      setSaving(false);
    }
  }, [readOnly, saving, model, skillUrl, scopeParams, baseHash, applyListing, selected, onSaved]);

  /* old version (#2839) ----------------------------------------------------- */

  const versionIsCurrent = !!versionView && !!currentHash && versionView.hash === currentHash;
  const restorePerm = versionPermission ? versionPermission.restore : { ok: false, reason: 'Not permitted' };
  const editFromPerm = versionPermission ? versionPermission.editFrom : { ok: false, reason: 'Not permitted' };
  const versionName = versionView ? (versionView.entry && versionView.entry.version != null ? `version ${versionView.entry.version}` : 'this version') : '';

  const restoreVersion = useCallback(async () => {
    if (!versionView || versionBusy) return;
    setDialog(null);
    setVersionBusy(true);
    setSaveError(null);
    setNotice(null);
    try {
      const d = await getJson(`${skillUrl}/versions/${encodeURIComponent(versionView.hash)}/restore?${scopeParams()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseHash: currentHash }),
      });
      if (!d.restored) {
        setNotice({ ok: true, text: 'This version already is the current content — nothing to restore.' });
        return;
      }
      onSaved?.();
      setVersionView(null);
      setNotice({ ok: true, text: `Restored ${versionName} as version ${d.version}.` });
    } catch (e) {
      const conflict = e.status === 409;
      setSaveError({ text: conflict ? 'The skill changed since this version was opened. Reload and try again.' : e.message, conflict });
    } finally {
      setVersionBusy(false);
    }
  }, [versionView, versionBusy, getJson, skillUrl, scopeParams, currentHash, onSaved, versionName]);

  const editFromVersion = useCallback(async () => {
    if (!versionView || versionBusy) return;
    setVersionBusy(true);
    setSaveError(null);
    setNotice(null);
    try {
      const hash = encodeURIComponent(versionView.hash);
      const diff = await getJson(`${skillUrl}/versions/diff?${scopeParams({ from: versionView.hash, to: 'working' })}`);
      const plan = planEditFromVersion(diff);
      const contents = new Map();
      for (const p of plan.fetch) {
        const f = await getJson(`${skillUrl}/versions/${hash}/file?${scopeParams({ file: p, encoding: 'base64' })}`);
        contents.set(p, decodeVersionFile(f));
      }
      pendingPlanRef.current = { plan, contents, expectHash: diff.to && diff.to.hash, label: versionName };
      setMode('preview');
      setVersionView(null);                              // the load effect applies the plan to the live skill
    } catch (e) {
      setSaveError({ text: `Could not load ${versionName}: ${e.message}` });
    } finally {
      setVersionBusy(false);
    }
  }, [versionView, versionBusy, getJson, skillUrl, scopeParams, versionName]);

  const overlayOpen = !!dialog || !!menu;

  // Escape closes, Ctrl/Cmd+S saves (AC15), Tab stays inside the modal (AC26).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!overlayOpen) save();
        return;
      }
      // The Skills side panel underneath closes on a window-level Escape — keep
      // it from unmounting the editor past the unsaved-changes guard.
      if (e.key === 'Escape') e.stopPropagation();
      if (overlayOpen) return; // the dialog / menu owns Escape and focus
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
      if (e.key === 'Tab' && containerRef.current) {
        const focusables = [...containerRef.current.querySelectorAll(
          'button:not([disabled]):not([tabindex="-1"]), textarea, input, [tabindex="0"], [href]',
        )].filter(el => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && (document.activeElement === first || !containerRef.current.contains(document.activeElement))) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !containerRef.current.contains(document.activeElement))) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlayOpen, save, requestClose]);

  // Initial focus: the tree's selected row once the listing is in.
  const initialFocusDone = useRef(false);
  useEffect(() => {
    if (initialFocusDone.current || !model) return;
    initialFocusDone.current = true;
    requestAnimationFrame(() => rowRefs.current.get(SKILL_MD)?.focus());
  }, [model]);

  /* operations -------------------------------------------------------------- */

  const apply = (result, after) => {
    if (result.error) { setNotice({ ok: false, text: result.error }); return false; }
    setNotice(null);
    setModel(result.state);
    if (after) after(result);
    return true;
  };

  const expandTo = (p) => setExpanded(prev => {
    const next = new Set(prev);
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) next.add(segs.slice(0, i).join('/'));
    return next;
  });

  const selectPath = (p) => { setSelected(p); setFocusPath(p); };
  // AC5: a file the user opens always starts in preview, whatever mode the
  // previous file was left in.
  const openPath = (p) => { if (p !== selected) setMode('preview'); selectPath(p); };

  function openNameDialog(kind, dir, current) {
    setDialog({ kind, dir, value: current ?? '', from: kind === 'rename' ? current : undefined });
  }

  function submitNameDialog() {
    const d = dialog;
    if (!d || !model) return;
    if (d.kind === 'new-file') {
      if (apply(createFile(model, d.dir, d.value), r => { expandTo(r.path); selectPath(r.path); if (!readOnly) setMode('edit'); })) setDialog(null);
    } else if (d.kind === 'new-folder') {
      if (apply(createFolder(model, d.dir, d.value), r => { expandTo(r.path); setExpanded(prev => new Set(prev).add(r.path)); selectPath(r.path); })) setDialog(null);
    } else if (d.kind === 'rename') {
      const from = d.from;
      if (apply(renamePath(model, from, d.value), r => {
        expandTo(r.path);
        if (isUnder(selected, from)) selectPath(r.path + selected.slice(from.length));
        setExpanded(prev => {
          const next = new Set();
          for (const e of prev) next.add(isUnder(e, from) ? r.path + e.slice(from.length) : e);
          return next;
        });
      })) setDialog(null);
    }
  }

  function nameDialogError() {
    const d = dialog;
    if (!d || !model) return null;
    if (d.kind === 'rename') {
      if (d.value === d.from) return null;
      const r = renamePath(model, d.from, d.value);
      return r.error;
    }
    const err = validateName(d.value);
    if (err) return d.value === '' ? null : err;
    const r = d.kind === 'new-file' ? createFile(model, d.dir, d.value) : createFolder(model, d.dir, d.value);
    return r.error;
  }

  function confirmDelete(p) {
    const r = deletePath(model, p);
    if (r.error) { setNotice({ ok: false, text: r.error }); return; }
    setDialog({ kind: 'confirm-delete', path: p, folder: isDir(model, p) });
  }

  function doDelete(p) {
    apply(deletePath(model, p), () => { if (isUnder(selected, p)) selectPath(SKILL_MD); });
    setDialog(null);
  }

  function startUpload(dir) {
    uploadDirRef.current = dir;
    uploadInputRef.current?.click();
  }

  async function handleFiles(fileList, dir) {
    if (readOnly || !model) return;
    const list = [...(fileList || [])];
    if (list.length === 0) return;
    const tooBig = list.filter(f => f.size > MAX_UPLOAD_BYTES);
    if (tooBig.length) {
      setNotice({ ok: false, text: `${tooBig.map(f => f.name).join(', ')}: larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit — nothing was added.` });
      return;
    }
    const badName = list.map(f => [f.name, validateName(f.name)]).find(([, err]) => err);
    if (badName) { setNotice({ ok: false, text: `${badName[0]}: ${badName[1]}` }); return; }
    const read = await Promise.all(list.map(async f => ({
      name: f.name, size: f.size, base64: bytesToBase64(new Uint8Array(await f.arrayBuffer())),
    })));
    const conflicts = uploadConflicts(model, dir, read.map(f => f.name));
    if (conflicts.length) setDialog({ kind: 'confirm-overwrite', dir, files: read, conflicts });
    else commitUploads(dir, read);
  }

  function commitUploads(dir, files) {
    let s = modelRef.current;
    for (const f of files) {
      const r = uploadFile(s, dir, f.name, { base64: f.base64, size: f.size });
      if (r.error) { setNotice({ ok: false, text: r.error }); setDialog(null); return; }
      s = r.state;
    }
    setModel(s);
    setNotice({ ok: true, text: `${files.length} file${files.length === 1 ? '' : 's'} added — pending until Save.` });
    if (dir) expandTo(`${dir}/x`);
    setDialog(null);
  }

  function menuItems(row) {
    const pinned = row.path === SKILL_MD;
    const folder = row.type === 'dir';
    const pinnedWhy = 'SKILL.md at the skill root is the skill itself — it cannot be renamed, moved or deleted.';
    return [
      ...(folder ? [
        { key: 'new-file', label: 'New file here…' },
        { key: 'new-folder', label: 'New folder here…' },
        { key: 'upload', label: 'Upload files here…' },
      ] : []),
      { key: 'rename', label: 'Rename / move…', disabled: pinned, title: pinned ? pinnedWhy : undefined, separated: folder },
      { key: 'delete', label: folder ? 'Delete folder…' : 'Delete…', danger: true, disabled: pinned, title: pinned ? pinnedWhy : undefined },
    ];
  }

  function onMenuChoose(key) {
    const row = menu?.row;
    if (!row) return;
    if (key === 'new-file') openNameDialog('new-file', row.path);
    else if (key === 'new-folder') openNameDialog('new-folder', row.path);
    else if (key === 'upload') startUpload(row.path);
    else if (key === 'rename') openNameDialog('rename', null, row.path);
    else if (key === 'delete') confirmDelete(row.path);
  }

  const toggleFolder = (p) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  /* tree keyboard (AC26) ---------------------------------------------------- */

  function focusRow(p) {
    setFocusPath(p);
    requestAnimationFrame(() => rowRefs.current.get(p)?.focus());
  }

  function onTreeKeyDown(e) {
    const idx = rows.findIndex(r => r.path === focusPath);
    const row = rows[idx];
    if (!row) return;
    const isFolder = row.type === 'dir';
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (idx < rows.length - 1) focusRow(rows[idx + 1].path); break;
      case 'ArrowUp': e.preventDefault(); if (idx > 0) focusRow(rows[idx - 1].path); break;
      case 'Home': e.preventDefault(); focusRow(rows[0].path); break;
      case 'End': e.preventDefault(); focusRow(rows[rows.length - 1].path); break;
      case 'ArrowRight':
        e.preventDefault();
        if (isFolder && !expanded.has(row.path)) toggleFolder(row.path);
        else if (isFolder && rows[idx + 1] && rows[idx + 1].depth > row.depth) focusRow(rows[idx + 1].path);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (isFolder && expanded.has(row.path)) toggleFolder(row.path);
        else if (parentDir(row.path)) focusRow(parentDir(row.path));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        openPath(row.path);
        if (isFolder) toggleFolder(row.path);
        break;
      case 'F2':
        if (!readOnly && row.path !== SKILL_MD) { e.preventDefault(); openNameDialog('rename', null, row.path); }
        break;
      case 'Delete':
        if (!readOnly && row.path !== SKILL_MD) { e.preventDefault(); confirmDelete(row.path); }
        break;
      case 'ContextMenu':
      case 'F10':
        if (!readOnly && (e.key === 'ContextMenu' || e.shiftKey)) {
          e.preventDefault();
          const r = rowRefs.current.get(row.path)?.getBoundingClientRect();
          setMenu({ row, anchor: { x: r ? r.left + 24 : 0, y: r ? r.bottom : 0 } });
        }
        break;
      default: break;
    }
  }

  /* drag & drop upload (AC20) ----------------------------------------------- */

  const dropDirFor = (target) => {
    const el = target && target.closest ? target.closest('[data-path]') : null;
    if (el) return targetFolder(model, el.getAttribute('data-path'));
    return targetFolder(model, selected);
  };

  /* resizable split (AC4) --------------------------------------------------- */

  function startResize(e) {
    e.preventDefault();
    const left = containerRef.current?.querySelector('[data-pane="tree"]')?.getBoundingClientRect().left || 0;
    const move = (ev) => setTreeWidth(Math.min(640, Math.max(180, ev.clientX - left)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* render ------------------------------------------------------------------ */

  const curDir = model ? targetFolder(model, selected) : '';
  const nameErr = dialog && ['new-file', 'new-folder', 'rename'].includes(dialog.kind) ? nameDialogError() : null;
  const titleId = 'skill-editor-title';

  const body = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)', padding: 'var(--eb-space-4)',
      }}
    >
      <div
        ref={containerRef}
        style={{
          display: 'flex', flexDirection: 'column', width: '96vw', height: '94vh',
          background: 'var(--eb-bg-surface)', borderRadius: 'var(--eb-radius-lg)',
          border: '1px solid var(--eb-border-default)', boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}
      >
        {/* header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-3)',
          borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0,
        }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
            {skill.name} <span style={{ color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-normal)' }}>({tierLabel})</span>
          </h2>
          {readOnly && (
            <span title={readOnlyReason || undefined} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', padding: '2px 8px',
              borderRadius: 'var(--eb-radius-sm)', background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
            }}>
              <Lock size={11} /> Read-only{readOnlyReason ? ` — ${readOnlyReason}` : ''}
            </span>
          )}
          {!readOnly && pending > 0 && (
            <span aria-live="polite" style={{
              fontSize: 'var(--eb-text-xs)', padding: '2px 8px', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-status-warning-bg)', color: 'var(--eb-status-warning-text)',
            }}>
              {pending} unsaved change{pending === 1 ? '' : 's'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {!readOnly && (
            <>
              <button type="button" onClick={() => setDialog({ kind: 'confirm-discard' })} disabled={pending === 0 || saving} style={btn(pending === 0 || saving)}>
                Discard
              </button>
              <button type="button" onClick={save} disabled={pending === 0 || saving} style={btn(pending === 0 || saving, true)} title="Save all changes as one new version (Ctrl+S / ⌘S)">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <button type="button" onClick={requestClose} aria-label="Close editor" title="Close (Esc)" style={{ ...toolBtn(false), padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {versionView && (
          <div role="note" aria-label="Old version" style={{
            display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '6px var(--eb-space-3)', flexShrink: 0, flexWrap: 'wrap',
            fontSize: 'var(--eb-text-xs)', borderBottom: '1px solid var(--eb-border-default)',
            background: 'var(--eb-status-warning-bg)', color: 'var(--eb-status-warning-text)',
          }}>
            <strong>You are viewing an old version</strong>
            <span style={{ fontFamily: 'var(--eb-font-mono)' }}>{versionLabel({ ...(versionView.entry || {}), hash: versionView.hash })}</span>
            {versionIsCurrent && <span>— this is the current content</span>}
            <span style={{ flex: 1 }} />
            <button type="button" style={btn(versionBusy)} disabled={versionBusy} onClick={() => setDialog({ kind: 'compare', from: versionView.hash })}>
              Compare with current
            </button>
            <button
              type="button"
              style={btn(versionBusy || !editFromPerm.ok || versionIsCurrent)}
              disabled={versionBusy || !editFromPerm.ok || versionIsCurrent}
              title={!editFromPerm.ok ? editFromPerm.reason : versionIsCurrent ? 'This version already is the current content' : 'Load this version into the editor as pending changes'}
              onClick={editFromVersion}
            >
              Edit from this version
            </button>
            <button
              type="button"
              style={btn(versionBusy || !restorePerm.ok || versionIsCurrent, true)}
              disabled={versionBusy || !restorePerm.ok || versionIsCurrent}
              title={!restorePerm.ok ? restorePerm.reason : versionIsCurrent ? 'This version already is the current content' : 'Make this version the current content again'}
              onClick={() => setDialog({ kind: 'confirm-restore' })}
            >
              {versionBusy ? 'Working…' : 'Restore this version'}
            </button>
          </div>
        )}

        {(saveError || notice) && (
          <div role={saveError || (notice && !notice.ok) ? 'alert' : 'status'} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '6px var(--eb-space-3)', flexShrink: 0,
            fontSize: 'var(--eb-text-xs)', borderBottom: '1px solid var(--eb-border-default)',
            color: saveError || !notice.ok ? 'var(--eb-status-error)' : 'var(--eb-status-success)',
          }}>
            <span style={{ flex: 1 }}>
              {saveError
                ? <>{saveError.file ? <strong>{saveError.file}: </strong> : null}{saveError.text}{!saveError.conflict && ' Nothing was written; your changes are still pending.'}</>
                : notice.text}
            </span>
            {saveError?.conflict && (
              <button type="button" onClick={() => setDialog({ kind: 'confirm-reload' })} style={btn(false)}>Reload</button>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => { setSaveError(null); setNotice(null); }} style={{ ...toolBtn(false), padding: 2 }}>
              <X size={12} />
            </button>
          </div>
        )}

        {listError ? (
          <div role="alert" style={{ padding: 'var(--eb-space-4)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            Failed to load the skill: {listError}
          </div>
        ) : !model ? (
          <div style={{ padding: 'var(--eb-space-4)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading skill…</div>
        ) : (
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {/* tree pane */}
            <div data-pane="tree" style={{ width: treeWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {!readOnly && (
                <div style={{ display: 'flex', gap: 2, padding: 'var(--eb-space-1)', borderBottom: '1px solid var(--eb-border-default)', flexWrap: 'wrap' }}>
                  <button type="button" style={toolBtn(false)} onClick={() => openNameDialog('new-file', curDir)} title={`New file in ${curDir || 'the skill root'}`}>
                    <FilePlus size={13} /> New file
                  </button>
                  <button type="button" style={toolBtn(false)} onClick={() => openNameDialog('new-folder', curDir)} title={`New folder in ${curDir || 'the skill root'}`}>
                    <FolderPlus size={13} /> New folder
                  </button>
                  <button type="button" style={toolBtn(false)} onClick={() => startUpload(curDir)} title={`Upload files into ${curDir || 'the skill root'} (or drop them on the tree)`}>
                    <Upload size={13} /> Upload
                  </button>
                  <input
                    ref={uploadInputRef}
                    type="file"
                    multiple
                    hidden
                    tabIndex={-1}
                    onChange={e => { handleFiles(e.target.files, uploadDirRef.current); e.target.value = ''; }}
                  />
                </div>
              )}
              <div
                ref={treeRef}
                role="tree"
                aria-label="Skill files"
                onKeyDown={onTreeKeyDown}
                onDragOver={e => {
                  if (readOnly || !e.dataTransfer?.types?.includes('Files')) return;
                  e.preventDefault();
                  setDropActive(true);
                }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); }}
                onDrop={e => {
                  if (readOnly) return;
                  e.preventDefault();
                  setDropActive(false);
                  handleFiles(e.dataTransfer.files, dropDirFor(e.target));
                }}
                style={{
                  flex: 1, overflow: 'auto', padding: 'var(--eb-space-1)',
                  outline: dropActive ? '2px dashed var(--eb-accent-primary)' : 'none', outlineOffset: -4,
                }}
              >
                {rows.map(row => (
                  <TreeRow
                    key={row.path}
                    row={row}
                    selected={row.path === selected}
                    focused={row.path === focusPath}
                    expanded={expanded.has(row.path)}
                    mark={marks.get(row.path)}
                    readOnly={readOnly}
                    rowRef={el => { if (el) rowRefs.current.set(row.path, el); else rowRefs.current.delete(row.path); }}
                    onSelect={r => openPath(r.path)}
                    onToggle={toggleFolder}
                    onMenu={(r, anchor) => { setFocusPath(r.path); setMenu({ row: r, anchor }); }}
                  />
                ))}
              </div>
              {!readOnly && (
                <div style={{ padding: '4px var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', borderTop: '1px solid var(--eb-border-default)' }}>
                  Empty folders are saved too. Right-click (or Shift+F10) a row for more.
                </div>
              )}
            </div>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file tree"
              aria-valuenow={treeWidth}
              aria-valuemin={180}
              aria-valuemax={640}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={e => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); setTreeWidth(w => Math.max(180, w - 20)); }
                if (e.key === 'ArrowRight') { e.preventDefault(); setTreeWidth(w => Math.min(640, w + 20)); }
              }}
              style={{ width: 5, cursor: 'col-resize', background: 'var(--eb-border-default)', flexShrink: 0 }}
            />

            {/* content pane */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {selEntry ? (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '6px var(--eb-space-3)',
                    borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0,
                  }}>
                    <span title={selected} style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selected}
                    </span>
                    {view?.size != null && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{formatBytes(view.size)}</span>}
                    {marks.get(selected) && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning-text)' }}>({CHANGE_LABEL[marks.get(selected)]})</span>}
                    <span style={{ flex: 1 }} />
                    {editable && (
                      <div role="group" aria-label="View mode" style={{ display: 'inline-flex', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden' }}>
                        {(isMd ? MD_MODES : TEXT_MODES).map(m => (
                          <button
                            key={m.key}
                            type="button"
                            aria-pressed={effectiveMode === m.key}
                            onClick={() => setMode(m.key)}
                            style={{
                              padding: '3px 10px', border: 'none', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit', cursor: 'pointer',
                              background: effectiveMode === m.key ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
                              color: effectiveMode === m.key ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {view?.truncated && (
                    <div role="note" style={{ padding: '6px var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-status-warning-bg)', color: 'var(--eb-status-warning-text)' }}>
                      This file is larger than {READ_CAP_BYTES / 1024} KB — only the first {READ_CAP_BYTES / 1024} KB are shown, and it cannot be edited here (saving it would cut it off). Upload a replacement instead.
                    </div>
                  )}
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-3)', overflow: 'hidden' }}>
                    {!view || view.loading ? (
                      <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading {selected}…</span>
                    ) : view.error ? (
                      <span role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load file: {view.error}</span>
                    ) : view.binary ? (
                      <span role="note" style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', fontStyle: 'italic' }}>
                        Binary file ({formatBytes(view.size)}) — not shown and not editable here. You can rename, move, delete or replace it by upload.
                      </span>
                    ) : (
                      <>
                        {(effectiveMode === 'edit' || effectiveMode === 'split') && (
                          <LineNumberedEditor
                            label={`Edit ${selected}`}
                            value={view.text}
                            onChange={text => apply(editFile(model, selected, text, view.baseText))}
                          />
                        )}
                        {(effectiveMode === 'preview' || effectiveMode === 'split') && (
                          <div style={{ flex: 1, minWidth: 0, overflow: 'auto', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
                            {isMd ? <MarkdownWithFrontmatter content={view.text} /> : <PlainText content={view.text} />}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ padding: 'var(--eb-space-4)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                  {selected && isDir(model, selected)
                    ? `Folder ${selected}/ — select a file to view it.`
                    : 'Select a file to view it.'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <style>{`
        .skill-editor-row .skill-editor-kebab { visibility: hidden; }
        .skill-editor-row:hover .skill-editor-kebab, .skill-editor-row:focus .skill-editor-kebab { visibility: visible; }
        .skill-editor-row:hover { background: var(--eb-bg-hover); }
        .skill-editor-row:focus-visible { outline: 2px solid var(--eb-accent-primary); outline-offset: -2px; }
      `}</style>
    </div>
  );

  return (
    <>
      {createPortal(body, document.body)}
      {menu && (
        <RowContextMenu
          items={menuItems(menu.row)}
          anchor={menu.anchor}
          label={`Actions for ${menu.row.path}`}
          onChoose={onMenuChoose}
          onClose={() => { setMenu(null); focusRow(menu.row.path); }}
        />
      )}
      <ConfirmDialog
        open={!!dialog && ['new-file', 'new-folder', 'rename'].includes(dialog.kind)}
        variant="info"
        title={dialog?.kind === 'new-file' ? 'New file' : dialog?.kind === 'new-folder' ? 'New folder' : `Rename / move ${dialog?.from ? baseName(dialog.from) : ''}`}
        confirmLabel={dialog?.kind === 'rename' ? 'Rename' : 'Create'}
        confirmDisabled={!!nameErr || !dialog?.value || (dialog?.kind === 'rename' && dialog?.value === dialog?.from)}
        onConfirm={submitNameDialog}
        onCancel={() => setDialog(null)}
        message={dialog && ['new-file', 'new-folder', 'rename'].includes(dialog.kind) ? (
          <NameField
            label={dialog.kind === 'rename' ? 'New path (relative to the skill folder)' : `Name (in ${dialog.dir ? `${dialog.dir}/` : 'the skill root'})`}
            hint={dialog.kind === 'rename' ? 'Change the folder part of the path to move it.' : undefined}
            value={dialog.value}
            onChange={v => setDialog(d => ({ ...d, value: v }))}
            error={nameErr}
            onSubmit={submitNameDialog}
          />
        ) : null}
      />
      <ConfirmDialog
        open={dialog?.kind === 'confirm-delete'}
        variant="danger"
        title={dialog?.folder ? 'Delete folder?' : 'Delete file?'}
        confirmLabel="Delete"
        message={dialog?.kind === 'confirm-delete'
          ? `${dialog.path}${dialog.folder ? '/ and everything in it' : ''} will be deleted when you save. You can still discard before saving.`
          : ''}
        onConfirm={() => doDelete(dialog.path)}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'confirm-overwrite'}
        variant="warning"
        title="Replace existing files?"
        confirmLabel="Replace"
        message={dialog?.kind === 'confirm-overwrite'
          ? `${dialog.conflicts.join(', ')} already exist${dialog.conflicts.length === 1 ? 's' : ''} in ${dialog.dir || 'the skill root'}. Replace with the uploaded version?`
          : ''}
        onConfirm={() => commitUploads(dialog.dir, dialog.files)}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'confirm-discard'}
        variant="danger"
        title="Discard all changes?"
        confirmLabel="Discard"
        message={dialog?.kind === 'confirm-discard' ? (
          <div style={{ fontSize: 'var(--eb-text-sm)' }}>
            <p style={{ margin: '0 0 var(--eb-space-2)' }}>These {pending} unsaved change{pending === 1 ? '' : 's'} will be lost:</p>
            <ul style={{ margin: 0, paddingLeft: '1.2em', maxHeight: 200, overflow: 'auto', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
              {changes.map(c => <li key={`${c.kind}:${c.path}`}>{c.from ? `${c.from} → ${c.path}` : c.path} ({c.kind.replace('-', ' ')})</li>)}
            </ul>
          </div>
        ) : ''}
        onConfirm={() => { setModel(createModel(listing)); setDialog(null); setSaveError(null); setNotice(null); selectPath(SKILL_MD); }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'confirm-close'}
        variant="warning"
        title="Close with unsaved changes?"
        confirmLabel="Discard and close"
        cancelLabel="Keep editing"
        message={`You have ${pending} unsaved change${pending === 1 ? '' : 's'}. Closing discards them.`}
        onConfirm={() => { setDialog(null); finishClose(); }}
        onCancel={() => setDialog(null)}
      />
      {dialog?.kind === 'compare' && (
        <SkillVersionDiffModal skill={skill} from={dialog.from} to="working" onClose={() => setDialog(null)} />
      )}
      <ConfirmDialog
        open={dialog?.kind === 'confirm-restore'}
        variant="warning"
        title={`Restore ${versionName}?`}
        confirmLabel="Restore"
        message={`The skill's current content is replaced by ${versionName}. This is recorded as a new "restored" version, so the current content stays in the history and can be restored again.`}
        onConfirm={restoreVersion}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'confirm-reload'}
        variant="warning"
        title="Reload the skill?"
        confirmLabel="Reload"
        message={`Reloading shows the current version of the skill and discards your ${pending} pending change${pending === 1 ? '' : 's'}. Copy anything you want to keep first.`}
        onConfirm={() => { setDialog(null); load(); }}
        onCancel={() => setDialog(null)}
      />
    </>
  );
}
