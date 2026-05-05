import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode,
  Brain, Sparkles, BookOpen, Loader2, X, RefreshCw, AlertCircle, FileWarning,
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

  // Bump generation counter on agent change so a slow response from the
  // previous agent can't poison the new agent's cache.
  const reqIdRef = useRef(0);

  /* ─── Reset on agent change ──────────────────────────────────────── */
  useEffect(() => {
    reqIdRef.current += 1;
    setDirCache(new Map());
    setExpanded(new Set(['']));
    setSelectedFile(null);
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
        borderBottom: '1px solid var(--eb-border-default)',
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
          onClick={refreshAll}
          title="Reload tree"
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

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

function DirNode({ relPath, name, depth, dirCache, expanded, onToggleDir, onSelectFile, selectedFilePath }) {
  const isRoot = relPath === '';
  const isOpen = expanded.has(relPath);
  const cache  = dirCache.get(relPath);
  const indent = depth * 12;

  const Caret = isOpen ? ChevronDown : ChevronRight;
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <div>
      {!isRoot && (
        <Row
          indent={indent}
          icon={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Caret size={11} />
              <FolderIcon size={13} color="var(--eb-text-muted)" />
            </span>
          }
          label={name}
          onClick={() => onToggleDir(relPath)}
        />
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
        />
      )}
    </div>
  );
}

function DirContents({ relPath, depth, cache, dirCache, expanded, onToggleDir, onSelectFile, selectedFilePath }) {
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

function Row({ indent, icon, label, secondary, dim, active, onClick }) {
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

function FileViewer({ agentId, path: relPath, onClose }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const reqIdRef = useRef(0);

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

  return (
    <div style={{
      flex: '1 1 60%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      borderTop: '1px solid var(--eb-border-default)',
      background: 'var(--eb-bg-surface)',
    }}>
      {/* Viewer header */}
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
        {/* Path: show containing directory dimmed, filename in normal weight.
            When the row overflows we ellipsize the directory part rather than
            the filename, so the most useful piece stays visible. */}
        {(() => {
          const idx = relPath.lastIndexOf('/');
          const dir = idx >= 0 ? relPath.slice(0, idx + 1) : '';
          const file = idx >= 0 ? relPath.slice(idx + 1) : relPath;
          return (
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
          );
        })()}
        {data?.truncated && (
          <span title={`Truncated at ${formatBytes(data.size)}; showing first 512 KB`}
            style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--eb-status-warning)' }}>
            <FileWarning size={12} />
          </span>
        )}
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
      </div>

      {/* Body */}
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
        {!loading && !error && data && !data.binary && (
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
                {/* Render as plain text so it sits inside the <pre> */}
                {`\n--- truncated at 512 KB; full size ${formatBytes(data.size)} ---`}
              </span>
            )}
          </pre>
        )}
      </div>
    </div>
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
  if (lower === 'context.md' || lower === 'log.md' || lower.startsWith('memory.')) {
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
