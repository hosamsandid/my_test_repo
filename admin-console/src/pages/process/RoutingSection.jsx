import React, { useEffect, useRef, useState } from 'react';
import { Plus, X, Trash2, Sparkles, Save, Loader2, AlertTriangle,
  GitPullRequest, CircleDot, Link, RefreshCw, Package, ChevronDown, ChevronRight,
  Clock, CalendarClock, Globe, Github, Workflow, Pencil } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SidePanel from '../../components/SidePanel';
import { TriggerForm } from '../agent-chat/TriggersPanel';
import { AddInputDialog, EditHandoffDialog } from './EdgeDialogs';
import { summarizeGithubEventTrigger, claimTooltip } from '../agent-chat/trigger-summary.js';
import { partitionTriggers, scheduleText, derivedChannelTrigger } from './input-rows.js';
import { consumersFor, outcomeHandsOffToHuman, outcomeHumanReviewers } from './outcome-consumers.js';
import {
  moveHumanDelivery, wireLabelHandoff, unwireLabelHandoff, wireChannel, unwireChannel,
} from './wiring-engine.js';
import {
  rowArtifact, wireConsumerSpec, currentConsumers, consumerCandidates, openEndMarker,
} from './outcome-routing.js';
import { consumeKey } from './humans-registry-ops';

// The human role currently wired to consume `entry` (or '' if none). #987.
function humanConsuming(humans, entry) {
  const key = consumeKey(entry);
  if (!key) return '';
  const h = (humans || []).find(r => (r.consumes || []).some(c => consumeKey(c) === key));
  return h ? h.id : '';
}

