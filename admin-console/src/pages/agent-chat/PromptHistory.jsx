import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, History, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * Authored-prompt version history + revert (#990, #2295).
 *
 * Renders the bounded, newest-first history of an agent's authored system prompt
 * (standalone `agent`/`team-member` override, or a `team`'s systemPromptTemplate)
 * and offers "revert to this version".
 *
 * #2295 (D2): a revert is no longer an immediate server write — the Details
 * tab's live prompt editor batches into the tab's one Save now, so reverting
 * loads that version's text into the editor as an unsaved change instead,
 * committed by the tab's Save like any other edit. Nothing in the history is
 * lost either way: a commit still records a new version, only the server-side
 * "this was a revert to vN" provenance is gone.
 *
 * Props:
 *   - agentId       Selected agent (required).
 *   - dirty         Whether the editor already holds unsaved text — gates the
 *                    confirm (AC8: replacing unsaved work needs a confirm,
 *                    loading into a clean editor does not).
 *   - onLoadVersion  Called with (content, version) once a version is chosen.
 *   - reloadKey      Change this to force a re-fetch (e.g. after a save records
 *                    a new version).
 */
export default function PromptHistory({ agentId, dirty = false, onLoadVersion, reloadKey }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [expanded, setExpanded] = useState({});   // version -> full content
  const [busy, setBusy]       = useState(null);   // version currently being fetched to load
  const [confirmVersion, setConfirmVersion] = useState(null); // version pending overwrite-confirm

  const load = useCallback(async () => {
    if (!agentId) { setData(null); return; }
    setLoading(true);
    setError(null);
    try {
      const j = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/prompt-history`);
      setData(j);
    } catch (e) {
      setError(e.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load, reloadKey]);

  async function toggle(version) {
    setExpanded(prev => {
      if (prev[version] !== undefined) {
        const next = { ...prev };
        delete next[version];
        return next;
      }
      return prev;
    });
    if (expanded[version] === undefined) {
      try {
        const entry = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/prompt-history/${version}`);
        setExpanded(prev => ({ ...prev, [version]: entry.content || '' }));
      } catch {
        setExpanded(prev => ({ ...prev, [version]: '(failed to load content)' }));
      }
    }
  }

  // Content for `toggle`'s preview and a revert's load are the same fetch —
  // reuse whatever is already expanded rather than fetching twice.
  async function contentFor(version) {
    if (expanded[version] !== undefined) return expanded[version];
    const entry = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/prompt-history/${version}`);
    return entry.content || '';
  }

  async function doLoad(version) {
    setConfirmVersion(null);
    setBusy(version);
    setError(null);
    try {
      const content = await contentFor(version);
      onLoadVersion?.(content, version);
    } catch (e) {
      setError(e.message || 'Failed to load that version');
    } finally {
      setBusy(null);
    }
  }

  // AC8: replacing unsaved typed text needs a confirm; loading into a clean
  // editor does not — there is nothing to silently destroy.
  function requestRevert(version) {
    if (dirty) setConfirmVersion(version);
    else doLoad(version);
  }

  if (!agentId) return null;

  const versions = data?.history || [];
  const current = data?.currentVersion || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <History size={12} style={{ color: 'var(--eb-text-muted)' }} />
        <div style={{
          flex: 1,
          fontSize: 'var(--eb-text-xs)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        }}>
          Prompt history{data?.field ? ` · ${data.field}` : ''}
        </div>
      </div>

      {loading && (
        <div style={rowMuted}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ marginLeft: 6 }}>Loading history…</span>
        </div>
      )}

      {!loading && error && (
        <div style={{ ...rowMuted, color: 'var(--eb-status-error)' }}>
          <AlertCircle size={12} /><span style={{ marginLeft: 6 }}>{error}</span>
        </div>
      )}

      {!loading && !error && versions.length === 0 && (
        <div style={rowMuted}>No versions recorded yet. The next edit starts the history.</div>
      )}

      {!loading && !error && versions.map(v => {
        const isCurrent = v.version === current;
        const open = expanded[v.version] !== undefined;
        return (
          <div key={v.version} style={{
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            background: 'var(--eb-bg-surface)',
            overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2)' }}>
              <button type="button" onClick={() => toggle(v.version)} title="Show content" style={iconBtn}>
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
                v{v.version}
              </span>
              <Tag label={v.action} />
              {isCurrent && <Tag label="current" tone="success" />}
              <span style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {formatWhen(v.at)} · {v.by}{v.note ? ` · ${v.note}` : ''}
              </span>
              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => requestRevert(v.version)}
                  disabled={busy !== null}
                  title={`Load v${v.version} into the editor as an unsaved change`}
                  style={{ ...revertBtn, cursor: busy !== null ? 'wait' : 'pointer' }}
                >
                  {busy === v.version
                    ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                    : <RotateCcw size={11} />}
                  Revert
                </button>
              )}
            </div>
            {open && (
              <pre style={{
                margin: 0,
                padding: 'var(--eb-space-3)',
                maxHeight: 240,
                overflow: 'auto',
                fontSize: 'var(--eb-text-xs)',
                fontFamily: 'var(--eb-font-mono)',
                color: 'var(--eb-text-primary)',
                background: 'var(--eb-bg-app)',
                borderTop: '1px solid var(--eb-border-default)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                tabSize: 2,
              }}>
                {expanded[v.version] || <span style={{ color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>(empty)</span>}
              </pre>
            )}
          </div>
        );
      })}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      <ConfirmDialog
        open={confirmVersion !== null}
        title={`Load v${confirmVersion}`}
        message={`Load version ${confirmVersion} into the editor? It replaces the unsaved text you've typed since — that text is not kept. Save the tab afterwards to commit it as a new version.`}
        variant="warning"
        confirmLabel="Load"
        busy={busy !== null}
        onConfirm={() => doLoad(confirmVersion)}
        onCancel={() => setConfirmVersion(null)}
      />
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function formatWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function Tag({ label, tone }) {
  const color = tone === 'success' ? 'var(--eb-status-success)' : 'var(--eb-text-secondary)';
  return (
    <span style={{
      padding: '1px 6px',
      fontSize: '10px',
      fontWeight: 'var(--eb-font-medium)',
      color,
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-full)',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

const rowMuted = {
  display: 'flex',
  alignItems: 'center',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  padding: 'var(--eb-space-2)',
};

const iconBtn = {
  background: 'none',
  border: 'none',
  color: 'var(--eb-text-muted)',
  cursor: 'pointer',
  padding: 2,
  display: 'inline-flex',
  alignItems: 'center',
};

const revertBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-secondary)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  padding: '3px 8px',
};
