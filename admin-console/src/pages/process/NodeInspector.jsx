import React, { useEffect, useState } from 'react';
import { Save, Trash2, Loader2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import RoutingSection from './RoutingSection';
import { resolveInheritedStage } from './hierarchy-utils';
import { applyDetailsSave } from './node-inspector-save';
import { summarizeGithubEventTrigger } from '../agent-chat/trigger-summary.js';

// Shared node inspector for the Flow Editor (#692). ONE component drives both
// modes so the first-page layout, tab set, and routing wiring live in a single
// place:
//   - DRAFT (mode='draft'): edits a process-template bundle role via draftOps.
//   - LIVE  (mode='live') : edits a materialized agent via liveOps (HTTP).
// Tabs are Details · Routing — two tabs, one flow surface (concept §2). The
// Connections tab was retired in #865 (its Parent/Stage moved to Details →
// Structure, its flow controls to Routing); the Triggers tab was retired in
// #866 once Routing → Inputs reached full CRUD parity (manual triggers are now
// authored/edited there via the reused TriggersPanel form, and a channel/
// data-flow trigger is never editable raw). A read-only raw-triggers.json
// disclosure inside Inputs preserves workspace transparency.
// Behavioural differences are mode-aware props, never duplicated components:
//   - Details tab, page 1: Display name, Agent ID, Agent prompt, then a
//     Structure section (Stage + Parent — both static placement, not flow).
//   - Agent ID is editable in draft (rewires references on rename) and
//     read-only in live (a materialized agent's id is its identity).
//   - The prompt is a plain textarea in draft (batched into the Details Save)
//     and the richer live editor (inherit/override toggle + file path, with its
//     own Save) in live — preserved verbatim from the old PromptTab.
//   - Delete is offered in draft only; live member deletion stays on the Agents
//     page (destructive — removes a running member).
export default function NodeInspector({
  mode,
  node,
  roles = [],       // draft peer list
  nodes = [],       // live peer list
  stages = [],
  lints = [],       // graph lints (Routing tab surfaces duplicate-listener for this node)
  labels = [],      // known label registry (label-name suggestions in the Add-input chooser)
  humans = [],      // named human roles (#987) — the delivery-target picker in Routing
  humanOps,         // scope-bound human wiring ops (#987): wire/unwireHumanConsume
  ops,
  teamId,           // live: binds a brand-new stage to the team's ordered list
  level,            // live: 'template' renders read-only
  focus,            // { tab, outcome? } — open a specific tab (canvas outcome-edge click → Routing)
  onClose,
  onChanged,
  onDeleted,        // draft
  onRenamedId,      // draft
}) {
  const isLive = mode === 'live';
  const structureFocus = focus?.section === 'structure' && (focus?.tab || 'details') === 'details';
  const [tab, setTab] = useState(focus?.tab || 'details');
  const [name, setName] = useState(node.displayName || node.id);
  const [id, setId] = useState(node.id);
  const [prompt, setPrompt] = useState(node.systemPrompt || '');  // draft only
  const [stage, setStage] = useState(node.stage || '');
  const [newStage, setNewStage] = useState('');
  const [parent, setParentState] = useState(node.parent || '');
  const [parentErr, setParentErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  // A jump (edge dialog "Open in Routing/Details", or outcome-edge click) can
  // change `focus` while this inspector is already mounted on the same node —
  // follow it to the requested tab (#865). Normal node selection clears focus.
  useEffect(() => { if (focus?.tab) setTab(focus.tab); }, [focus]);

  if (!node) return null;
  const isTemplate = level === 'template' || node.role === 'template';
  // Warning dot on the Routing tab when any lint it surfaces fires for this node
  // (today: duplicate-listener), so problems are findable without opening it (§3).
  const routingHasLint = (lints || []).some(l => l.code === 'duplicate-listener' && l.nodeId === node.id);

  const peers = isLive ? nodes : roles;
  const siblings = peers.filter(n => n.id !== node.id).map(n => ({ id: n.id, displayName: n.displayName || n.id }));
  const inheritedStage = isLive
    ? (!node.stage && node.effectiveStage ? node.effectiveStage : '')
    : resolveInheritedStage(roles, node);

  // The stage picker needs the team's ordered list; in live mode that requires a
  // team scope. Without one (standalone live agent) the control degrades to
  // hidden rather than erroring — matching how it behaved before #692.
  const canStage = !isLive || !!teamId;
  // A brand-new stage typed inline registers on the team's list first; bind the
  // teamId into liveOps.addStage(teamId, name) so the shared save is mode-blind.
  const saveOps = isLive && teamId
    ? { ...ops, addStage: (n) => ops.addStage(teamId, n) }
    : ops;

  async function saveMeta() {
    setBusy(true); setSaved(false); setError(null);
    try {
      const res = await applyDetailsSave(saveOps, node, { name, id, prompt, stage, newStage }, { mode });
      setNewStage('');
      setStage(res.stage);
      if (res.renamedId) {
        setId(res.renamedId);
        onChanged?.();
        onRenamedId?.(res.renamedId);
      } else {
        onChanged?.();
      }
      setSaved(true);
    } catch (e) {
      setError(e.message || String(e));
    } finally { setBusy(false); }
  }

  // Parent is static placement, not flow — it applies immediately (like it did
  // in the retired Connections tab), independent of the batched Details Save.
  // The cycle guard lives server/adapter-side; we just surface its error.
  async function applyParent(v) {
    const next = v || '';
    setParentState(next); setParentErr(null);
    try { await ops.setParent(node.id, next || null); onChanged?.(); }
    catch (e) { setParentState(node.parent || ''); setParentErr(e?.message || String(e)); }
  }

  return (
    <SidePanel open onClose={onClose} title={node.displayName || node.id} width="560px">
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {isLive ? (
          <>
            <span style={badge}>{node.role || 'agent'}</span>
            {node.sessionPolicy === 'per-invocation' && <span style={badge}>per-invocation</span>}
            {node.isEntryPoint && <span style={badge}>DM entry point</span>}
          </>
        ) : (
          <span style={badge}>draft agent</span>
        )}
      </div>

      {isTemplate ? (
        <TemplateReadonly node={node} />
      ) : (
        <>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--eb-border-default)', marginBottom: 'var(--eb-space-4)' }}>
            <TabButton active={tab === 'details'} onClick={() => setTab('details')}>Details</TabButton>
            <TabButton active={tab === 'routing'} onClick={() => setTab('routing')} dot={routingHasLint}>Routing</TabButton>
          </div>

          {tab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
              <Field label="Display name">
                <input value={name} onChange={e => { setName(e.target.value); setSaved(false); }} style={input} />
              </Field>

              <Field label="Agent ID">
                {isLive ? (
                  <>
                    <input value={id} readOnly disabled
                      style={{ ...input, fontFamily: 'var(--eb-font-mono)', background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-muted)', cursor: 'not-allowed' }} />
                    <span style={hint}>A materialized agent's ID is fixed.</span>
                  </>
                ) : (
                  <>
                    <input value={id}
                      onChange={e => { setId(e.target.value); setSaved(false); setError(null); }}
                      style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} />
                    <span style={hint}>Lowercase letters, digits and hyphens. Renaming rewires all of this agent's inputs and hand-offs.</span>
                  </>
                )}
              </Field>

              <Field label="Agent prompt">
                {isLive ? (
                  <LivePromptEditor agentId={node.id} onChanged={onChanged} />
                ) : (
                  <textarea value={prompt} onChange={e => { setPrompt(e.target.value); setSaved(false); }}
                    placeholder="What this agent does, its responsibilities and tone…"
                    style={{ ...input, minHeight: 220, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', lineHeight: 1.5 }} />
                )}
              </Field>

              {/* Structure — static placement (Stage + Parent), not flow. Moved
                  here from the retired Connections tab (#865). Parent applies
                  immediately; Stage is part of the batched Save below. */}
              {(canStage || ops.setParent) && (
                <div style={{
                  borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)',
                  display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
                  ...(structureFocus ? { borderRadius: 'var(--eb-radius-md)', boxShadow: '0 0 0 2px var(--eb-accent-primary)', padding: 'var(--eb-space-3)' } : {}),
                }}>
                  <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-medium)' }}>Structure</div>
                  {canStage && (
                    <Field label="Stage (layout column)">
                      <select value={stages.includes(stage) ? stage : ''}
                        onChange={e => { setStage(e.target.value); setNewStage(''); setSaved(false); }} style={input}>
                        <option value="">{inheritedStage ? `— inherit (${inheritedStage}) —` : '— none —'}</option>
                        {stages.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <input value={newStage} onChange={e => { setNewStage(e.target.value); setSaved(false); }}
                        placeholder="＋ or type a new stage name…" style={{ ...input, marginTop: 4 }} />
                      <span style={hint}>
                        Stages are the ordered columns of the flow — manage the order under <strong>Stages</strong> in the toolbar.
                      </span>
                    </Field>
                  )}
                  {ops.setParent && (
                    <Field label="Parent (optional)">
                      <select value={siblings.some(s => s.id === parent) ? parent : ''}
                        onChange={e => applyParent(e.target.value)} style={input}>
                        <option value="">— none —</option>
                        {siblings.map(s => <option key={s.id} value={s.id}>{s.displayName || s.id}</option>)}
                      </select>
                      <span style={hint}>Nests this agent under a parent for the hierarchy layout. Applied immediately.</span>
                      {parentErr && <span style={{ ...hint, color: 'var(--eb-status-error)' }}>{parentErr}</span>}
                    </Field>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
                <button onClick={saveMeta} disabled={busy} style={primary}>
                  <Save size={14} /> Save
                </button>
                {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
                {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}
              </div>

              {!isLive && (
                <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)' }}>
                  <button onClick={async () => { await ops.deleteRole(node.id); onDeleted?.(); }}
                    style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)' }}>
                    <Trash2 size={14} /> Delete agent
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'routing' && (
            <RoutingSection
              node={node}
              peers={peers}
              lints={lints}
              labels={labels}
              humans={humans}
              humanOps={humanOps}
              ops={ops}
              mode={mode}
              focusOutcome={focus?.tab === 'routing' ? focus?.outcome : null}
              focusSection={focus?.tab === 'routing' ? focus?.section : null}
              onChanged={onChanged}
            />
          )}
        </>
      )}
    </SidePanel>
  );
}

// Live-only prompt editor — preserved verbatim from the old ProcessNodeInspector
// PromptTab (#692): a team-member gets the inherit-from-team vs. custom-override
// toggle (systemPrompt: null when inheriting), a non-member gets the file-based
// prompt path (PUT /api/agents/:id/prompt). Self-contained with its own Save.
function LivePromptEditor({ agentId, onChanged }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mode, setMode] = useState('file');   // 'file' (AGENT-PROMPT.md) | 'member'
  const [text, setText] = useState('');
  const [inherit, setInherit] = useState(false);
  const [inheritedPreview, setInheritedPreview] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await apiCall('GET', `/api/agents/${agentId}`);
        if (!alive) return;
        if (cfg.role === 'team-member') {
          setMode('member');
          const hasOverride = typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0;
          setInherit(!hasOverride);
          setText(cfg.systemPrompt || '');
          if (cfg.parentTeamId) {
            try {
              const team = await apiCall('GET', `/api/agents/${cfg.parentTeamId}`);
              if (alive) setInheritedPreview(team.systemPromptTemplate || '');
            } catch { /* preview best-effort */ }
          }
        } else {
          setMode('file');
          const { content } = await apiCall('GET', `/api/agents/${agentId}/prompt`);
          if (alive) setText(content || '');
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [agentId]);

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      if (mode === 'member') {
        await apiCall('PUT', `/api/agents/${agentId}`, { systemPrompt: inherit ? null : text });
      } else {
        await apiCall('PUT', `/api/agents/${agentId}/prompt`, { content: text });
      }
      setSaved(true);
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading prompt…</span>;

  const editingDisabled = mode === 'member' && inherit;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      {mode === 'member' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={inherit} onChange={e => { setInherit(e.target.checked); setSaved(false); }} />
          Inherit agent prompt from team
        </label>
      )}

      <textarea
        value={editingDisabled ? inheritedPreview : text}
        onChange={e => { setText(e.target.value); setSaved(false); }}
        readOnly={editingDisabled}
        placeholder={mode === 'member' ? 'Custom agent prompt for this member…' : 'AGENT-PROMPT.md…'}
        style={{
          width: '100%', minHeight: 220, resize: 'vertical', boxSizing: 'border-box',
          fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5,
          background: editingDisabled ? 'var(--eb-bg-elevated)' : 'var(--eb-bg-app)',
          color: editingDisabled ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
          padding: 'var(--eb-space-3)', outline: 'none',
        }}
      />
      {editingDisabled && (
        <span style={hint}>
          Showing the team template (read-only). Untick “Inherit” to set a custom prompt for this member.
        </span>
      )}

      {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <button onClick={save} disabled={saving} style={{ ...primary, cursor: saving ? 'wait' : 'pointer' }}>
          {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
          Save prompt
        </button>
        {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function TemplateReadonly({ node }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        This is an <strong>agent template</strong> (blueprint view). Editing happens on live agents —
        switch the scope to a team, or materialise this agent via the Team Wizard.
      </div>
      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 4 }}>Triggers</div>
        {(node.triggers || []).length === 0
          ? <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>None.</span>
          : (node.triggers || []).map(t => {
            // Friendly event + required label, sharing TriggersPanel's source of
            // truth so raw dotted keys no longer appear here either (#778 AC10).
            const s = summarizeGithubEventTrigger(t);
            const evText = s.events.join(', ');
            return (
              <div key={t.id} style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-secondary)', padding: '3px 0', borderTop: '1px solid var(--eb-border-default)' }}>
                <span>{t.type}</span>
                {evText ? ` · ${evText}` : ''}
                {s.label ? ` · 🏷 ${s.label}` : ''}
                {/* Trigger-level emits were removed (#783) — label hand-offs are
                    shown at the node/role level, not per trigger. */}
              </div>
            );
          })}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, dot, children }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: 'none', border: 'none', borderBottom: active ? '2px solid var(--eb-accent-primary)' : '2px solid transparent',
      color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
    }}>
      {children}
      {dot && <span title="This tab has a warning" style={{
        width: 6, height: 6, borderRadius: '50%', background: 'var(--eb-status-warning, #d97706)', flexShrink: 0,
      }} />}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}

const badge = { fontSize: 'var(--eb-text-xs)', padding: '1px 7px', borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)', color: 'var(--eb-text-secondary)' };
const hint = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' };
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const ghost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '4px 10px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