// Routing tab (#828, agent-outcomes concept §5.2; absorbs the retired
// Connections tab in #865) — ONE place for an agent's whole routing decision.
// Shared by the draft + live inspector through the same `ops` adapter; nothing
// branches on mode.
//
//   INPUTS   — what wakes this agent, in one unified list with FULL CRUD (#866):
//              the GitHub PR/issue channels it reacts to (channels[]), its
//              data-flow inputs + dependencies (dataFlow.inputs / dependsOn), the
//              manual triggers (cron / once / http / github-event) with their
//              contributing `sources`, and the derived (channel/dataFlow) triggers
//              shown read-only as "⟲ derived from connection" rows that point at
//              their owning port. Manual triggers are created/edited/toggled/
//              deleted via the reused TriggersPanel form; channels edit via the
//              inlined channel editor; a `[+ Add input]` chooser authors any kind.
//              Derived triggers are NEVER edited raw (the §1 footgun is gone —
//              they're edited via their owning port). The `duplicate-listener`
//              lint offers an inline delete; a read-only raw-`triggers.json`
//              disclosure preserves workspace transparency. This retires the
//              separate Triggers tab (concept §6).
//   OUTCOMES — the structured `outcomes` port: mode toggle (exactly one / any
//              of), editable option rows (title / when / actions), the derived
//              read-only consumers per outcome, and "suggest outcomes…".
//   ARTIFACTS — the data-flow outputs this agent produces (dataFlow.outputs):
//              name, hint, computed consumers, remove.
//   LEGACY   — a collapsed disclosure holding the emitted-labels editor and the
//              GitHub-outputs checkboxes, kept reachable until phase 3 (#865).
//
// The Outcomes editor holds a local draft and persists only on Save (or when a
// suggestion is confirmed) — nothing is written implicitly, so a declined
// suggestion persists nothing (AC4).
export default function RoutingSection({ node, peers = [], lints = [], labels = [], humans = [], humanOps, ops, onChanged, focusOutcome = null, focusSection = null, mode }) {
  const [outcomes, setOutcomes] = useState(null);   // { mode, options[] } local draft
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState(false);  // current draft is an unconfirmed suggestion

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const oc = ops.getRoleOutcomes ? await ops.getRoleOutcomes(node.id) : node.outcomes;
        if (!alive) return;
        setOutcomes(normalize(oc));
      } catch (e) {
        if (alive) { setOutcomes(emptyPort()); setError(e.message || String(e)); }
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [node.id]);

  const mutate = (next) => { setOutcomes(next); setDirty(true); setSaved(false); setSuggested(false); };

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const port = finalize(outcomes);
      await ops.setRoleOutcomes(node.id, port.options.length ? port : null);
      setDirty(false); setSuggested(false); setSaved(true);
      onChanged?.();
    } catch (e) { setError(e.message || String(e)); }
    finally { setSaving(false); }
  }

  async function suggest() {
    setSuggesting(true); setError(null);
    try {
      // In draft mode the node carries its prompt; in live mode fetch it best-effort.
      let prompt = typeof node.systemPrompt === 'string' ? node.systemPrompt : '';
      if (!prompt && mode === 'live') {
        try { const p = await apiCall('GET', `/api/agents/${node.id}/prompt`); prompt = p?.content || ''; } catch { /* best-effort */ }
      }
      const res = await apiCall('POST', '/api/agent-outcomes/suggest', {
        roleName: node.displayName || node.id, prompt,
      });
      if (res?.suggestion) {
        setOutcomes(normalize(res.suggestion));
        setDirty(true); setSaved(false); setSuggested(true);
      }
    } catch (e) { setError(e.message || String(e)); }
    finally { setSuggesting(false); }
  }

  const dupLints = (lints || []).filter(l => l.code === 'duplicate-listener' && l.nodeId === node.id);

  if (!loaded || !outcomes) {
    return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading routing…
    </div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <InputsPanel node={node} peers={peers} dupLints={dupLints} labels={labels} ops={ops} onChanged={onChanged} focus={focusSection === 'inputs'} />

      <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-medium)' }}>Outcomes</div>
          <ModeToggle value={outcomes.mode} onChange={(m) => mutate({ ...outcomes, mode: m })} />
        </div>

        {suggested && (
          <div style={banner}>
            <Sparkles size={13} /> Suggested outcomes — review and edit, then <strong>Save</strong>. Nothing is stored until you do.
          </div>
        )}

        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {outcomes.mode === 'exactlyOne'
            ? 'exactly one — the agent picks exactly one outcome per run (a switch).'
            : 'any of — zero or more outcomes may apply on a run.'}
        </div>

        {outcomes.options.length === 0 && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            How does a run of this agent end? Define outcomes so downstream agents can react —
            or let the assistant suggest them from the prompt.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          {outcomes.options.map((o, i) => (
            <OutcomeRow
              key={o.id || i}
              index={i}
              option={o}
              highlight={suggested || (focusOutcome && o.id === focusOutcome)}
              consumers={consumersFor(o, node, peers)}
              humanHandoff={outcomeHandsOffToHuman(o, labels)}
              humanReviewers={outcomeHumanReviewers(o, node, humans)}
              node={node} peers={peers} labels={labels} humans={humans}
              ops={ops} humanOps={humanOps} dirty={dirty} onChanged={onChanged}
              onChange={(next) => mutate({ ...outcomes, options: outcomes.options.map((x, j) => j === i ? next : x) })}
              onRemove={() => mutate({ ...outcomes, options: outcomes.options.filter((_, j) => j !== i) })}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
          <button onClick={() => mutate({ ...outcomes, options: [...outcomes.options, newOption()] })} style={ghost}>
            <Plus size={13} /> Add outcome
          </button>
          <button onClick={suggest} disabled={suggesting} style={ghost}>
            {suggesting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={13} />} Suggest outcomes…
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
          <button onClick={save} disabled={saving || !dirty} style={{ ...primary, opacity: dirty ? 1 : 0.6, cursor: dirty && !saving ? 'pointer' : 'default' }}>
            {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />} Save outcomes
          </button>
          {dirty && !saving && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Unsaved changes</span>}
          {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
          {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}
        </div>
      </div>

      <ArtifactsBlock node={node} peers={peers} ops={ops} humans={humans} humanOps={humanOps} onChanged={onChanged} focus={focusSection === 'artifacts'} />

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Inputs ─────────────────────────────────────────────────────────────────
// Everything that wakes this agent, in one unified list with full CRUD (#866).
function InputsPanel({ node, peers, dupLints, labels, ops, onChanged, focus }) {
  const ref = useRef(null);
  useFocusScroll(ref, focus);
  const { manual, derived } = partitionTriggers(node.triggers);
  const channels = Array.isArray(node.channels) ? node.channels : [];
  const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const nameOf = (id) => peers.find(p => p.id === id)?.displayName || id;
  const [busy, setBusy] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTrigger, setEditTrigger] = useState(null);   // manual trigger being edited
  const [editChannel, setEditChannel] = useState(null);   // channel port being edited
  const [editInput, setEditInput] = useState(null);       // data-flow input port being edited
  const [savingEdit, setSavingEdit] = useState(false);

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); onChanged?.(); }
    catch (e) { window.alert(e?.message || String(e)); }
    finally { setBusy(null); }
  };
  const removeTrigger = (tid) => { if (ops.deleteTrigger) run(`t:${tid}`, () => ops.deleteTrigger(node.id, tid)); };
  const toggleTrigger = (t) => { if (ops.updateTrigger) run(`t:${t.id}`, () => ops.updateTrigger(node.id, t.id, { enabled: t.enabled === false })); };

  const closeEdits = () => { setEditTrigger(null); setEditChannel(null); setEditInput(null); };
  const afterEdit = () => { closeEdits(); onChanged?.(); };

  const hasAny = channels.length || deps.length || inputs.length || manual.length || derived.length;

  async function saveTriggerEdit(body) {
    setSavingEdit(true);
    try { await ops.updateTrigger(node.id, editTrigger.id, body); afterEdit(); }
    finally { setSavingEdit(false); }
  }

  return (
    <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', ...(focus ? focusRing : {}) }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-medium)' }}>
        Inputs <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>— what wakes this agent</span>
      </div>
      {!hasAny && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Nothing wakes this agent yet — add an input below, or drag a hand-off onto it on the canvas.
        </div>
      )}

      {/* GitHub PR/issue channels (#380) — edit label/gate via the channel editor,
          or remove. Never edit the derived trigger raw (§1 footgun removal). */}
      {channels.map(c => {
        const key = `ch:${c.artifact}:${c.from}:${c.label || ''}`;
        const noun = c.artifact === 'pr' ? 'pull request' : 'issue';
        // Claim (#958): only a LABELLED channel derives one — an "opened" channel
        // has no wake label to take over, so the toggle would be meaningless.
        // The claim shown is READ BACK from the derived listener the backend
        // actually generated (never re-derived here): the `<wake>:wip` convention
        // has exactly one implementation, in process-template.js.
        const claimable = !!(c.label && c.label.trim());
        const autoClaim = c.autoClaim !== false;
        const claim = claimable ? (derivedChannelTrigger(derived, c)?.claim || null) : null;
        // Delivery transport (#1194): a labelled, agent-set channel may opt into
        // internal delivery (poller-excluded, woken by aee-emit). Like the claim
        // opt-out, the flag lives on the PORT (the derived trigger is regenerated).
        // A human gate stays poller-only — a person sets the label on GitHub.
        const internalable = claimable && c.gate !== 'human';
        const internal = c.transport === 'internal';
        return (
          <InputRow key={key} busy={busy === key}
            icon={c.artifact === 'pr' ? <GitPullRequest size={14} /> : <CircleDot size={14} />}
            onEdit={ops.updateChannel || ops.addChannel ? () => setEditChannel(c) : null}
            onRemove={ops.removeChannel ? () => run(key, () => ops.removeChannel(node.id, { artifact: c.artifact, from: c.from, label: c.label || '' })) : null}
            text={<>Reacts to <strong>{nameOf(c.from)}</strong>'s {noun}
              {c.label ? <> when labeled <code style={codeChip}>{c.label}</code></> : null}
              {c.gate === 'human' ? ' · 👤 human gate' : null}
              {/* Derived claim, read-only (auto) + per-listener opt-out. The flag
                  lives on the PORT because the derived trigger is regenerated on
                  every reconcile — a trigger-level flag would be wiped. */}
              {claimable ? (
                <>
                  {' · '}
                  {claim
                    ? <span title={claimTooltip(claim)}>⇥ claims <code style={codeChip}>{claim.add}</code></span>
                    : <span style={{ color: 'var(--eb-text-muted)' }}>⇥ claim off</span>}
                  {ops.updateChannel ? (
                    <button type="button" disabled={busy === key}
                      onClick={() => run(key, () => ops.updateChannel(node.id, { ...c, autoClaim: !autoClaim ? undefined : false }))}
                      title={autoClaim
                        ? 'Turn the auto-claim off for this listener — it will keep the wake label instead of taking it over.'
                        : 'Turn the auto-claim back on (derived by convention).'}
                      style={{ marginLeft: 6, background: 'none', border: 'none', padding: 0,
                        color: 'var(--eb-text-muted)', cursor: 'pointer', font: 'inherit',
                        fontSize: 'var(--eb-text-xs)', textDecoration: 'underline' }}>
                      {autoClaim ? 'disable' : 'enable'}
                    </button>
                  ) : null}
                </>
              ) : null}
              {/* Delivery transport (#1194) — read-out + inline toggle, mirroring
                  the claim opt-out. Shown only for a labelled, agent-set channel. */}
              {internalable ? (
                <>
                  {' · '}
                  {internal
                    ? <span title="Woken directly by the orchestrator (the producer runs aee-emit); the label is still mirrored onto GitHub as visible status.">⚡ internal</span>
                    : <span style={{ color: 'var(--eb-text-muted)' }}>via GitHub</span>}
                  {ops.updateChannel ? (
                    <button type="button" disabled={busy === key}
                      onClick={() => run(key, () => ops.updateChannel(node.id, { ...c, transport: internal ? undefined : 'internal' }))}
                      title={internal
                        ? 'Switch back to GitHub-poller delivery for this listener.'
                        : 'Deliver this wake directly over the internal channel (label mirrored to GitHub).'}
                      style={{ marginLeft: 6, background: 'none', border: 'none', padding: 0,
                        color: 'var(--eb-text-muted)', cursor: 'pointer', font: 'inherit',
                        fontSize: 'var(--eb-text-xs)', textDecoration: 'underline' }}>
                      {internal ? 'use GitHub' : 'make internal'}
                    </button>
                  ) : null}
                </>
              ) : null}</>} />
        );
      })}

      {/* Dependencies (node-level) — remove-only (a plain ordering link has no
          editable field). */}
      {deps.map(d => {
        const key = `dep:${d}`;
        return (
          <InputRow key={key} busy={busy === key} icon={<Link size={14} />}
            onRemove={ops.removeDependency ? () => run(key, () => ops.removeDependency(node.id, d)) : null}
            text={<>Depends on <strong>{nameOf(d)}</strong></>} />
        );
      })}

      {/* Data-flow inputs (#382) — edit the port (hint/description) or remove; the
          match key (name) is fixed so the producer link never desyncs. */}
      {inputs.map(a => {
        const key = `in:${artifactKey(a)}`;
        const h = a && typeof a === 'object' && a.name && a.hint ? a.hint : '';
        return (
          <InputRow key={key} busy={busy === key} icon={<Package size={14} />}
            onEdit={ops.addArtifact && ops.removeArtifact && a && typeof a === 'object' && a.name ? () => setEditInput(a) : null}
            onRemove={ops.removeArtifact ? () => run(key, () => ops.removeArtifact(node.id, { direction: 'input', name: a && a.name, path: a && a.path })) : null}
            text={<>Consumes artifact <code style={codeChip}>{artifactKey(a)}</code>{h ? ` · ${h}` : ''}</>} />
        );
      })}

      {/* Manual triggers (cron / once / http / github-event) — full CRUD via the
          reused TriggersPanel form (#866). */}
      {manual.map(t => (
        <ManualTriggerRow key={t.id} trigger={t} agentId={node.id} busy={busy === `t:${t.id}`}
          onEdit={ops.updateTrigger ? () => setEditTrigger(t) : null}
          onToggle={ops.updateTrigger ? () => toggleTrigger(t) : null}
          onRemove={ops.deleteTrigger ? () => removeTrigger(t.id) : null}
          nameOf={nameOf} />
      ))}

      {/* Derived triggers (channel/dataFlow) — read-only, they point back at the
          owning port row above; never edited here (§1 footgun removal). */}
      {derived.map(t => {
        const s = summarizeGithubEventTrigger(t);
        const origin = t.channel ? 'a PR/issue channel above' : 'a data-flow input above';
        return (
          <div key={t.id} style={{ ...derivedRow }}>
            <RefreshCw size={13} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                ⟲ derived from {origin} — edit it there
              </span>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                {s.events.join(', ') || t.type}{s.label ? ` · 🏷 ${s.label}` : ''}
                {/* Derived claim (#958), read-only — toggled on the owning port. */}
                {t.claim ? <span title={claimTooltip(t.claim)}> · ⇥ {t.claim.add}</span> : null}
              </span>
            </div>
          </div>
        );
      })}

      {dupLints.map((l, i) => {
        // The duplicate is the trigger standing next to the derived one — offer to
        // delete the non-derived (manual) trigger of the flagged set inline.
        const derivedIds = new Set(derived.map(t => t.id));
        const manualIds = (l.triggerIds || []).filter(id => !derivedIds.has(id));
        const target = manualIds[0] || (l.triggerIds || [])[0];
        return (
          <div key={i} style={warn}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>
              <div>{l.message || `Duplicate input${l.label ? ` on "${l.label}"` : ''}.`}</div>
              {target && ops.deleteTrigger && (
                <button onClick={() => removeTrigger(target)} disabled={busy === `t:${target}`} style={{ ...ghost, marginTop: 4, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)' }}>
                  <Trash2 size={12} /> Delete duplicate trigger
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* [+ Add input] — the single entry point onto every wake source (#866),
          sharing the canvas CreateEdgeDialog vocabulary + ops. */}
      {ops.createTrigger && (
        <button onClick={() => setAddOpen(true)} style={{ ...ghost, alignSelf: 'flex-start', marginTop: 2 }}>
          <Plus size={13} /> Add input
        </button>
      )}

      <RawTriggersDisclosure triggers={node.triggers} />

      {addOpen && (
        <AddInputDialog node={node} peers={peers} labels={labels} ops={ops}
          onClose={() => setAddOpen(false)}
          onDone={() => { setAddOpen(false); onChanged?.(); }} />
      )}

      {editTrigger && (
        <SidePanel open onClose={closeEdits} title="Edit input" width="520px">
          <TriggerForm agentId={node.id} ops={ops} initialValues={editTrigger} saving={savingEdit}
            labels={labels} onSave={saveTriggerEdit} onCancel={closeEdits} />
        </SidePanel>
      )}

      {editChannel && (
        <EditHandoffDialog
          edge={{ on: 'github', from: editChannel.from, to: node.id, artifact: editChannel.artifact, label: editChannel.label || '', gate: editChannel.gate }}
          fromName={nameOf(editChannel.from)} toName={node.displayName || node.id}
          ops={ops}
          onClose={closeEdits} onDone={afterEdit} />
      )}

      {editInput && (
        <EditArtifactInputDialog artifact={editInput} nodeId={node.id} ops={ops}
          onClose={closeEdits} onDone={afterEdit} />
      )}
    </div>
  );
}

// A manual trigger row: type icon + plain-language schedule + enabled switch +
// edit + remove. The detail editor (edit) is the reused TriggersPanel form.
const TRIGGER_ICON = { cron: Clock, once: CalendarClock, http: Globe, 'github-event': Github, 'jira-event': Workflow };
function ManualTriggerRow({ trigger, agentId, busy, onEdit, onToggle, onRemove, nameOf }) {
  const Icon = TRIGGER_ICON[trigger.type] || Github;
  const enabled = trigger.enabled !== false;
  const sources = Array.isArray(trigger.sources) ? trigger.sources : [];
  return (
    <div style={unifiedRow}>
      <span style={{ flexShrink: 0, color: 'var(--eb-text-muted)', display: 'inline-flex', marginTop: 1 }}><Icon size={14} /></span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', opacity: enabled ? 1 : 0.55 }}>
          {scheduleText(trigger, agentId)}
        </span>
        {trigger.description && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{trigger.description}</span>
        )}
        {sources.length > 0 && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>← {sources.map(nameOf).join('  ← ')}</span>
        )}
        {!enabled && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>disabled</span>}
      </div>
      {onToggle && (
        <button onClick={onToggle} disabled={busy} title={enabled ? 'Disable' : 'Enable'} style={switchBtn(enabled)}>
          <span style={switchKnob(enabled)} />
        </button>
      )}
      {onEdit && (
        <button onClick={onEdit} title="Edit input" style={iconBtn}><Pencil size={13} /></button>
      )}
      {onRemove && (
        <button onClick={onRemove} disabled={busy} title="Remove" style={iconBtn}>
          {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <X size={13} />}
        </button>
      )}
    </div>
  );
}

// Read-only "view raw triggers.json" disclosure — the workspace-transparency
// principle: the file stays the browsable truth even though editing now happens
// through the plain-language rows above (concept §6).
function RawTriggersDisclosure({ triggers }) {
  const [open, setOpen] = useState(false);
  const list = Array.isArray(triggers) ? triggers : [];
  if (!list.length) return null;
  return (
    <div style={{ marginTop: 2 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer',
        color: 'var(--eb-text-muted)', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)', padding: 0,
      }}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} View raw <code style={{ fontFamily: 'var(--eb-font-mono)' }}>triggers.json</code>
      </button>
      {open && (
        <pre style={{
          margin: '6px 0 0', maxHeight: 200, overflow: 'auto', fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)', background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
        }}>{JSON.stringify(list, null, 2)}</pre>
      )}
    </div>
  );
}

