import React, { useEffect, useState } from 'react';
import { Save, Trash2, Loader2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import { useHelpSubject } from '../../context/HelperChatContext';
import { OVERLAY_FLOW_NODE } from '../../context/page-help-view.js';
import { apiCall } from '../../hooks/useApi';
import RoutingSection from './RoutingSection';
import { resolveInheritedStage } from './hierarchy-utils';
import { applyDetailsSave, parseSaveError, savedSummary } from './node-inspector-save';
import { summarizeGithubEventTrigger } from '../agent-chat/trigger-summary.js';
import { ID_FORMAT_HINT } from '../../components/id-field-view';
import PromptHistory from '../agent-chat/PromptHistory';
import ScalingSection from './ScalingSection';
import { poolBadgeText, scalingDraftFromPool, scalingDraftDirty, scalingSaveDecision } from './scaling-view.js';
import { ROUTING_SAVE_HINT, leaveGuard, discardMessage, roleDeleteImpact, deleteRoleSummary } from './node-inspector-view.js';
import {
  PROMPT_MODES,
  PROMPT_MODE_LABELS,
  resolvePromptMode,
  composeMemberPrompt,
} from '../prompt-mode-view.js';

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
//     and the richer live editor (inherit/override toggle + file path) in
//     live — preserved from the old PromptTab, but #2295 lifted its state up
//     here so it batches into the SAME Details Save (see below).
//   - Delete is offered in draft only; live member deletion stays on the Agents
//     page (destructive — removes a running member).
//
// #2295: the Details tab has exactly ONE save control in every mode. The live
// prompt editor's own "Save prompt", the Scaling section's own "Save", and
// the Parent picker's apply-on-selection are gone — all four (name/prompt/
// stage/parent/scaling) batch through `applyDetailsSave` and one click. An
// unsaved-edits guard gates closing the panel, and the save button reports
// which parts actually changed (`savedSummary`) or which one failed
// (`parseSaveError`).
export default function NodeInspector({
  mode,
  node,
  roles = [],       // draft peer list
  nodes = [],       // live peer list
  agents = [],      // live: flat /api/agents list (#2271 Scaling — pool + parent wipLimit, no separate fetch)
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
  // The Routing tab's "?" (RoutingSection) renders inside this SidePanel
  // (60/61), so the subject is published here — by the component that owns the
  // panel body — to lift the help panel in front of it (#1984).
  useHelpSubject({ overlay: OVERLAY_FLOW_NODE });
  const isLive = mode === 'live';
  const structureFocus = focus?.section === 'structure' && (focus?.tab || 'details') === 'details';
  const [tab, setTab] = useState(focus?.tab || 'details');
  const [name, setName] = useState(node.displayName || node.id);
  const [id, setId] = useState(node.id);
  const [prompt, setPrompt] = useState(node.systemPrompt || '');  // draft only
  const [stage, setStage] = useState(node.stage || '');
  const [newStage, setNewStage] = useState('');
  const [parent, setParent] = useState(node.parent || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');            // savedSummary() text, '' when not shown
  const [saveError, setSaveError] = useState(null);   // {label, message} | null, from parseSaveError
  // #2660: a pending guarded leave — { action: 'close' | 'tab', toTab?, parts }
  // — or null. `outcomesDirty` mirrors RoutingSection's own "Save outcomes"
  // draft, which would otherwise vanish silently on close or tab switch.
  const [pendingLeave, setPendingLeave] = useState(null);
  const [outcomesDirty, setOutcomesDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Live prompt editor state, lifted here (out of LivePromptEditor) so it can
  // batch into this tab's one Save (#2295) instead of owning its own. `null`
  // until LivePromptEditor's fetch resolves; `livePromptBaseline` is what was
  // loaded (or last saved), the yardstick `promptDirty` compares against.
  const [livePromptDraft, setLivePromptDraft] = useState(null);
  const [livePromptBaseline, setLivePromptBaseline] = useState(null);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);

  // A jump (edge dialog "Open in Routing/Details", or outcome-edge click) can
  // change `focus` while this inspector is already mounted on the same node —
  // follow it to the requested tab (#865). Normal node selection clears focus.
  useEffect(() => { if (focus?.tab) setTab(focus.tab); }, [focus]);

  const peers = isLive ? nodes : roles;
  const memberCfg = isLive ? agents.find(a => a.id === node?.id) : null;
  const isPooledRoleNode = isLive && memberCfg?.role === 'team-member';
  const parentCfg = isPooledRoleNode && memberCfg.parentTeamId
    ? agents.find(a => a.id === memberCfg.parentTeamId) : null;

  // Scaling draft (#2295), only meaningful for a pooled role node — declared
  // unconditionally (hooks can't be conditional) with a harmless blank/
  // disabled default otherwise. `poolBaseline` moves to whatever was just
  // written after a successful save, the same way `livePromptBaseline` does.
  const [poolDraft, setPoolDraft] = useState(() => scalingDraftFromPool(memberCfg?.pool));
  const [poolBaseline, setPoolBaseline] = useState(() => (memberCfg ? memberCfg.pool : null));

  if (!node) return null;
  const isTemplate = level === 'template' || node.role === 'template';
  // Warning dot on the Routing tab when any lint it surfaces fires for this node
  // (today: duplicate-listener), so problems are findable without opening it (§3).
  const routingHasLint = (lints || []).some(l => l.code === 'duplicate-listener' && l.nodeId === node.id);

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

  const nameDirty = name !== (node.displayName ?? node.id);
  const idDirty = mode === 'draft' && id !== node.id;
  const promptDirty = mode === 'draft'
    ? prompt !== (node.systemPrompt || '')
    : !!(livePromptDraft && livePromptBaseline && (
      livePromptDraft.role === 'member'
        ? (livePromptDraft.promptMode !== livePromptBaseline.promptMode || livePromptDraft.text !== livePromptBaseline.text)
        : livePromptDraft.text !== livePromptBaseline.text
    ));
  const stageDirty = stage !== (node.stage || '') || !!newStage.trim();
  const parentDirty = !!ops.setParent && parent !== (node.parent || '');
  const scalingDirty = isPooledRoleNode && scalingDraftDirty(poolDraft, poolBaseline);
  const dirty = nameDirty || idDirty || promptDirty || stageDirty || parentDirty || scalingDirty;

  function markDirty() { setSaved(''); setSaveError(null); }

  async function saveMeta() {
    setBusy(true); setSaved(''); setSaveError(null);
    try {
      const res = await applyDetailsSave(saveOps, node, {
        name, id, prompt, stage, newStage,
        parent: ops.setParent ? parent : undefined,
        livePrompt: (mode === 'live' && livePromptDraft) ? {
          ...livePromptDraft,
          initialPromptMode: livePromptBaseline?.promptMode,
          initialText: livePromptBaseline?.text,
        } : undefined,
        pool: isPooledRoleNode
          ? { draft: poolDraft, parentWipLimit: parentCfg?.wipLimit, initialPool: poolBaseline }
          : undefined,
      }, { mode });
      setNewStage('');
      setStage(res.stage);
      if (res.renamedId) {
        setId(res.renamedId);
        onChanged?.();
        onRenamedId?.(res.renamedId);
      } else {
        onChanged?.();
      }
      if (mode === 'live' && livePromptDraft) {
        setLivePromptBaseline(livePromptDraft);
        if (promptDirty) setHistoryReloadKey(k => k + 1);
      }
      if (isPooledRoleNode) {
        setPoolBaseline(scalingSaveDecision(poolDraft, parentCfg?.wipLimit).payload);
      }
      setSaved(savedSummary([
        { label: 'Display name', dirty: nameDirty },
        { label: 'Agent prompt', dirty: promptDirty },
        { label: 'Stage', dirty: stageDirty },
        { label: 'Parent', dirty: parentDirty },
        { label: 'Scaling', dirty: scalingDirty },
        { label: 'Agent ID', dirty: idDirty },
      ]));
    } catch (e) {
      setSaveError(parseSaveError(e.message || String(e)));
    } finally { setBusy(false); }
  }

  // #2295 AC9: closing with unsaved edits is confirmed rather than silently
  // discarding them — the panel's only "cancel" is the X/Escape, so that is
  // where the guard has to sit. #2660 extends it to the Routing tab's unsaved
  // outcomes, and to leaving that tab (its outcomes draft unmounts with it).
  function requestClose() {
    const parts = leaveGuard({ action: 'close', detailsDirty: dirty, outcomesDirty });
    if (parts.length) setPendingLeave({ action: 'close', parts });
    else onClose?.();
  }

  function requestTab(next) {
    const parts = leaveGuard({ action: 'tab', fromTab: tab, toTab: next, detailsDirty: dirty, outcomesDirty });
    if (parts.length) setPendingLeave({ action: 'tab', toTab: next, parts });
    else setTab(next);
  }

  function confirmLeave() {
    const leave = pendingLeave;
    setPendingLeave(null);
    if (!leave) return;
    if (leave.action === 'tab') {
      setOutcomesDirty(false);
      setTab(leave.toTab);
    } else {
      onClose?.();
    }
  }

  // #2660: Delete agent is confirmed (naming the connections it cuts) and a
  // failed delete is reported inside the dialog instead of becoming an
  // unhandled rejection.
  const deleteImpact = !isLive && confirmDelete ? roleDeleteImpact(node.id, roles) : null;
  async function deleteAgent() {
    if (deleting) return;
    setDeleting(true); setDeleteError(null);
    try {
      await ops.deleteRole(node.id);
      setConfirmDelete(false);
      onDeleted?.();
    } catch (e) {
      setDeleteError(e?.message || String(e));
    } finally { setDeleting(false); }
  }

  return (
    <SidePanel open onClose={requestClose} title={node.displayName || node.id} width="560px">
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {isLive ? (
          <>
            <span style={badge}>{node.role || 'agent'}</span>
            {node.sessionPolicy === 'per-invocation' && <span style={badge}>per-invocation</span>}
            {node.isEntryPoint && <span style={badge}>DM entry point</span>}
            {/* #2271 AC4 — read-only "at a glance" badge (A2.2: "so an
                operator looking at one agent sees its scaling at a glance"),
                visible regardless of which tab is active. */}
            {isPooledRoleNode && poolBadgeText(memberCfg.pool) && <span style={badge}>{poolBadgeText(memberCfg.pool)}</span>}
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
            <TabButton active={tab === 'details'} onClick={() => requestTab('details')}>Details</TabButton>
            <TabButton active={tab === 'routing'} onClick={() => requestTab('routing')} dot={routingHasLint}>Routing</TabButton>
          </div>

          {tab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
              <Field label="Display name">
                <input value={name} onChange={e => { setName(e.target.value); markDirty(); }} style={input} />
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
                      onChange={e => { setId(e.target.value); markDirty(); }}
                      style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} />
                    <span style={hint}>{ID_FORMAT_HINT} Renaming rewires all of this agent's inputs and hand-offs.</span>
                  </>
                )}
              </Field>

              <Field label="Agent prompt">
                {isLive ? (
                  <LivePromptEditor
                    agentId={node.id}
                    draft={livePromptDraft}
                    onLoaded={(initial) => { setLivePromptDraft(initial); setLivePromptBaseline(initial); }}
                    onDraftChange={(next) => { setLivePromptDraft(next); markDirty(); }}
                    historyReloadKey={historyReloadKey}
                    dirty={promptDirty}
                  />
                ) : (
                  <textarea value={prompt} onChange={e => { setPrompt(e.target.value); markDirty(); }}
                    placeholder="What this agent does, its responsibilities and tone…"
                    style={{ ...input, minHeight: 220, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', lineHeight: 1.5 }} />
                )}
              </Field>

              {/* Structure — static placement (Stage + Parent), not flow. Moved
                  here from the retired Connections tab (#865). #2295 AC3:
                  Parent is now batched like everything else — it no longer
                  applies the moment it's touched. */}
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
                        onChange={e => { setStage(e.target.value); setNewStage(''); markDirty(); }} style={input}>
                        <option value="">{inheritedStage ? `— inherit (${inheritedStage}) —` : '— none —'}</option>
                        {stages.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <input value={newStage} onChange={e => { setNewStage(e.target.value); markDirty(); }}
                        placeholder="＋ or type a new stage name…" style={{ ...input, marginTop: 4 }} />
                      <span style={hint}>
                        Stages are the ordered columns of the flow — manage the order under <strong>Stages</strong> in the toolbar.
                      </span>
                    </Field>
                  )}
                  {ops.setParent && (
                    <Field label="Parent (optional)">
                      <select value={siblings.some(s => s.id === parent) ? parent : ''}
                        onChange={e => { setParent(e.target.value); markDirty(); }} style={input}>
                        <option value="">— none —</option>
                        {siblings.map(s => <option key={s.id} value={s.id}>{s.displayName || s.id}</option>)}
                      </select>
                      <span style={hint}>Nests this agent under a parent for the hierarchy layout. Applies on Save.</span>
                      {saveError?.label === 'Parent' && <span style={{ ...hint, color: 'var(--eb-status-error)' }}>{saveError.message}</span>}
                    </Field>
                  )}
                </div>
              )}

              {/* Scaling (#2271, Amendment 2 A2.2 of
                  `docs/parallel-workers-concept.md`) — the role-axis config
                  surface for agent pools, live team-member nodes only (the
                  live `pool` route, #2270, is gated the same way). #2295
                  AC11: folds into this tab's Save, not its own. */}
              {isPooledRoleNode && (
                <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)' }}>
                    <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-medium)' }}>Scaling</div>
                  </div>
                  <ScalingSection
                    draft={poolDraft}
                    onChange={(next) => { setPoolDraft(next); markDirty(); }}
                    parentWipLimit={parentCfg?.wipLimit}
                    error={saveError?.label === 'Scaling' ? saveError.message : null}
                  />
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
                {dirty && (
                  <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                    Unsaved changes — press Save to apply them.
                  </span>
                )}
                {!dirty && saved && (
                  <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>{saved}</span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
                  <button onClick={saveMeta} disabled={busy} style={primary}>
                    <Save size={14} /> Save
                  </button>
                  {saveError && (
                    <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
                      {saveError.label ? `${saveError.label}: ` : ''}{saveError.message}
                    </span>
                  )}
                </div>
              </div>

              {!isLive && (
                <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)' }}>
                  <button onClick={() => { setDeleteError(null); setConfirmDelete(true); }}
                    style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)' }}>
                    <Trash2 size={14} /> Delete agent
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'routing' && (
            <>
              {/* #2295 AC13: the Details tab batches everything behind one
                  Save; Routing's wiring (inputs, hand-offs, artifacts) is a
                  graph edit that shows on the canvas at once. #2660: the
                  Outcomes block is the exception with its own Save, so the
                  hint says so instead of claiming there is no Save. */}
              <div style={{ ...hint, marginBottom: 'var(--eb-space-3)' }}>
                {ROUTING_SAVE_HINT}
              </div>
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
                onOutcomesDirtyChange={setOutcomesDirty}
              />
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!pendingLeave}
        title="Discard unsaved changes?"
        message={pendingLeave ? discardMessage(pendingLeave.parts, pendingLeave.action) : ''}
        variant="warning"
        confirmLabel="Discard"
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeave(null)}
      />

      <ConfirmDialog
        open={!!deleteImpact}
        title="Delete agent?"
        message={deleteImpact ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)' }}>
            <p style={{ margin: 0 }}>{deleteRoleSummary(node.displayName || node.id, deleteImpact)}</p>
            {[['Hand-offs into this agent', deleteImpact.incoming],
              ['Hand-offs from this agent', deleteImpact.outgoing],
              ['Nested agents', deleteImpact.children]].filter(([, rows]) => rows.length).map(([heading, rows]) => (
              <div key={heading}>
                <div style={{ fontWeight: 'var(--eb-font-medium)' }}>{heading}</div>
                <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                  {rows.map(r => <li key={r}>{r}</li>)}
                </ul>
              </div>
            ))}
            {deleteError && <p style={{ margin: 0, color: 'var(--eb-status-error)' }}>Delete failed: {deleteError}</p>}
          </div>
        ) : null}
        variant="danger"
        confirmLabel="Delete agent"
        busy={deleting}
        maxWidth={520}
        onConfirm={deleteAgent}
        onCancel={() => { if (!deleting) setConfirmDelete(false); }}
      />
    </SidePanel>
  );
}

// Live-only prompt editor — the old ProcessNodeInspector PromptTab (#692): a
// team-member gets the three-mode system-prompt control (#1511: Inherit /
// Additional input / Exclusive overriding input), a non-member gets the
// file-based prompt path. #2295: fully controlled by the host (`draft`/
// `onDraftChange`/`onLoaded`) so it batches into the Details tab's one Save —
// it still owns its own initial fetch (the host has no reason to know the
// agent's role or the parent team's template ahead of time), but never
// writes and carries no Save button of its own any more.
function LivePromptEditor({ agentId, draft, onLoaded, onDraftChange, historyReloadKey, dirty }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inheritedPreview, setInheritedPreview] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await apiCall('GET', `/api/agents/${agentId}`);
        if (!alive) return;
        if (cfg.role === 'team-member') {
          if (cfg.parentTeamId) {
            try {
              const team = await apiCall('GET', `/api/agents/${cfg.parentTeamId}`);
              if (alive) setInheritedPreview(team.systemPromptTemplate || '');
            } catch { /* preview best-effort */ }
          }
          if (alive) onLoaded({ role: 'member', promptMode: resolvePromptMode(cfg), text: cfg.systemPrompt || '' });
        } else {
          const { content } = await apiCall('GET', `/api/agents/${agentId}/prompt`);
          if (alive) onLoaded({ role: 'file', promptMode: null, text: content || '' });
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // agentId is stable for this component's lifetime (NodeInspector remounts
    // — new `key` — on node switch), so this fetch runs exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  if (loading || !draft) return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading prompt…</span>;

  const memberInherit = draft.role === 'member' && draft.promptMode === PROMPT_MODES.INHERIT;
  // The main textarea is read-only only when inheriting (member) — it then
  // previews the team template. Additional/exclusive/file all edit `draft.text`.
  const editingDisabled = memberInherit;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      {draft.role === 'member' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          {[PROMPT_MODES.INHERIT, PROMPT_MODES.ADDITIONAL, PROMPT_MODES.EXCLUSIVE].map(m => (
            <label key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)', cursor: 'pointer' }}>
              <input type="radio" checked={draft.promptMode === m} onChange={() => onDraftChange({ ...draft, promptMode: m })} />
              {PROMPT_MODE_LABELS[m]}
            </label>
          ))}
        </div>
      )}

      <textarea
        value={editingDisabled ? inheritedPreview : draft.text}
        onChange={e => onDraftChange({ ...draft, text: e.target.value })}
        readOnly={editingDisabled}
        placeholder={draft.role === 'member'
          ? (draft.promptMode === PROMPT_MODES.ADDITIONAL
            ? 'Agent-specific instructions to append after the team prompt…'
            : 'Full system prompt that replaces the team prompt…')
          : 'AGENT-PROMPT.md…'}
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
          Showing the team template (read-only). Choose “Additional input” or “Exclusive overriding input” to set a prompt for this member.
        </span>
      )}
      {draft.role === 'member' && draft.promptMode === PROMPT_MODES.ADDITIONAL && (
        <>
          <span style={hint}>Effective prompt preview (team prompt + your addition):</span>
          <div style={{
            width: '100%', maxHeight: 220, overflow: 'auto', boxSizing: 'border-box',
            whiteSpace: 'pre-wrap', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)',
            lineHeight: 1.5, background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-muted)',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-3)',
          }}>
            {composeMemberPrompt(PROMPT_MODES.ADDITIONAL, inheritedPreview, draft.text) || '(the team prompt is empty)'}
          </div>
        </>
      )}

      {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}

      <div style={{ marginTop: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-2)', borderTop: '1px solid var(--eb-border-default)' }}>
        <PromptHistory
          agentId={agentId}
          reloadKey={historyReloadKey}
          dirty={dirty}
          onLoadVersion={(content) => onDraftChange({ ...draft, text: content })}
        />
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
        switch the scope to a team, or materialise this agent via the Agent Team Wizard.
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
