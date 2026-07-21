import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutTemplate, Blocks, PencilRuler, AlertCircle, AlertTriangle, Info,
  CheckCircle, Loader2, ArrowUp, ArrowDown, X, Plus, Save, Workflow, Sparkles,
} from 'lucide-react';
import { useApi, apiCall } from '../../hooks/useApi';
import { computePreviewLayout, ellipsize, PREVIEW } from './flow-preview-layout';

// ─── Wizard "Process" step (#422) ────────────────────────────────────────────
// Replaces the flat role-checkbox Members step in create mode. Three entries:
//   • Use a template  — gallery of curated process templates (#419) + drafts
//   • Compose         — stage columns with pattern slots, wired live by the
//                       Flow-Weaver (#421); gap rules are explained inline
//   • Blank canvas    — creates an empty draft and jumps to the Flows editor
// Whatever the entry, the result is one processTemplate bundle on the form,
// previewed as a mini flow + lint badges, and fed to POST /api/teams(/stream).

const cardStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  padding: 'var(--eb-space-5)',
};

const labelStyle = {
  display: 'block',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 'var(--eb-space-2)',
};

const hintStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  lineHeight: 1.5,
};

const selectStyle = {
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

const tinyButtonStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '2px 6px',
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)',
  color: 'var(--eb-text-secondary)',
  fontSize: 'var(--eb-text-xs)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

// Default composer skeleton: the Core-SDLC loop, ready to be extended.
export function defaultComposerStages() {
  return [
    { name: 'Requirements', scout: null, author: null, companion: null, extras: ['business-analyst', 'issue-triage'], gateAtExit: true },
    { name: 'Build', scout: null, author: 'developer', companion: 'code-reviewer', extras: [], gateAtExit: true },
  ];
}

// The role selection a composer stage sends to the weaver, in slot order.
function stageRoleIds(stage) {
  return [stage.scout, stage.author, stage.companion, ...(stage.extras || [])].filter(Boolean);
}

export function composerToWeaveRequest(name, composerStages) {
  return {
    name,
    stages: composerStages.map(s => ({
      name: s.name,
      roles: [
        ...stageRoleIds(s).map(id => ({ templateId: id })),
        // Custom roles (#423) travel inline — the weaver treats them exactly
        // like catalog roles once their pattern ports are confirmed.
        ...(s.customRoles || []).map(r => ({ ...r, inline: true })),
      ],
    })),
    options: {
      humanGates: Object.fromEntries(composerStages.filter(s => s.gateAtExit === false).map(s => [s.name, false])),
    },
  };
}

// ─── Mini flow preview ──────────────────────────────────────────────────────
// A light, read-only SVG projection of the bundle: stage columns, role boxes,
// and the hand-off edges (GitHub channels + label hand-offs). Deliberately not
// the full canvas renderer — this is a "does the flow hang together" glance.
// All geometry (lanes, label staggering, corridor clamping, #427) lives in
// flow-preview-layout.js.

// Halo behind edge labels so they stay readable when crossing a line.
const labelHaloStyle = {
  paintOrder: 'stroke',
  stroke: 'var(--eb-bg-elevated)',
  strokeWidth: 3,
  strokeLinejoin: 'round',
};

function PreviewEdge({ edge }) {
  const color = edge.gate ? 'var(--eb-status-error)' : 'var(--eb-text-muted)';
  return (
    <g>
      <path d={edge.d} fill="none" stroke={color} strokeWidth={1.2}
        strokeDasharray={edge.gate ? '4 3' : undefined}
        markerEnd={`url(#${edge.gate ? 'proc-arrow-gate' : 'proc-arrow'})`} opacity={0.85} />
      <text x={edge.labelX} y={edge.labelY} textAnchor="middle"
        style={{ fontSize: 9.5, fill: color, ...labelHaloStyle }}>
        {edge.labelText}
      </text>
    </g>
  );
}