// Small port editor for a data-flow INPUT artifact (#866): the match key (name)
// is fixed — only the informative hint/description are editable, so the
// producer↔consumer name match never desyncs. Persisted as remove-then-add on
// the same key (no dedicated update op on the shared adapter).
function EditArtifactInputDialog({ artifact, nodeId, ops, onClose, onDone }) {
  const [hint, setHint] = useState(artifact.hint || '');
  const [description, setDescription] = useState(artifact.description || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setSaving(true); setError(null);
    try {
      await ops.removeArtifact(nodeId, { direction: 'input', name: artifact.name });
      await ops.addArtifact(nodeId, { direction: 'input', name: artifact.name, hint: hint.trim(), description: description.trim() || undefined });
      onDone?.();
    } catch (e) { setError(e?.message || String(e)); setSaving(false); }
  }
  return (
    <SidePanel open onClose={onClose} title="Edit artifact input" width="520px">
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0 }}>
        Consumes artifact <code style={codeChip}>{artifact.name}</code>. The name is the match key with the
        producer — edit the informative path / description only.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Path hint (optional)</span>
          <input value={hint} onChange={e => setHint(e.target.value)} placeholder="e.g. reports/analysis.md" style={input} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Description (optional)</span>
          <input value={description} onChange={e => setDescription(e.target.value)} style={input} />
        </label>
        {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={save} disabled={saving} style={primary}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

// A unified input/artifact row: kind icon + plain-language sentence + optional
// edit + remove buttons (#865/#866). Read-only rows omit both callbacks.
function InputRow({ icon, text, subtitle, onEdit, onRemove, busy }) {
  return (
    <div style={unifiedRow}>
      <span style={{ flexShrink: 0, color: 'var(--eb-text-muted)', display: 'inline-flex', marginTop: 1 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{text}</span>
        {subtitle && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{subtitle}</span>}
      </div>
      {onEdit && (
        <button onClick={onEdit} title="Edit" style={iconBtn}><Pencil size={13} /></button>
      )}
      {onRemove && (
        <button onClick={onRemove} disabled={busy} title="Remove" style={iconBtn}>
          {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <X size={13} />}
        </button>
      )}
    </div>
  );
}

// ── Artifacts ────────────────────────────────────────────────────────────────
// The data-flow outputs this agent produces (dataFlow.outputs) — name, hint,
// computed consumers, remove (#865). Below Outcomes so the reader goes
// inputs → decisions → produced artifacts top to bottom.
// A dropdown that wires an artifact delivery to a NAMED human role (#987) — the
// replacement for the #981 "a person consumes this" checkbox. Selecting a role
// adds the delivery to that role's `consumes`; switching moves it; "— none —"
// removes it. Mode-agnostic through humanOps. Hidden when no human roles exist
// (add one via the toolbar's "Add human" first).
function HumanDeliveryPicker({ humans = [], humanOps, entry, onChanged, disabled }) {
  const [busy, setBusy] = useState(false);
  if (!humanOps || !humans.length) return null;
  const current = humanConsuming(humans, entry);
  const change = async (next) => {
    if (busy || next === current) return;
    setBusy(true);
    try {
      // The engine moves the delivery between roles (unwire old, wire new).
      await moveHumanDelivery({ humanOps }, { entry, fromHuman: current, toHuman: next });
      onChanged?.();
    } catch (e) { window.alert(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
      reviewed by
      <select value={current} disabled={busy || disabled} onChange={e => change(e.target.value)}
        style={{ ...input, width: 'auto', padding: '2px 4px', fontSize: 'var(--eb-text-xs)' }}>
        <option value="">— nobody —</option>
        {humans.map(h => <option key={h.id} value={h.id}>👤 {h.name || h.id}</option>)}
      </select>
    </label>
  );
}

function ArtifactsBlock({ node, peers, ops, humans = [], humanOps, onChanged, focus }) {
  const ref = useRef(null);
  useFocusScroll(ref, focus);
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [hint, setHint] = useState('');
  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); onChanged?.(); }
    catch (e) { window.alert(e?.message || String(e)); }
    finally { setBusy(null); }
  };
  const existingKeys = new Set(outputs.map(artifactKey));
  const nm = name.trim();
  const canAdd = !!nm && !existingKeys.has(nm);
  const addArtifact = () => run('add', async () => {
    await ops.addArtifact(node.id, { direction: 'output', name: nm, hint: hint.trim() });
    setName(''); setHint(''); setAdding(false);
  });
  return (
    <div ref={ref} style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', ...(focus ? focusRing : {}) }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-medium)' }}>
        Artifacts <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>— what this agent produces</span>
      </div>
      {outputs.length === 0 && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>No output artifacts.</div>
      )}
      {outputs.map(a => {
        const key = `out:${artifactKey(a)}`;
        const h = a && typeof a === 'object' && a.name && a.hint ? a.hint : '';
        const consumers = artifactConsumers(a, node, peers);
        // Human delivery picker (#987, replaces the #981 audience checkbox): a
        // named person reads this output (a report, a review document). Wiring a
        // role clears the unconsumed-output lint and draws producer → role.
        const deliveryEntry = { artifact: 'file', name: artifactKey(a) };
        const reviewer = humanConsuming(humans, deliveryEntry);
        // Open-end marker (#1004): a declared terminal/external output is a
        // proper endpoint, not "no consumer yet".
        const marker = a && typeof a === 'object' ? (a.terminal === true ? 'terminal' : (a.external ? 'external' : null)) : null;
        const setMarker = (m) => ops.setArtifactMarker
          && run(key, () => ops.setArtifactMarker(node.id, { name: a && a.name, path: a && a.path, marker: m }));
        const subtitle = (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {marker === 'terminal' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                ⏹ Terminal by design — the end product.
                {ops.setArtifactMarker && <button type="button" onClick={() => setMarker(null)} title="Unmark" style={{ ...iconBtn, padding: 0 }}><X size={11} /></button>}
              </span>
            ) : marker === 'external' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                ↗ external{a.external && a.external.note ? `: ${a.external.note}` : ' — consumed outside this flow'}
                {ops.setArtifactMarker && <button type="button" onClick={() => setMarker(null)} title="Unmark" style={{ ...iconBtn, padding: 0 }}><X size={11} /></button>}
              </span>
            ) : consumers.length ? `consumers: ${consumers.join(', ')}${reviewer ? ' + a person' : ''}`
              : reviewer ? 'read by a person 👤' : (
                // Open-end CTA (#1004): wire a person below, or declare the end.
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  no consumer yet
                  {ops.setArtifactMarker && (
                    <>
                      — <button type="button" onClick={() => setMarker({ terminal: true })} style={{ ...ghost, padding: '1px 6px', fontSize: 'var(--eb-text-xs)' }}>mark terminal</button>
                      <button type="button" onClick={() => {
                        const note = window.prompt('Who consumes this outside the flow? (optional note)') || '';
                        setMarker({ external: note.trim() ? { note: note.trim() } : {} });
                      }} style={{ ...ghost, padding: '1px 6px', fontSize: 'var(--eb-text-xs)' }}>mark external…</button>
                    </>
                  )}
                </span>
              )}
            <HumanDeliveryPicker humans={humans} humanOps={humanOps} entry={deliveryEntry} onChanged={onChanged} disabled={busy === key} />
          </span>
        );
        return (
          <InputRow key={key} busy={busy === key} icon={<Package size={14} />}
            onRemove={ops.removeArtifact ? () => run(key, () => ops.removeArtifact(node.id, { direction: 'output', name: a && a.name, path: a && a.path })) : null}
            text={<><code style={codeChip}>{artifactKey(a)}</code>{h ? ` · ${h}` : ''}</>}
            subtitle={subtitle} />
        );
      })}

      {/* Inline "+ Add artifact" form (#866) — writes dataFlow.outputs via the
          same op the canvas artifact drag uses (matched by logical name). */}
      {ops.addArtifact && (adding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)' }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Artifact name (the match key, e.g. analysis-report)"
            style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} autoFocus />
          <input value={hint} onChange={e => setHint(e.target.value)} placeholder="Path hint (optional, e.g. reports/analysis.md)"
            style={{ ...input, fontSize: 'var(--eb-text-xs)' }} />
          {nm && existingKeys.has(nm) && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning, #d97706)' }}>An artifact named “{nm}” already exists.</span>
          )}
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button onClick={addArtifact} disabled={!canAdd || busy === 'add'} style={{ ...primary, opacity: canAdd ? 1 : 0.6, cursor: canAdd ? 'pointer' : 'default' }}>
              {busy === 'add' ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={13} />} Add
            </button>
            <button onClick={() => { setAdding(false); setName(''); setHint(''); }} style={ghost}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...ghost, alignSelf: 'flex-start' }}>
          <Plus size={13} /> Add artifact
        </button>
      ))}
    </div>
  );
}

