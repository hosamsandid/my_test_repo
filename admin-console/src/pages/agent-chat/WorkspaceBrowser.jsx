import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode,
  Brain, Sparkles, BookOpen, Loader2, X, RefreshCw, AlertCircle, FileWarning,
  Maximize2, Minimize2, Code2, Eye, GitBranch, Upload, GitCompare, Download, Trash2,
  ImageOff, AtSign, ShieldAlert,
} from 'lucide-react';
import DiffView from './DiffView';
import { isImageData, imageSrcUrl } from './workspace-image';
import {
  HTML_PREVIEW_SANDBOX, HTML_PREVIEW_MAX_BYTES, isHtmlFile, canOfferHtmlPreview, isHtmlTooLarge,
  htmlPreviewUrl, initialViewState, viewStateFor, viewStateReducer, bodyViewMode, htmlPreviewBannerText,
} from './html-preview.js';
import {
  isContextKey, isReadOnlyKey, workspaceUrl, withContextRoot, childKey,
  mountForKey, sameWritableSource, writeApiBase, apiRelOf,
} from './workspace-source';
import ConfirmDialog from '../../components/ConfirmDialog';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
// #2067: the same panel the agent's Settings tab renders, so both surfaces
// read and write the same data and enforce the same authorization (AC20).
import AgentRepositoriesPanel from './AgentRepositoriesPanel';

const MODE_KEY = 'agentChat.workspaceMode';

// Chip for a mounted host-folder root (#1283/#1289). The label reflects the
// mount's ACCESS MODE — how the agent sees the folder — so a read-write mount
// no longer masquerades as read-only. The console itself always browses the
// folder read-only (there is no write route into the container's mount), which
// the tooltip keeps honest.
function contextChip(item) {
  const rw = !!(item && item.readWrite);
  const label = rw ? 'host · read-write' : 'host · read-only';
  const mode = rw
    ? 'host folder, read-write for the agent; browsed read-only here'
    : 'host folder, read-only';
  const title = item && item.hostPath ? `${item.hostPath} (${mode})` : `Host folder (${mode})`;
  return { label, title };
}

/**
 * Read-only workspace browser for an agent.
 *
 * Layout: vertical split. Top half is the lazy-loading file tree rooted at
 * /workspace/agents/<agentId>/. Bottom half is the file viewer that appears
 * when a file is clicked. The split is removed entirely while no file is
 * open so the tree fills the panel.
 *
 * Refresh: a small button in the toolbar refetches the currently expanded
 * directories. We don't auto-refresh because the agent's filesystem is
 * mostly static between turns; explicit refresh keeps the UI predictable.
 *
 * Props:
 *   - agentId  Selected agent. When null, shows a "pick an agent" stub.
 *   - active   Whether this tab is currently visible. Used to skip the
 *              initial fetch while the panel is hidden behind another tab.
 *   - onReference  (relPath) => void — called by a per-file "Reference in chat"
 *              button (#1699) to splice a `@<relPath>` token into the composer.
 *              Only offered for real workspace files, never a `/context` mount
 *              key (those are not workspace-relative resolvable — the agent
 *              cannot open them from its cwd). Omitted ⇒ no reference button.
 */