export function BundleFlowPreview({ bundle }) {
  const layout = useMemo(() => computePreviewLayout(bundle), [bundle]);

  if (!layout) return null;
  const { NODE_W, COL_W, NODE_H, PAD } = PREVIEW;
  const { stages, nodes, forward, back, width, height } = layout;

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-elevated)' }}>
      <svg width={width} height={height} style={{ display: 'block', minWidth: '100%' }}>
        <defs>
          <marker id="proc-arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--eb-text-muted)" />
          </marker>
          <marker id="proc-arrow-gate" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--eb-status-error)" />
          </marker>
        </defs>
        {stages.map((s, i) => (
          <text key={`st-${i}`} x={PAD + i * COL_W + NODE_W / 2} y={PAD + 12} textAnchor="middle"
            style={{ fontSize: 11, fontWeight: 600, fill: 'var(--eb-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {s || '—'}
          </text>
        ))}
        {forward.map((e, i) => <PreviewEdge key={`f-${i}`} edge={e} />)}
        {back.map((e, i) => <PreviewEdge key={`b-${i}`} edge={e} />)}
        {nodes.map(({ role, x, y }) => (
          <g key={role.id}>
            <title>{role.displayName && role.displayName !== role.id ? `${role.displayName} (${role.id})` : role.id}</title>
            <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={7}
              fill="var(--eb-bg-surface)" stroke="var(--eb-border-default)" strokeWidth={1} />
            <text x={x + NODE_W / 2} y={y + 17} textAnchor="middle"
              style={{ fontSize: 10.5, fontWeight: 600, fill: 'var(--eb-text-primary)' }}>
              {ellipsize(role.displayName || role.id, 26)}
            </text>
            <text x={x + NODE_W / 2} y={y + 31} textAnchor="middle"
              style={{ fontSize: 9, fill: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
              {ellipsize(role.id, 29)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ─── Lint + weaver-note panels ──────────────────────────────────────────────

export function LintBadges({ lints, loading }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...hintStyle }}>
        <Loader2 size={12} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} /> Checking wiring…
      </div>
    );
  }
  const list = Array.isArray(lints) ? lints : [];
  const errors = list.filter(l => l.severity === 'error');
  const warnings = list.filter(l => l.severity === 'warning');
  const infos = list.filter(l => l.severity === 'info');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {errors.length === 0 && warnings.length === 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)' }}>
            <CheckCircle size={12} /> Wiring is clean
          </span>
        )}
        {errors.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
            <AlertCircle size={12} /> {errors.length} error{errors.length > 1 ? 's' : ''}
          </span>
        )}
        {warnings.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>
            <AlertTriangle size={12} /> {warnings.length} warning{warnings.length > 1 ? 's' : ''}
          </span>
        )}
        {infos.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            <Info size={12} /> {infos.length} info
          </span>
        )}
      </div>
      {(errors.length > 0 || warnings.length > 0) && (
        <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {[...errors, ...warnings].map((l, i) => (
            <li key={i} style={{ fontSize: 'var(--eb-text-xs)', color: l.severity === 'error' ? 'var(--eb-status-error)' : 'var(--eb-status-warning)' }}>
              {l.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WeaverNotes({ notes }) {
  if (!Array.isArray(notes) || notes.length === 0) return null;
  return (
    <div style={{
      padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
      border: '1px dashed var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
    }}>
      <div style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 600, color: 'var(--eb-text-secondary)', marginBottom: 4 }}>
        Auto-compensations by the Flow-Weaver
      </div>
      <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {notes.map((n, i) => (
          <li key={i} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{n.message}</li>
        ))}
      </ul>
    </div>
  );
}

// Role list grouped by stage — reused by the Review step.
export function BundleRolesSummary({ bundle, teamId }) {
  if (!bundle || !Array.isArray(bundle.roles)) return null;
  const stages = Array.isArray(bundle.stages) && bundle.stages.length ? bundle.stages : [null];
  const groups = stages.map(s => ({ stage: s, roles: bundle.roles.filter(r => (s === null ? true : r.stage === s)) }));
  const unstaged = bundle.roles.filter(r => !stages.includes(r.stage));
  if (stages[0] !== null && unstaged.length) groups.push({ stage: '—', roles: unstaged });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      {groups.filter(g => g.roles.length).map(g => (
        <div key={g.stage || 'all'}>
          {g.stage !== null && (
            <div style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--eb-text-muted)', marginBottom: 4 }}>
              {g.stage}
            </div>
          )}
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
            {g.roles.map(r => (
              <li key={r.id}>
                <strong style={{ color: 'var(--eb-text-primary)' }}>{r.displayName || r.id}</strong>
                {teamId && <> — <code>{teamId}-{r.id}</code></>}
                {r.sessionPolicy === 'per-invocation' && <span style={{ color: 'var(--eb-text-muted)' }}> · per-invocation</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ─── Custom role dialog (#423) ──────────────────────────────────────────────
// Name + notes → LLM-drafted prompt (existing endpoint) + suggested wiring
// (patternRole / sessionPolicy / produce flags). Suggestions land in editable
// fields the user confirms — nothing is applied silently.

function slugifyRole(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom-role';
}

const PATTERN_ROLE_COPY = {
  scout: 'Scout — prepares incoming work (readiness + evidence)',
  author: 'Author — produces the stage\'s work product, opens PRs',
  companion: 'Companion — reviews, routes feedback, brokers escalations',
  intake: 'Intake — turns human requests into refined issues',
  standalone: 'Standalone — reacts to external events on its own',
};

function CustomRoleDialog({ stageName, onAdd, onClose }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [patternRole, setPatternRole] = useState('standalone');
  const [sessionPolicy, setSessionPolicy] = useState('per-invocation');
  const [producesPr, setProducesPr] = useState(false);
  const [producesIssue, setProducesIssue] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestSource, setSuggestSource] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState(null);

  async function suggestPorts() {
    if (!name.trim()) { setErr('Give the role a name first'); return; }
    setSuggesting(true); setErr(null);
    try {
      const { suggestion, source } = await apiCall('POST', '/api/agent-ports/suggest', {
        roleName: name.trim(), notes: notes.trim(), stageName,
      });
      setPatternRole(suggestion.patternRole);
      setSessionPolicy(suggestion.sessionPolicy);
      setProducesPr(!!suggestion.ports?.produces?.pr);
      setProducesIssue(!!suggestion.ports?.produces?.issue);
      setSuggestSource(source);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setSuggesting(false);
    }
  }

  async function generatePrompt() {
    if (!name.trim()) { setErr('Give the role a name first'); return; }
    setGenerating(true); setErr(null);
    try {
      const { prompt: p } = await apiCall('POST', '/api/agent-prompt/generate', {
        roleName: name.trim(), notes: notes.trim(),
      });
      setPrompt(p);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setGenerating(false);
    }
  }

  function add() {
    if (!name.trim()) { setErr('Role name required'); return; }
    onAdd({
      id: slugifyRole(name),
      displayName: name.trim(),
      sessionPolicy,
      patternRole,
      github: (producesPr || producesIssue)
        ? { ...(producesPr ? { producesPr: true } : {}), ...(producesIssue ? { producesIssue: true } : {}) }
        : undefined,
      systemPrompt: prompt.trim(),
      triggers: [],
    });
  }

  const fieldRow = { display: 'flex', flexDirection: 'column', gap: 4 };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--eb-space-5)',
    }} onClick={onClose}>
      <div style={{ ...cardStyle, width: 560, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>
            Custom agent — {stageName}
          </div>
          <button type="button" style={tinyButtonStyle} onClick={onClose}><X size={12} /></button>
        </div>

        <div style={fieldRow}>
          <label style={labelStyle}>Agent name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. JCL Migration Engineer" style={selectStyle} autoFocus />
        </div>
        <div style={fieldRow}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...selectStyle, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="Keywords for what this agent should do" />
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={tinyButtonStyle} onClick={suggestPorts} disabled={suggesting}>
            {suggesting ? <Loader2 size={11} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} /> : <Sparkles size={11} />}
            Suggest wiring
          </button>
          <button type="button" style={tinyButtonStyle} onClick={generatePrompt} disabled={generating}>
            {generating ? <Loader2 size={11} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} /> : <Sparkles size={11} />}
            Generate agent prompt
          </button>
          {suggestSource && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              wiring suggested by {suggestSource === 'llm' ? 'LLM' : 'heuristic'} — review below
            </span>
          )}
        </div>

        <div style={fieldRow}>
          <label style={labelStyle}>Pattern role (drives the wiring)</label>
          <select value={patternRole} onChange={e => setPatternRole(e.target.value)} style={selectStyle}>
            {Object.entries(PATTERN_ROLE_COPY).map(([v, copy]) => <option key={v} value={v}>{copy}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--eb-space-3)' }}>
          <div style={fieldRow}>
            <label style={labelStyle}>Session policy</label>
            <select value={sessionPolicy} onChange={e => setSessionPolicy(e.target.value)} style={selectStyle}>
              <option value="per-invocation">per-invocation (reactive)</option>
              <option value="persistent">persistent (chat context)</option>
            </select>
          </div>
          <div style={fieldRow}>
            <label style={labelStyle}>Opens on GitHub</label>
            <div style={{ display: 'flex', gap: 'var(--eb-space-3)', alignItems: 'center', minHeight: 34 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                <input type="checkbox" checked={producesPr} onChange={() => setProducesPr(v => !v)} /> PRs
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                <input type="checkbox" checked={producesIssue} onChange={() => setProducesIssue(v => !v)} /> Issues
              </label>
            </div>
          </div>
        </div>
        <div style={fieldRow}>
          <label style={labelStyle}>Agent prompt</label>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={7} style={{ ...selectStyle, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="You are the … (or use Generate agent prompt above)" />
        </div>

        {err && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{err}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button type="button" style={tinyButtonStyle} onClick={onClose}>Cancel</button>
          <button type="button" onClick={add} style={{
            ...tinyButtonStyle, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', padding: 'var(--eb-space-2) var(--eb-space-3)',
          }}>
            <Plus size={12} /> Add agent
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Entry cards ────────────────────────────────────────────────────────────

function EntryCard({ icon: Icon, title, copy, onClick, disabled, badge }) {
  return (
    <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled} style={{
      ...cardStyle, textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
      opacity: disabled ? 0.55 : 1,
    }}>
      <Icon size={20} style={{ color: disabled ? 'var(--eb-text-muted)' : 'var(--eb-accent-primary)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>{title}</span>
        {badge && (
          <span style={{
            fontSize: 'var(--eb-text-xs)', fontWeight: 600, color: 'var(--eb-text-muted)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-sm)', padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>{badge}</span>
        )}
      </div>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>{copy}</div>
    </button>
  );
}

// ─── The step ───────────────────────────────────────────────────────────────

const SPIN_KEYFRAMES = <style>{'@keyframes team-setup-spin { to { transform: rotate(360deg); } }'}</style>;

export default function StepProcess({ form, setForm, templates, error }) {
  const navigate = useNavigate();
  const { data: registry } = useApi('/api/process-templates');
  const { data: drafts } = useApi('/api/process/drafts');
  const [weaving, setWeaving] = useState(false);
  const [weaveError, setWeaveError] = useState(null);
  const [lints, setLints] = useState(null);
  const [lintLoading, setLintLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [customRoleStage, setCustomRoleStage] = useState(null); // stage index with an open dialog
  const debounceRef = useRef(null);
  const lintSeq = useRef(0);

  const catalog = templates || [];
  const byPattern = (p) => catalog.filter(t => t.patternRole === p);
  const extraCandidates = catalog.filter(t => (t.patternRole === 'intake' || t.patternRole === 'standalone') && t.category !== 'pattern');

  const setBundle = (bundle, notes, mode, templateId) => {
    setForm(f => ({
      ...f,
      processMode: mode,
      processTemplateId: templateId ?? f.processTemplateId,
      processBundle: bundle,
      weaveNotes: notes || [],
      processLints: null,
    }));
  };

  // Authoritative lint check for whatever bundle is currently selected/woven.
  useEffect(() => {
    const bundle = form.processBundle;
    if (!bundle) { setLints(null); return; }
    const seq = ++lintSeq.current;
    setLintLoading(true);
    apiCall('POST', '/api/flows/graph', { processTemplate: bundle })
      .then(g => {
        if (seq !== lintSeq.current) return;
        setLints(g.lints || []);
        setForm(f => ({ ...f, processLints: g.lints || [] }));
      })
      .catch(() => { if (seq === lintSeq.current) setLints([]); })
      .finally(() => { if (seq === lintSeq.current) setLintLoading(false); });
  }, [form.processBundle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live weave (debounced) while composing.
  useEffect(() => {
    if (form.processMode !== 'compose') return;
    const stages = form.composerStages || [];
    if (stages.every(s => stageRoleIds(s).length === 0 && (s.customRoles || []).length === 0)) {
      setBundle(null, [], 'compose');
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setWeaving(true);
      setWeaveError(null);
      try {
        // With Process as step 1 the team name is usually not set yet — the
        // wizard overwrites the bundle name with the team name at submit (#428).
        const req = composerToWeaveRequest(form.teamName?.trim() || 'Team process', stages);
        const { bundle, notes } = await apiCall('POST', '/api/process/weave', req);
        setBundle(bundle, notes, 'compose');
      } catch (err) {
        setWeaveError(err.message || String(err));
      } finally {
        setWeaving(false);
      }
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [form.processMode, JSON.stringify(form.composerStages), form.teamName]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickTemplate(entry) {
    try {
      const bundle = entry.kind === 'draft'
        ? await apiCall('GET', `/api/process/drafts/${encodeURIComponent(entry.id)}`)
        : await apiCall('GET', `/api/process-templates/${encodeURIComponent(entry.id)}`);
      setBundle(bundle, [], 'template', `${entry.kind}:${entry.id}`);
    } catch (err) {
      setWeaveError(err.message || String(err));
    }
  }

  async function saveAsDraft() {
    if (!form.processBundle) return;
    setSavingDraft(true);
    try {
      const d = await apiCall('POST', '/api/process/drafts', {
        name: `${form.teamName?.trim() || form.processBundle.name || 'Process'}`,
        processTemplate: form.processBundle,
      });
      navigate(`/flows?proc=${encodeURIComponent(`draft:${d.id}`)}`);
    } catch (err) {
      setWeaveError(err.message || String(err));
      setSavingDraft(false);
    }
  }

  async function startBlank() {
    try {
      const d = await apiCall('POST', '/api/process/drafts', { name: form.teamName?.trim() || 'New process' });
      navigate(`/flows?proc=${encodeURIComponent(`draft:${d.id}`)}`);
    } catch (err) {
      setWeaveError(err.message || String(err));
    }
  }

  const setStages = (fn) => setForm(f => ({
    ...f,
    composerStages: typeof fn === 'function' ? fn(f.composerStages || []) : fn,
  }));

  // ── entry selection ──
  if (!form.processMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {SPIN_KEYFRAMES}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--eb-space-3)' }}>
          <EntryCard icon={LayoutTemplate} title="Use a template"
            copy="Start from a curated process (Core SDLC, Extended SDLC, …) or one of your saved drafts. One click, ready to review."
            onClick={() => setForm(f => ({ ...f, processMode: 'template' }))} />
          <EntryCard icon={Blocks} title="Compose a process" disabled badge="Coming soon"
            copy="Define stages and pick 1–3 agents per stage from the catalog. The Flow-Weaver wires hand-offs, human gates and escalation loops for you." />
          <EntryCard icon={PencilRuler} title="Start blank in the canvas"
            copy="Open an empty draft in the Flows editor and design the process free-form. Materialise it into a team later."
            onClick={startBlank} />
        </div>
        {weaveError && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{weaveError}</div>}
        {error && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</div>}
      </div>
    );
  }

  const backToEntry = (
    <button type="button" style={tinyButtonStyle}
      onClick={() => setForm(f => ({ ...f, processMode: null, processBundle: null, processTemplateId: null, weaveNotes: [], processLints: null }))}>
      <X size={11} /> Choose a different entry
    </button>
  );

  // ── template gallery ──
  if (form.processMode === 'template') {
    const gallery = [
      ...((registry?.templates) || []).map(t => ({ ...t, kind: 'registry' })),
      ...((Array.isArray(drafts) ? drafts : []) || []).map(d => ({
        id: d.id, name: d.name, description: 'Saved draft from the Flows editor.',
        roleCount: d.roleCount, stages: [], kind: 'draft',
      })),
    ];
    return (
      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {SPIN_KEYFRAMES}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={labelStyle}>Pick a process template</div>
          {backToEntry}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 'var(--eb-space-3)' }}>
          {gallery.map(t => {
            const selected = form.processTemplateId === `${t.kind === 'draft' ? 'draft' : 'registry'}:${t.id}`;
            return (
              <button key={`${t.kind}:${t.id}`} type="button" onClick={() => pickTemplate({ id: t.id, kind: t.kind === 'draft' ? 'draft' : 'registry' })}
                style={{
                  ...cardStyle, padding: 'var(--eb-space-4)', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                  display: 'flex', flexDirection: 'column', alignItems: 'stretch',
                  border: `1px solid ${selected ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 'var(--eb-text-md)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>{t.name}</div>
                  <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', whiteSpace: 'nowrap' }}>
                    {t.kind === 'draft' ? 'Draft' : `${t.roleCount} agents`}
                  </span>
                </div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>{t.description}</div>
                {t.stages?.length > 0 && (
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 6, fontFamily: 'var(--eb-font-mono)' }}>
                    {t.stages.join(' → ')}
                  </div>
                )}
              </button>
            );
          })}
          {gallery.length === 0 && <div style={hintStyle}>No process templates found — is the pool seeded (`make seed-process-templates`)?</div>}
        </div>
        {form.processBundle && (
          <PreviewBlock form={form} lints={lints} lintLoading={lintLoading} onSaveDraft={saveAsDraft} savingDraft={savingDraft} />
        )}
        {weaveError && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{weaveError}</div>}
        {error && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</div>}
      </div>
    );
  }

  // ── composer ──
  const stages = form.composerStages || [];
  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {SPIN_KEYFRAMES}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={labelStyle}>Compose your process</div>
          <div style={hintStyle}>
            Per stage: an <strong>Author</strong> produces the work product; a <strong>Scout</strong> prepares it; a <strong>Companion</strong> reviews,
            routes feedback and brokers escalations. Leave a slot empty — the weaver merges its duties into the Author and tells you below.
          </div>
        </div>
        {backToEntry}
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-3)', overflowX: 'auto', paddingBottom: 4 }}>
        {stages.map((s, i) => (
          <div key={i} style={{
            flex: '0 0 240px', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input value={s.name}
                onChange={e => setStages(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                style={{ ...selectStyle, fontWeight: 600, flex: 1 }} />
              <button type="button" title="Move left" style={tinyButtonStyle} disabled={i === 0}
                onClick={() => setStages(prev => { const c = [...prev]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}>
                <ArrowUp size={11} style={{ transform: 'rotate(-90deg)' }} />
              </button>
              <button type="button" title="Move right" style={tinyButtonStyle} disabled={i === stages.length - 1}
                onClick={() => setStages(prev => { const c = [...prev]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}>
                <ArrowDown size={11} style={{ transform: 'rotate(-90deg)' }} />
              </button>
              <button type="button" title="Remove stage" style={tinyButtonStyle}
                onClick={() => setStages(prev => prev.filter((_, j) => j !== i))}>
                <X size={11} />
              </button>
            </div>

            {[['scout', 'Scout'], ['author', 'Author'], ['companion', 'Companion']].map(([slot, label]) => (
              <div key={slot}>
                <div style={{ ...hintStyle, marginBottom: 2 }}>{label}</div>
                <select value={s[slot] || ''} style={selectStyle}
                  onChange={e => setStages(prev => prev.map((x, j) => j === i ? { ...x, [slot]: e.target.value || null } : x))}>
                  <option value="">(none)</option>
                  {byPattern(slot === 'scout' ? 'scout' : slot === 'author' ? 'author' : 'companion').map(t => (
                    <option key={t.id} value={t.id}>{t.displayName}</option>
                  ))}
                </select>
              </div>
            ))}

            <div>
              <div style={{ ...hintStyle, marginBottom: 2 }}>Additional agents</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {extraCandidates.map(t => {
                  const checked = (s.extras || []).includes(t.id);
                  return (
                    <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked}
                        onChange={() => setStages(prev => prev.map((x, j) => j === i
                          ? { ...x, extras: checked ? (x.extras || []).filter(id => id !== t.id) : [...(x.extras || []), t.id] }
                          : x))} />
                      {t.displayName}
                    </label>
                  );
                })}
              </div>
            </div>

            {(s.customRoles || []).length > 0 && (
              <div>
                <div style={{ ...hintStyle, marginBottom: 2 }}>Custom agents</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {(s.customRoles || []).map((r, k) => (
                    <div key={`${r.id}-${k}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                      <Sparkles size={10} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{r.displayName} <span style={{ color: 'var(--eb-text-muted)' }}>({r.patternRole})</span></span>
                      <button type="button" title="Remove" style={{ ...tinyButtonStyle, padding: '0 4px' }}
                        onClick={() => setStages(prev => prev.map((x, j) => j === i
                          ? { ...x, customRoles: (x.customRoles || []).filter((_, m) => m !== k) }
                          : x))}>
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button type="button" style={{ ...tinyButtonStyle, alignSelf: 'flex-start' }}
              onClick={() => setCustomRoleStage(i)}>
              <Plus size={11} /> Custom agent
            </button>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', cursor: 'pointer', marginTop: 2 }}>
              <input type="checkbox" checked={s.gateAtExit !== false}
                onChange={() => setStages(prev => prev.map((x, j) => j === i ? { ...x, gateAtExit: x.gateAtExit === false } : x))} />
              Human gate at stage exit
            </label>
          </div>
        ))}
        <button type="button" style={{ ...tinyButtonStyle, flex: '0 0 auto', alignSelf: 'flex-start', padding: 'var(--eb-space-3)' }}
          onClick={() => setStages(prev => [...prev, { name: `Stage ${prev.length + 1}`, scout: null, author: null, companion: null, extras: [], gateAtExit: true }])}>
          <Plus size={12} /> Add stage
        </button>
      </div>

      {weaving && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...hintStyle }}>
          <Loader2 size={12} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} /> Weaving the flow…
        </div>
      )}
      {weaveError && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{weaveError}</div>}

      {form.processBundle && !weaving && (
        <PreviewBlock form={form} lints={lints} lintLoading={lintLoading} onSaveDraft={saveAsDraft} savingDraft={savingDraft} />
      )}
      {error && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</div>}

      {customRoleStage !== null && stages[customRoleStage] && (
        <CustomRoleDialog
          stageName={stages[customRoleStage].name}
          onClose={() => setCustomRoleStage(null)}
          onAdd={(role) => {
            setStages(prev => prev.map((x, j) => j === customRoleStage
              ? { ...x, customRoles: [...(x.customRoles || []), role] }
              : x));
            setCustomRoleStage(null);
          }}
        />
      )}
    </div>
  );
}

function PreviewBlock({ form, lints, lintLoading, onSaveDraft, savingDraft }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>
          <Workflow size={14} /> Flow preview — {form.processBundle.roles.length} agents
        </div>
        <button type="button" onClick={onSaveDraft} disabled={savingDraft} style={tinyButtonStyle}>
          {savingDraft ? <Loader2 size={11} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} /> : <Save size={11} />}
          Save as draft &amp; open in canvas
        </button>
      </div>
      <BundleFlowPreview bundle={form.processBundle} />
      <LintBadges lints={lints} loading={lintLoading} />
      <WeaverNotes notes={form.weaveNotes} />
    </div>
  );
}
