import React, { useState, useEffect, useRef } from 'react';
import { Folder, ChevronRight, ChevronLeft, Check } from 'lucide-react';

/**
 * DirectoryPicker — modal for navigating and selecting a directory
 * inside the agent workspace.
 *
 * Props:
 *   agentId   — agent id (used for API calls)
 *   onSelect  — callback(path: string) with the selected relative path
 *   onClose   — callback to close without selecting
 */
export default function DirectoryPicker({ agentId, onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState('');
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    loadDirs(currentPath);
  }, [currentPath]);

  // Escape closes the picker
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function loadDirs(relPath) {
    setLoading(true);
    setError(null);
    try {
      const qs = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
      const resp = await fetch(`/api/agents/${agentId}/workspace/dirs${qs}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // The endpoint returns { path, items } — keep only directories
      const items = Array.isArray(data) ? data : (data.items || []);
      setDirs(items.filter(item => item.type === 'dir'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function navigateUp() {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join('/'));
  }

  function navigateInto(dirName) {
    const newPath = currentPath ? `${currentPath}/${dirName}` : dirName;
    setCurrentPath(newPath);
  }

  // Breadcrumb segments
  const breadcrumbParts = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select directory"
      style={overlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={dialogRef} style={dialogStyle}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--eb-space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
            Select directory
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-lg)',
              lineHeight: 1, padding: 'var(--eb-space-1)',
            }}
          >
            ×
          </button>
        </div>

        {/* Breadcrumb */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          gap: 'var(--eb-space-1)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-bg-app)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          marginBottom: 'var(--eb-space-3)',
          minHeight: 36,
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-muted)',
        }}>
          <button
            onClick={() => setCurrentPath('')}
            style={breadcrumbBtnStyle}
            title="Root directory"
          >
            /
          </button>
          {breadcrumbParts.map((part, idx) => (
            <React.Fragment key={idx}>
              <ChevronRight size={12} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />
              <button
                onClick={() => setCurrentPath(breadcrumbParts.slice(0, idx + 1).join('/'))}
                style={breadcrumbBtnStyle}
              >
                {part}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Navigation: Up button */}
        {currentPath && (
          <button
            onClick={navigateUp}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-1-5) var(--eb-space-3)',
              background: 'none',
              border: 'none',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--eb-text-sm)',
              fontFamily: 'inherit',
              width: '100%',
              textAlign: 'left',
              marginBottom: 'var(--eb-space-1)',
            }}
          >
            <ChevronLeft size={15} />
            Up
          </button>
        )}

        {/* Directory list */}
        <div style={{
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)',
          overflow: 'hidden',
          minHeight: 120,
          maxHeight: 320,
          overflowY: 'auto',
        }}>
          {loading && (
            <div style={stateRowStyle}>
              <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading…</span>
            </div>
          )}
          {error && (
            <div style={stateRowStyle}>
              <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
                Error: {error}
              </span>
            </div>
          )}
          {!loading && !error && dirs.length === 0 && (
            <div style={stateRowStyle}>
              <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                No subdirectories.
              </span>
            </div>
          )}
          {!loading && !error && dirs.map((dir, idx) => (
            <button
              key={dir.name}
              onClick={() => navigateInto(dir.name)}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                width: '100%', textAlign: 'left',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'none',
                border: 'none',
                borderBottom: idx < dirs.length - 1 ? '1px solid var(--eb-border-subtle, var(--eb-border-default))' : 'none',
                color: 'var(--eb-text-primary)',
                cursor: 'pointer',
                fontSize: 'var(--eb-text-sm)',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-elevated)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <Folder size={15} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dir.name}
              </span>
              <ChevronRight size={13} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />
            </button>
          ))}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--eb-space-4)', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {currentPath ? currentPath : '/'}
          </div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexShrink: 0 }}>
            <button onClick={onClose} style={cancelBtnStyle}>
              Cancel
            </button>
            <button
              onClick={() => onSelect(currentPath)}
              style={confirmBtnStyle}
            >
              <Check size={14} />
              Select this directory
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'oklch(0 0 0 / 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const dialogStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  padding: 'var(--eb-space-5, 20px)',
  width: '90%',
  maxWidth: 520,
  boxShadow: 'var(--eb-shadow-xl)',
};

const breadcrumbBtnStyle = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--eb-accent-primary)',
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-xs)',
  padding: '0 var(--eb-space-0-5)',
  borderRadius: 'var(--eb-radius-sm)',
};

const stateRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--eb-space-6)',
};

const cancelBtnStyle = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const confirmBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1-5)',
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