// The "GitHub artifacts — who reviews them" block was retired (#1003, concept
// §4.2): the reviewer picker lives on the owning outcome row now, and the
// produce badge is a projection of the openPr/openIssue outcome actions.

// Scroll a focused section into view when the inspector opens on it (jump link).
function useFocusScroll(ref, focus) {
  useEffect(() => {
    if (focus && ref.current) {
      try { ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* jsdom / older browsers */ }
    }
  }, [focus]);
}

// An artifact is keyed by its logical name when set, else its path (#382).
function artifactKey(a) {
  return (typeof a === 'string' ? a : (a && (a.name || a.path))) || '';
}
// Peers that consume this output artifact (matched by logical name/path key).
function artifactConsumers(output, node, peers) {
  const key = artifactKey(output);
  const names = new Set();
  for (const p of peers) {
    if (!p || p.id === node.id) continue;
    const ins = Array.isArray(p.inputs) ? p.inputs : [];
    if (ins.some(a => artifactKey(a) === key)) names.add(p.displayName || p.id);
  }
  return [...names];
}

// ── one outcome row ──────────────────────────────────────────────────────────
// Besides editing the outcome's content (title / when / actions — explicit
// Save), the row routes its signal in place (#1003, concept §4.2): a consumer
// picker wiring the listener/channel via the engine, and — for openPr/openIssue
// actions — the reviewer picker that used to live in the retired GitHub-
// artifacts block. Routing applies immediately; content stays save-gated.
function OutcomeRow({ index, option, consumers, humanHandoff, humanReviewers = [], highlight, node, peers = [], labels = [], humans = [], ops, humanOps, dirty, onChanged, onChange, onRemove }) {
  const actions = Array.isArray(option.actions) && option.actions.length ? option.actions : [{ type: 'none' }];
  const setActions = (next) => onChange({ ...option, actions: next });
  const isNone = actions.every(a => a.type === 'none');
  const [busy, setBusy] = useState(false);
  const [wireError, setWireError] = useState(null);

  const artifact = rowArtifact(option);
  const wireSpec = wireConsumerSpec(option);
  const wired = currentConsumers(option, node, peers);
  const wiredIds = new Set(wired.map(w => w.id));
  const candidates = consumerCandidates(node, peers).filter(c => !wiredIds.has(c.id));

  const run = async (fn) => {
    setBusy(true); setWireError(null);
    try { await fn(); onChanged?.(); }
    catch (e) { setWireError(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const wireTo = (targetId) => run(async () => {
    const target = peers.find(p => p.id === targetId);
    if (wireSpec.kind === 'label') {
      await wireLabelHandoff({ ops }, {
        from: node.id, to: targetId, label: wireSpec.label, labels,
        fromName: node.displayName || node.id, toName: target?.displayName || targetId,
      });
    } else {
      await wireChannel({ ops }, { from: node.id, to: targetId, artifact: wireSpec.artifact });
    }
  });
  const unwire = (w) => run(async () => {
    if (w.spec.kind === 'label') {
      await unwireLabelHandoff({ ops }, {
        from: node.id, to: w.id, triggerId: w.spec.triggerId, label: w.spec.label,
        removeListener: true, removeEmit: false, // the emit IS this outcome — keep it
      });
    } else {
      await unwireChannel({ ops }, { from: node.id, to: w.id, artifact: w.spec.artifact, label: w.spec.label || '' });
    }
  });

  // Routing is disabled while the outcome content has unsaved edits — the
  // engine must wire against the persisted label/action, not a draft.
  const routingDisabled = busy || dirty;
  // Open-end markers (#1004, concept §4.7): a declared endpoint is content
  // (edited via onChange + explicit Save), not wiring.
  const marker = option.terminal === true ? 'terminal' : (option.external ? 'external' : null);
  const noConsumerYet = !isNone && !humanHandoff && !marker && !wired.length && !humanReviewers.length;

  return (
    <div style={{ ...rowBox, ...(highlight ? { borderColor: 'var(--eb-accent-primary)', boxShadow: '0 0 0 1px var(--eb-accent-primary)' } : {}) }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', minWidth: 16 }}>{index + 1}.</span>
        <input value={option.title || ''} placeholder="Outcome title (e.g. Accepted)"
          onChange={e => onChange({ ...option, title: e.target.value })} style={{ ...input, flex: 1 }} />
        <button onClick={onRemove} title="Remove outcome" style={iconBtn}><X size={13} /></button>
      </div>
      <input value={option.when || ''} placeholder="when: the condition this outcome is chosen (free text)"
        onChange={e => onChange({ ...option, when: e.target.value })} style={{ ...input, fontSize: 'var(--eb-text-xs)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {actions.map((a, i) => (
          <ActionRow key={i} action={a}
            onChange={(na) => setActions(actions.map((x, j) => j === i ? na : x))}
            onRemove={actions.length > 1 ? () => setActions(actions.filter((_, j) => j !== i)) : null} />
        ))}
        <button onClick={() => setActions([...actions.filter(a => a.type !== 'none'), { type: 'setLabel', label: '' }])} style={{ ...ghost, alignSelf: 'flex-start' }}>
          <Plus size={12} /> Add action
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {isNone
          ? 'Terminal outcome — no signal (dead-end by design).'
          : humanHandoff
            // Brake label (#981): the hand-off to a person IS the consumer.
            ? <>hands off to a person 👤 — the flow pauses for a decision{consumers.length ? <> · also wakes {consumers.join(', ')}</> : null}</>
            : (
              <>
                {marker === 'terminal' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    ⏹ Terminal by design — the end product.
                    <button type="button" onClick={() => { const { terminal, ...rest } = option; onChange(rest); }}
                      title="Unmark — this outcome is not the end product" style={{ ...iconBtn, padding: 0 }}><X size={11} /></button>
                  </span>
                )}
                {marker === 'external' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    ↗ external:
                    <input value={option.external?.note || ''} placeholder="who consumes this (e.g. CI workflow)"
                      onChange={e => onChange({ ...option, external: e.target.value ? { note: e.target.value } : {} })}
                      style={{ ...input, width: 180, padding: '1px 4px', fontSize: 'var(--eb-text-xs)' }} />
                    <button type="button" onClick={() => { const { external, ...rest } = option; onChange(rest); }}
                      title="Unmark — this outcome is consumed inside this flow" style={{ ...iconBtn, padding: 0 }}><X size={11} /></button>
                  </span>
                )}
                {noConsumerYet && (
                  // Open-end CTA (#1004): three ways to close the question —
                  // wire a consumer, or declare the open end intentional.
                  <>
                    <span style={{ color: 'var(--eb-status-warning, #d97706)' }}>no consumer yet —</span>
                    <button type="button" onClick={() => onChange({ ...option, terminal: true })}
                      style={{ ...ghost, padding: '1px 6px', fontSize: 'var(--eb-text-xs)' }}>mark terminal</button>
                    <button type="button" onClick={() => onChange({ ...option, external: {} })}
                      style={{ ...ghost, padding: '1px 6px', fontSize: 'var(--eb-text-xs)' }}>mark external…</button>
                  </>
                )}
                {wired.map(w => (
                  <span key={w.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    wakes <strong>{w.name}</strong>
                    <button type="button" onClick={() => unwire(w)} disabled={routingDisabled}
                      title={`Stop waking ${w.name}`} style={{ ...iconBtn, padding: 0 }}><X size={11} /></button>
                  </span>
                ))}
                {wireSpec && candidates.length > 0 && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {wired.length ? 'also wake' : 'wake'}
                    <select value="" disabled={routingDisabled} onChange={e => e.target.value && wireTo(e.target.value)}
                      style={{ ...input, width: 'auto', padding: '2px 4px', fontSize: 'var(--eb-text-xs)' }}>
                      <option value="">— pick an agent —</option>
                      {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                )}
                {artifact && (
                  // Reviewer binding, per row (#1003 — replaces the retired
                  // GitHub-artifacts block): which person reviews the PR/issue.
                  <HumanDeliveryPicker humans={humans} humanOps={humanOps}
                    entry={{ artifact, from: node.id }} onChanged={onChanged} disabled={routingDisabled} />
                )}
              </>
            )}
        {dirty && !isNone && !humanHandoff && (
          <span style={{ color: 'var(--eb-text-muted)' }}>(save outcomes to route)</span>
        )}
        {wireError && <span style={{ color: 'var(--eb-status-error)' }}>{wireError}</span>}
      </div>
    </div>
  );
}

function ActionRow({ action, onChange, onRemove }) {
  const type = ACTION_TYPES.includes(action.type) ? action.type : 'setLabel';
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select value={type} onChange={e => onChange(e.target.value === 'setLabel' ? { type: 'setLabel', label: action.label || '' } : { type: e.target.value })}
        style={{ ...input, width: 130, flexShrink: 0 }}>
        <option value="setLabel">set label</option>
        <option value="openPr">open PR</option>
        <option value="openIssue">open issue</option>
        <option value="none">no signal</option>
      </select>
      {type === 'setLabel' && (
        <input value={action.label || ''} placeholder="label" onChange={e => onChange({ type: 'setLabel', label: e.target.value })}
          style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} />
      )}
      {onRemove && <button onClick={onRemove} title="Remove action" style={iconBtn}><X size={12} /></button>}
    </div>
  );
}