export default function WorkspaceBrowser({ agentId, active, refreshKey = 0, onReference = null }) {
  // dirCache:  Map<relativePath, { items, loading, error }>  (resolved listings)
  // expanded:  Set<relativePath>   currently open directories (root is "")
  const [dirCache, setDirCache] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [selectedFile, setSelectedFile] = useState(null); // { path }

  // Workspace has two display modes: the file tree (default) and a git diff
  // view. The mode is persisted across reloads but reset on agent change so
  // that switching agents always starts with a predictable view.
  const [mode, setMode] = useState(() => {
    try {
      const v = localStorage.getItem(MODE_KEY);
      if (v === 'tree' || v === 'diff') return v;
    } catch { /* ignore */ }
    return 'tree';
  });
  useEffect(() => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  }, [mode]);

  // Agent-scoped repositories panel (#2067). Collapsed by default and never
  // persisted: it is a configuration surface, not a display mode, and it
  // shares the toolbar with Upload — opening one closes the other, so the
  // tree is never pushed off-screen by two stacked panels.
  const [reposOpen, setReposOpen] = useState(false);

  // Upload panel state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDir, setUploadDir] = useState('');
  const [uploadStatus, setUploadStatus] = useState('idle'); // 'idle' | 'uploading' | 'success' | 'error'
  const [uploadMessage, setUploadMessage] = useState('');
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadResetTimerRef = useRef(null);

  // Delete confirmation state. deleteTarget = { path, type, name } | null.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Drag-and-drop move state.
  //   dragItem    = { path, type } currently being dragged | null
  //   dragOverDir = rel path of the directory under the cursor ('' = root) | null
  //   moveError   = message shown in an alert dialog when a move fails | ''
  const [dragItem, setDragItem] = useState(null);
  const [dragOverDir, setDragOverDir] = useState(null);
  const [moveError, setMoveError] = useState('');

  // Per-directory ZIP download (#2318).
  //   dirDownloadError = message shown in an alert dialog when a download is
  //                      refused (too large) or fails to start | ''
  //   downloadingDir   = rel path of the directory whose pre-flight check is in
  //                      progress (shows a spinner in place of its icon) | null
  const [dirDownloadError, setDirDownloadError] = useState('');
  const [downloadingDir, setDownloadingDir] = useState(null);

  // Read-only host context folder (#1283/#1286). When the agent has one, the
  // tree grows a virtual `context` root next to the real workspace entries; its
  // contents are read through the agent's container, never from this container.
  // null = unknown/none.
  const [contextStatus, setContextStatus] = useState(null);

  // Bump generation counter on agent change so a slow response from the
  // previous agent can't poison the new agent's cache.
  const reqIdRef = useRef(0);

  /* ─── Reset on agent change; cancel any pending upload-reset timer ── */
  useEffect(() => {
    reqIdRef.current += 1;
    setDirCache(new Map());
    setExpanded(new Set(['']));
    setSelectedFile(null);
    setUploadOpen(false);
    setReposOpen(false);
    setUploadDir('');
    setUploadStatus('idle');
    setUploadMessage('');
    setDeleteTarget(null);
    setDeleteBusy(false);
    setDeleteError('');
    setDragItem(null);
    setDragOverDir(null);
    setMoveError('');
    setContextStatus(null);
    return () => { clearTimeout(uploadResetTimerRef.current); };
  }, [agentId]);

  /* ─── Does this agent have a mounted context folder? ─────────────── */
  useEffect(() => {
    if (!active || !agentId) return;
    const reqId = reqIdRef.current;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/context/status`);
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || reqId !== reqIdRef.current) return;
        setContextStatus(data && data.enabled ? data : null);
      } catch { /* no mount surfaced — the tree just stays workspace-only */ }
    })();
    return () => { cancelled = true; };
  }, [active, agentId]);

  const fetchDir = useCallback(async (relPath) => {
    if (!agentId) return;
    const reqId = reqIdRef.current;
    setDirCache(prev => {
      const next = new Map(prev);
      next.set(relPath, { ...(next.get(relPath) || {}), loading: true, error: null });
      return next;
    });
    try {
      const r = await fetch(workspaceUrl(agentId, relPath, 'tree'));
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      if (reqId !== reqIdRef.current) return; // outdated agent
      setDirCache(prev => {
        const next = new Map(prev);
        next.set(relPath, { items: Array.isArray(data?.items) ? data.items : [], loading: false, error: null });
        return next;
      });
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setDirCache(prev => {
        const next = new Map(prev);
        next.set(relPath, { items: [], loading: false, error: err.message || 'Failed' });
        return next;
      });
    }
  }, [agentId]);

  /* ─── Initial root fetch when the panel becomes active ──────────── */
  useEffect(() => {
    if (!active || !agentId) return;
    if (dirCache.has('')) return;
    fetchDir('');
  }, [active, agentId, dirCache, fetchDir]);

  const toggleDir = useCallback((relPath) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(relPath)) {
        next.delete(relPath);
      } else {
        next.add(relPath);
        if (!dirCache.has(relPath)) fetchDir(relPath);
      }
      return next;
    });
  }, [dirCache, fetchDir]);

  const refreshAll = useCallback(() => {
    if (!agentId) return;
    const paths = Array.from(expanded);
    setDirCache(new Map());
    paths.forEach(p => fetchDir(p));
  }, [agentId, expanded, fetchDir]);

  /* ─── External refresh signal ───────────────────────────────────────
   * The chat composer bumps `refreshKey` after it uploads a file into the
   * agent's `chat-uploads/` dir, so the tree picks up the new file without a
   * manual refresh. Same effect as clicking the toolbar refresh button. We
   * track the previous value so this never fires on mount / agent switch.
   */
  const prevRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === prevRefreshKeyRef.current) return;
    prevRefreshKeyRef.current = refreshKey;
    refreshAll();
  }, [refreshKey, refreshAll]);

  // isFolder=true: files carry webkitRelativePath for directory tree reconstruction.
  const handleUpload = useCallback(async (files, isFolder = false) => {
    if (!files || files.length === 0) return;
    setUploadStatus('uploading');
    setUploadMessage('');
    const form = new FormData();
    // uploadDir is a tree key — a workspace path, or a `/context…` key for a
    // read-write mount. Route + relativise accordingly (apiRelOf strips the
    // leading `/context` for the mount browse API).
    form.append('path', apiRelOf(uploadDir));
    for (const f of files) {
      form.append('files', f);
      form.append('relativePaths', isFolder && f.webkitRelativePath ? f.webkitRelativePath : '');
    }
    try {
      const r = await fetch(`${writeApiBase(agentId, uploadDir)}/upload`, {
        method: 'POST',
        body: form,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setUploadStatus('error');
        setUploadMessage(j?.error || `HTTP ${r.status}`);
        return;
      }
      const n = j?.uploaded?.length ?? 0;
      const folderName = isFolder && files[0]?.webkitRelativePath
        ? files[0].webkitRelativePath.split('/')[0]
        : null;
      setUploadStatus('success');
      setUploadMessage(folderName
        ? `${n} file${n !== 1 ? 's' : ''} from "${folderName}" uploaded`
        : `${n} file${n !== 1 ? 's' : ''} uploaded`);
      refreshAll();
      // Auto-close the panel after a brief success indication.
      // Timer is stored so it can be cancelled if the component unmounts first.
      clearTimeout(uploadResetTimerRef.current);
      uploadResetTimerRef.current = setTimeout(
        () => { setUploadOpen(false); setUploadStatus('idle'); setUploadMessage(''); },
        1800,
      );
    } catch (err) {
      setUploadStatus('error');
      setUploadMessage(err.message || 'Upload failed');
    }
  }, [agentId, uploadDir, refreshAll]);

  // Opens the upload panel pre-targeted to a specific directory path.
  const handleUploadToDir = useCallback((dirPath) => {
    setUploadDir(dirPath);
    setUploadOpen(true);
    setUploadStatus('idle');
    setUploadMessage('');
  }, []);

  // Download one workspace directory as a ZIP (#2318). Two steps on purpose:
  //  1. A pre-flight fetch (`?probe=1`) asks the server to size the directory
  //     WITHOUT producing any archive. An oversize refusal comes back as JSON
  //     and is shown as an in-app alert — never as raw JSON in a new tab or a
  //     completed-but-empty download (AC8/AC10).
  //  2. Only once the server has said yes do we trigger the browser's native
  //     streamed download via a synthetic anchor (same mechanism as the per-file
  //     download). The native download UI is the "download started" indicator
  //     the streamed-archive case needs — there is no Content-Length, so no
  //     progress bar — and its Cancel closes the connection, which the server
  //     turns into killing the zip process; a mid-stream failure is destroyed
  //     server-side so the browser marks the download failed (AC11/AC12).
  const downloadDir = useCallback(async (relPath, name) => {
    // Workspace directories only — never the root and never a `/context` mount
    // (D3). The rows already hide the control there; this refuses defensively.
    if (!agentId || !relPath || isContextKey(relPath)) return;
    const url = workspaceUrl(agentId, relPath, 'zip');
    if (!url) return;
    setDirDownloadError('');
    setDownloadingDir(relPath);
    try {
      const probe = await fetch(`${url}&probe=1`);
      if (!probe.ok) {
        const j = await probe.json().catch(() => ({}));
        setDirDownloadError(j?.error || `Could not download this directory (HTTP ${probe.status}).`);
        return;
      }
    } catch (err) {
      setDirDownloadError(err?.message || 'Could not start the download.');
      return;
    } finally {
      setDownloadingDir(prev => (prev === relPath ? null : prev));
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.zip`;
    a.click();
  }, [agentId]);

  // Opens the delete-confirmation dialog for one file or directory. A key under
  // a read-only context mount is never deletable — the rows don't offer the
  // action, and this refuses it even if something else calls in.
  const requestDelete = useCallback((relPath, type, name) => {
    if (isReadOnlyKey(relPath, contextStatus)) return;
    setDeleteError('');
    setDeleteTarget({ path: relPath, type, name });
  }, [contextStatus]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !agentId) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const r = await fetch(
        `${writeApiBase(agentId, deleteTarget.path)}/file?path=${encodeURIComponent(apiRelOf(deleteTarget.path))}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      // Close the viewer if the open file lived under the deleted path.
      setSelectedFile(prev => {
        if (!prev) return prev;
        if (prev.path === deleteTarget.path || prev.path.startsWith(deleteTarget.path + '/')) return null;
        return prev;
      });
      setDeleteTarget(null);
      refreshAll();
    } catch (err) {
      setDeleteError(err.message || 'Delete failed');
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, agentId, refreshAll]);

  /* ─── Drag-and-drop move ──────────────────────────────────────────── */

  const parentOf = (relPath) => (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '');

  // Whether the current drag item may be dropped into targetDir ('' = root).
  const canDropInto = useCallback((targetDir) => {
    if (!dragItem) return false;
    const src = dragItem.path;
    // A move is a plain rename within ONE filesystem — allowed only between two
    // workspace keys or two keys under the SAME read-write context mount. This
    // rules out read-only mounts, cross-folder and workspace↔context drags.
    if (!sameWritableSource(src, targetDir, contextStatus)) return false;
    if (targetDir === parentOf(src)) return false;          // already there
    if (dragItem.type === 'dir') {
      if (targetDir === src) return false;                   // into itself
      if (targetDir.startsWith(src + '/')) return false;     // into own descendant
    }
    return true;
  }, [dragItem, contextStatus]);

  const performMove = useCallback(async (targetDir) => {
    const item = dragItem;
    setDragItem(null);
    setDragOverDir(null);
    if (!item || !agentId || !canDropInto(targetDir)) return;
    const from = item.path;
    const movedName = from.includes('/') ? from.slice(from.lastIndexOf('/') + 1) : from;
    try {
      // from and targetDir share a source (canDropInto), so either both route to
      // /workspace or both to /context with mount-relative paths.
      const r = await fetch(`${writeApiBase(agentId, from)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: apiRelOf(from), toDir: apiRelOf(targetDir) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const newPath = targetDir ? `${targetDir}/${movedName}` : movedName;
      // Follow the open file if it (or its ancestor) moved.
      setSelectedFile(prev => {
        if (!prev) return prev;
        if (prev.path === from) return { path: newPath };
        if (prev.path.startsWith(from + '/')) return { path: newPath + prev.path.slice(from.length) };
        return prev;
      });
      // Refresh source + destination (and expand the destination so the moved
      // item is visible). Recompute from the current expanded set + targetDir.
      const paths = new Set(expanded);
      paths.add(targetDir);
      setExpanded(paths);
      setDirCache(new Map());
      paths.forEach(p => fetchDir(p));
    } catch (err) {
      setMoveError(err.message || 'Move failed');
    }
  }, [dragItem, agentId, canDropInto, expanded, fetchDir]);

  // Bundle of handlers/state threaded down to every tree row.
  const dnd = useMemo(() => ({
    dragItemPath: dragItem?.path ?? null,
    dragOverDir,
    canDropInto,
    onDragStart: (relPath, type) => setDragItem({ path: relPath, type }),
    onDragEnd: () => { setDragItem(null); setDragOverDir(null); },
    onDirDragOver: (relPath, e) => {
      if (!canDropInto(relPath)) return;     // not a valid target → no-drop cursor
      e.preventDefault();
      e.stopPropagation();                   // don't let the root container also claim it
      e.dataTransfer.dropEffect = 'move';
      setDragOverDir(prev => (prev === relPath ? prev : relPath));
    },
    onDirDragLeave: (relPath) => setDragOverDir(prev => (prev === relPath ? null : prev)),
    onDirDrop: (relPath, e) => { e.preventDefault(); e.stopPropagation(); performMove(relPath); },
  }), [dragItem, dragOverDir, canDropInto, performMove]);

  /* ─── Render ─────────────────────────────────────────────────────── */
  if (!agentId) {
    return (
      <div style={emptyStyle}>
        Select an agent to browse its workspace.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Mode switch — sits above the toolbar so the path label still reads
          left-to-right in the tree mode. */}
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
      }}>
        <ModeButton
          icon={<FolderOpen size={11} />}
          label="Tree"
          active={mode === 'tree'}
          onClick={() => setMode('tree')}
        />
        <ModeButton
          icon={<GitCompare size={11} />}
          label="Git"
          active={mode === 'diff'}
          onClick={() => setMode('diff')}
        />
        <div style={{ flex: 1 }} />
        {/* #1972: this tab's "?" — what the tree shows, "reference in chat", and
            how a context-folder mount differs (read-only vs read-write). The
            chapter describes mounts generally, so the "?" reads the same for an
            agent that has none. */}
        <PageHelpButton
          label="What the workspace tab shows"
          size={13}
          section={AGENT_CHAT_HELP_SECTIONS.workspace}
          style={{ padding: '0 var(--eb-space-2)', alignSelf: 'center' }}
        />
      </div>

      {/* Diff mode renders its own toolbar + list + diff pane. */}
      {mode === 'diff' && (
        <DiffView agentId={agentId} active={active && mode === 'diff'} />
      )}

      {/* Tree-mode toolbar */}
      {mode === 'tree' && (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        borderBottom: (uploadOpen || reposOpen) ? 'none' : '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          fontFamily: 'var(--eb-font-mono)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          /workspace/agents/{agentId}/
        </div>
        {/* #2067 D1: attaching an additional repository to THIS agent, placed
            with the existing Workspace actions because the workspace is where
            a user notices a repository is missing. Sits first because it
            changes what the tree contains rather than acting on what it
            already has. */}
        <button
          onClick={() => { setReposOpen(o => !o); if (!reposOpen) setUploadOpen(false); }}
          title="Repositories in this agent's workspace"
          style={{ ...iconBtnStyle, color: reposOpen ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }}
          onMouseEnter={e => { if (!reposOpen) e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { if (!reposOpen) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <GitBranch size={12} />
        </button>
        <button
          onClick={() => { setUploadOpen(o => !o); if (!uploadOpen) setReposOpen(false); setUploadStatus('idle'); setUploadMessage(''); if (!uploadOpen) setUploadDir(''); }}
          title="Upload files or folder to workspace"
          style={{ ...iconBtnStyle, color: uploadOpen ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }}
          onMouseEnter={e => { if (!uploadOpen) e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { if (!uploadOpen) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <Upload size={12} />
        </button>
        <button
          onClick={() => window.open(`/api/agents/${encodeURIComponent(agentId)}/export`, '_blank')}
          title="Export agent workspace as ZIP"
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <Download size={12} />
        </button>
        <button
          onClick={refreshAll}
          title="Reload tree"
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      )}

      {/* Agent-scoped repositories panel (#2067). The same component the
          Settings tab renders (AC20), so the two surfaces cannot drift; a
          successful attach/remove refreshes the tree so the new directory
          appears without pressing Refresh (AC4). */}
      {mode === 'tree' && reposOpen && (
        <div style={{
          borderBottom: '1px solid var(--eb-border-default)',
          background: 'var(--eb-bg-elevated)',
          padding: 'var(--eb-space-3)',
          flexShrink: 0,
          maxHeight: '50%',
          overflowY: 'auto',
        }}>
          <AgentRepositoriesPanel
            agentId={agentId}
            active={active}
            onChanged={refreshAll}
          />
        </div>
      )}

      {/* Upload panel */}
      {mode === 'tree' && uploadOpen && (
        <div style={{
          borderBottom: '1px solid var(--eb-border-default)',
          background: 'var(--eb-bg-elevated)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-2)',
        }}>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>Target:</span>
            <input
              type="text"
              value={uploadDir}
              onChange={e => setUploadDir(e.target.value)}
              placeholder="workspace root"
              disabled={uploadStatus === 'uploading'}
              style={{
                flex: 1,
                fontSize: 'var(--eb-text-xs)',
                fontFamily: 'var(--eb-font-mono)',
                background: 'var(--eb-bg-surface)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-sm)',
                color: 'var(--eb-text-primary)',
                padding: '2px 6px',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Hidden file inputs */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => { handleUpload(e.target.files, false); e.target.value = ''; }}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => { handleUpload(e.target.files, true); e.target.value = ''; }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadStatus === 'uploading'}
              style={{
                fontSize: 'var(--eb-text-xs)',
                padding: '3px 10px',
                background: uploadStatus === 'uploading' ? 'var(--eb-bg-active)' : 'var(--eb-accent-primary)',
                color: uploadStatus === 'uploading' ? 'var(--eb-text-muted)' : 'var(--eb-text-inverted)',
                border: 'none',
                borderRadius: 'var(--eb-radius-sm)',
                cursor: uploadStatus === 'uploading' ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                flexShrink: 0,
              }}
            >
              {uploadStatus === 'uploading'
                ? <><Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> Uploading…</>
                : <><Upload size={10} /> Files</>}
            </button>
            <button
              onClick={() => {
                // webkitdirectory must be set imperatively; React doesn't forward it as a DOM attribute.
                if (folderInputRef.current) {
                  folderInputRef.current.setAttribute('webkitdirectory', '');
                  folderInputRef.current.click();
                }
              }}
              disabled={uploadStatus === 'uploading'}
              style={{
                fontSize: 'var(--eb-text-xs)',
                padding: '3px 10px',
                background: 'var(--eb-bg-surface)',
                color: uploadStatus === 'uploading' ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-sm)',
                cursor: uploadStatus === 'uploading' ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                flexShrink: 0,
              }}
            >
              <Folder size={10} /> Folder
            </button>
            {uploadMessage && (
              <span style={{
                fontSize: 'var(--eb-text-xs)',
                color: uploadStatus === 'error' ? 'var(--eb-status-error)' : 'var(--eb-status-success)',
                flex: 1,
              }}>
                {uploadMessage}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tree (top) — shrinks when a file viewer is open below. The container
          itself is the drop target for "move to workspace root": children that
          are directories stop propagation, so this only fires over empty space
          or non-directory rows. */}
      {mode === 'tree' && (
        <div
          onDragOver={(e) => {
            if (!canDropInto('')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragOverDir(prev => (prev === '' ? prev : ''));
          }}
          onDragLeave={(e) => {
            // Only clear when the pointer actually leaves the container.
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setDragOverDir(prev => (prev === '' ? null : prev));
          }}
          onDrop={(e) => { if (canDropInto('')) { e.preventDefault(); performMove(''); } }}
          style={{
            flex: selectedFile ? '0 0 40%' : '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            padding: '4px 0',
            outline: dragOverDir === '' ? '2px dashed var(--eb-accent-primary)' : 'none',
            outlineOffset: '-2px',
          }}
        >
          <DirNode
            relPath=""
            name={null}
            depth={0}
            dirCache={dirCache}
            expanded={expanded}
            onToggleDir={toggleDir}
            onSelectFile={(p) => setSelectedFile({ path: p })}
            selectedFilePath={selectedFile?.path || null}
            onUploadToDir={handleUploadToDir}
            onDownloadDir={downloadDir}
            downloadingDir={downloadingDir}
            onRequestDelete={requestDelete}
            onReference={onReference}
            dnd={dnd}
            agentId={agentId}
            contextStatus={contextStatus}
          />
        </div>
      )}

      {/* File viewer (bottom) */}
      {mode === 'tree' && selectedFile && (
        <FileViewer
          agentId={agentId}
          path={selectedFile.path}
          onClose={() => setSelectedFile(null)}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        variant="danger"
        title={deleteTarget?.type === 'dir' ? 'Delete directory' : 'Delete file'}
        confirmLabel={deleteBusy ? 'Deleting…' : 'Delete'}
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleteBusy) { setDeleteTarget(null); setDeleteError(''); } }}
        message={(
          <div>
            <p style={{ margin: 0 }}>
              Delete {deleteTarget?.type === 'dir' ? 'directory' : 'file'}{' '}
              <code style={{ fontFamily: 'var(--eb-font-mono)', wordBreak: 'break-all' }}>{deleteTarget?.name}</code>?
            </p>
            <p style={{ margin: 'var(--eb-space-2) 0 0', color: 'var(--eb-text-muted)' }}>
              {deleteTarget?.type === 'dir'
                ? 'This removes the directory and all of its contents. This cannot be undone.'
                : 'This cannot be undone.'}
            </p>
            {deleteError && (
              <p style={{ margin: 'var(--eb-space-2) 0 0', color: 'var(--eb-status-error)' }}>
                {deleteError}
              </p>
            )}
          </div>
        )}
      />

      {/* Move-failure alert */}
      <ConfirmDialog
        open={!!moveError}
        alertOnly
        variant="danger"
        title="Move failed"
        message={moveError}
        onConfirm={() => setMoveError('')}
        onCancel={() => setMoveError('')}
      />

      {/* Directory-download refusal (#2318 AC10): an oversize directory or a
          failed pre-flight surfaces here as an in-app message, not raw JSON. */}
      <ConfirmDialog
        open={!!dirDownloadError}
        alertOnly
        variant="danger"
        title="Download failed"
        message={dirDownloadError}
        onConfirm={() => setDirDownloadError('')}
        onCancel={() => setDirDownloadError('')}
      />
    </div>
  );
}

function ModeButton({ icon, label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        background: 'none',
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--eb-accent-primary)' : 'transparent'}`,
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
        fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
        fontFamily: 'inherit',
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      {icon}
      {label}
    </button>
  );
}

/* ─── Tree node ───────────────────────────────────────────────────── */

function DirNode({ relPath, name, depth, dirCache, expanded, onToggleDir, onSelectFile, selectedFilePath, gitBranch, onUploadToDir, onDownloadDir, downloadingDir, onRequestDelete, onReference, dnd, agentId, contextStatus, chip }) {
  const isRoot = relPath === '';
  const isOpen = expanded.has(relPath);
  const cache  = dirCache.get(relPath);
  const indent = depth * 12;
  const [hovered, setHovered] = useState(false);
  // Read-only mounts carry no write actions. A read-write mount's ROOT node is a
  // valid upload/drop target but is never itself a drag source or deletable —
  // that would remove the bind-mount point, not a file in it.
  const readOnly = isReadOnlyKey(relPath, contextStatus);
  const mount = mountForKey(relPath, contextStatus);
  const isMountRoot = !!(mount && mount.key === relPath);

  const Caret = isOpen ? ChevronDown : ChevronRight;
  const FolderIcon = isOpen ? FolderOpen : Folder;
  const isDropTarget = dnd?.dragOverDir === relPath && dnd?.dragItemPath != null;

  return (
    <div>
      {!isRoot && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            background: isDropTarget ? 'var(--eb-accent-muted)' : 'transparent',
            outline: isDropTarget ? '2px dashed var(--eb-accent-primary)' : 'none',
            outlineOffset: '-2px',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onDragOver={dnd ? (e) => dnd.onDirDragOver(relPath, e) : undefined}
          onDragLeave={dnd ? () => dnd.onDirDragLeave(relPath) : undefined}
          onDrop={dnd ? (e) => dnd.onDirDrop(relPath, e) : undefined}
        >
          {/* Directory toggle button — takes all available width. Also the drag
              source for moving this directory. */}
          <button
            type="button"
            draggable={!!dnd && !readOnly && !isMountRoot}
            onDragStart={dnd && !readOnly && !isMountRoot ? (e) => { e.dataTransfer.effectAllowed = 'move'; dnd.onDragStart(relPath, 'dir'); } : undefined}
            onDragEnd={dnd ? dnd.onDragEnd : undefined}
            onClick={() => onToggleDir(relPath)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flex: 1,
              minWidth: 0,
              textAlign: 'left',
              paddingLeft: 16 + indent,
              paddingRight: 4,
              paddingTop: 3,
              paddingBottom: 3,
              background: hovered && !isDropTarget ? 'var(--eb-bg-hover)' : 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--eb-text-xs)',
              fontFamily: 'inherit',
              color: 'var(--eb-text-secondary)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <Caret size={11} />
              <FolderIcon size={13} color="var(--eb-text-muted)" />
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </span>
            {gitBranch && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                color: 'var(--eb-text-muted)',
                fontFamily: 'var(--eb-font-mono)',
                fontSize: '10px',
                flexShrink: 0,
                opacity: 0.8,
              }}>
                <GitBranch size={10} />
                {gitBranch}
              </span>
            )}
            {chip && (
              <span
                title={chip.title || undefined}
                style={{
                  color: 'var(--eb-text-muted)',
                  fontFamily: 'var(--eb-font-mono)',
                  fontSize: '10px',
                  flexShrink: 0,
                  opacity: 0.8,
                }}
              >
                {chip.label}
              </span>
            )}
          </button>
          {/* Per-directory download icon — visible on hover, same placement and
              style as the per-file download (#2318 AC1). Real workspace
              directories only: never a `/context` mount root or a directory
              inside one (D3/AC15); the root row is never rendered here, so it
              never gets one either (AC14). While the pre-flight size check runs
              a spinner replaces the icon (there is no Content-Length, so this is
              the only "download starting" feedback). */}
          {onDownloadDir && !isContextKey(relPath) && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDownloadDir(relPath, name); }}
            disabled={downloadingDir === relPath}
            title={`Download ${name}/ as ZIP`}
            style={{
              ...iconBtnStyle,
              flexShrink: 0,
              padding: '3px 6px',
              marginRight: 2,
              opacity: hovered || downloadingDir === relPath ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              color: 'var(--eb-text-muted)',
              background: hovered ? 'var(--eb-bg-hover)' : 'none',
              transition: 'opacity 0.1s',
            }}
          >
            {downloadingDir === relPath
              ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
              : <Download size={11} />}
          </button>
          )}
          {/* Per-directory upload icon — visible on hover. Absent under the
              read-only context mount: there is no route that could write there. */}
          {!readOnly && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUploadToDir(relPath); }}
            title={`Upload to ${relPath}/`}
            style={{
              ...iconBtnStyle,
              flexShrink: 0,
              padding: '3px 6px',
              marginRight: 2,
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              color: 'var(--eb-text-muted)',
              background: hovered ? 'var(--eb-bg-hover)' : 'none',
              transition: 'opacity 0.1s',
            }}
          >
            <Upload size={11} />
          </button>
          )}
          {/* Per-directory delete icon — visible on hover. Hidden on the mount
              root: you can delete files IN it, not the mount point itself. */}
          {!readOnly && !isMountRoot && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRequestDelete(relPath, 'dir', name); }}
            title={`Delete ${name}/`}
            style={{
              ...iconBtnStyle,
              flexShrink: 0,
              padding: '3px 6px',
              marginRight: 2,
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              color: 'var(--eb-text-muted)',
              background: hovered ? 'var(--eb-bg-hover)' : 'none',
              transition: 'opacity 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-status-error)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
          >
            <Trash2 size={11} />
          </button>
          )}
        </div>
      )}
      {(isRoot || isOpen) && (
        <DirContents
          relPath={relPath}
          depth={isRoot ? 0 : depth + 1}
          cache={cache}
          dirCache={dirCache}
          expanded={expanded}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
          selectedFilePath={selectedFilePath}
          onUploadToDir={onUploadToDir}
          onDownloadDir={onDownloadDir}
          downloadingDir={downloadingDir}
          onRequestDelete={onRequestDelete}
          onReference={onReference}
          dnd={dnd}
          agentId={agentId}
          contextStatus={contextStatus}
        />
      )}
    </div>
  );
}

