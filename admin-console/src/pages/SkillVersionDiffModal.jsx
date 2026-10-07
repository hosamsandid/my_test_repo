import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  readDiffMode, writeDiffMode, visibleDiffFiles, fileNote, fileCounts, fileStatusLabel, fileStatusMark,
  summaryText, buildUnifiedRows, buildSplitRows, versionLabel,
} from './skill-version-view.js';

/*
 * SkillVersionDiffModal — full-screen comparison of two skill versions (#2839).
 *
 * Fetches GET /api/skills/:name/versions/diff (the server orders the pair
 * older → newer) and renders every changed file with +/− markers, either
 * side-by-side or inline (remembered for the session). Unchanged files are
 * hidden behind a toggle; binary / over-cap files say "changed / unchanged"
 * instead of a line diff. Row shaping lives in skill-version-view.js.
 */

const btn = (active) => ({
  padding: '4px 10px', borderRadius: 'var(--eb-radius-sm)', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
  border: '1px solid var(--eb-border-default)', cursor: 'pointer',
  background: active ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
  color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
  fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
});

const LINE_BG = { '+': 'var(--eb-status-success-bg)', '-': 'var(--eb-status-error-bg)', ' ': 'transparent' };
const MARK = { '+': '+', '-': '−', ' ': ' ' };

const mono = { fontFamily: 'var(--eb-font-mono, monospace)', fontSize: 'var(--eb-text-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' };
const numCell = { ...mono, width: 44, textAlign: 'right', color: 'var(--eb-text-muted)', padding: '0 6px', userSelect: 'none', verticalAlign: 'top' };
const markCell = { ...mono, width: 14, textAlign: 'center', userSelect: 'none', fontWeight: 'var(--eb-font-medium)', verticalAlign: 'top' };
const textCell = { ...mono, padding: '0 6px', verticalAlign: 'top' };

function sideLabel(side) {
  if (!side) return '';
  if (side.working && !side.entry) return 'Working copy';
  return versionLabel({ ...(side.entry || {}), hash: side.hash });
}

function GapRow({ count, cols }) {
  return (
    <tr>
      <td colSpan={cols} style={{ ...mono, padding: '2px 8px', color: 'var(--eb-text-muted)', background: 'var(--eb-bg-elevated)', fontStyle: 'italic' }}>
        ⋯ {count} unchanged line{count === 1 ? '' : 's'}
      </td>
    </tr>
  );
}

function InlineDiff({ ops }) {
  const rows = useMemo(() => buildUnifiedRows(ops), [ops]);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <tbody>
        {rows.map((r, i) => (r.type === 'gap' ? <GapRow key={i} count={r.count} cols={4} /> : (
          <tr key={i} style={{ background: LINE_BG[r.t] }}>
            <td style={numCell}>{r.a ?? ''}</td>
            <td style={numCell}>{r.b ?? ''}</td>
            <td style={markCell} aria-label={r.t === '+' ? 'added' : r.t === '-' ? 'removed' : undefined}>{MARK[r.t]}</td>
            <td style={textCell}>{r.s}</td>
          </tr>
        )))}
      </tbody>
    </table>
  );
}

function SplitSide({ cell }) {
  if (!cell) return <><td style={{ ...numCell, background: 'var(--eb-bg-elevated)' }} /><td style={{ ...markCell, background: 'var(--eb-bg-elevated)' }} /><td style={{ ...textCell, background: 'var(--eb-bg-elevated)' }} /></>;
  const bg = LINE_BG[cell.t];
  return (
    <>
      <td style={{ ...numCell, background: bg }}>{cell.n ?? ''}</td>
      <td style={{ ...markCell, background: bg }} aria-label={cell.t === '+' ? 'added' : cell.t === '-' ? 'removed' : undefined}>{MARK[cell.t]}</td>
      <td style={{ ...textCell, background: bg }}>{cell.s}</td>
    </>
  );
}

function SplitDiff({ ops }) {
  const rows = useMemo(() => buildSplitRows(ops), [ops]);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <colgroup><col style={{ width: 44 }} /><col style={{ width: 14 }} /><col /><col style={{ width: 44 }} /><col style={{ width: 14 }} /><col /></colgroup>
      <tbody>
        {rows.map((r, i) => (r.type === 'gap' ? <GapRow key={i} count={r.count} cols={6} /> : (
          <tr key={i}><SplitSide cell={r.left} /><SplitSide cell={r.right} /></tr>
        )))}
      </tbody>
    </table>
  );
}