function ModeToggle({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 12, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
      <label style={radio}><input type="radio" checked={value === 'exactlyOne'} onChange={() => onChange('exactlyOne')} /> exactly one ◇</label>
      <label style={radio}><input type="radio" checked={value === 'anyOf'} onChange={() => onChange('anyOf')} /> any of</label>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────
const ACTION_TYPES = ['setLabel', 'openPr', 'openIssue', 'none'];

function emptyPort() { return { mode: 'anyOf', options: [] }; }
function normalize(oc) {
  if (!oc || typeof oc !== 'object' || !Array.isArray(oc.options)) return emptyPort();
  return {
    mode: oc.mode === 'exactlyOne' ? 'exactlyOne' : 'anyOf',
    options: oc.options.map(o => ({
      id: o.id, title: o.title || '', when: o.when || '',
      actions: Array.isArray(o.actions) && o.actions.length ? o.actions.map(a => ({ ...a })) : [{ type: 'none' }],
      ...(o.notify ? { notify: o.notify } : {}),
      // #1037: hydrate the open-end marker so a persisted terminal/external
      // outcome re-displays (previously dropped here, so it never re-showed).
      ...openEndMarker(o),
    })),
  };
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
function newOption() {
  // No id yet — finalize() derives a stable id from the title on Save (falling
  // back to outcome-<n> for a still-blank title), so a titled outcome persists as
  // a readable slug (e.g. "Route to Developer" → "route-to-developer").
  return { id: '', title: '', when: '', actions: [{ type: 'setLabel', label: '' }] };
}
// Produce the persisted port: assign missing ids from title, drop empty setLabel
// actions, keep only well-formed options. Server-side validateOutcomes is the gate.
function finalize(oc) {
  const seen = new Set();
  const options = (oc.options || []).map((o, i) => {
    let id = o.id && slug(o.id) ? slug(o.id) : (slug(o.title) || `outcome-${i + 1}`);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const actions = (Array.isArray(o.actions) ? o.actions : [])
      .map(a => a.type === 'setLabel' ? { type: 'setLabel', label: String(a.label || '').trim() } : { type: a.type })
      .filter(a => a.type !== 'setLabel' || a.label);
    return {
      id,
      ...(o.title && o.title.trim() ? { title: o.title.trim() } : {}),
      ...(o.when && o.when.trim() ? { when: o.when.trim() } : {}),
      actions: actions.length ? actions : [{ type: 'none' }],
      ...(o.notify ? { notify: o.notify } : {}),
      // #1037: carry the open-end marker into the persisted port so the
      // declared endpoint survives Save (previously dropped before the payload).
      ...openEndMarker(o),
    };
  });
  return { mode: oc.mode === 'exactlyOne' ? 'exactlyOne' : 'anyOf', options };
}

// `consumersFor` (derived, read-only consumers of an outcome) moved to the pure
// ./outcome-consumers.js module in #963 so the read-only Outcomes tab in the
// Agent-Chat right rail derives the same consumer set from the same code.
// Imported above.

const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const ghost = {
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '4px 9px', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)', cursor: 'pointer',
};
const primary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
};
const iconBtn = { background: 'none', border: 'none', color: 'var(--eb-text-muted)', cursor: 'pointer', display: 'inline-flex', padding: 2 };
// Compact enabled switch for a manual-trigger row (mirrors TriggersPanel's).
const switchBtn = (on) => ({
  width: 28, height: 16, borderRadius: 'var(--eb-radius-full)', border: 'none', flexShrink: 0,
  background: on ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
  position: 'relative', cursor: 'pointer', padding: 0, alignSelf: 'center',
});
const switchKnob = (on) => ({
  position: 'absolute', top: 2, left: on ? 12 : 2, width: 12, height: 12,
  borderRadius: '50%', background: 'white',
});
const rowBox = { display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)' };
const unifiedRow = { display: 'flex', alignItems: 'flex-start', gap: 8, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)' };
const derivedRow = { display: 'flex', alignItems: 'flex-start', gap: 8, borderLeft: '2px solid var(--eb-border-default)', paddingLeft: 'var(--eb-space-2)', marginLeft: 6 };
const codeChip = { fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-sm)', padding: '0 4px' };
const focusRing = { borderRadius: 'var(--eb-radius-md)', boxShadow: '0 0 0 2px var(--eb-accent-primary)', padding: 'var(--eb-space-2)' };
const check = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' };
const radio = { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' };
const banner = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-accent-primary)',
  background: 'var(--eb-accent-primary-soft, rgba(99,102,241,0.1))', border: '1px solid var(--eb-accent-primary)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
};
const warn = {
  display: 'flex', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning, #d97706)',
  background: 'rgba(217,119,6,0.08)', border: '1px solid var(--eb-status-warning, #d97706)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
};