function DirContents({ relPath, depth, cache, dirCache, expanded, onToggleDir, onSelectFile, selectedFilePath, onUploadToDir, onDownloadDir, downloadingDir, onRequestDelete, onReference, dnd, agentId, contextStatus }) {
  if (!cache) {
    return null; // not yet fetched (open root state pre-fetch)
  }
  if (cache.loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        paddingLeft: depth * 12 + 16,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        color: 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
      }}>
        <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
        Loading…
      </div>
    );
  }
  if (cache.error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        paddingLeft: depth * 12 + 16,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        color: 'var(--eb-status-error)',
        fontSize: 'var(--eb-text-xs)',
      }}>
        <AlertCircle size={11} />
        {cache.error}
      </div>
    );
  }
  // The mounted host folder is grafted onto the workspace root as a virtual
  // node — it is not part of the listing the API returned (it lives in the
  // agent's container, not in this volume), so it is added here.
  const items = relPath === '' ? withContextRoot(cache.items, contextStatus) : (cache.items || []);

  if (items.length === 0) {
    return (
      <div style={{
        paddingLeft: depth * 12 + 16,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        color: 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
        fontStyle: 'italic',
      }}>
        (empty)
      </div>
    );
  }

  return (
    <div>
      {items.map(item => {
        const childRel = childKey(relPath, item);
        const readOnly = isReadOnlyKey(childRel, contextStatus);
        if (item.type === 'dir') {
          return (
            <DirNode
              key={childRel}
              relPath={childRel}
              name={item.name}
              depth={depth}
              dirCache={dirCache}
              expanded={expanded}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              selectedFilePath={selectedFilePath}
              gitBranch={item.gitBranch || null}
              onUploadToDir={onUploadToDir}
              onDownloadDir={onDownloadDir}
              downloadingDir={downloadingDir}
              onRequestDelete={onRequestDelete}
              onReference={onReference}
              dnd={readOnly ? null : dnd}
              agentId={agentId}
              chip={(item.key && isContextKey(item.key))
                ? contextChip(item)
                : null}
            />
          );
        }
        return (
          <Row
            key={childRel}
            indent={depth * 12}
            icon={fileIconFor(item.name)}
            label={item.name}
            secondary={formatBytes(item.size)}
            dim={item.hidden}
            active={selectedFilePath === childRel}
            onClick={() => onSelectFile(childRel)}
            onDownload={agentId ? () => {
              const a = document.createElement('a');
              a.href = workspaceUrl(agentId, childRel, 'download');
              a.download = item.name;
              a.click();
            } : null}
            onDelete={onRequestDelete && !readOnly ? () => onRequestDelete(childRel, 'file', item.name) : null}
            // "Reference in chat" (#1699) — files only, and only for real
            // workspace paths. A `/context` mount key has a leading slash and is
            // not resolvable by the agent from its cwd, so it never gets the
            // control (Open Question 2 → hide where not agent-resolvable). This
            // is independent of the delete gate, so a read-only context file
            // that hides Delete would still reference — but context keys are the
            // only read-only source here, so in practice: workspace files show
            // it, context files don't.
            onReference={onReference && !isContextKey(childRel) ? () => onReference(childRel) : null}
            relPath={childRel}
            dnd={readOnly ? null : dnd}
          />
        );
      })}
    </div>
  );
}