function FileSection({ file, mode }) {
  const note = fileNote(file);
  const counts = fileCounts(file);
  return (
    <section aria-label={`${fileStatusLabel(file.status)}: ${file.path}`} style={{ border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: '6px 10px', background: 'var(--eb-bg-elevated)', borderBottom: '1px solid var(--eb-border-default)', flexWrap: 'wrap' }}>
        <span style={{ ...mono, fontWeight: 'var(--eb-font-medium)' }}>{fileStatusMark(file.status)}</span>
        <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>{fileStatusLabel(file.status)}</span>
        <span style={{ ...mono, color: 'var(--eb-text-primary)' }}>
          {file.status === 'renamed' ? `${file.fromPath} → ${file.path}` : file.path}
        </span>
        {counts && <span style={{ ...mono, color: 'var(--eb-text-muted)' }}>{counts}</span>}
        {note && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>{note}</span>}
      </header>
      {Array.isArray(file.ops) && file.ops.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          {mode === 'inline' ? <InlineDiff ops={file.ops} /> : <SplitDiff ops={file.ops} />}
        </div>
      )}
      {file.status === 'renamed' && !file.contentChanged && (
        <div style={{ padding: '4px 10px', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Content unchanged.</div>
      )}
    </section>
  );
}

export default function SkillVersionDiffModal({ skill, from, to = 'working', onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(() => readDiffMode(typeof window !== 'undefined' ? window.sessionStorage : null));
  const [showUnchanged, setShowUnchanged] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const p = new URLSearchParams({ source: skill.source, from, to });
    if (skill.agentId) p.set('agentId', skill.agentId);
    if (skill.teamId) p.set('teamId', skill.teamId);
    fetch(`/api/skills/${encodeURIComponent(skill.name)}/versions/diff?${p}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [skill.name, skill.source, skill.agentId, skill.teamId, from, to]);

  // Escape closes this modal only — the editor / side panel underneath stay.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    // Window capture runs before the editor's / side panel's document handlers.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => { closeRef.current?.focus(); }, []);

  const pickMode = (m) => {
    setMode(m);
    writeDiffMode(typeof window !== 'undefined' ? window.sessionStorage : null, m);
  };

  const files = data ? visibleDiffFiles(data.files, showUnchanged) : [];

  const body = (
    <div
      role="presentation"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Compare versions of ${skill.name}`}
        style={{
          display: 'flex', flexDirection: 'column', width: '96vw', height: '94vh',
          background: 'var(--eb-bg-surface)', borderRadius: 'var(--eb-radius-lg)',
          border: '1px solid var(--eb-border-default)', boxShadow: 'var(--eb-shadow-lg)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Compare versions — {skill.name}
            </div>
            {data && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                <span style={mono}>{sideLabel(data.from)}</span> → <span style={mono}>{sideLabel(data.to)}</span>
                {' · '}{summaryText(data.summary)}
              </div>
            )}
          </div>
          <div role="group" aria-label="Diff layout" style={{ display: 'inline-flex', gap: 4 }}>
            <button type="button" style={btn(mode === 'split')} aria-pressed={mode === 'split'} onClick={() => pickMode('split')}>Side-by-side</button>
            <button type="button" style={btn(mode === 'inline')} aria-pressed={mode === 'inline'} onClick={() => pickMode('inline')}>Inline</button>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            <input type="checkbox" checked={showUnchanged} onChange={e => setShowUnchanged(e.target.checked)} />
            Show unchanged files{data?.summary?.unchanged ? ` (${data.summary.unchanged})` : ''}
          </label>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close comparison" style={{ ...btn(false), display: 'inline-flex', alignItems: 'center' }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--eb-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {!data && !error && <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Comparing…</div>}
          {error && <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Could not compare: {error}</div>}
          {data && data.identical && (
            <div style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>No differences — both versions have the same content.</div>
          )}
          {data && files.map(f => <FileSection key={`${f.status}:${f.fromPath || ''}:${f.path}`} file={f} mode={mode} />)}
        </div>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
