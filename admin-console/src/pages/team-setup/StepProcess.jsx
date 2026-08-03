import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, Link } from 'react-router';
import {
  LayoutTemplate, PencilRuler, AlertCircle, AlertTriangle, Info,
  CheckCircle, Loader2, X, Save, Workflow, Sparkles,
} from 'lucide-react';
import { useApi, apiCall } from '../../hooks/useApi';
import { assistHeaders, notifyAssistError } from '../../context/assist-transport.js';
import { computePreviewLayout, previewEdgesFromGraph, ellipsize, PREVIEW } from './flow-preview-layout';
import { EDGE_STYLES } from '../process/flow-graph-render';
import { copilotErrorInfo, consumeCopilotStream, phaseLabel } from '../process/flow-copilot-view';

// ─── Wizard "Process" step (#422) ────────────────────────────────────────────
// Replaces the flat role-checkbox Members step in create mode. Three entries:
//   • Use a template  — gallery of curated process templates (#419) + drafts
//   • Describe        — plain-language description → the Flow Copilot endpoint
//                       (#1070; same POST /api/process/copilot as the editor
//                       panel — no second LLM/grounding path)
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

// Edge colours/dash come from the canvas' shared EDGE_STYLES (#1009) so the
// preview and the Flows view can never diverge in edge naming or styling; a
// server edge without a style key falls back to the old gate/muted pair.
function edgeStyleOf(edge) {
  const st = edge.styleKey ? EDGE_STYLES[edge.styleKey] : null;
  if (st) return { color: st.color, dashed: !!st.dashed };
  return { color: edge.gate ? 'var(--eb-status-error)' : 'var(--eb-text-muted)', dashed: !!edge.gate };
}

function PreviewEdge({ edge }) {
  const { color, dashed } = edgeStyleOf(edge);
  return (
    <g>
      <path d={edge.d} fill="none" stroke={color} strokeWidth={1.2}
        strokeDasharray={dashed ? '4 3' : undefined}
        markerEnd={`url(#proc-arrow-${(edge.styleKey || (edge.gate ? 'gate' : 'default'))})`} opacity={0.85} />
      <text x={edge.labelX} y={edge.labelY} textAnchor="middle"
        style={{ fontSize: 9.5, fill: color, ...labelHaloStyle }}>
        {edge.labelText}
      </text>
    </g>
  );
}