function Row({ indent, icon, label, secondary, dim, active, onClick, gitBranch, onDownload, onDelete, onReference, relPath, dnd }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', width: '100%' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Files are not drop targets; swallow drag-over/drop so a drop landing on
      // a file row doesn't bubble to the root container and become a root move.
      onDragOver={dnd ? (e) => e.stopPropagation() : undefined}
      onDrop={dnd ? (e) => e.stopPropagation() : undefined}
    >
      <button
        type="button"
        draggable={!!dnd}
        onDragStart={dnd ? (e) => { e.dataTransfer.effectAllowed = 'move'; dnd.onDragStart(relPath, 'file'); } : undefined}
        onDragEnd={dnd ? dnd.onDragEnd : undefined}
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
          textAlign: 'left',
          paddingLeft: 16 + (indent || 0),
          paddingRight: (onReference || onDownload || onDelete) ? 2 : 8,
          paddingTop: 3,
          paddingBottom: 3,
          background: active ? 'var(--eb-accent-muted)' : (hovered ? 'var(--eb-bg-hover)' : 'none'),
          border: 'none',
          cursor: 'pointer',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'inherit',
          color: active
            ? 'var(--eb-accent-primary)'
            : (dim ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)'),
        }}
      >
        {/* Reserve the same chevron gutter folders carry (Caret 11px + 2px gap)
            so a file's icon lines up with its sibling folders' icons instead of
            their expand-chevron — this also steps nested files one level in. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <span style={{ width: 11, flexShrink: 0 }} aria-hidden="true" />
          {icon}
        </span>
        <span style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        {gitBranch && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            color: 'var(--eb-text-muted)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: '10px',
            flexShrink: 0,
            opacity: 0.8,
          }}>
            <GitBranch size={10} />
            {gitBranch}
          </span>
        )}
        {secondary && (
          <span style={{
            color: 'var(--eb-text-muted)',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: '10px',
            flexShrink: 0,
          }}>
            {secondary}
          </span>
        )}
      </button>
      {onReference && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReference(); }}
          title="Reference in chat"
          aria-label={`Reference ${label} in chat`}
          style={{
            ...iconBtnStyle,
            flexShrink: 0,
            padding: '3px 6px',
            marginRight: 2,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            color: 'var(--eb-text-muted)',
            background: hovered ? 'var(--eb-bg-hover)' : 'none',
            transition: 'opacity 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-accent-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <AtSign size={11} />
        </button>
      )}
      {onDownload && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          title={`Download ${label}`}
          style={{
            ...iconBtnStyle,
            flexShrink: 0,
            padding: '3px 6px',
            marginRight: 2,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            color: 'var(--eb-text-muted)',
            background: hovered ? 'var(--eb-bg-hover)' : 'none',
            transition: 'opacity 0.1s',
          }}
        >
          <Download size={11} />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={`Delete ${label}`}
          style={{
            ...iconBtnStyle,
            flexShrink: 0,
            padding: '3px 6px',
            marginRight: 2,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            color: 'var(--eb-text-muted)',
            background: hovered ? 'var(--eb-bg-hover)' : 'none',
            transition: 'opacity 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-status-error)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

/* ─── File viewer ─────────────────────────────────────────────────── */

function isMarkdownFile(path) {
  return String(path || '').toLowerCase().endsWith('.md');
}

function toggleLabel(viewMode, isHtml) {
  if (viewMode !== 'raw') return 'Show raw source';
  return isHtml ? 'Show rendered HTML (sandboxed preview)' : 'Show rendered Markdown';
}

function FileViewerHeader({ relPath, data, isMarkdown, isHtml = false, viewMode, onToggleViewMode, expanded, onToggleExpand, onClose }) {
  const idx = relPath.lastIndexOf('/');
  const dir = idx >= 0 ? relPath.slice(0, idx + 1) : '';
  const file = idx >= 0 ? relPath.slice(idx + 1) : relPath;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--eb-space-2)',
      padding: '6px var(--eb-space-3)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0,
    }}>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        {fileIconFor(relPath.split('/').pop())}
      </span>
      <div
        title={relPath}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'baseline',
          gap: 0,
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
        }}
      >
        {dir && (
          <span style={{
            color: 'var(--eb-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
            minWidth: 0,
          }}>
            {dir}
          </span>
        )}
        <span style={{
          color: 'var(--eb-text-primary)',
          fontWeight: 'var(--eb-font-medium)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {file}
        </span>
      </div>
      {data?.truncated && (
        <span title={`Truncated at ${formatBytes(data.size)}; showing first 512 KB`}
          style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--eb-status-warning)' }}>
          <FileWarning size={12} />
        </span>
      )}
      {(isMarkdown || isHtml) && (
        <button
          onClick={onToggleViewMode}
          title={toggleLabel(viewMode, isHtml)}
          aria-label={toggleLabel(viewMode, isHtml)}
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          {viewMode !== 'raw' ? <Code2 size={13} /> : <Eye size={13} />}
        </button>
      )}
      <button
        onClick={onToggleExpand}
        title={expanded ? 'Collapse viewer' : 'Expand viewer'}
        aria-label={expanded ? 'Collapse viewer' : 'Expand viewer'}
        style={iconBtnStyle}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
      >
        {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      {onClose && (
        <button
          onClick={onClose}
          title="Close file"
          aria-label="Close file"
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// Inline raster-image preview (PNG/JPEG/GIF/WebP). The image scales to fit its
// container without distortion (object-fit: contain) — in the maximize modal
// that container is the full window, giving the fit-to-window view (AC4). A
// checkerboard backdrop keeps transparent PNGs legible in both themes (E5). On
// a load failure (missing / corrupt / unsupported bytes) it shows a readable
// message instead of a broken-image icon (AC9). Filename lives in the header;
// the size caption keeps it visible here too (AC5). Remounted per file via a
// `key` on the caller so the error state resets on file change.
function ImagePreview({ agentId, relPath, data }) {
  const [failed, setFailed] = useState(false);
  const src = imageSrcUrl(agentId, relPath);

  if (failed || !src) {
    return (
      <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column', textAlign: 'center', color: 'var(--eb-status-error)' }}>
        <ImageOff size={20} />
        <div style={{ marginTop: 8 }}>Image could not be displayed</div>
        <div style={{ marginTop: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          The file may be missing or corrupt.
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: 0,
      padding: 'var(--eb-space-4)',
      gap: 'var(--eb-space-2)',
      boxSizing: 'border-box',
    }}>
      <img
        src={src}
        alt={relPath}
        onError={() => setFailed(true)}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          borderRadius: 'var(--eb-radius-sm)',
          // Checkerboard so transparency reads in light and dark themes (E5).
          backgroundColor: '#ffffff',
          backgroundImage:
            'linear-gradient(45deg, #c0c0c0 25%, transparent 25%), linear-gradient(-45deg, #c0c0c0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c0c0c0 75%), linear-gradient(-45deg, transparent 75%, #c0c0c0 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        }}
      />
      {data?.size != null && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexShrink: 0 }}>
          {formatBytes(data.size)}
        </div>
      )}
    </div>
  );
}

function FileViewerBody({ agentId, relPath, loading, error, data, viewMode, htmlPreview = null, onHtmlNavigated, frameSuppressed = false }) {
  const isHtml = isHtmlFile(relPath);
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      padding: 0,
      background: 'var(--eb-bg-app)',
    }}>
      {loading && (
        <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ marginLeft: 8 }}>Loading…</span>
        </div>
      )}
      {!loading && error && (
        <div style={{ ...emptyStyle, color: 'var(--eb-status-error)', padding: 'var(--eb-space-4)' }}>
          <AlertCircle size={14} />
          <span style={{ marginLeft: 8 }}>{error}</span>
        </div>
      )}
      {!loading && !error && data && isImageData(data) && (
        <ImagePreview key={relPath} agentId={agentId} relPath={relPath} data={data} />
      )}
      {!loading && !error && data && data.binary && !isImageData(data) && (
        <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column', textAlign: 'center' }}>
          <FileWarning size={20} />
          <div style={{ marginTop: 8 }}>Binary file — preview unavailable</div>
          <div style={{ marginTop: 4, fontSize: 'var(--eb-text-xs)' }}>
            {formatBytes(data.size)}
          </div>
        </div>
      )}
      {!loading && !error && data && !data.binary && isHtml && viewMode === 'too-large' && (
        <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column', textAlign: 'center' }}>
          <FileWarning size={20} />
          <div style={{ marginTop: 8 }}>File too large to preview — download it instead</div>
          <div style={{ marginTop: 4, fontSize: 'var(--eb-text-xs)' }}>
            {formatBytes(data.size)}; the rendered preview is limited to {formatBytes(HTML_PREVIEW_MAX_BYTES)}.
          </div>
          <a
            href={workspaceUrl(agentId, relPath, 'download')}
            download
            style={{ marginTop: 'var(--eb-space-2)', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-xs)' }}
          >
            <Download size={12} /> Download
          </a>
        </div>
      )}
      {/* Collapsing the expanded viewer remounts this frame, so the page runs
          again without a new dialog — intended: it is the same confirmed opening. */}
      {!loading && !error && data && !data.binary && isHtml && viewMode === 'rendered' && htmlPreview && (
        frameSuppressed ? (
          <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)' }}>
            The rendered preview is open in the expanded viewer.
          </div>
        ) : (
          <HtmlPreviewFrame
            agentId={agentId}
            relPath={relPath}
            external={htmlPreview.external}
            openId={htmlPreview.openId}
            onNavigated={onHtmlNavigated}
          />
        )
      )}
      {!loading && !error && data && !data.binary && !isHtml && viewMode === 'rendered' && (
        <div style={{ padding: 'var(--eb-space-3)', fontSize: 'var(--eb-text-sm)' }} className="ws-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {data.content || ''}
          </ReactMarkdown>
          {data.truncated && (
            <p style={{ marginTop: 'var(--eb-space-3)', color: 'var(--eb-status-warning)', fontStyle: 'italic', fontSize: 'var(--eb-text-xs)' }}>
              --- truncated at 512 KB; full size {formatBytes(data.size)} ---
            </p>
          )}
        </div>
      )}
      {!loading && !error && data && !data.binary && viewMode === 'raw' && (
        <pre style={{
          margin: 0,
          padding: 'var(--eb-space-3)',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-primary)',
          whiteSpace: 'pre',
          tabSize: 2,
          minWidth: 0,
        }}>
          {data.content || ''}
          {data.truncated && (
            <span style={{
              display: 'block',
              marginTop: 'var(--eb-space-3)',
              color: 'var(--eb-status-warning)',
              fontStyle: 'italic',
            }}>
              {`\n--- truncated at 512 KB; full size ${formatBytes(data.size)} ---`}
            </span>
          )}
        </pre>
      )}
      <style>{`
        .ws-md { line-height: 1.6; color: var(--eb-text-primary); }
        .ws-md p { margin: 0; }
        .ws-md p + p { margin-top: var(--eb-space-2); }
        .ws-md ul, .ws-md ol { padding-left: 1.4em; margin: var(--eb-space-1) 0; }
        .ws-md li { margin: 2px 0; }
        .ws-md table { border-collapse: collapse; margin: var(--eb-space-2) 0; font-size: var(--eb-text-sm); width: max-content; max-width: 100%; }
        .ws-md th, .ws-md td { border: 1px solid var(--eb-border-default); padding: 4px 8px; text-align: left; }
        .ws-md th { background: var(--eb-bg-elevated); font-weight: var(--eb-font-semibold); }
        .ws-md blockquote { margin: var(--eb-space-2) 0; padding-left: var(--eb-space-3); border-left: 3px solid var(--eb-border-default); color: var(--eb-text-secondary); }
        .ws-md h1, .ws-md h2, .ws-md h3, .ws-md h4 { margin: var(--eb-space-3) 0 var(--eb-space-1); font-weight: var(--eb-font-semibold); }
        .ws-md h1 { font-size: var(--eb-text-lg); }
        .ws-md h2 { font-size: var(--eb-text-md); border-bottom: 1px solid var(--eb-border-default); padding-bottom: var(--eb-space-1); }
        .ws-md h3 { font-size: var(--eb-text-md); color: var(--eb-text-secondary); }
        .ws-md hr { border: none; border-top: 1px solid var(--eb-border-default); margin: var(--eb-space-3) 0; }
        .ws-md a { color: var(--eb-accent-primary); }
        .ws-md code { background: var(--eb-bg-elevated); padding: 1px 6px; border-radius: var(--eb-radius-sm); font-size: 0.9em; font-family: var(--eb-font-mono); border: 1px solid var(--eb-border-default); }
        .ws-md pre { background: var(--eb-bg-elevated); border: 1px solid var(--eb-border-default); border-radius: var(--eb-radius-md); padding: var(--eb-space-3); overflow-x: auto; margin: var(--eb-space-2) 0; }
        .ws-md pre code { background: none; border: none; padding: 0; font-size: var(--eb-text-xs); }
      `}</style>
    </div>
  );
}

