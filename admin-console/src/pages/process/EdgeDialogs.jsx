import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { liveOps } from './edit-adapters';

// Only these GitHub events carry a label name, so a labelFilter is meaningful.
const LABEL_EVENTS = [
  { value: 'issues.labeled', label: 'Issue labeled' },
  { value: 'pull_request.labeled', label: 'PR labeled' },
  { value: 'issues.unlabeled', label: 'Issue unlabeled' },
  { value: 'pull_request.unlabeled', label: 'PR unlabeled' },
];
const FROM_OPTIONS = ['any-except-self', 'humans', 'agents', 'team'];

const uniq = (arr) => [...new Set(arr)];

function firstRepo(...triggerLists) {
  for (const list of triggerLists) {
    for (const t of list || []) {
      if (t.type === 'github-event' && t.repo) return t.repo;
    }
  }
  return '';
}

/* ── Create a hand-off: emitter A → label → listener B ─────────────────── */
export function CreateHandoffDialog({ from, to, fromName, toName, labels, ops = liveOps, onClose, onDone }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [fromTriggers, setFromTriggers] = useState([]);
  const [toTriggers, setToTriggers] = useState([]);

  const [label, setLabel] = useState('');
  const [events, setEvents] = useState(['issues.labeled']);
  const [fromFilter, setFromFilter] = useState('any-except-self');
  const [emitterId, setEmitterId] = useState('');
  const [repo, setRepo] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [ft, tt] = await Promise.all([
          ops.listTriggers(from),
          ops.listTriggers(to),
        ]);
        if (!alive) return;
        const fl = Array.isArray(ft) ? ft : [];
        const tl = Array.isArray(tt) ? tt : [];
        setFromTriggers(fl);
        setToTriggers(tl);
        setEmitterId(fl[0]?.id || '');
        setRepo(firstRepo(fl, tl));
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [from, to]);

  // Keep a sensible default listener prompt in sync with label/repo.
  useEffect(() => {
    setPrompt(p => p || '');
  }, []);
  const effectivePrompt = prompt
    || `An issue in \`${repo || '<repo>'}\` was labeled \`${label || '<label>'}\`. The event payload above has the issue number, title and body.\n\n<Describe what this agent should do.> Reply \`[PASS]\` if there's nothing to do.`;

  const toggleEvent = (v) => setEvents(prev =>
    prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);

  // Human gates (human:*) and the universal brakes are set by humans, never by
  // an agent — so we wire only the listener, never an agent emit (#333).
  const isGate = label.trim().startsWith('human:');
  const isBrake = label.trim() === 'hold' || label.trim() === 'needs:human';
  const humanLabel = isGate || isBrake;

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed) { setError('Pick or type a hand-off label.'); return; }
    if (events.length === 0) { setError('Select at least one event.'); return; }
    if (!humanLabel && !emitterId) { setError('Pick which trigger on the source emits this label.'); return; }
    setSaving(true); setError(null);
    try {
      // 1. Listener on B — skip if one already filters on this label.
      const existing = toTriggers.find(t => t.type === 'github-event' && t.labelFilter === trimmed);
      if (!existing) {
        await ops.createTrigger(to, {
          type: 'github-event',
          events,
          from: fromFilter,
          repo: repo || undefined,
          labelFilter: trimmed,
          enabled: true,
          description: humanLabel
            ? `Wait for human gate \`${trimmed}\``
            : `Wake on \`${trimmed}\` (wired from ${fromName || from})`,
          prompt: effectivePrompt,
        });
      }
      // 2. Record the emission on A's chosen trigger — but never for a human
      // gate/brake (the lint would flag an agent that claims to set it).
      if (!humanLabel) {
        const emitter = fromTriggers.find(t => t.id === emitterId);
        const nextEmits = uniq([...(emitter?.emits || []), trimmed]);
        await ops.setEmits(from, emitterId, nextEmits);
      }
      onDone?.();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <SidePanel open onClose={onClose} title="Wire a hand-off" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> emits a label that wakes <strong>{toName || to}</strong>.
      </p>
      {loading ? (
        <Center><Loader2 size={14} style={spin} /> Loading triggers…</Center>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <Field label="Hand-off label">
            <input list="pc-label-list" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="e.g. dispatch, stage:td, assigned:dev-1" style={input} />
            <datalist id="pc-label-list">
              {(labels || []).map(l => <option key={l.name} value={l.name} />)}
            </datalist>
          </Field>

          {humanLabel ? (
            <div style={{ ...small, padding: 'var(--eb-space-2)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-warning)' }}>
              <code>{label.trim()}</code> is a {isGate ? 'human gate' : 'brake'} — only a human sets it.
              This wires <strong>{toName || to}</strong> to wait on it; no agent is recorded as emitting it.
            </div>
          ) : (
            <Field label={`Emitting trigger on ${fromName || from}`}>
              <select value={emitterId} onChange={e => setEmitterId(e.target.value)} style={input}>
                {fromTriggers.length === 0 && <option value="">(no triggers — add one first)</option>}
                {fromTriggers.map(t => (
                  <option key={t.id} value={t.id}>{t.id} · {t.type}</option>
                ))}
              </select>
              <small style={small}>The label is added to this trigger's <code>emits</code>.</small>
            </Field>
          )}

          <Field label="Listener events (on target)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
              {LABEL_EVENTS.map(ev => (
                <label key={ev.value} style={check}>
                  <input type="checkbox" checked={events.includes(ev.value)} onChange={() => toggleEvent(ev.value)} />
                  {ev.label}
                </label>
              ))}
            </div>
          </Field>

          <Field label="Origin filter (from)">
            <select value={fromFilter} onChange={e => setFromFilter(e.target.value)} style={input}>
              {FROM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>

          <Field label="Repo">
            <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/name" style={input} />
          </Field>

          <Field label="Listener prompt">
            <textarea value={effectivePrompt} onChange={e => setPrompt(e.target.value)}
              style={{ ...input, minHeight: 120, fontFamily: 'var(--eb-font-mono)', resize: 'vertical' }} />
          </Field>

          {error && <span style={errStyle}>{error}</span>}

          <div style={actions}>
            <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
            <button onClick={submit} disabled={saving} style={primary}>
              {saving ? 'Wiring…' : 'Create hand-off'}
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

/* ── on-type picker: choose how A hands off to B (#367) ─────────────────────
 * Label hand-off delegates to CreateHandoffDialog (unchanged). Dependency and
 * data-flow are BP mechanisms, written via the draft ops onto node ports. */
export function CreateEdgeDialog({ from, to, fromName, toName, labels, ops = liveOps, types, onClose, onDone }) {
  const allowed = Array.isArray(types) && types.length ? types : ['label', 'dependency', 'artifact'];
  const [type, setType] = useState(allowed.length === 1 ? allowed[0] : null);

  if (type === 'label') {
    return (
      <CreateHandoffDialog
        from={from} to={to} fromName={fromName} toName={toName}
        labels={labels} ops={ops} onClose={onClose} onDone={onDone}
      />
    );
  }
  if (type === 'dependency') {
    return (
      <DependencyEdgeForm from={from} to={to} fromName={fromName} toName={toName}
        ops={ops} onBack={() => setType(null)} onClose={onClose} onDone={onDone} />
    );
  }
  if (type === 'artifact') {
    return (
      <ArtifactEdgeForm from={from} to={to} fromName={fromName} toName={toName}
        ops={ops} onBack={() => setType(null)} onClose={onClose} onDone={onDone} />
    );
  }
  if (type === 'hierarchy') {
    return (
      <HierarchyEdgeForm from={from} to={to} fromName={fromName} toName={toName}
        ops={ops} onBack={() => setType(null)} onClose={onClose} onDone={onDone} />
    );
  }

  const choices = [
    { id: 'label', title: 'Label hand-off', desc: `${fromName || from} emits a label that wakes ${toName || to}.` },
    { id: 'dependency', title: 'Dependency', desc: `${toName || to} depends on ${fromName || from} — it can't start until that is done.` },
    { id: 'artifact', title: 'Data flow', desc: `${fromName || from} produces a file that ${toName || to} consumes.` },
    { id: 'hierarchy', title: 'Parent / child', desc: `${fromName || from} groups ${toName || to} as a child — it inherits its parent's stage.` },
  ].filter(c => allowed.includes(c.id));

  return (
    <SidePanel open onClose={onClose} title="Connect roles" width="520px">
      <p style={hint}>
        How does <strong>{fromName || from}</strong> hand off to <strong>{toName || to}</strong>?
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        {choices.map(c => (
          <button key={c.id} onClick={() => setType(c.id)} style={{
            textAlign: 'left', background: 'var(--eb-bg-app)', cursor: 'pointer',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-3)', fontFamily: 'inherit',
          }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>{c.title}</div>
            <div style={{ ...small, marginTop: 2 }}>{c.desc}</div>
          </button>
        ))}
      </div>
    </SidePanel>
  );
}

function DependencyEdgeForm({ from, to, fromName, toName, ops, onBack, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    setSaving(true); setError(null);
    try { await ops.addDependency(to, from); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }
  return (
    <SidePanel open onClose={onClose} title="Add dependency" width="520px">
      <p style={hint}>
        <strong>{toName || to}</strong> depends on <strong>{fromName || from}</strong>.
        It becomes ready only once <strong>{fromName || from}</strong> is complete.
      </p>
      {error && <span style={errStyle}>{error}</span>}
      <div style={actions}>
        <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>
        <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
        <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Adding…' : 'Add dependency'}</button>
      </div>
    </SidePanel>
  );
}

function ArtifactEdgeForm({ from, to, fromName, toName, ops, onBack, onClose, onDone }) {
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    const p = path.trim();
    if (!p) { setError('Enter the artifact path.'); return; }
    setSaving(true); setError(null);
    try {
      await ops.addArtifact(from, { direction: 'output', path: p, description });
      await ops.addArtifact(to, { direction: 'input', path: p, description });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }
  return (
    <SidePanel open onClose={onClose} title="Add data flow" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> produces a file that <strong>{toName || to}</strong> consumes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Artifact path">
          <input value={path} onChange={e => setPath(e.target.value)}
            placeholder="e.g. artifacts/spec.md" style={input} />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={e => setDescription(e.target.value)}
            placeholder="What this file carries" style={input} />
        </Field>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Adding…' : 'Add data flow'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

function HierarchyEdgeForm({ from, to, fromName, toName, ops, onBack, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    setSaving(true); setError(null);
    try { await ops.setParent(to, from); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }
  return (
    <SidePanel open onClose={onClose} title="Set parent" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> becomes the parent of <strong>{toName || to}</strong>.
        Children inherit their parent's stage by default and can override it.
      </p>
      {error && <span style={errStyle}>{error}</span>}
      <div style={actions}>
        <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>
        <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
        <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Setting…' : 'Set parent'}</button>
      </div>
    </SidePanel>
  );
}

/* ── Edit / delete an existing hand-off ────────────────────────────────── */
export function EditHandoffDialog({ edge, fromName, toName, ops = liveOps, onClose, onDone }) {
  const { from, to, label, triggerId } = edge;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [fromFilter, setFromFilter] = useState('any-except-self');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delListener, setDelListener] = useState(true);
  const [delEmit, setDelEmit] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tt = await ops.listTriggers(to);
        if (!alive) return;
        const t = (Array.isArray(tt) ? tt : []).find(x => x.id === triggerId);
        if (t) {
          setEvents(Array.isArray(t.events) ? t.events : []);
          setFromFilter(t.from || 'any-except-self');
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  const toggleEvent = (v) => setEvents(prev =>
    prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);

  async function saveEdits() {
    setSaving(true); setError(null);
    try {
      await ops.updateTrigger(to, triggerId, { events, from: fromFilter });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  async function doDelete() {
    setSaving(true); setError(null);
    try {
      if (delListener) {
        await ops.deleteTrigger(to, triggerId);
      }
      if (delEmit) {
        // Strip the label from any emitter trigger on the source that declares it.
        const ft = await ops.listTriggers(from);
        for (const t of (Array.isArray(ft) ? ft : [])) {
          if (Array.isArray(t.emits) && t.emits.includes(label)) {
            await ops.setEmits(from, t.id, t.emits.filter(l => l !== label));
          }
        }
      }
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Edit hand-off" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> → <code>{label}</code> → <strong>{toName || to}</strong>
      </p>
      {loading ? (
        <Center><Loader2 size={14} style={spin} /> Loading…</Center>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <Field label="Listener events">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
              {LABEL_EVENTS.map(ev => (
                <label key={ev.value} style={check}>
                  <input type="checkbox" checked={events.includes(ev.value)} onChange={() => toggleEvent(ev.value)} />
                  {ev.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Origin filter (from)">
            <select value={fromFilter} onChange={e => setFromFilter(e.target.value)} style={input}>
              {FROM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>

          {error && <span style={errStyle}>{error}</span>}

          <div style={actions}>
            <button onClick={() => setConfirmDelete(true)} disabled={saving}
              style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)', marginRight: 'auto' }}>
              Delete…
            </button>
            <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
            <button onClick={saveEdits} disabled={saving} style={primary}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>

          {confirmDelete && (
            <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
              <strong style={{ fontSize: 'var(--eb-text-sm)' }}>Remove this hand-off?</strong>
              <label style={check}>
                <input type="checkbox" checked={delListener} onChange={e => setDelListener(e.target.checked)} />
                Delete listener trigger <code>{triggerId}</code> on {toName || to}
              </label>
              <label style={check}>
                <input type="checkbox" checked={delEmit} onChange={e => setDelEmit(e.target.checked)} />
                Remove <code>{label}</code> from {fromName || from}'s emits
              </label>
              <div style={actions}>
                <button onClick={() => setConfirmDelete(false)} disabled={saving} style={ghost}>Keep</button>
                <button onClick={doDelete} disabled={saving || (!delListener && !delEmit)}
                  style={{ ...primary, background: 'var(--eb-status-error)' }}>
                  {saving ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

/* ── shared bits ───────────────────────────────────────────────────────── */
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}
function Center({ children }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>{children}</div>;
}
const spin = { animation: 'spin 1s linear infinite' };
const hint = { fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginTop: 0 };
const small = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' };
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const check = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' };
const actions = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)', alignItems: 'center' };
const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
const errStyle = { fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' };