export function BundleFlowPreview({ bundle, graph }) {
  // Server truth first (#1009): once /api/flows/graph answered, the preview
  // draws exactly the edge set the Flows canvas would; the client derivation
  // only bridges the fetch latency.
  const serverEdges = useMemo(() => (graph ? previewEdgesFromGraph(graph) : null), [graph]);
  const layout = useMemo(() => computePreviewLayout(bundle, serverEdges || undefined), [bundle, serverEdges]);

  if (!layout) return null;
  const { NODE_W, COL_W, NODE_H, PAD } = PREVIEW;
  const { stages, nodes, forward, back, width, height } = layout;

  // One arrow marker per semantic style in use, matching its stroke; the
  // legend mirrors the canvas legend — same keys, same names, same colours.
  const usedKeys = [...new Set([...forward, ...back].map(e => e.styleKey).filter(k => k && EDGE_STYLES[k]))];

  return (
    <div style={{ border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', background: 'var(--eb-bg-elevated)' }}>
      <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ display: 'block', minWidth: '100%' }}>
        <defs>
          <marker id="proc-arrow-default" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--eb-text-muted)" />
          </marker>
          <marker id="proc-arrow-gate" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STYLES.gate.color} />
          </marker>
          {usedKeys.filter(k => k !== 'gate').map(k => (
            <marker key={k} id={`proc-arrow-${k}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STYLES[k].color} />
            </marker>
          ))}
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
      {usedKeys.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)', fontSize: 10, color: 'var(--eb-text-muted)' }}>
          {usedKeys.map(k => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={EDGE_STYLES[k].color}
                strokeWidth="2" strokeDasharray={EDGE_STYLES[k].dashed ? '4 3' : undefined} /></svg>
              {EDGE_STYLES[k].label}
            </span>
          ))}
        </div>
      )}
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

// ─── Entry cards ────────────────────────────────────────────────────────────

function EntryCard({ icon: Icon, title, copy, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      ...cardStyle, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
    }}>
      <Icon size={20} style={{ color: 'var(--eb-accent-primary)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--eb-text-md)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>{title}</span>
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
  const [weaveError, setWeaveError] = useState(null);
  const [lints, setLints] = useState(null);
  const [previewGraph, setPreviewGraph] = useState(null); // full /api/flows/graph response (#1009 — the preview renders SERVER edges)
  const [lintLoading, setLintLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const lintSeq = useRef(0);

  const setBundle = (bundle, mode, templateId) => {
    setForm(f => ({
      ...f,
      processMode: mode,
      processTemplateId: templateId ?? f.processTemplateId,
      processBundle: bundle,
      processLints: null,
    }));
  };

  // Authoritative lint check for whatever bundle is currently selected.
  useEffect(() => {
    const bundle = form.processBundle;
    if (!bundle) { setLints(null); setPreviewGraph(null); return; }
    const seq = ++lintSeq.current;
    setLintLoading(true);
    apiCall('POST', '/api/flows/graph', { processTemplate: bundle })
      .then(g => {
        if (seq !== lintSeq.current) return;
        setLints(g.lints || []);
        setPreviewGraph(g);
        setForm(f => ({ ...f, processLints: g.lints || [] }));
      })
      .catch(() => { if (seq === lintSeq.current) { setLints([]); setPreviewGraph(null); } })
      .finally(() => { if (seq === lintSeq.current) setLintLoading(false); });
  }, [form.processBundle]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickTemplate(entry) {
    try {
      const bundle = entry.kind === 'draft'
        ? await apiCall('GET', `/api/process/drafts/${encodeURIComponent(entry.id)}`)
        : await apiCall('GET', `/api/process-templates/${encodeURIComponent(entry.id)}`);
      setBundle(bundle, 'template', `${entry.kind}:${entry.id}`);
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

  // ── entry selection ──
  if (!form.processMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {SPIN_KEYFRAMES}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--eb-space-3)' }}>
          <EntryCard icon={LayoutTemplate} title="Use a template"
            copy="Start from a curated process (Core SDLC, Extended SDLC, …) or one of your saved drafts. One click, ready to review."
            onClick={() => setForm(f => ({ ...f, processMode: 'template' }))} />
          <EntryCard icon={Sparkles} title="Describe the flow"
            copy="Write the process in plain language — roles, hand-offs, human gates. The Flow Copilot generates a validated flow you review here."
            onClick={() => setForm(f => ({ ...f, processMode: 'describe' }))} />
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
      onClick={() => setForm(f => ({ ...f, processMode: null, processBundle: null, processTemplateId: null, processLints: null }))}>
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
          <PreviewBlock form={form} graph={previewGraph} lints={lints} lintLoading={lintLoading} onSaveDraft={saveAsDraft} savingDraft={savingDraft} />
        )}
        {weaveError && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{weaveError}</div>}
        {error && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</div>}
      </div>
    );
  }

  // ── describe (#1070) ──
  if (form.processMode === 'describe') {
    return (
      <DescribeSection
        form={form} setForm={setForm} setBundle={setBundle}
        previewGraph={previewGraph} lints={lints} lintLoading={lintLoading}
        onSaveDraft={saveAsDraft} savingDraft={savingDraft}
        backToEntry={backToEntry} error={error}
      />
    );
  }

  // processMode can only be null | 'template' | 'describe' — all handled above.
  return null;
}

// ─── "Describe" entry (#1070) ────────────────────────────────────────────────
// A minimal inline variant of the Flow-Copilot exchange: one description field,
// regenerate on edit — no chat history (the full panel lives in the Flows
// editor; "Save as draft & open in canvas" hands over to it). Calls the SAME
// POST /api/process/copilot NDJSON endpoint as the panel; an ok:true bundle
// lands in form.processBundle where the existing authoritative lint pass
// (POST /api/flows/graph) gates submission exactly like every other entry.

function DescribeSection({ form, setForm, setBundle, previewGraph, lints, lintLoading, onSaveDraft, savingDraft, backToEntry, error }) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(null);
  const [genError, setGenError] = useState(null);   // copilotErrorInfo shape
  const [summary, setSummary] = useState(null);
  const [findings, setFindings] = useState(null);   // error lints of an ok:false result
  const text = form.describeText || '';

  async function generate() {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setRunning(true); setPhase(null); setGenError(null); setSummary(null); setFindings(null);
    try {
      // Always a fresh whole-flow generation from the description (no bundle,
      // no history) — editing the text and regenerating replaces the result.
      const res = await fetch('/api/process/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...assistHeaders() },
        body: JSON.stringify({ messages: [{ role: 'user', content: trimmed }] }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        if (b && b.code) notifyAssistError(b.code);
        setGenError(copilotErrorInfo(res.status, b && b.error));
        return;
      }
      const out = await consumeCopilotStream(res, setPhase);
      setSummary(out.summary || '');
      if (out.ok && out.bundle) {
        // Lands on the form like the template path; the lint effect
        // in StepProcess re-checks it authoritatively.
        setBundle(out.bundle, 'describe');
      } else {
        // Error-level findings survived the repair loop — keep the form
        // untouched (an unappliable bundle must not reach submission) and let
        // the user refine the description.
        setFindings((out.lints || []).filter(l => l.severity === 'error'));
      }
    } catch (e) {
      setGenError(copilotErrorInfo(e.status, e.message));
    } finally {
      setRunning(false);
      setPhase(null);
    }
  }

  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {SPIN_KEYFRAMES}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={labelStyle}>Describe the flow</div>
        {backToEntry}
      </div>
      <div style={hintStyle}>
        Roles, hand-offs, human approval gates — in your own words. Example: <em>"an issue-triage agent
        labels new issues, a Business Analyst refines them, a human approves with `ready`, a Developer
        implements and opens a PR, a Code Reviewer routes to a Reworker or approves, a Merger merges."</em>
      </div>
      <textarea
        value={text}
        onChange={e => { const v = e.target.value; setForm(f => ({ ...f, describeText: v })); }}
        rows={5}
        autoFocus
        disabled={running}
        placeholder="Describe the process…"
        style={{ ...selectStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, opacity: running ? 0.6 : 1 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
        <button type="button" onClick={generate} disabled={running || !text.trim()} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
          borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2) var(--eb-space-4)',
          fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 600,
          cursor: (running || !text.trim()) ? 'not-allowed' : 'pointer', opacity: (running || !text.trim()) ? 0.6 : 1,
        }}>
          {running
            ? <Loader2 size={13} style={{ animation: 'team-setup-spin 0.9s linear infinite' }} />
            : <Sparkles size={13} />}
          {form.processBundle && form.processMode === 'describe' ? 'Regenerate' : 'Generate flow'}
        </button>
        {running && <span style={hintStyle}>{phaseLabel(phase)}</span>}
      </div>

      {genError && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{genError.message}</div>
          {genError.kind === 'provider' && (
            <div style={hintStyle}>
              The Copilot needs a configured LLM —{' '}
              <Link to="/models" style={{ color: 'var(--eb-accent-primary)', textDecoration: 'none' }}>add a Model Provider</Link>{' '}
              and try again.
            </div>
          )}
        </div>
      )}

      {findings && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
            <AlertCircle size={13} /> The generated flow still has validation errors — refine the description and regenerate.
          </div>
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-5)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {findings.map((l, i) => (
              <li key={i} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{l.message}</li>
            ))}
          </ul>
        </div>
      )}

      {summary && form.processBundle && !findings && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>{summary}</div>
      )}

      {form.processBundle && (
        <PreviewBlock form={form} graph={previewGraph} lints={lints} lintLoading={lintLoading} onSaveDraft={onSaveDraft} savingDraft={savingDraft} />
      )}
      {error && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</div>}
    </div>
  );
}

function PreviewBlock({ form, graph, lints, lintLoading, onSaveDraft, savingDraft }) {
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
      <BundleFlowPreview bundle={form.processBundle} graph={graph} />
      <LintBadges lints={lints} loading={lintLoading} />
    </div>
  );
}