// Fetches the `/file` metadata (size/truncated/binary/imageType/content) for
// one workspace-relative path — the same request `FileViewer` below makes on
// a tree click. Extracted so the Agent Chat inline-image-thumbnail fullscreen
// preview (#2146, `chat-image-thumbnail.jsx`) can feed the exact same
// `FileViewerModal` without a second, parallel viewer (the ticket's own
// constraint: reuse the existing preview, not rebuild it).
export function useWorkspaceFileData(agentId, relPath) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!agentId || !relPath) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(workspaceUrl(agentId, relPath, 'file'))
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (reqId !== reqIdRef.current) return;
        if (!ok) throw new Error(j?.error || 'Failed');
        setData(j);
      })
      .catch(e => {
        if (reqId !== reqIdRef.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false);
      });
  }, [agentId, relPath]);

  return { data, loading, error };
}

// Sandboxed rendered preview of an agent-written HTML file (#2778). Two
// independent layers keep it out of the console's origin: the iframe's
// `sandbox` attribute (scripts only — NEVER allow-same-origin, pinned by
// html-preview.test.js) and the `/html-preview` endpoint's own CSP `sandbox` +
// network-off headers. Keyed by `openId`, so every confirmed opening is a fresh
// document; unmounting (Raw, close, another file) tears the frame and its
// scripts down (AC10). A second `load` means the page navigated its frame away
// (a link, a meta refresh) — the preview is closed rather than showing it.
function HtmlPreviewFrame({ agentId, relPath, external, openId, onNavigated }) {
  const loadsRef = useRef(0);
  const src = htmlPreviewUrl(agentId, relPath, { external, openId });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        role="note"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: '6px var(--eb-space-3)',
          flexShrink: 0,
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-status-warning-text)',
          background: 'var(--eb-status-warning-bg)',
          borderBottom: '1px solid var(--eb-status-warning)',
        }}
      >
        <ShieldAlert size={13} style={{ flexShrink: 0 }} />
        <span>{htmlPreviewBannerText(external)}</span>
      </div>
      <iframe
        key={openId}
        title={`Rendered preview of ${relPath}`}
        src={src}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        onLoad={() => {
          loadsRef.current += 1;
          if (loadsRef.current > 1 && onNavigated) onNavigated();
        }}
        style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#ffffff' }}
      />
    </div>
  );
}

