import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X, Trash2, Sparkles, Save, Loader2, AlertTriangle,
  GitPullRequest, CircleDot, Link, RefreshCw, Package, ChevronDown, ChevronRight } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import { summarizeGithubEventTrigger } from '../agent-chat/trigger-summary.js';

// Routing tab (#828, agent-outcomes concept §5.2; absorbs the retired
// Connections tab in #865) — ONE place for an agent's whole routing decision.
// Shared by the draft + live inspector through the same `ops` adapter; nothing
// branches on mode.
//
//   INPUTS   — what wakes this agent, in one unified list: the GitHub PR/issue
//              channels it reacts to (channels[]), its data-flow inputs +
//              dependencies (dataFlow.inputs / dependsOn), the manual
//              github-event listeners with their contributing `sources`, and the
//              derived (channel/dataFlow) triggers shown read-only as
//              "⟲ derived from connection" rows that point at their owning port.
//              The `duplicate-listener` lint offers an inline delete. The
//              port rows (channels/inputs/deps) are remove-only in this phase.
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
export default function RoutingSection({ node, peers = [], lints = [], ops, onChanged, focusOutcome = null, focusSection = null, mode }) {
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
      <InputsPanel node={node} peers={peers} dupLints={dupLints} ops={ops} onChanged={onChanged} focus={focusSection === 'inputs'} />

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

        {outcomes.options.length === 0 && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            No outcomes yet — add one, or let the assistant suggest a set from this agent's prompt.
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

      <ArtifactsBlock node={node} peers={peers} ops={ops} onChanged={onChanged} focus={focusSection === 'artifacts'} />

      <LegacyDisclosure node={node} ops={ops} onChanged={onChanged} focus={focusSection === 'legacy'} />

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Inputs ─────────────────────────────────────────────────────────────────
// Everything that wakes this agent, in one unified list (#865): the PR/issue
// channels + data-flow inputs + dependencies it reacts to (remove-only ports),
// the manual github-event listeners, and the derived triggers shown read-only.
function InputsPanel({ node, peers, dupLints, ops, onChanged, focus }) {
  const ref = useRef(null);
  useFocusScroll(ref, focus);
  const listeners = (node.triggers || []).filter(t => t && t.type === 'github-event');
  const derived = listeners.filter(t => t.channel || t.dataFlow);
  const manual = listeners.filter(t => !t.channel && !t.dataFlow);
  const channels = Array.isArray(node.channels) ? node.channels : [];
  const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const nameOf = (id) => peers.find(p => p.id === id)?.displayName || id;
  const [busy, setBusy] = useState(null);

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); onChanged?.(); }
    catch (e) { window.alert(e?.message || String(e)); }
    finally { setBusy(null); }
  };
  const removeTrigger = (tid) => { if (ops.deleteTrigger) run(`t:${tid}`, () => ops.deleteTrigger(node.id, tid)); };

  const hasAny = channels.length || deps.length || inputs.length || manual.length || derived.length;

  return (
    <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', ...(focus ? focusRing : {}) }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-medium)' }}>
        Inputs <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)' }}>— what wakes this agent</span>
      </div>
      {!hasAny && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Nothing wakes this agent yet — drag a connection onto it on the canvas.
        </div>
      )}

      {/* GitHub PR/issue channels (#380) — remove-only in this phase. */}
      {channels.map(c => {
        const key = `ch:${c.artifact}:${c.from}:${c.label || ''}`;
        const noun = c.artifact === 'pr' ? 'pull request' : 'issue';
        return (
          <InputRow key={key} busy={busy === key}
            icon={c.artifact === 'pr' ? <GitPullRequest size={14} /> : <CircleDot size={14} />}
            onRemove={ops.removeChannel ? () => run(key, () => ops.removeChannel(node.id, { artifact: c.artifact, from: c.from, label: c.label || '' })) : null}
            text={<>Reacts to <strong>{nameOf(c.from)}</strong>'s {noun}
              {c.label ? <> when labeled <code style={codeChip}>{c.label}</code></> : null}
              {c.gate === 'human' ? ' · 👤 human gate' : null}</>} />
        );
      })}

      {/* Dependencies (node-level) — remove-only. */}
      {deps.map(d => {
        const key = `dep:${d}`;
        return (
          <InputRow key={key} busy={busy === key} icon={<Link size={14} />}
            onRemove={ops.removeDependency ? () => run(key, () => ops.removeDependency(node.id, d)) : null}
            text={<>Depends on <strong>{nameOf(d)}</strong></>} />
        );
      })}

      {/* Data-flow inputs (#382) — remove-only. */}
      {inputs.map(a => {
        const key = `in:${artifactKey(a)}`;
        const h = a && typeof a === 'object' && a.name && a.hint ? a.hint : '';
        return (
          <InputRow key={key} busy={busy === key} icon={<Package size={14} />}
            onRemove={ops.removeArtifact ? () => run(key, () => ops.removeArtifact(node.id, { direction: 'input', name: a && a.name, path: a && a.path })) : null}
            text={<>Consumes artifact <code style={codeChip}>{artifactKey(a)}</code>{h ? ` · ${h}` : ''}</>} />
        );
      })}

      {/* Manual github-event listeners — the raw triggers not derived from a port. */}
      {manual.map(t => {
        const s = summarizeGithubEventTrigger(t);
        const sources = Array.isArray(t.sources) ? t.sources : [];
        return (
          <div key={t.id} style={listenerRow}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{s.events.join(', ') || t.type}</span>
              {s.label && <span style={labelChip}>🏷 {s.label}</span>}
            </div>
            {sources.length > 0 && (
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                ← {sources.map(nameOf).join('  ← ')}
              </div>
            )}
          </div>
        );
      })}

      {/* Derived triggers (channel/dataFlow) — read-only, they point back at the
          owning port row above; never edited here (#865). */}
      {derived.map(t => {
        const s = summarizeGithubEventTrigger(t);
        const origin = t.channel ? 'a PR/issue channel above' : 'a data-flow input above';
        return (
          <div key={t.id} style={{ ...derivedRow }}>
            <RefreshCw size={13} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                ⟲ derived from {origin}
              </span>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                {s.events.join(', ') || t.type}{s.label ? ` · 🏷 ${s.label}` : ''}
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
              <div>{l.message || `Duplicate listener${l.label ? ` on "${l.label}"` : ''}.`}</div>
              {target && ops.deleteTrigger && (
                <button onClick={() => removeTrigger(target)} disabled={busy === `t:${target}`} style={{ ...ghost, marginTop: 4, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)' }}>
                  <Trash2 size={12} /> Delete duplicate trigger
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A unified input/artifact row: kind icon + plain-language sentence + optional
// remove button (#865). Remove-only ports use this; read-only rows omit onRemove.
function InputRow({ icon, text, subtitle, onRemove, busy }) {
  return (
    <div style={unifiedRow}>
      <span style={{ flexShrink: 0, color: 'var(--eb-text-muted)', display: 'inline-flex', marginTop: 1 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{text}</span>
        {subtitle && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{subtitle}</span>}
      </div>
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
function ArtifactsBlock({ node, peers, ops, onChanged, focus }) {
  const ref = useRef(null);
  useFocusScroll(ref, focus);
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  const [busy, setBusy] = useState(null);
  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); onChanged?.(); }
    catch (e) { window.alert(e?.message || String(e)); }
    finally { setBusy(null); }
  };
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
        return (
          <InputRow key={key} busy={busy === key} icon={<Package size={14} />}
            onRemove={ops.removeArtifact ? () => run(key, () => ops.removeArtifact(node.id, { direction: 'output', name: a && a.name, path: a && a.path })) : null}
            text={<><code style={codeChip}>{artifactKey(a)}</code>{h ? ` · ${h}` : ''}</>}
            subtitle={consumers.length ? `consumers: ${consumers.join(', ')}` : 'no consumer yet'} />
        );
      })}
    </div>
  );
}

// ── Legacy ───────────────────────────────────────────────────────────────────
// Collapsed disclosure holding the emitted-labels editor and the GitHub-outputs
// checkboxes, relocated from the retired Connections tab so nothing is lost
// mid-transition (#865); these move to their final home in phase 3.
function LegacyDisclosure({ node, ops, onChanged, focus }) {
  const ref = useRef(null);
  useFocusScroll(ref, focus);
  const [open, setOpen] = useState(!!focus);
  useEffect(() => { if (focus) setOpen(true); }, [focus]);
  const gh = node.github || {};
  const [producesPr, setPr] = useState(!!gh.producesPr);
  const [producesIssue, setIssue] = useState(!!gh.producesIssue);
  const hasEmits = !!ops.setRoleEmits;
  const hasGithub = !!ops.setGithubProduces;
  if (!hasEmits && !hasGithub) return null;

  const saveProduces = async (pr, issue) => {
    setPr(pr); setIssue(issue);
    try { await ops.setGithubProduces(node.id, { pr, issue }); onChanged?.(); }
    catch (e) { window.alert(e?.message || String(e)); }
  };

  return (
    <div ref={ref} style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)', ...(focus ? focusRing : {}) }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer',
        color: 'var(--eb-text-secondary)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', padding: 0,
      }}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Legacy
        <span style={{ fontWeight: 'normal', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>
          — emitted labels &amp; GitHub outputs (moving in a later phase)
        </span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', marginTop: 'var(--eb-space-3)' }}>
          {hasEmits && <EmitsEditor node={node} ops={ops} onChanged={onChanged} />}
          {hasGithub && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>GitHub outputs</div>
              <label style={check}>
                <input type="checkbox" checked={producesPr} onChange={e => saveProduces(e.target.checked, producesIssue)} />
                Opens pull requests
              </label>
              <label style={check}>
                <input type="checkbox" checked={producesIssue} onChange={e => saveProduces(producesPr, e.target.checked)} />
                Opens issues
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Role-level emits editor (#414), relocated from ConnectionsSection (#865): the
// labels this agent sets during its work, independent of any trigger.
function EmitsEditor({ node, ops, onChanged }) {
  const [emits, setEmits] = useState(Array.isArray(node.emits) ? node.emits : []);
  const [newLabel, setNewLabel] = useState('');
  const save = async (next) => {
    try {
      await ops.setRoleEmits(node.id, next);
      setEmits(next);
      onChanged?.();
    } catch (e) { window.alert(e?.message || String(e)); }
  };
  const add = () => {
    const l = newLabel.trim();
    if (l && !emits.includes(l)) save([...emits, l]);
    setNewLabel('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Emits labels</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {emits.map(l => (
          <button key={l} onClick={() => save(emits.filter(x => x !== l))} title="Remove" style={{
            fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
            background: '#3b82f61a', color: '#3b82f6', border: '1px solid #3b82f6',
            borderRadius: 'var(--eb-radius-sm)', padding: '0 5px', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 3,
          }}>{l} <X size={10} /></button>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="add label…" style={{ ...input, width: 130, padding: '1px 6px', fontSize: 'var(--eb-text-xs)' }} />
          <button onClick={add} title="Add emitted label" style={{
            background: 'none', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: '1px 5px', cursor: 'pointer', color: 'var(--eb-text-secondary)', display: 'inline-flex',
          }}><Plus size={11} /></button>
        </span>
      </div>
    </div>
  );
}

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
function OutcomeRow({ index, option, consumers, highlight, onChange, onRemove }) {
  const actions = Array.isArray(option.actions) && option.actions.length ? option.actions : [{ type: 'none' }];
  const setActions = (next) => onChange({ ...option, actions: next });
  const isNone = actions.every(a => a.type === 'none');
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
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {isNone
          ? 'Terminal outcome — no signal (dead-end by design).'
          : consumers.length
            ? <>consumers: {consumers.join(', ')}</>
            : <span style={{ color: 'var(--eb-status-warning, #d97706)' }}>no consumer — nothing listens for this outcome's signal</span>}
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
    };
  });
  return { mode: oc.mode === 'exactlyOne' ? 'exactlyOne' : 'anyOf', options };
}

// Derived, read-only consumers of an outcome: peers that listen on any label the
// outcome sets, or (openPr/openIssue) consume a channel from this node.
function consumersFor(option, node, peers) {
  const names = new Set();
  const labels = (option.actions || []).filter(a => a.type === 'setLabel' && a.label).map(a => a.label);
  const opensPr = (option.actions || []).some(a => a.type === 'openPr');
  const opensIssue = (option.actions || []).some(a => a.type === 'openIssue');
  for (const p of peers) {
    if (p.id === node.id) continue;
    const listensLabel = (p.triggers || []).some(t => typeof t.labelFilter === 'string' && labels.includes(t.labelFilter));
    const chans = Array.isArray(p.channels) ? p.channels : [];
    const consumesPr = opensPr && chans.some(c => c.artifact === 'pr' && c.from === node.id);
    const consumesIssue = opensIssue && chans.some(c => c.artifact === 'issue' && c.from === node.id);
    if (listensLabel || consumesPr || consumesIssue) names.add(p.displayName || p.id);
  }
  return [...names];
}

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
const rowBox = { display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)' };
const listenerRow = { display: 'flex', flexDirection: 'column', gap: 2, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)' };
const unifiedRow = { display: 'flex', alignItems: 'flex-start', gap: 8, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)' };
const derivedRow = { display: 'flex', alignItems: 'flex-start', gap: 8, borderLeft: '2px solid var(--eb-border-default)', paddingLeft: 'var(--eb-space-2)', marginLeft: 6 };
const codeChip = { fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-sm)', padding: '0 4px' };
const focusRing = { borderRadius: 'var(--eb-radius-md)', boxShadow: '0 0 0 2px var(--eb-accent-primary)', padding: 'var(--eb-space-2)' };
const check = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' };
const labelChip = { fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-secondary)' };
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
