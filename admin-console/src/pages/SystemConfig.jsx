import React, { useState, useEffect } from 'react';
import { useApi, apiCall } from '../hooks/useApi';

export default function SystemConfig() {
  const { data: config, loading, error, refetch } = useApi('/api/config');

  const [editing, setEditing] = useState(false);
  const [aceRepoPath, setAceRepoPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    if (config) setAceRepoPath(config.aceRepoPath || '');
  }, [config]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      await apiCall('PUT', '/api/config', { aceRepoPath: aceRepoPath.trim() });
      setSavedOk(true);
      setEditing(false);
      refetch();
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setAceRepoPath(config?.aceRepoPath || '');
    setSaveError(null);
    setEditing(false);
  }

  if (loading) {
    return <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load config: {error}
      </div>
    );
  }

  const isEmpty = !config?.aceRepoPath;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        System Configuration
      </h1>

      {/* ── ACE / BriefingPack section ─────────────────────────────────── */}
      <div style={{
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          borderBottom: '1px solid var(--eb-border-default)',
          fontWeight: 'var(--eb-font-semibold)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          ACE / Briefing Packs
        </div>

        <div style={{ padding: 'var(--eb-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>

          {/* Path row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
            <div style={{
              width: 200,
              flexShrink: 0,
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              color: 'var(--eb-text-secondary)',
            }}>
              ACE Repository Path
            </div>

            {editing ? (
              <div style={{ flex: 1, display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={aceRepoPath}
                  onChange={e => setAceRepoPath(e.target.value)}
                  placeholder="/absolute/path/to/i-sase"
                  style={{
                    flex: 1,
                    minWidth: 260,
                    padding: 'var(--eb-space-2) var(--eb-space-3)',
                    fontFamily: 'var(--eb-font-mono)',
                    fontSize: 'var(--eb-text-sm)',
                    background: 'var(--eb-bg-input)',
                    border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-md)',
                    color: 'var(--eb-text-primary)',
                    outline: 'none',
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
                  autoFocus
                />
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    padding: 'var(--eb-space-2) var(--eb-space-3)',
                    background: 'var(--eb-accent-primary)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--eb-radius-md)',
                    fontSize: 'var(--eb-text-sm)',
                    cursor: saving ? 'not-allowed' : 'pointer',
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={saving}
                  style={{
                    padding: 'var(--eb-space-2) var(--eb-space-3)',
                    background: 'none',
                    border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-md)',
                    fontSize: 'var(--eb-text-sm)',
                    color: 'var(--eb-text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
                <code style={{
                  fontFamily: 'var(--eb-font-mono)',
                  fontSize: 'var(--eb-text-sm)',
                  color: isEmpty ? 'var(--eb-text-tertiary)' : 'var(--eb-text-primary)',
                }}>
                  {isEmpty ? '(not set)' : config.aceRepoPath}
                </code>
                <button
                  onClick={() => { setSavedOk(false); setEditing(true); }}
                  style={{
                    padding: 'var(--eb-space-1) var(--eb-space-2)',
                    background: 'none',
                    border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-md)',
                    fontSize: 'var(--eb-text-xs)',
                    color: 'var(--eb-text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Edit
                </button>
                {savedOk && (
                  <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)' }}>
                    Saved
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Inline errors */}
          {saveError && (
            <div role="alert" style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
              {saveError}
            </div>
          )}

          {/* Hint */}
          <div style={{
            padding: 'var(--eb-space-3) var(--eb-space-4)',
            background: 'var(--eb-status-warning-bg)',
            border: '1px solid var(--eb-status-warning)',
            borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)',
            color: 'var(--eb-text-primary)',
          }}>
            <strong>Note:</strong> The path is stored in{' '}
            <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-subtle)', padding: '1px 4px', borderRadius: 'var(--eb-radius-sm)' }}>
              /workspace/config.json
            </code>{' '}
            and takes effect immediately for API calls. The{' '}
            <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-subtle)', padding: '1px 4px', borderRadius: 'var(--eb-radius-sm)' }}>
              /ace
            </code>{' '}
            bind-mount in <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-subtle)', padding: '1px 4px', borderRadius: 'var(--eb-radius-sm)' }}>
              docker-compose.yml
            </code>{' '}
            must be uncommented and the stack restarted for the new path to be accessible inside the containers.
          </div>
        </div>
      </div>
    </div>
  );
}