// The warning shown on EVERY switch to Rendered for an HTML file (AC2/AC3).
// Mounted only while the view state is 'confirm', so the checkbox starts
// unticked each time and nothing is remembered. Portaled to <body> so it opens
// above the fullscreen viewer, which is portaled there too.
function HtmlPreviewConfirm({ dispatch }) {
  const [external, setExternal] = useState(false);
  return createPortal(
    <ConfirmDialog
      open
      title="Show rendered HTML preview?"
      variant="warning"
      maxWidth={480}
      confirmLabel="Show preview"
      cancelLabel="Cancel"
      onConfirm={() => dispatch({ type: 'confirm', external })}
      onCancel={() => dispatch({ type: 'cancel' })}
      message={(
        <>
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
            <li>This file was generated by an agent and may contain harmful content.</li>
            <li>It may not display correctly, particularly with external dependencies or heavy JavaScript.</li>
            <li>The preview runs isolated from Agent Studio: it cannot use your session or read console data.</li>
          </ul>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-3)', color: 'var(--eb-text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} />
            Also load external resources
          </label>
          <div style={{ marginTop: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Fonts, scripts and images from other hosts. Off by default — the page then cannot load external fonts, scripts or images, or make network requests from script.
          </div>
        </>
      )}
    />,
    document.body,
  );
}

// Raw/Rendered state of one open file, incl. the HTML confirm-every-time flow
// (pure reducer in html-preview.js). Resets on every file change; until the
// reset lands, `viewStateFor` already answers the new file's initial state.
function useFileViewState(relPath) {
  const [state, dispatch] = useReducer(viewStateReducer, relPath, initialViewState);
  useEffect(() => { dispatch({ type: 'reset', relPath }); }, [relPath]);
  return [viewStateFor(state, relPath), dispatch];
}

function toggleAction(relPath, data) {
  return { type: 'toggle', html: isHtmlFile(relPath), tooLarge: isHtmlTooLarge(data) };
}

// `viewState`/`dispatch` come from the owner (the Workspace tab's FileViewer)
// when it has them; otherwise (the chat `@<path>` preview, #2146) the modal
// owns its own state, so the HTML preview works the same there (AC12).
export function FileViewerModal({ agentId, relPath, data, loading, error, viewState: ownerState, dispatch: ownerDispatch, onClose }) {
  const isMarkdown = isMarkdownFile(relPath);
  const [ownState, ownDispatch] = useFileViewState(relPath);
  const viewState = ownerState || ownState;
  const dispatch = ownerDispatch || ownDispatch;
  const confirmOpen = viewState.mode === 'confirm';

  useEffect(() => {
    // Escape belongs to the confirm dialog while it is open.
    const onKey = (e) => { if (e.key === 'Escape' && !confirmOpen) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, confirmOpen]);

  return (
    <>
      {createPortal(
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)',
            padding: 'var(--eb-space-4)',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            width: '90vw',
            height: '90vh',
            background: 'var(--eb-bg-surface)',
            borderRadius: 'var(--eb-radius-lg)',
            border: '1px solid var(--eb-border-default)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
            overflow: 'hidden',
          }}>
            <FileViewerHeader
              relPath={relPath}
              data={data}
              isMarkdown={isMarkdown}
              isHtml={canOfferHtmlPreview(relPath, data)}
              viewMode={bodyViewMode(viewState)}
              onToggleViewMode={() => dispatch(toggleAction(relPath, data))}
              expanded
              onToggleExpand={onClose}
              onClose={onClose}
            />
            <FileViewerBody
              agentId={agentId}
              relPath={relPath}
              loading={loading}
              error={error}
              data={data}
              viewMode={bodyViewMode(viewState)}
              htmlPreview={viewState}
              onHtmlNavigated={() => dispatch({ type: 'navigated' })}
            />
          </div>
        </div>,
        document.body,
      )}
      {!ownerDispatch && confirmOpen && <HtmlPreviewConfirm dispatch={dispatch} />}
    </>
  );
}

