import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode,
  Brain, Sparkles, BookOpen, Loader2, X, RefreshCw, AlertCircle, FileWarning,
  Maximize2, Minimize2, Code2, Eye, GitBranch, Upload,
} from 'lucide-react';

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
 */
export default function WorkspaceBrowser({ agentId, active }) {
  // dirCache:  Map<relativePath, { items, loading, error }>  (resolved listings)
  // expanded:  Set<relativePath>   currently open directories (root is "")
  const [dirCache, setDirCache] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [selectedFile, setSelectedFile] = useState(null); // { path }

  // Upload panel state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDir, setUploadDir] = useState('');
  const [uploadStatus, setUploadStatus] = useState('idle'); // 'idle' | 'uploading' | 'success' | 'error'
  const [uploadMessage, setUploadMessage] = useState('');
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadResetTimerRef = useRef(null);

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
    setUploadDir('');
    setUploadStatus('idle');
    setUploadMessage('');
    return () => { clearTimeout(uploadResetTimerRef.current); };
  }, [agentId]);

  const fetchDir = useCallback(async (relPath) => {
    if (!agentId) return;
    const reqId = reqIdRef.current;
    setDirCache(prev => {
      const next = new Map(prev);
      next.set(relPath, { ...(next.get(relPath) || {}), loading: true, error: null });
      return next;
    });
    try {
      const url = `/api/agents/${encodeURIComponent(agentId)}/workspace/tree?path=${encodeURIComponent(relPath)}`;
      const r = await fetch(url);
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

  // isFolder=true: files carry webkitRelativePath for directory tree reconstruction.
  const handleUpload = useCallback(async (files, isFolder = false) => {
    if (!files || files.length === 0) return;
    setUploadStatus('uploading');
    setUploadMessage('');
    const form = new FormData();
    form.append('path', uploadDir);
    for (const f of files) {
      form.append('files', f);
      form.append('relativePaths', isFolder && f.webkitRelativePath ? f.webkitRelativePath : '');
    }
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/workspace/upload`, {
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
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        borderBottom: uploadOpen ? 'none' : '1px solid var(--eb-border-default)',
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
        <button
          onClick={() => { setUploadOpen(o => !o); setUploadStatus('idle'); setUploadMessage(''); if (!uploadOpen) setUploadDir(''); }}
          title="Upload files or folder to workspace"
          style={{ ...iconBtnStyle, color: uploadOpen ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }}
          onMouseEnter={e => { if (!uploadOpen) e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { if (!uploadOpen) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <Upload size={12} />
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

      {/* Upload panel */}
      {uploadOpen && (
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

      {/* Tree (top) — shrinks when a file viewer is open below. */}
      <div
        style={{
          flex: selectedFile ? '0 0 40%' : '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          padding: '4px 0',
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
        />
      </div>

      {/* File viewer (bottom) */}
      {selectedFile && (
        <FileViewer
          agentId={agentId}
          path={selectedFile.path}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}

/* ─── Tree node ───────────────────────────────────────────────────── */

function DirNode({ relPath, name, depth, dirCache, expanded, onToggleDir, onSelectFile, selectedFilePath, gitBranch, onUploadToDir }) {
  const isRoot = relPath === '';
  const isOpen = expanded.has(relPath);
  const cache  = dirCache.get(relPath);
  const indent = depth * 12;
  const [hovered, setHovered] = useState(false);

  const Caret = isOpen ? ChevronDown : ChevronRight;
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <div>
      {!isRoot && (
        <div
          style={{ display: 'flex', alignItems: 'center', width: '100%' }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {/* Directory toggle button — takes all available width */}
          <button
            type="button"
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
              background: hovered ? 'var(--eb-bg-hover)' : 'none',
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
          </button>
          {/* Per-directory upload icon — visible on hover */}
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
        />
      )}
    </div>
  );
}

function DirContents({ relPath, depth, cache, dirCache, expanded, onToggleDir, onSelectFile, selectedFilePath, onUploadToDir }) {
  if (!cache) {
    return null; // not yet fetched (open root state pre-fetch)
  }
  if (cache.loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        paddingLeft: depth * 12 + 16,
        color: 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
        padding: '3px 8px',
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
        color: 'var(--eb-status-error)',
        fontSize: 'var(--eb-text-xs)',
        padding: '3px 8px',
      }}>
        <AlertCircle size={11} />
        {cache.error}
      </div>
    );
  }
  if (!cache.items || cache.items.length === 0) {
    return (
      <div style={{
        paddingLeft: depth * 12 + 16,
        color: 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
        fontStyle: 'italic',
        padding: '3px 8px',
      }}>
        (empty)
      </div>
    );
  }

  return (
    <div>
      {cache.items.map(item => {
        const childRel = relPath ? `${relPath}/${item.name}` : item.name;
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
          />
        );
      })}
    </div>
  );
}

function Row({ indent, icon, label, secondary, dim, active, onClick, gitBranch }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        paddingLeft: 16 + (indent || 0),
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        background: active ? 'var(--eb-accent-muted)' : 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 'var(--eb-text-xs)',
        fontFamily: 'inherit',
        color: active
          ? 'var(--eb-accent-primary)'
          : (dim ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)'),
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'none'; }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
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
  );
}

/* ─── File viewer ─────────────────────────────────────────────────── */

function isMarkdownFile(path) {
  return String(path || '').toLowerCase().endsWith('.md');
}

function FileViewerHeader({ relPath, data, isMarkdown, viewMode, onToggleViewMode, expanded, onToggleExpand, onClose }) {
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
      {isMarkdown && (
        <button
          onClick={onToggleViewMode}
          title={viewMode === 'rendered' ? 'Show raw source' : 'Show rendered Markdown'}
          aria-label={viewMode === 'rendered' ? 'Show raw source' : 'Show rendered Markdown'}
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          {viewMode === 'rendered' ? <Code2 size={13} /> : <Eye size={13} />}
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

function FileViewerBody({ loading, error, data, viewMode }) {
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
      {!loading && !error && data && data.binary && (
        <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column', textAlign: 'center' }}>
          <FileWarning size={20} />
          <div style={{ marginTop: 8 }}>Binary file — preview unavailable</div>
          <div style={{ marginTop: 4, fontSize: 'var(--eb-text-xs)' }}>
            {formatBytes(data.size)}
          </div>
        </div>
      )}
      {!loading && !error && data && !data.binary && viewMode === 'rendered' && (
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

function FileViewerModal({ agentId, relPath, data, loading, error, viewMode, onToggleViewMode, onClose }) {
  const isMarkdown = isMarkdownFile(relPath);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
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
          viewMode={viewMode}
          onToggleViewMode={onToggleViewMode}
          expanded
          onToggleExpand={onClose}
          onClose={onClose}
        />
        <FileViewerBody loading={loading} error={error} data={data} viewMode={viewMode} />
      </div>
    </div>,
    document.body,
  );
}

function FileViewer({ agentId, path: relPath, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState(() => isMarkdownFile(relPath) ? 'rendered' : 'raw');
  const reqIdRef = useRef(0);

  // Reset view mode when file changes.
  useEffect(() => {
    setViewMode(isMarkdownFile(relPath) ? 'rendered' : 'raw');
  }, [relPath]);

  useEffect(() => {
    if (!agentId || !relPath) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/agents/${encodeURIComponent(agentId)}/workspace/file?path=${encodeURIComponent(relPath)}`)
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

  const isMarkdown = isMarkdownFile(relPath);
  const toggleViewMode = () => setViewMode(m => m === 'rendered' ? 'raw' : 'rendered');

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
          viewMode={viewMode}
          onToggleViewMode={toggleViewMode}
          expanded={false}
          onToggleExpand={() => setExpanded(true)}
          onClose={onClose}
        />
        <FileViewerBody loading={loading} error={error} data={data} viewMode={viewMode} />
      </div>
      {expanded && (
        <FileViewerModal
          agentId={agentId}
          relPath={relPath}
          data={data}
          loading={loading}
          error={error}
          viewMode={viewMode}
          onToggleViewMode={toggleViewMode}
          onClose={() => setExpanded(false)}
        />
      )}
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
