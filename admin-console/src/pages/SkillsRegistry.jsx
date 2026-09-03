import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, Link } from 'react-router';
import { Trash2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { assistFetch } from '../context/assist-transport.js';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import SkillMarkdown from '../components/SkillMarkdown';
import { usePageActions } from '../context/PageActionsContext';
import { useHelpSubject } from '../context/HelperChatContext';
import { OVERLAY_SKILL_DETAIL, OVERLAY_SKILLS_MERGE } from '../context/page-help-view.js';
import { SKILLS_HELP_SECTIONS } from './skills-help-sections.js';

/* ─── Skill name validation (mirrors SKILL_NAME_RE in api.js) ─────────── */
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;

const FILTER_OPTIONS = ['All', 'Global', 'Team', 'Agent'];

// Deep-link tier param (?tier=pool|team|agent) → the registry's filter label
// and the row `source` value (#774 AC5).
const TIER_TO_FILTER = { pool: 'Global', team: 'Team', agent: 'Agent' };
const TIER_TO_SOURCE = { pool: 'pool', team: 'team', agent: 'agent' };

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
function NewSkillForm({ onCreated, onCancel, teams = [] }) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [target, setTarget] = useState('global'); // 'global' or 'team:<id>'
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
      const body = { name, content };
      if (target.startsWith('team:')) {
        body.source = 'team';
        body.teamId = target.slice('team:'.length);
      }
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
          Target pool
        </label>
        <select
          value={target}
          onChange={e => setTarget(e.target.value)}
          style={{
            width: '100%', padding: '6px 10px',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        >
          <option value="global">Global pool (visible to all teams)</option>
          {teams.map(t => <option key={t.id} value={`team:${t.id}`}>Team: {t.name} ({t.id})</option>)}
        </select>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          A team skill is seeded only into agents owned by that team; global skills go to everyone.
        </span>
      </div>
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

/* ─── Version / drift / provenance chips (#632) ───────────────────────── */
const DRIFT_META = {
  'in-sync': { label: 'in sync', color: 'var(--eb-status-success)', bg: 'var(--eb-status-success-bg)' },
  outdated:  { label: 'outdated', color: 'var(--eb-status-warning)', bg: 'var(--eb-status-warning-bg)' },
  diverged:  { label: 'diverged', color: 'var(--eb-status-warning)', bg: 'var(--eb-status-warning-bg)' },
  conflict:  { label: 'conflict', color: 'var(--eb-status-error)',   bg: 'var(--eb-status-error-bg)' },
  orphaned:  { label: 'orphaned', color: 'var(--eb-status-error)',   bg: 'var(--eb-status-error-bg)' },
  unknown:   { label: 'unknown',  color: 'var(--eb-text-muted)',     bg: 'var(--eb-bg-elevated)' },
};

function Chip({ label, color, bg, title, mono }) {
  return (
    <span title={title} style={{
      padding: '1px 7px', borderRadius: 'var(--eb-radius-sm)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      background: bg || 'var(--eb-bg-elevated)', color: color || 'var(--eb-text-secondary)',
      border: `1px solid ${color || 'var(--eb-border-default)'}`,
      fontFamily: mono ? 'var(--eb-font-mono)' : 'inherit', whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function DriftBadge({ state }) {
  const m = DRIFT_META[state];
  if (!m) return null;
  return <Chip label={m.label} color={m.color} bg={m.bg} title={`Drift vs. source: ${state}`} />;
}

// The `v4 · a1b2c3` content-version chip the list rows + detail header render.
function VersionChip({ version, contentHash }) {
  if (!Number.isInteger(version)) return null;
  const short = typeof contentHash === 'string' ? contentHash.slice(0, 6) : '';
  return <Chip mono label={`v${version}${short ? ` · ${short}` : ''}`} title="Content version · hash prefix" />;
}

// Provenance chips derived from the list row's compact summary (#632, AC2):
// `shared` when the copy carries an origin team, `provenance` when a
// provenance.json exists at all. Absent for hand-authored skills.
function ProvenanceChips({ row }) {
  const chips = [];
  if (row.originTeamId) chips.push(<Chip key="shared" label={`shared from ${row.originTeamId}`} title="Promoted/shared from a team pool" color="var(--eb-status-info)" bg="var(--eb-status-info-bg)" />);
  else if (row.provenance) chips.push(<Chip key="prov" label="provenance" title="Carries knowledge provenance" color="var(--eb-status-info)" bg="var(--eb-status-info-bg)" />);
  if (!chips.length) return null;
  return <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{chips}</span>;
}

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

const TIER_LABEL = { global: 'global', team: 'team', agent: 'agent' };

// Map a lineage copy ({tier, teamId?, agentId?}) to the row shape openSkill
// expects (the list tags the global tier as `pool`).
function copyToRow(copy, name) {
  const source = copy.tier === 'global' ? 'pool' : copy.tier;
  return { name, source, teamId: copy.teamId, agentId: copy.agentId };
}

/* ─── Versions tab — skill.json history timeline (#632, AC2) ───────────── */
function VersionsTab({ lineage, loading, error }) {
  if (loading) return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading version history…</div>;
  if (error) return <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load lineage: {error}</div>;
  const versions = lineage?.versions;
  const history = Array.isArray(versions?.history) ? versions.history : [];
  if (!history.length) {
    return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', fontStyle: 'italic' }}>No version history recorded yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      {history.map((h, i) => (
        <div key={`${h.version}-${h.hash}-${i}`} style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          border: `1px solid ${h.current ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
          background: h.current ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
          borderRadius: 'var(--eb-radius-sm)',
        }}>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <VersionChip version={h.version} contentHash={h.hash} />
            {h.action && <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>{h.action}</span>}
            {h.current && <Chip label="current" color="var(--eb-accent-primary)" bg="var(--eb-accent-muted)" title="The live revision on disk" />}
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            {[h.by, formatTs(h.at)].filter(Boolean).join(' · ')}
          </div>
          {h.note && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', fontStyle: 'italic' }}>{h.note}</div>}
        </div>
      ))}
    </div>
  );
}

/* ─── Lineage tab — provenance + origin + every known copy (#632, AC2) ── */
function LineageTab({ lineage, loading, error, name, onOpenCopy }) {
  if (loading) return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading lineage…</div>;
  if (error) return <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load lineage: {error}</div>;
  if (!lineage) return null;

  const origin = lineage.origin;
  const prov = lineage.provenance;
  const copies = Array.isArray(lineage.copies) ? lineage.copies : [];
  const entryIds = Array.isArray(prov?.entryIds) ? prov.entryIds : [];
  const knowledgeHref = prov?.originTeamId ? `/knowledge?team=${encodeURIComponent(prov.originTeamId)}` : '/knowledge';

  const sectionTitle = { fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* Origin (content lineage — where THIS copy descends from) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        <span style={sectionTitle}>Origin</span>
        {origin ? (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
            {[TIER_LABEL[origin.tier] || origin.tier, origin.teamId, origin.action].filter(Boolean).join(' · ')}
            {origin.sourceHash ? <span style={{ fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}> ({String(origin.sourceHash).slice(0, 6)})</span> : null}
          </span>
        ) : (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>Hand-authored — no recorded origin.</span>
        )}
      </div>

      {/* Provenance (knowledge lineage — entryIds that drove a promotion) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        <span style={sectionTitle}>Knowledge provenance</span>
        {prov ? (
          <>
            {prov.originTeamId && (
              <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
                Promoted from team <strong>{prov.originTeamId}</strong>
              </span>
            )}
            {entryIds.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{entryIds.length} knowledge entr{entryIds.length === 1 ? 'y' : 'ies'}:</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {entryIds.map(id => (
                    <a key={id} href={knowledgeHref} title={`Open the Knowledge page (entry ${id})`}
                      style={{ textDecoration: 'none' }}>
                      <Chip mono label={String(id).slice(0, 10)} color="var(--eb-accent-primary)" bg="var(--eb-accent-muted)" />
                    </a>
                  ))}
                </div>
              </div>
            )}
            <a href={knowledgeHref} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)' }}>View in Knowledge →</a>
          </>
        ) : (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>No knowledge provenance (not a promoted/shared skill).</span>
        )}
      </div>

      {/* All known copies across tiers with drift */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        <span style={sectionTitle}>Copies ({copies.length})</span>
        {copies.length === 0 ? (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>No other copies found.</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {copies.map((c, i) => {
              const scopeLabel = c.tier === 'global' ? 'global pool' : c.tier === 'team' ? `team ${c.teamId}` : `agent ${c.agentId}`;
              return (
                <button
                  key={`${c.tier}:${c.teamId ?? ''}:${c.agentId ?? ''}:${i}`}
                  onClick={() => onOpenCopy?.(copyToRow(c, name))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap',
                    padding: 'var(--eb-space-2) var(--eb-space-3)', textAlign: 'left', width: '100%',
                    border: `1px solid ${c.viewed ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                    background: c.viewed ? 'var(--eb-accent-muted)' : 'var(--eb-bg-surface)',
                    borderRadius: 'var(--eb-radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                  title={`Open the ${scopeLabel} copy`}
                >
                  <SourceBadge value={c.tier === 'global' ? 'pool' : c.tier} />
                  <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', fontFamily: 'var(--eb-font-mono)' }}>{scopeLabel}</span>
                  {Number.isInteger(c.version) && <VersionChip version={c.version} contentHash={c.contentHash} />}
                  {c.drift && <DriftBadge state={c.drift} />}
                  {c.viewed && <Chip label="viewing" color="var(--eb-accent-primary)" bg="var(--eb-accent-muted)" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Usage tab — where the skill is actually seeded (#632, AC2/AC3) ───── */
function UsageTab({ lineage, loading, error }) {
  if (loading) return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading usage…</div>;
  if (error) return <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load lineage: {error}</div>;
  const copies = Array.isArray(lineage?.copies) ? lineage.copies : [];
  const agentCopies = copies.filter(c => c.tier === 'agent');
  const summary = lineage?.summary;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {summary && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Lives in <strong>{summary.total}</strong> place{summary.total === 1 ? '' : 's'} — {summary.byTier.global} global, {summary.byTier.team} team, {summary.byTier.agent} agent.
          {summary.worstDrift && <> Worst drift: <DriftBadge state={summary.worstDrift} />.</>}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
          Seeded into agents ({agentCopies.length})
        </span>
        {agentCopies.length === 0 ? (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
            No agent currently carries this skill in its workspace.
          </span>
        ) : (
          agentCopies.map((c, i) => (
            <div key={`${c.agentId}:${i}`} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
              borderRadius: 'var(--eb-radius-sm)',
            }}>
              <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', fontFamily: 'var(--eb-font-mono)' }}>{c.agentId}</span>
              {c.teamId && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>({c.teamId})</span>}
              {c.drift && <DriftBadge state={c.drift} />}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const VIEWER_TABS = [
  { id: 'content', label: 'Content' },
  { id: 'versions', label: 'Versions' },
  { id: 'lineage', label: 'Lineage' },
  { id: 'usage', label: 'Usage' },
];

/* ─── Skill viewer / inline editor ────────────────────────────────────── */
function SkillViewer({ skill, onDeleted, onPromoted, onOpenCopy, installableAgents, agentSkills, teams }) {
  const isPool = skill.source === 'pool';
  const isTeam = skill.source === 'team';
  const isAgent = skill.source === 'agent';
  const isManaged = isPool || isTeam; // editable / deletable here
  const skillKey = `${skill.source}:${skill.agentId ?? ''}:${skill.teamId ?? ''}:${skill.name}`;

  // Append the source-specific scope params (agentId for agent skills, teamId
  // for team skills) so the API resolves the right pool.
  const withScope = (params) => {
    if (skill.agentId) params.set('agentId', skill.agentId);
    if (skill.teamId) params.set('teamId', skill.teamId);
    return params;
  };

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
  const [deleteBlocking, setDeleteBlocking] = useState(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [pendingTransfer, setPendingTransfer] = useState(null);
  const [installTarget, setInstallTarget] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);
  const [installMsg, setInstallMsg] = useState(null);
  const [confirmInstallOverwrite, setConfirmInstallOverwrite] = useState(false);
  const [adoptTeamId, setAdoptTeamId] = useState('');
  // #781 distillation (team skills only — the pass is team-scoped).
  const [distill, setDistill] = useState(null); // null | {loading} | {old,new,changed,reason} | {error}
  const [distillBusy, setDistillBusy] = useState(false);

  // Detail tabs (#632): Content (files, default) + Versions / Lineage / Usage,
  // the latter three fed by one lineage fetch. The fetch is lazy — it only fires
  // once the operator leaves the Content tab, so browsing files stays a single
  // round-trip.
  // A deep link may open straight on a detail tab (#1143 — drift chips land on
  // Lineage). `skill.initialTab` is validated against VIEWER_TABS before use.
  const initialTab = VIEWER_TABS.some(t => t.id === skill.initialTab) ? skill.initialTab : 'content';
  const [tab, setTab] = useState(initialTab);
  const [lineage, setLineage] = useState(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageError, setLineageError] = useState(null);

  useEffect(() => {
    // Reset when the selected skill changes; the fetch effect below refills it
    // when a lineage tab is active. Honours a deep-linked initial tab.
    setTab(initialTab);
    setLineage(null);
    setLineageError(null);
    setLineageLoading(false);
  }, [skillKey]);

  useEffect(() => {
    // Fetch the shared lineage payload once, lazily, when a lineage-backed tab
    // is first opened. `lineageLoading` must NOT be a dependency here: the effect
    // sets it, so listing it would tear the effect down mid-flight and cancel the
    // in-flight fetch before it resolves (its cleanup flips `cancelled`), leaving
    // the panel stuck on "Loading…". Guard on the resolved states instead — once
    // we have data or an error, switching between lineage tabs reuses it (no
    // refetch), and the fetch never self-cancels.
    if (tab === 'content' || lineage || lineageError) return;
    let cancelled = false;
    setLineageLoading(true);
    const params = withScope(new URLSearchParams({ source: skill.source }));
    fetch(`/api/skills/${encodeURIComponent(skill.name)}/lineage?${params}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setLineage(d); })
      .catch(e => { if (!cancelled) setLineageError(e.message); })
      .finally(() => { if (!cancelled) setLineageLoading(false); });
    return () => { cancelled = true; };
  }, [tab, skillKey, lineage, lineageError]);

  // Load the file list whenever the selected skill changes.
  useEffect(() => {
    let cancelled = false;
    setFilesLoading(true); setFilesError(null); setFiles([]); setEditing(false);
    const params = withScope(new URLSearchParams({ source: skill.source }));
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
    const params = withScope(new URLSearchParams({ source: skill.source, file: selectedFile }));
    fetch(`/api/skills/${encodeURIComponent(skill.name)}/file?${params}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => { if (!cancelled) setFileData(d); })
      .catch(e => { if (!cancelled) setFileError(e.message); })
      .finally(() => { if (!cancelled) setFileLoading(false); });
    return () => { cancelled = true; };
  }, [skillKey, selectedFile]);

  const fileEditable = isManaged && fileData && !fileData.binary && !fileData.truncated;

  function exportSkill() {
    const params = withScope(new URLSearchParams({ source: skill.source }));
    window.open(`/api/skills/${encodeURIComponent(skill.name)}/export?${params}`, '_blank');
  }

  // Unified tier-transfer (#626): one endpoint for every tier transition — adopt
  // (global→team), promote copy (team→global), and move (team→global). `to`/`from`/
  // `mode` are passed through to the engine, which validates the cell, gates on
  // permission, stamps lineage + carries provenance. On a destination name
  // collision the engine returns 409 {exists}; we surface the overwrite dialog and
  // replay the same transfer with onCollision:'overwrite'.
  async function transfer(body) {
    setPromoting(true);
    setPromoteError(null);
    try {
      const res = await fetch('/api/skills/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.exists) {
          setPendingTransfer(body);
          setConfirmOverwrite(true);
          setPromoting(false);
          return;
        }
        if (res.status === 409 && data.agents) {
          throw new Error(`${data.error}: ${data.agents.join(', ')}`);
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfirmOverwrite(false);
      setPendingTransfer(null);
      onPromoted?.({ name: data.name, source: data.to?.tier === 'team' ? 'team' : 'pool', teamId: data.to?.teamId });
    } catch (e) {
      setPromoteError(e.message);
    } finally {
      setPromoting(false);
    }
  }

  // #781 §3.4: distil this team skill — preview old-vs-new, then apply. LLM failure
  // leaves the skill byte-identical (backend-enforced).
  async function distillPreview() {
    setDistillBusy(true);
    setDistill({ loading: true });
    try {
      const res = await fetch('/api/knowledge/distill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: skill.teamId, skill: skill.name, apply: false }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setDistill({ old: d.old || '', new: d.new || '', changed: !!d.changed, reason: d.reason });
    } catch (e) {
      setDistill({ error: e.message });
    } finally {
      setDistillBusy(false);
    }
  }
  async function distillApply() {
    setDistillBusy(true);
    try {
      const res = await fetch('/api/knowledge/distill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: skill.teamId, skill: skill.name, apply: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (d.changed && selectedFile === 'SKILL.md' && typeof d.new === 'string') {
        setFileData(fd => ({ ...(fd || {}), content: d.new }));
      }
      setDistill(null);
    } catch (e) {
      setDistill({ error: e.message });
    } finally {
      setDistillBusy(false);
    }
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

  async function handleSaveFile() {
    setSaving(true);
    setError(null);
    try {
      const params = withScope(new URLSearchParams({ source: skill.source, file: selectedFile }));
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

  async function handleDelete(cascade = false) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const params = withScope(new URLSearchParams({ source: skill.source }));
      if (cascade) params.set('cascade', 'true');
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}?${params}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.agents) {
          // Guarded: the skill still resolves to this tier for these constructs.
          // Offer a cascade (deactivate the grants, then delete) in one action.
          setDeleteBlocking(data.agents);
          setDeleteError(`Skill is in use by: ${data.agents.join(', ')}`);
          setDeleting(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfirmDelete(false);
      setDeleteBlocking(null);
      onDeleted(skill.name);
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', height: '100%' }}>
      {/* Detail tab strip (#632) */}
      <div style={{ display: 'flex', gap: 'var(--eb-space-1)', borderBottom: '1px solid var(--eb-border-default)' }}>
        {VIEWER_TABS.map(t => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
                fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
                color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
                borderBottom: `2px solid ${active ? 'var(--eb-accent-primary)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'versions' && <VersionsTab lineage={lineage} loading={lineageLoading} error={lineageError} />}
      {tab === 'lineage' && <LineageTab lineage={lineage} loading={lineageLoading} error={lineageError} name={skill.name} onOpenCopy={onOpenCopy} />}
      {tab === 'usage' && <UsageTab lineage={lineage} loading={lineageLoading} error={lineageError} />}

      {tab === 'content' && (<>
      {/* toolbar */}
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {!editing && (
          <button onClick={exportSkill} style={secondaryBtnStyle} title="Download the whole skill directory as a ZIP">
            Export ZIP
          </button>
        )}
        {isManaged && !editing && (
          <>
            <button
              onClick={() => { setEditing(true); setEditContent(fileData?.content ?? ''); setPreview(false); setError(null); }}
              disabled={!fileEditable}
              title={fileEditable ? undefined : 'This file cannot be edited here (binary or too large)'}
              style={fileEditable ? secondaryBtnStyle : { ...secondaryBtnStyle, cursor: 'not-allowed', opacity: 0.5 }}
            >
              Edit {files.length > 1 ? 'file' : ''}
            </button>
            {isTeam && (
              <button
                onClick={() => transfer({ name: skill.name, from: { tier: 'team', teamId: skill.teamId }, to: { tier: 'global' }, mode: 'copy' })}
                disabled={promoting}
                style={primaryBtnStyle(promoting)}
                title="Copy this team skill into the global pool (visible to all teams); the team-tier copy stays put"
              >
                {promoting ? 'Promoting…' : 'Promote to global'}
              </button>
            )}
            {isTeam && (
              <button
                onClick={() => transfer({ name: skill.name, from: { tier: 'team', teamId: skill.teamId }, to: { tier: 'global' }, mode: 'move' })}
                disabled={promoting}
                style={secondaryBtnStyle}
                title="Move this team skill into the global pool (retires the team-tier copy, keeps a recoverable snapshot)"
              >
                {promoting ? 'Moving…' : 'Move to global'}
              </button>
            )}
            {isTeam && (
              <button
                onClick={distillPreview}
                disabled={distillBusy}
                style={secondaryBtnStyle}
                title="Re-synthesise the whole skill from its accumulated content — dedupe, restructure, re-abstract. Shows a diff before applying (#781)."
              >
                {distillBusy && distill && distill.loading ? 'Distilling…' : 'Distill…'}
              </button>
            )}
            <button onClick={() => { setDeleteError(null); setConfirmDelete(true); }} style={dangerBtnStyle}>
              Delete skill
            </button>
          </>
        )}
        {isManaged && editing && (
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
        {isAgent && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
            This skill lives inside a single agent. It can&apos;t be shared directly — copy it to a team first, then promote that team skill to global.{' '}
            <Link
              to={skill.teamId ? `/knowledge?team=${encodeURIComponent(skill.teamId)}` : '/knowledge'}
              style={{ color: 'var(--eb-accent-primary)', fontStyle: 'normal' }}
            >
              Open the Knowledge page{skill.teamId ? ' for this team' : ''} →
            </Link>{' '}
            to lift it into a team pool, then use Promote to global on the resulting team skill. Both steps write provenance and skill.json lineage.
          </span>
        )}
        {/* The action panel's own "?" — opens the Skills topic at the chapter
            that explains promote / move / distill / merge / import-export
            (#1990). Hidden while editing a file, where none of those buttons
            are on screen. */}
        {!editing && (
          <PageHelpButton
            label="What these skill actions do"
            size={14}
            style={{ padding: 0, marginLeft: 'auto' }}
            section={SKILLS_HELP_SECTIONS.actions}
          />
        )}
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</div>
      )}
      {promoteError && (
        <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{promoteError}</div>
      )}

      {/* Adopt a global skill into a team pool (#626, global→team transfer) */}
      {isPool && !editing && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
          padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
            Adopt as team skill
            <PageHelpButton
              label="Adopt, move and the other transfer actions"
              size={13}
              style={{ padding: 0 }}
              section={SKILLS_HELP_SECTIONS.actions}
            />
          </span>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={adoptTeamId}
              onChange={e => { setAdoptTeamId(e.target.value); setPromoteError(null); }}
              style={{
                padding: '5px 10px', borderRadius: 'var(--eb-radius-sm)',
                border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
                color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                minWidth: 180,
              }}
            >
              <option value="">Select a team…</option>
              {(teams ?? []).map(t => (
                <option key={t.id} value={t.id}>{t.name || t.id}</option>
              ))}
            </select>
            <button
              onClick={() => transfer({ name: skill.name, from: { tier: 'global' }, to: { tier: 'team', teamId: adoptTeamId }, mode: 'copy' })}
              disabled={!adoptTeamId || promoting}
              style={primaryBtnStyle(!adoptTeamId || promoting)}
              title="Copy this global skill into the selected team's pool and activate it"
            >
              {promoting ? 'Adopting…' : 'Adopt'}
            </button>
            <button
              onClick={() => transfer({ name: skill.name, from: { tier: 'global' }, to: { tier: 'team', teamId: adoptTeamId }, mode: 'move' })}
              disabled={!adoptTeamId || promoting}
              style={!adoptTeamId || promoting ? { ...secondaryBtnStyle, cursor: 'not-allowed', opacity: 0.5 } : secondaryBtnStyle}
              title="Move this global skill into the selected team's pool (retires the global copy, keeps a recoverable snapshot). Requires System Admin."
            >
              {promoting ? 'Moving…' : 'Move to team'}
            </button>
          </div>
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
            <strong>Adopt</strong> copies the whole skill into the team pool (activated by default) so the team owns a curatable copy; <strong>Move to team</strong> relocates it and retires the global copy (a recoverable snapshot is archived).
          </span>
        </div>
      )}

      {/* Install pool skill into an existing agent (no full workspace reset) */}
      {isPool && !editing && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
          padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
            Install into agent
            {/* Installing is the verb people confuse with granting, so this "?"
                lands on the grant / activation / install chapter rather than the
                action table (#1990). */}
            <PageHelpButton
              label="Granting, activation and installing into an agent"
              size={13}
              style={{ padding: 0 }}
              section={SKILLS_HELP_SECTIONS.grants}
            />
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
            Copies the whole skill directory (scripts included) into the agent. It picks the skill up on its next message. Note: a later workspace reset re-seeds only the skills granted to the agent (or its team).
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

      {/* Delete confirmation dialog. A guarded delete (409) surfaces the
          blocking constructs and offers a cascade: deactivate the grants, then
          delete — in one confirm. A snapshot is archived either way (restorable). */}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete skill"
        variant="danger"
        message={
          deleteBlocking ? (
            <span>
              <strong>{skill.name}</strong> still resolves to this tier for: {deleteBlocking.join(', ')}.
              <br />Deactivate those grants and delete anyway? A restorable snapshot is archived first.
            </span>
          ) : deleteError ? (
            <span><strong>Cannot delete:</strong> {deleteError}</span>
          ) : (
            `Delete "${skill.name}"? A restorable snapshot is archived, then the skill directory is removed.`
          )
        }
        confirmLabel={
          deleteBlocking ? (deleting ? 'Deactivating…' : 'Deactivate grants & delete')
            : deleteError ? undefined
            : (deleting ? 'Deleting…' : 'Delete')
        }
        alertOnly={!!deleteError && !deleteBlocking}
        onConfirm={
          deleteBlocking ? () => handleDelete(true)
            : deleteError ? () => { setConfirmDelete(false); setDeleteError(null); }
            : () => handleDelete(false)
        }
        onCancel={() => { setConfirmDelete(false); setDeleteError(null); setDeleteBlocking(null); }}
      />

      {/* Overwrite confirmation (destination tier already has a skill with this name) */}
      <ConfirmDialog
        open={confirmOverwrite}
        title="Skill already exists at destination"
        variant="danger"
        message={`A skill named "${skill.name}" already exists at the destination. Overwrite it with this version? This replaces the entire destination skill directory.`}
        confirmLabel={promoting ? 'Overwriting…' : 'Overwrite'}
        onConfirm={() => pendingTransfer && transfer({ ...pendingTransfer, onCollision: 'overwrite' })}
        onCancel={() => { setConfirmOverwrite(false); setPendingTransfer(null); }}
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

      {/* #781 distillation diff (team skills) */}
      {distill && (
        <div
          onClick={() => !distillBusy && setDistill(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', maxWidth: 900, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--eb-border-default)' }}>
              <strong style={{ fontSize: 'var(--eb-text-sm)' }}>Distill “{skill.name}”</strong>
              {/* Primer so a first-time operator knows what distillation does (#1146) */}
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5, marginTop: 4 }}>
                Distilling re-synthesises the whole skill from everything that has accumulated in it — deduping
                repeats, restructuring, and re-abstracting — so it stays tight as agents keep adding to it.
                It only rewrites the wording; you review the diff below and apply it yourself.
              </div>
            </div>
            <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
              {distill.loading && <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Re-synthesising the skill…</div>}
              {distill.error && <div style={{ color: 'var(--eb-status-error, #d33)', fontSize: 'var(--eb-text-sm)' }}>Distillation failed: {distill.error}</div>}
              {!distill.loading && !distill.error && !distill.changed && (
                <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                  {distill.reason === 'llm-failed'
                    ? 'The re-synthesis did not produce a usable result — the skill is left unchanged.'
                    : 'The distillation produced no change — the skill is already well-structured.'}
                </div>
              )}
              {!distill.loading && !distill.error && distill.changed && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 4 }}>Current</div>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-elevated)', padding: 8, borderRadius: 6, margin: 0, maxHeight: '55vh', overflow: 'auto' }}>{distill.old}</pre>
                  </div>
                  <div>
                    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 4 }}>Distilled</div>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-elevated)', padding: 8, borderRadius: 6, margin: 0, maxHeight: '55vh', overflow: 'auto' }}>{distill.new}</pre>
                  </div>
                </div>
              )}
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--eb-border-default)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDistill(null)} disabled={distillBusy} style={secondaryBtnStyle}>Close</button>
              {!distill.loading && !distill.error && distill.changed && (
                <button onClick={distillApply} disabled={distillBusy} style={primaryBtnStyle(distillBusy)}>
                  {distillBusy ? 'Applying…' : 'Apply distillation'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}

/* ─── Merge helpers (#631) ─────────────────────────────────────────────── */

// A stable key for a skill row (matches getRowKey below and skill-merge refKey).
function skillRowKey(row) {
  return `${row.source}:${row.agentId ?? ''}:${row.teamId ?? ''}:${row.name}`;
}

// Map a skills-list row to the merge endpoint's source-ref shape. The list tags
// the global pool as `pool`; the merge API calls that tier `global`.
function rowToMergeSource(row) {
  if (row.source === 'team') return { tier: 'team', teamId: row.teamId, name: row.name };
  if (row.source === 'agent') return { tier: 'agent', agentId: row.agentId, name: row.name };
  return { tier: 'global', name: row.name };
}

const MERGE_SOURCE_BADGE = { global: 'global', team: 'team', agent: 'agent' };

/* ─── Merge dialog (#631, concept §3.4) ────────────────────────────────────
 * Fold the multi-selected skills into ONE target skill. The operator picks the
 * target name + tier, edits an LLM-drafted (heuristic-fallback) combined
 * SKILL.md, and chooses whether to retire the sources (default on). Submitting
 * unions the sources' provenance, carries their files, migrates every grant
 * naming a retired source to the target, and archives the retired sources. */
function MergeSkillsDialog({ sources, teams = [], onClose, onMerged }) {
  // Default target: if every source is a team skill in the same team, target
  // that team; otherwise the global pool. Prefill the name from the first source.
  const allSameTeam = sources.length > 0 && sources.every(
    s => s.tier === 'team' && s.teamId === sources[0].teamId,
  );
  const [targetTier, setTargetTier] = useState(allSameTeam ? 'team' : 'global');
  const [targetTeamId, setTargetTeamId] = useState(allSameTeam ? sources[0].teamId : '');
  const [name, setName] = useState(sources[0]?.name ?? '');
  const [draft, setDraft] = useState('');
  const [retireSources, setRetireSources] = useState(true);
  const [preview, setPreview] = useState(false);

  const [drafting, setDrafting] = useState(false);
  const [draftSource, setDraftSource] = useState(null); // 'heuristic' | 'llm'
  const [draftError, setDraftError] = useState(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  // The dialog renders at z-index 1000; the help panel's own is 50, so without a
  // published overlay subject its own "?" would open the panel BEHIND the dialog
  // (#1892's panelZIndex is what lifts it). The key claims no topic — help still
  // resolves to the /skills topic underneath (#1990).
  useHelpSubject({ overlay: OVERLAY_SKILLS_MERGE });

  const nameValid = SKILL_NAME_RE.test(name);
  const targetReady = nameValid && (targetTier === 'global' || !!targetTeamId);

  const target = useCallback(() => (
    targetTier === 'team' ? { tier: 'team', teamId: targetTeamId, name } : { tier: 'global', name }
  ), [targetTier, targetTeamId, name]);

  // Draft a combined SKILL.md. `heuristicOnly` skips the LLM for an instant
  // deterministic concat prefill; otherwise the server tries the LLM first.
  const generate = useCallback(async (heuristicOnly) => {
    if (!targetReady) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await assistFetch('/api/skills/merge-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, target: target(), heuristicOnly: !!heuristicOnly }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDraft(data.draft?.skillMd ?? '');
      setDraftSource(data.source || null);
    } catch (e) {
      setDraftError(e.message);
    } finally {
      setDrafting(false);
    }
  }, [sources, target, targetReady]);

  // Prefill once with the instant heuristic concat so the textarea is never
  // empty; the operator can then regenerate with AI or edit by hand.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !targetReady) return;
    prefilled.current = true;
    generate(true);
  }, [targetReady, generate]);

  async function merge(overwrite) {
    if (!targetReady || !draft.trim()) return;
    setMerging(true);
    setError(null);
    try {
      const res = await fetch('/api/skills/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, target: target(), draft, retireSources, overwrite }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.exists) {
          setConfirmOverwrite(true);
          setMerging(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setConfirmOverwrite(false);
      onMerged?.(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setMerging(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--eb-space-4)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(680px, 100%)', maxHeight: '90vh', overflowY: 'auto',
          background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)', padding: 'var(--eb-space-5)',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)',
        }}
      >
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
            Merge {sources.length} skills
            {/* Deep-links to the overwrite-and-merge chapter — what merging does
                to provenance, extra files and grants (#1878 moved the prose off
                this dialog, #1990 gives it a way back to it). */}
            <PageHelpButton
              label="What merging does to provenance and grants"
              size={14}
              style={{ padding: 0 }}
              section={SKILLS_HELP_SECTIONS.overwrite}
            />
          </h2>
          {/* One line here; what merging does to provenance, extra files and
              grants is explained in the Skills help topic (#1878). */}
          <p style={{ margin: 'var(--eb-space-1) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            Fold the selected skills into one.
          </p>
        </div>

        {/* Source list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
          <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
            Sources
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1)' }}>
            {sources.map((s, i) => (
              <span
                key={`${s.tier}:${s.teamId ?? ''}:${s.agentId ?? ''}:${s.name}:${i}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '2px 8px', borderRadius: 'var(--eb-radius-sm)',
                  fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
                  border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-elevated)',
                }}
              >
                {s.name}
                <span style={{ color: 'var(--eb-text-muted)', fontFamily: 'inherit' }}>
                  {MERGE_SOURCE_BADGE[s.tier]}{s.teamId ? `:${s.teamId}` : s.agentId ? `:${s.agentId}` : ''}
                </span>
              </span>
            ))}
          </div>
        </div>

        {/* Target tier + name */}
        <div style={{ display: 'flex', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', marginBottom: 4 }}>
              Target tier
            </label>
            <select
              value={targetTier === 'team' ? `team:${targetTeamId}` : 'global'}
              onChange={e => {
                const v = e.target.value;
                if (v.startsWith('team:')) { setTargetTier('team'); setTargetTeamId(v.slice('team:'.length)); }
                else { setTargetTier('global'); setTargetTeamId(''); }
              }}
              style={{
                width: '100%', padding: '6px 10px',
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
                background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
                fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            >
              <option value="global">Global pool</option>
              {teams.map(t => <option key={t.id} value={`team:${t.id}`}>Team: {t.name || t.id} ({t.id})</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', marginBottom: 4 }}>
              Target skill name
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. jcl-conversion"
              style={{
                width: '100%', padding: '6px 10px',
                border: `1px solid ${name && !nameValid ? 'var(--eb-status-error)' : 'var(--eb-border-default)'}`,
                borderRadius: 'var(--eb-radius-sm)', background: 'var(--eb-bg-surface)',
                color: 'var(--eb-text-primary)', fontFamily: 'var(--eb-font-mono)',
                fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box',
              }}
            />
            {name && !nameValid && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
                Only letters, digits, hyphens, underscores, dots, and colons allowed.
              </span>
            )}
          </div>
        </div>

        {/* Draft editor */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
              Combined SKILL.md
              {draftSource && (
                <span style={{ marginLeft: 8, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-normal)' }}>
                  ({draftSource === 'llm' ? 'AI-drafted' : 'concatenated'})
                </span>
              )}
            </label>
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => generate(false)}
                disabled={!targetReady || drafting}
                style={{ ...secondaryBtnStyle, padding: '3px 10px', opacity: (!targetReady || drafting) ? 0.5 : 1 }}
                title="Ask the model to synthesise one coherent SKILL.md from the sources"
              >
                {drafting ? 'Generating…' : 'Generate with AI'}
              </button>
              <button
                type="button"
                onClick={() => setPreview(p => !p)}
                style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {preview ? 'Edit' : 'Preview'}
              </button>
            </div>
          </div>
          {preview ? (
            <div style={{
              minHeight: 200, maxHeight: 360, overflowY: 'auto', padding: 'var(--eb-space-3)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)',
            }}>
              <SkillMarkdown content={draft} />
            </div>
          ) : (
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={14}
              placeholder={drafting ? 'Generating draft…' : 'The combined skill content…'}
              style={{
                width: '100%', padding: '8px 10px',
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
                background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
                fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)',
                resize: 'vertical', boxSizing: 'border-box',
              }}
            />
          )}
          {draftError && (
            <span role="alert" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
              Draft failed: {draftError}
            </span>
          )}
        </div>

        {/* Retire sources */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer' }}>
          <input type="checkbox" checked={retireSources} onChange={e => setRetireSources(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <strong>Retire source skills</strong> after merging
            <span style={{ display: 'block', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Migrates every grant naming a source to the target, then archives the sources (restorable). Uncheck to keep the sources in place.
            </span>
          </span>
        </label>

        {error && (
          <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{error}</div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} disabled={merging} style={secondaryBtnStyle}>Cancel</button>
          <button
            type="button"
            onClick={() => merge(false)}
            disabled={merging || drafting || !targetReady || !draft.trim()}
            style={primaryBtnStyle(merging || drafting || !targetReady || !draft.trim())}
          >
            {merging ? 'Merging…' : 'Merge skills'}
          </button>
        </div>

        <ConfirmDialog
          open={confirmOverwrite}
          title="Target skill already exists"
          variant="danger"
          message={`A skill named "${name}" already exists at the target. Overwrite it with the merged version? This replaces the entire target skill directory.`}
          confirmLabel={merging ? 'Overwriting…' : 'Overwrite'}
          onConfirm={() => merge(true)}
          onCancel={() => setConfirmOverwrite(false)}
        />
      </div>
    </div>
  );
}

/* ─── Source badge ─────────────────────────────────────────────────────── */
const BADGE_LABEL = { pool: 'global', team: 'team', agent: 'agent' };
function SourceBadge({ value: v }) {
  const isPool = v === 'pool';
  const isTeam = v === 'team';
  const color = isPool ? 'var(--eb-accent-primary)'
    : isTeam ? 'var(--eb-status-warning)'
    : 'var(--eb-status-info)';
  const bg = isPool ? 'var(--eb-accent-muted)'
    : isTeam ? 'var(--eb-status-warning-bg)'
    : 'var(--eb-status-info-bg)';
  return (
    <span style={{
      padding: '1px 8px',
      borderRadius: 'var(--eb-radius-sm)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      background: bg,
      color,
      border: `1px solid ${color}`,
    }}>
      {BADGE_LABEL[v] || v}
    </span>
  );
}

function makeColumns(onDeleteRow, select) {
  const cols = [];
  if (select) {
    cols.push({
      key: '_select',
      label: '',
      sortable: false,
      render: (_, row) => {
        const checked = select.isSelected(row);
        return (
          <input
            type="checkbox"
            checked={checked}
            aria-label={`Select ${row.name} for merge`}
            onClick={e => e.stopPropagation()}
            onChange={e => { e.stopPropagation(); select.onToggle(row); }}
            style={{ cursor: 'pointer' }}
          />
        );
      },
    });
  }
  cols.push(
    { key: 'name', label: 'Skill Name' },
    { key: 'source', label: 'Tier', render: v => <SourceBadge value={v} /> },
    { key: '_scope', label: 'Scope', sortable: false, render: (_, row) => {
      const v = row.source === 'agent' ? row.agentId : row.source === 'team' ? row.teamId : null;
      return v
        ? <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span>
        : <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
    } },
    { key: 'version', label: 'Version', sortable: false, render: (_, row) => (
      Number.isInteger(row.version)
        ? <VersionChip version={row.version} contentHash={row.contentHash} />
        : <span style={{ color: 'var(--eb-text-muted)' }}>—</span>
    ) },
    { key: '_prov', label: 'Provenance', sortable: false, render: (_, row) => {
      const chips = <ProvenanceChips row={row} />;
      return chips || <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
    } },
    { key: 'drift', label: 'Drift', sortable: false, render: (v) => (
      v ? <DriftBadge state={v} /> : <span style={{ color: 'var(--eb-text-muted)' }}>—</span>
    ) },
    {
      key: '_del',
      label: '',
      sortable: false,
      render: (_, row) => (row.source === 'pool' || row.source === 'team') ? (
        <IconButton icon={Trash2} label="Delete skill" danger onClick={e => { e.stopPropagation(); onDeleteRow(row); }} size={14} />
      ) : null,
    },
  );
  return cols;
}

/* ─── Main page ────────────────────────────────────────────────────────── */
export default function SkillsRegistry() {
  const { data: allSkills, loading, error, refetch } = useApi('/api/skills');
  const { data: allAgents } = useApi('/api/agents');
  const { data: allTeams } = useApi('/api/admin/teams');
  const [filter, setFilter] = useState('All');
  const [showNewForm, setShowNewForm] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState(null);
  // row-level delete state (separate from the side-panel delete flow)
  const [rowDeleteTarget, setRowDeleteTarget] = useState(null);
  const [rowDeleteError, setRowDeleteError] = useState(null);
  const [rowDeleteBlocking, setRowDeleteBlocking] = useState(null);
  const [rowDeleting, setRowDeleting] = useState(false);
  // import (.zip / .skill upload → pool skill)
  const importFileRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
  const [importTarget, setImportTarget] = useState('global'); // 'global' or 'team:<id>'
  // multi-select → merge (#631): rowKey → row for the selected skills
  const [selectedRows, setSelectedRows] = useState({});
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState(null);

  // The skill detail SidePanel (backdrop z-index 60) hosts the action-panel "?"
  // buttons, so the help panel has to be lifted above it while it is open —
  // same reason as the merge dialog below. Retracted automatically when the
  // panel closes, which hands help back to the page (#1990).
  useHelpSubject({ overlay: OVERLAY_SKILL_DETAIL, active: !!selectedSkill });

  const filteredSkills = (allSkills ?? []).filter(s => {
    if (filter === 'Global') return s.source === 'pool';
    if (filter === 'Team') return s.source === 'team';
    if (filter === 'Agent') return s.source === 'agent';
    return true;
  });

  // The SkillViewer fetches its own file list + content; opening just selects.
  const openSkill = useCallback((row) => {
    setSelectedSkill(row);
  }, []);

  // Deep link (#774 AC5): `?skill=<name>&tier=<pool|team|agent>&team=<id>`
  // preselects the tier filter and opens the named skill's viewer. An optional
  // `&tab=<content|versions|lineage|usage>` (#1143) opens straight on that detail
  // tab — the drift chips in SkillPicker use `tab=lineage`. The param is left on
  // the URL, so a full-page reload of the link restores the same view. A
  // consumed-ref guards against reopening the panel after the user closes it
  // (the URL still carries the param until the next navigation/reload).
  const [searchParams] = useSearchParams();
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current) return;
    const skillName = searchParams.get('skill');
    if (!skillName) { deepLinkConsumed.current = true; return; }
    if (!allSkills) return; // wait until the list has loaded to resolve the copy
    const tier = searchParams.get('tier') || 'pool';
    const team = searchParams.get('team') || undefined;
    const tabParam = searchParams.get('tab');
    const initialTab = VIEWER_TABS.some(t => t.id === tabParam) ? tabParam : undefined;
    const source = TIER_TO_SOURCE[tier] || 'pool';
    if (TIER_TO_FILTER[tier]) setFilter(TIER_TO_FILTER[tier]);
    // Prefer the real row from the loaded list (carries teamId/agentId), else a
    // minimal row the viewer can still fetch content for.
    const match = (allSkills || []).find(s =>
      s.name === skillName && s.source === source &&
      (source !== 'team' || !team || s.teamId === team));
    setSelectedSkill({
      ...(match || {
        name: skillName, source,
        ...(source === 'team' && team ? { teamId: team } : {}),
      }),
      ...(initialTab ? { initialTab } : {}),
    });
    deepLinkConsumed.current = true;
  }, [allSkills, searchParams]);

  const toggleRow = useCallback((row) => {
    const key = skillRowKey(row);
    setSelectedRows(prev => {
      const next = { ...prev };
      if (next[key]) delete next[key]; else next[key] = row;
      return next;
    });
  }, []);
  const isRowSelected = useCallback((row) => !!selectedRows[skillRowKey(row)], [selectedRows]);
  const selectedList = Object.values(selectedRows);

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
      if (importTarget.startsWith('team:')) {
        formData.append('tier', 'team');
        formData.append('teamId', importTarget.slice('team:'.length));
      } else {
        formData.append('tier', 'global');
      }
      const resp = await fetch('/api/skills/import', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const where = data.source === 'team' ? `team '${data.teamId}'` : 'the global pool';
      setImportSuccess(`Skill '${data.name}' imported into ${where}.`);
      refetch?.();
      openSkill(data.source === 'team'
        ? { name: data.name, source: 'team', teamId: data.teamId }
        : { name: data.name, source: 'pool' });
    } catch (e) {
      setImportError(e.message);
    } finally {
      setImporting(false);
    }
  }

  // Only materialized, enabled agents can receive a skill in-place (a stub has
  // no workspace yet and would be re-seeded from its environment on enable).
  const installableAgents = (allAgents ?? [])
    .filter(a => a.enabled !== false && a.token && a.role !== 'team' && a.role !== 'orchestrator')
    .map(a => ({ id: a.id, displayName: a.displayName || a.id }));

  async function confirmRowDelete(cascade = false) {
    if (!rowDeleteTarget) return;
    setRowDeleting(true);
    setRowDeleteError(null);
    try {
      const params = new URLSearchParams({ source: rowDeleteTarget.source });
      if (rowDeleteTarget.teamId) params.set('teamId', rowDeleteTarget.teamId);
      if (cascade) params.set('cascade', 'true');
      const res = await fetch(`/api/skills/${encodeURIComponent(rowDeleteTarget.name)}?${params}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.agents) {
          setRowDeleteBlocking(data.agents);
          setRowDeleteError(`Skill is in use by: ${data.agents.join(', ')}`);
          setRowDeleting(false);
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (selectedSkill?.name === rowDeleteTarget.name && selectedSkill?.source === 'pool') {
        setSelectedSkill(null);
      }
      setRowDeleteTarget(null);
      setRowDeleteBlocking(null);
      refetch?.();
    } catch (e) {
      setRowDeleteError(e.message);
    } finally {
      setRowDeleting(false);
    }
  }

  function handleMerged(data) {
    setMergeOpen(false);
    setSelectedRows({});
    setMergeSuccess(`Merged into "${data.name}"${data.retiredSources ? ` (${(data.sources || []).length} source(s) retired)` : ''}.`);
    refetch?.();
    openSkill(data.target?.tier === 'team'
      ? { name: data.name, source: 'team', teamId: data.target.teamId }
      : { name: data.name, source: 'pool' });
  }

  const columns = makeColumns(
    row => { setRowDeleteError(null); setRowDeleteTarget(row); },
    { isSelected: isRowSelected, onToggle: toggleRow },
  );

  if (loading) {
    return <div aria-busy="true" style={{ height: 300, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }

  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load skills: {error}</div>;
  }

  const headerAction = usePageActions(
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <input
            ref={importFileRef}
            type="file"
            accept=".zip,.skill,application/zip,application/octet-stream"
            onChange={handleImport}
            style={{ display: 'none' }}
          />
          <select
            value={importTarget}
            onChange={e => setImportTarget(e.target.value)}
            disabled={importing}
            title="Where to import the skill — the global pool (System Admin) or a team pool (Team Admin)"
            style={{
              padding: '6px 10px',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
            }}
          >
            <option value="global">Import to: Global pool</option>
            {(allTeams ?? []).map(t => (
              <option key={t.id} value={`team:${t.id}`}>Import to: Team {t.name} ({t.id})</option>
            ))}
          </select>
          <button
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
            style={secondaryBtnStyle}
            title="Upload a skill packaged as a .zip or .skill archive and add it to the selected pool"
          >
            {importing ? 'Importing…' : 'Import skill'}
          </button>
          <button onClick={() => setShowNewForm(f => !f)} style={primaryBtnStyle(false)}>
            {showNewForm ? 'Cancel' : '+ New Skill'}
          </button>
          {/* The page's own "?" (#1990). The #1847 header unification left this
              slot as the page's only header, so this is also where the
              page-level affordance E4 added went when the on-page <h1> was
              removed; it deep-links to the action chapter, which is what
              documents Import / Export. */}
          <PageHelpButton
            label="How importing and exporting skills works"
            size={16}
            section={SKILLS_HELP_SECTIONS.actions}
          />
        </div>
  );

  return (
    <>
      {headerAction}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

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
            Create skill
          </h2>
          <NewSkillForm onCreated={handleCreated} onCancel={() => setShowNewForm(false)} teams={allTeams ?? []} />
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
        {/* The filter strip IS the tier vocabulary, so its "?" explains the three
            tiers and the own-team-pool-first resolution order (#1990). */}
        <PageHelpButton
          label="What Global, Team and Agent mean"
          size={14}
          style={{ padding: 0, marginLeft: 'var(--eb-space-1)' }}
          section={SKILLS_HELP_SECTIONS.tiers}
        />
      </div>

      {/* Merge success feedback */}
      {mergeSuccess && (
        <div role="status" style={{ color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)' }}>
          {mergeSuccess}
        </div>
      )}

      {/* Multi-select merge action bar (#631) — checkboxes in the table drive this */}
      {selectedList.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexWrap: 'wrap',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-accent-muted)', border: '1px solid var(--eb-accent-primary)',
          borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)',
        }}>
          <span style={{ color: 'var(--eb-text-primary)' }}>
            {selectedList.length} skill{selectedList.length === 1 ? '' : 's'} selected
          </span>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginLeft: 'auto' }}>
            <button onClick={() => setSelectedRows({})} style={secondaryBtnStyle}>Clear</button>
            <button
              onClick={() => { setMergeSuccess(null); setMergeOpen(true); }}
              disabled={selectedList.length < 2}
              style={primaryBtnStyle(selectedList.length < 2)}
              title={selectedList.length < 2 ? 'Select at least two skills to merge' : 'Merge the selected skills into one'}
            >
              Merge selected
            </button>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        data={filteredSkills}
        onRowClick={openSkill}
        emptyText="No skills yet. Use “+ New Skill” to create one, “Import skill” to load an existing bundle, or promote lessons from the Knowledge page."
        getRowKey={row => `${row.source}:${row.agentId ?? ''}:${row.teamId ?? ''}:${row.name}`}
      />

      {mergeOpen && (
        <MergeSkillsDialog
          sources={selectedList.map(rowToMergeSource)}
          teams={allTeams ?? []}
          onClose={() => setMergeOpen(false)}
          onMerged={handleMerged}
        />
      )}

      <SidePanel
        open={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        title={selectedSkill ? `${selectedSkill.name} (${selectedSkill.source === 'pool' ? 'global' : selectedSkill.source}${selectedSkill.teamId ? `: ${selectedSkill.teamId}` : ''})` : ''}
        width="560px"
      >
        {selectedSkill && (
          <SkillViewer
            key={`${selectedSkill.source}:${selectedSkill.agentId ?? ''}:${selectedSkill.teamId ?? ''}:${selectedSkill.name}`}
            skill={selectedSkill}
            onDeleted={handleDeleted}
            onPromoted={handlePromoted}
            onOpenCopy={openSkill}
            installableAgents={installableAgents}
            agentSkills={allSkills ?? []}
            teams={allTeams ?? []}
          />
        )}
      </SidePanel>

      {/* Row-level delete confirmation */}
      <ConfirmDialog
        open={!!rowDeleteTarget}
        title="Delete skill"
        variant="danger"
        message={
          rowDeleteBlocking ? (
            <span>
              <strong>{rowDeleteTarget?.name}</strong> still resolves to this tier for: {rowDeleteBlocking.join(', ')}.
              <br />Deactivate those grants and delete anyway? A restorable snapshot is archived first.
            </span>
          ) : rowDeleteError ? (
            <span><strong>Cannot delete:</strong> {rowDeleteError}</span>
          ) : (
            `Delete "${rowDeleteTarget?.name}"? A restorable snapshot is archived, then the skill is removed.`
          )
        }
        confirmLabel={
          rowDeleteBlocking ? (rowDeleting ? 'Deactivating…' : 'Deactivate grants & delete')
            : rowDeleteError ? undefined
            : (rowDeleting ? 'Deleting…' : 'Delete')
        }
        alertOnly={!!rowDeleteError && !rowDeleteBlocking}
        onConfirm={
          rowDeleteBlocking ? () => confirmRowDelete(true)
            : rowDeleteError ? () => { setRowDeleteTarget(null); setRowDeleteError(null); }
            : () => confirmRowDelete(false)
        }
        onCancel={() => { setRowDeleteTarget(null); setRowDeleteError(null); setRowDeleteBlocking(null); }}
      />
    </div>
    </>
  );
}