function FileViewer({ agentId, path: relPath, onClose }) {
  const { data, loading, error } = useWorkspaceFileData(agentId, relPath);
  const [expanded, setExpanded] = useState(false);
  const [viewState, dispatch] = useFileViewState(relPath);

  const isMarkdown = isMarkdownFile(relPath);
  const toggleViewMode = () => dispatch(toggleAction(relPath, data));

  return (
    <>
      <div style={{
        flex: '1 1 60%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
      }}>
        <FileViewerHeader
          relPath={relPath}
          data={data}
          isMarkdown={isMarkdown}
          isHtml={canOfferHtmlPreview(relPath, data)}
          viewMode={bodyViewMode(viewState)}
          onToggleViewMode={toggleViewMode}
          expanded={false}
          onToggleExpand={() => setExpanded(true)}
          onClose={onClose}
        />
        {/* While expanded, only the modal runs the HTML frame — never two
            copies of the same untrusted page at once. */}
        <FileViewerBody
          agentId={agentId}
          relPath={relPath}
          loading={loading}
          error={error}
          data={data}
          viewMode={bodyViewMode(viewState)}
          htmlPreview={viewState}
          onHtmlNavigated={() => dispatch({ type: 'navigated' })}
          frameSuppressed={expanded}
        />
      </div>
      {expanded && (
        <FileViewerModal
          agentId={agentId}
          relPath={relPath}
          data={data}
          loading={loading}
          error={error}
          viewState={viewState}
          dispatch={dispatch}
          onClose={() => setExpanded(false)}
        />
      )}
      {viewState.mode === 'confirm' && <HtmlPreviewConfirm dispatch={dispatch} />}
    </>
  );
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

const iconBtnStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--eb-text-muted)',
  cursor: 'pointer',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const emptyStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: 'var(--eb-text-muted)',
  fontSize: 'var(--eb-text-xs)',
};

