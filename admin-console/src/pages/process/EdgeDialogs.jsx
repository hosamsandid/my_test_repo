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

/* ── Create a label hand-off: A → label → B ─────────────────────────────────
 * Mirrors the data-flow dialog: draw A→B, choose the label kind (issue / PR),
 * whether it's added or removed, and the name. Both sides are wired
 * automatically — B gets a listener (the derived event + labelFilter) and A is
 * recorded as emitting the label (an agent-level emit, no pre-existing trigger
 * required). Human gates/brakes are listener-only (no agent emits them). */
const LABEL_TARGETS = [
  { value: 'issues', label: 'Issue label' },
  { value: 'pull_request', label: 'Pull-request label' },
];
const LABEL_ACTIONS = [
  { value: 'labeled', label: 'added' },
  { value: 'unlabeled', label: 'removed' },
];

export function CreateHandoffDialog({ from, to, fromName, toName, labels, ops = liveOps, onClose, onDone }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [toTriggers, setToTriggers] = useState([]);
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState('issues');       // issues | pull_request
  const [action, setAction] = useState('labeled');       // labeled | unlabeled
  const [fromFilter, setFromFilter] = useState('any-except-self');
  const [repo, setRepo] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [ft, tt] = await Promise.all([ops.listTriggers(from), ops.listTriggers(to)]);
        if (!alive) return;
        const fl = Array.isArray(ft) ? ft : [];
        const tl = Array.isArray(tt) ? tt : [];
        setToTriggers(tl);
        setRepo(firstRepo(fl, tl));
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [from, to]);

  const event = `${target}.${action}`; // e.g. issues.labeled, pull_request.unlabeled
  const verb = action === 'labeled' ? 'added to' : 'removed from';
  const targetNoun = target === 'issues' ? 'an issue' : 'a pull request';

  // Human gates (human:*) and the universal brakes are set by humans, never by
  // an agent — wire only the listener, never an agent emit (#333).
  const isGate = label.trim().startsWith('human:');
  const isBrake = label.trim() === 'hold' || label.trim() === 'needs:human';
  const humanLabel = isGate || isBrake;

  const effectivePrompt = prompt
    || `\`${label || '<label>'}\` was ${verb} ${targetNoun} in \`${repo || '<repo>'}\` by ${fromName || from}. The event payload above has the details.\n\n<Describe what ${toName || to} should do.> Reply \`[PASS]\` if there's nothing to do.`;

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed) { setError('Enter the label name.'); return; }
    setSaving(true); setError(null);
    try {
      // 1. Listener on B — skip if one already filters on this label + event.
      const existing = toTriggers.find(t =>
        t.type === 'github-event' && t.labelFilter === trimmed &&
        Array.isArray(t.events) && t.events.includes(event));
      if (!existing) {
        await ops.createTrigger(to, {
          type: 'github-event',
          events: [event],
          from: fromFilter,
          repo: repo || undefined,
          labelFilter: trimmed,
          enabled: true,
          description: humanLabel
            ? `Wait for human gate \`${trimmed}\``
            : `Wake when \`${trimmed}\` is ${verb} ${targetNoun} (from ${fromName || from})`,
          prompt: effectivePrompt,
        });
      }
      // 2. Record A as emitting the label — an agent-level emit, so the edge is
      // wired without depending on a pre-existing trigger on A. Skipped for
      // human gates/brakes (no agent may claim to set those).
      if (!humanLabel) {
        const current = await ops.getRoleEmits(from);
        await ops.setRoleEmits(from, uniq([...(Array.isArray(current) ? current : []), trimmed]));
      }
      onDone?.();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <SidePanel open onClose={onClose} title="Wire a label hand-off" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> sets a label that wakes <strong>{toName || to}</strong>.
      </p>
      {loading ? (
        <Center><Loader2 size={14} style={spin} /> Loading…</Center>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <Field label="Label kind">
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
              <select value={target} onChange={e => setTarget(e.target.value)} style={{ ...input, flex: 1 }}>
                {LABEL_TARGETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={action} onChange={e => setAction(e.target.value)} style={{ ...input, flex: 1 }}>
                {LABEL_ACTIONS.map(o => <option key={o.value} value={o.value}>label {o.label}</option>)}
              </select>
            </div>
            <small style={small}>
              Listens on <code>{event}</code> — wakes when the label is {verb} {targetNoun}.
            </small>
          </Field>

          <Field label="Label name">
            <input list="pc-label-list" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="e.g. dispatch, stage:td, ready-for-review" style={input} />
            <datalist id="pc-label-list">
              {(labels || []).map(l => <option key={l.name} value={l.name} />)}
            </datalist>
          </Field>

          {humanLabel ? (
            <div style={{ ...small, padding: 'var(--eb-space-2)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-warning)' }}>
              <code>{label.trim()}</code> is a {isGate ? 'human gate' : 'brake'} — only a human sets it.
              This wires <strong>{toName || to}</strong> to wait on it; <strong>{fromName || from}</strong> is not recorded as emitting it.
            </div>
          ) : (
            <div style={{ ...small, padding: 'var(--eb-space-2)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)' }}>
              <strong>{fromName || from}</strong> will be recorded as emitting <code>{label.trim() || '<label>'}</code>,
              and <strong>{toName || to}</strong> gets a listener — no need to pre-configure a trigger on {fromName || from}.
            </div>
          )}

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
  if (type === 'github') {
    return (
      <CreateChannelDialog from={from} to={to} fromName={fromName} toName={toName}
        ops={ops} onBack={() => setType(null)} onClose={onClose} onDone={onDone} />
    );
  }

  const choices = [
    { id: 'github', title: 'GitHub PR / Issue', desc: `${fromName || from} opens a PR/issue that wakes ${toName || to} (optionally via a human-approved label).` },
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

/* ── Create a GitHub channel: A opens a PR/Issue that wakes B (#380) ─────────
 * Stored as a declarative `channels` port on the *consumer* (B); the backend
 * derives the github-event trigger. An optional label + human-approval gate model
 * "A opens a PR → a human labels it → B is woken". Also ensures A is marked as
 * producing that artifact so the producer badge/prompt-block appear. */
export function CreateChannelDialog({ from, to, artifact: artifact0, fromName, toName, ops = liveOps, onBack, onClose, onDone }) {
  const [artifact, setArtifact] = useState(artifact0 === 'issue' ? 'issue' : 'pr');
  const [label, setLabel] = useState('');
  const [human, setHuman] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const noun = artifact === 'pr' ? 'pull request' : 'issue';

  async function submit() {
    if (human && !label.trim()) { setError('A human-approval gate needs the label a human applies.'); return; }
    setSaving(true); setError(null);
    try {
      // Ensure the producer is flagged so its badge + prompt block appear.
      if (ops.getRoleGithub && ops.setGithubProduces) {
        const g = (await ops.getRoleGithub(from)) || {};
        const next = { pr: !!g.producesPr, issue: !!g.producesIssue };
        if (artifact === 'pr') next.pr = true; else next.issue = true;
        if (next.pr !== !!g.producesPr || next.issue !== !!g.producesIssue) {
          await ops.setGithubProduces(from, next);
        }
      }
      await ops.addChannel(to, {
        artifact, from,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(human ? { gate: 'human' } : {}),
      });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Wire a GitHub channel" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> opens a {noun} that wakes <strong>{toName || to}</strong>.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Artifact">
          <select value={artifact} onChange={e => setArtifact(e.target.value)} style={input}>
            <option value="pr">Pull request</option>
            <option value="issue">Issue</option>
          </select>
        </Field>
        <Field label="Routing label (optional)">
          <input value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. approved — only wake on this label" style={input} />
          <small style={small}>
            Leave empty to wake on every {noun} {fromName || from} opens. With a label, {toName || to}
            {' '}wakes only when that label is present on the {noun}.
          </small>
        </Field>
        <label style={check}>
          <input type="checkbox" checked={human} onChange={e => setHuman(e.target.checked)} />
          Human approval gate — a person applies the label (renders as a gate on the edge)
        </label>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          {onBack && <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>}
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Wiring…' : 'Create channel'}</button>
        </div>
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

/* ── Edit / delete an existing edge ─────────────────────────────────────────
 * Type-aware dispatcher: label hand-offs keep the full editor; dependency /
 * data-flow / parent edges get a focused remove dialog; derived edges (a
 * PR-review outcome, a manual pass-through) are read-only here. Same surface in
 * draft and live — the ops adapter differs underneath. */
export function EditHandoffDialog(props) {
  const on = props.edge?.on;
  if (on === 'dependency' || on === 'parent') return <RemoveEdgeDialog kind={on} {...props} />;
  if (on === 'artifact') return <RemoveArtifactEdgeDialog {...props} />;
  if (on === 'github') return <EditChannelDialog {...props} />;
  if (on === 'review' || on === 'manual') return <ReadonlyEdgeDialog {...props} />;
  return <EditLabelHandoff {...props} />;
}

/* ── Edit / remove a GitHub channel edge (#380) ─────────────────────────────
 * The channel is a port on the consumer; editing changes the routing label +
 * human-gate, removing drops the port (the backend re-derives the trigger). */
function EditChannelDialog({ edge, fromName, toName, ops = liveOps, onClose, onDone }) {
  const { from, to, artifact: art } = edge;
  const artifact = art === 'issue' ? 'issue' : 'pr';
  const [label, setLabel] = useState(edge.label || '');
  const [human, setHuman] = useState(edge.gate === 'human');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const noun = artifact === 'pr' ? 'pull request' : 'issue';

  async function save() {
    if (human && !label.trim()) { setError('A human-approval gate needs the label a human applies.'); return; }
    setSaving(true); setError(null);
    try {
      await (ops.updateChannel || ops.addChannel)(to, {
        artifact, from,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(human ? { gate: 'human' } : {}),
      });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }
  async function remove() {
    setSaving(true); setError(null);
    try { await ops.removeChannel(to, { artifact, from }); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="GitHub channel" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong>'s {noun} → <strong>{toName || to}</strong>
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Routing label (optional)">
          <input value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. approved" style={input} />
        </Field>
        <label style={check}>
          <input type="checkbox" checked={human} onChange={e => setHuman(e.target.checked)} />
          Human approval gate — a person applies the label
        </label>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          <button onClick={remove} disabled={saving}
            style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)', marginRight: 'auto' }}>
            Remove
          </button>
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={save} disabled={saving} style={primary}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

function EditLabelHandoff({ edge, fromName, toName, ops = liveOps, onClose, onDone }) {
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
        // Strip the label from the source's agent-level emits (the new default
        // wiring) …
        if (ops.getRoleEmits && ops.setRoleEmits) {
          const cur = await ops.getRoleEmits(from);
          if (Array.isArray(cur) && cur.includes(label)) {
            await ops.setRoleEmits(from, cur.filter(l => l !== label));
          }
        }
        // … and from any legacy per-trigger emits that still declare it.
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

/* ── Remove a dependency or parent edge ─────────────────────────────────── */
function RemoveEdgeDialog({ kind, edge, fromName, toName, ops = liveOps, onClose, onDone }) {
  const { from, to } = edge;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const isDep = kind === 'dependency';

  async function remove() {
    setSaving(true); setError(null);
    try {
      if (isDep) await ops.removeDependency(to, from); // "to depends on from"
      else await ops.setParent(to, null);              // "from is parent of to"
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title={isDep ? 'Dependency' : 'Parent / child'} width="520px">
      <p style={hint}>
        {isDep ? (
          <><strong>{toName || to}</strong> depends on <strong>{fromName || from}</strong>.</>
        ) : (
          <><strong>{fromName || from}</strong> is the parent of <strong>{toName || to}</strong>.</>
        )}
      </p>
      {error && <span style={errStyle}>{error}</span>}
      <div style={actions}>
        <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
        <button onClick={remove} disabled={saving} style={{ ...primary, background: 'var(--eb-status-error)' }}>
          {saving ? 'Removing…' : (isDep ? 'Remove dependency' : 'Remove parent link')}
        </button>
      </div>
    </SidePanel>
  );
}

/* ── Remove one side of a data-flow (artifact) edge ─────────────────────────
 * The graph routes data flow through a shared artifact node, so a click targets
 * exactly one port — a producer's output or a consumer's input of that path. */
function RemoveArtifactEdgeDialog({ edge, fromName, ops = liveOps, onClose, onDone }) {
  const { from, direction, path } = edge;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const isOutput = direction === 'output';

  async function remove() {
    setSaving(true); setError(null);
    try { await ops.removeArtifact(from, { direction, path }); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Data flow" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> {isOutput ? 'produces' : 'consumes'} <code>{path}</code>.
      </p>
      <div style={{ ...small, marginBottom: 'var(--eb-space-3)' }}>
        Removes this {isOutput ? 'output' : 'input'} port only. The other side of the flow (if any) stays —
        remove it from its own node to clear the whole hand-off.
      </div>
      {error && <span style={errStyle}>{error}</span>}
      <div style={actions}>
        <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
        <button onClick={remove} disabled={saving} style={{ ...primary, background: 'var(--eb-status-error)' }}>
          {saving ? 'Removing…' : `Remove ${isOutput ? 'output' : 'input'}`}
        </button>
      </div>
    </SidePanel>
  );
}

/* ── Derived edges (PR-review outcome, manual pass-through) — read-only here ── */
function ReadonlyEdgeDialog({ edge, fromName, toName, onClose }) {
  const { from, to, on } = edge;
  return (
    <SidePanel open onClose={onClose} title={on === 'review' ? 'PR review' : 'Connection'} width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> → <strong>{toName || to}</strong>
      </p>
      <div style={small}>
        {on === 'review'
          ? 'This edge is derived from a PR-review step. Edit it in the reviewer’s inspector (reviews-from / on-approve / on-changes), not here.'
          : 'This connection is derived and can’t be edited here.'}
      </div>
      <div style={actions}>
        <button onClick={onClose} style={ghost}>Close</button>
      </div>
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