function fileIconFor(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === 'memory' || lower.startsWith('memory')) {
    // Folder name lookup happens at the parent level — fall through.
  }
  // Special-case the agent's curated files.
  if (lower === 'claude.md' || lower === 'agent-prompt.md') {
    return <Sparkles size={12} color="var(--eb-accent-primary)" />;
  }
  if (lower === 'skill.md') {
    return <BookOpen size={12} color="var(--eb-status-success)" />;
  }
  if (['context.md', 'log.md', 'facts.md', 'entities.md', 'users.md'].includes(lower) || lower.startsWith('memory.')) {
    return <Brain size={12} color="var(--eb-accent-primary)" />;
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.log')) {
    return <FileText size={12} color="var(--eb-text-muted)" />;
  }
  if (
    lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.jsx') ||
    lower.endsWith('.tsx') || lower.endsWith('.json') || lower.endsWith('.yml') ||
    lower.endsWith('.yaml') || lower.endsWith('.sh') || lower.endsWith('.py') ||
    lower.endsWith('.cob') || lower.endsWith('.cbl') || lower.endsWith('.jcl') ||
    lower.endsWith('.sql')
  ) {
    return <FileCode size={12} color="var(--eb-text-muted)" />;
  }
  return <FileText size={12} color="var(--eb-text-muted)" />;
}

function formatBytes(bytes) {
  if (bytes == null) return '';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
