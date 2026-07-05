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

// The one GitHub event catalog the unified trigger dialog offers — raw repo
// events plus the label events. (The Events API splits closed PRs: `closed`
// for non-merged closes, `merged` for merged ones.)
const GH_EVENTS = [
  { value: 'issues.opened', label: 'Issue opened' },
  { value: 'issues.closed', label: 'Issue closed' },
  { value: 'issues.labeled', label: 'Issue labeled' },
  { value: 'issues.unlabeled', label: 'Issue unlabeled' },
  { value: 'pull_request.opened', label: 'PR opened' },
  { value: 'pull_request.reopened', label: 'PR reopened' },
  { value: 'pull_request.closed', label: 'PR closed (without merge)' },
  { value: 'pull_request.merged', label: 'PR merged' },
  { value: 'pull_request.labeled', label: 'PR labeled' },
  { value: 'pull_request.unlabeled', label: 'PR unlabeled' },
  { value: 'pull_request_review.submitted', label: 'PR review submitted' },
  { value: 'issue_comment.created', label: 'Comment created' },
  { value: 'push', label: 'Push' },
];
// Events that carry a `payload.label.name` — the only ones where a label
// filter makes sense (mirrors the poller / TriggersPanel semantics).
const LABEL_FILTERABLE = new Set(LABEL_EVENTS.map(e => e.value));

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

export function CreateHandoffDialog({ from, to, fromName, toName, labels, ops = liveOps, onBack, onClose, onDone }) {
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

          <Field label="Listener prompt">
            <textarea value={effectivePrompt} onChange={e => setPrompt(e.target.value)}
              style={{ ...input, minHeight: 120, fontFamily: 'var(--eb-font-mono)', resize: 'vertical' }} />
          </Field>
          <small style={small}>
            The repository is resolved automatically — from the agent's working
            environment (live team) or when the draft is materialised.
          </small>

          {error && <span style={errStyle}>{error}</span>}

          <div style={actions}>
            {onBack && <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>}
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

/* ── on-type picker: the ONE create dialog for every connection (#411) ───────
 * Drag the ● port from any source — an agent or an actor (@github /
 * @external) — onto an agent and this dialog opens. Step 1 picks the
 * connection type (filtered by the capability matrix per source kind, ranked by
 * context: a PR/Issue producer sees its channel first); step 2 is the
 * type-specific detail form, with Back always available. */
export function CreateEdgeDialog({
  from, to, fromName, toName, labels, ops = liveOps, types, fromNode,
  onClose, onDone,
}) {
  // Legacy token: 'github' expands to the two explicit channel tiles.
  const allowed = (Array.isArray(types) && types.length ? types : ['label', 'dependency', 'artifact'])
    .flatMap(t => (t === 'github' ? ['github-pr', 'github-issue'] : [t]));
  const [type, setType] = useState(allowed.length === 1 ? allowed[0] : null);

  const common = { from, to, fromName, toName, ops, onClose, onDone };
  const back = allowed.length > 1 ? () => setType(null) : undefined;

  if (type === 'label') {
    return <CreateHandoffDialog {...common} labels={labels} onBack={back} />;
  }
  if (type === 'dependency') return <DependencyEdgeForm {...common} onBack={back} />;
  if (type === 'artifact') return <ArtifactEdgeForm {...common} onBack={back} />;
  if (type === 'hierarchy') return <HierarchyEdgeForm {...common} onBack={back} />;
  if (type === 'github-pr' || type === 'github-issue') {
    return <CreateChannelDialog {...common} artifact={type === 'github-pr' ? 'pr' : 'issue'} lockArtifact onBack={back} />;
  }
  if (type === 'event') return <GithubTriggerForm {...common} labels={labels} onBack={back} />;
  if (type === 'webhook') return <WebhookForm {...common} onBack={back} />;

  const gh = (fromNode && fromNode.github) || {};
  const A = fromName || from;
  const B = toName || to;
  const choices = [
    {
      id: 'github-pr', title: 'Pull-request channel',
      desc: `${A} opens a pull request that wakes ${B} (optionally routed via a label / human approval).`,
      recommended: !!gh.producesPr,
    },
    {
      id: 'github-issue', title: 'Issue channel',
      desc: `${A} opens an issue that wakes ${B} (optionally routed via a label / human approval).`,
      recommended: !!gh.producesIssue,
    },
    { id: 'label', title: 'Label hand-off', desc: `${A} emits a label that wakes ${B}.` },
    { id: 'dependency', title: 'Dependency', desc: `${B} is woken when ${A} pushes to the repo.` },
    { id: 'artifact', title: 'Data flow / hand-off', desc: `${A} produces an artifact that ${B} consumes. Leave the name empty for a plain dependency.` },
    { id: 'hierarchy', title: 'Parent / child', desc: `${A} groups ${B} as a child — it inherits its parent's stage.` },
    { id: 'event', title: 'GitHub trigger', desc: `${B} wakes on a repo event (issue opened, PR opened, push, …) or on a label — including labels a human sets.` },
    { id: 'webhook', title: 'Webhook', desc: `An external system (CI, tooling) wakes ${B} via an HTTP call.` },
  ].filter(c => allowed.includes(c.id));
  // Context ranking (#411): recommended tiles (the source's PR/Issue badges) first.
  choices.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));

  return (
    <SidePanel open onClose={onClose} title="Create connection" width="520px">
      <p style={hint}>
        How should <strong>{B}</strong> be connected to <strong>{A}</strong>?
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        {choices.map(c => (
          <button key={c.id} onClick={() => setType(c.id)} style={{
            textAlign: 'left', background: 'var(--eb-bg-app)', cursor: 'pointer',
            border: c.recommended ? '1px solid var(--eb-accent-primary)' : '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            padding: 'var(--eb-space-3)', fontFamily: 'inherit',
          }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
              {c.title}
              {c.recommended && <span style={{ color: 'var(--eb-accent-primary)', fontWeight: 'normal' }}> — recommended</span>}
            </div>
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
export function CreateChannelDialog({ from, to, artifact: artifact0, lockArtifact, fromName, toName, ops = liveOps, onBack, onClose, onDone }) {
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
        {!lockArtifact && (
          <Field label="Artifact">
            <select value={artifact} onChange={e => setArtifact(e.target.value)} style={input}>
              <option value="pr">Pull request</option>
              <option value="issue">Issue</option>
            </select>
          </Field>
        )}
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
        {' '}It is woken when <strong>{fromName || from}</strong> pushes to the repo — this
        records the ordering; it does not block <strong>{toName || to}</strong> from running.
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
  const [name, setName] = useState('');
  const [pathHint, setPathHint] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const nm = name.trim();
  const h = pathHint.trim();

  async function submit() {
    setSaving(true); setError(null);
    try {
      if (!nm && !h) {
        // No artifact at all — a plain ordering dependency (still wakes the
        // consumer on the producer's push).
        await ops.addDependency(to, from);
      } else if (nm) {
        // Named artifact: matched by name, path is just a hint (resolved from the
        // manifest at runtime).
        await ops.addArtifact(from, { direction: 'output', name: nm, hint: h, description });
        await ops.addArtifact(to, { direction: 'input', name: nm, hint: h, description });
      } else {
        // Only a concrete path given → a path-keyed artifact (BriefingPack-style).
        await ops.addArtifact(from, { direction: 'output', path: h, description });
        await ops.addArtifact(to, { direction: 'input', path: h, description });
      }
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Add data flow" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> produces an artifact that <strong>{toName || to}</strong> consumes.
        {' '}<strong>{toName || to}</strong> is woken when <strong>{fromName || from}</strong> pushes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Artifact name (optional)">
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Functional Design" style={input} />
          <small style={small}>
            The logical name of the hand-off. Matched by name, so the exact path can
            vary per run — the consumer resolves it from the artifact manifest
            (<code>aee-artifact</code>). Leave empty for a plain dependency.
          </small>
        </Field>
        <Field label="Path / path hint (optional)">
          <input value={pathHint} onChange={e => setPathHint(e.target.value)}
            placeholder="e.g. designs/**  — where it usually lands" style={input} />
          <small style={small}>
            With a name: an informational hint. Without a name: a fixed path the
            artifact is matched on exactly.
          </small>
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={e => setDescription(e.target.value)}
            placeholder="What this artifact carries" style={input} />
        </Field>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>
            {saving ? 'Adding…' : (!nm && !h ? 'Add dependency' : 'Add data flow')}
          </button>
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

/* ── Edit / delete an existing edge — the one "Connection" shell (#412) ─────
 * Every clickable edge opens the same shell: type + endpoints + the type's
 * editable properties (where it has any) + delete. Actor edges (timer, event,
 * webhook, human-set label) are fully editable; edges whose ops the adapter
 * doesn't support (e.g. parent links in the BP view) and derived edges render
 * read-only with a pointer to their source of truth. Same surface in draft,
 * live and BP — the ops adapter differs underneath. */
export function EditHandoffDialog(props) {
  const on = props.edge?.on;
  const ops = props.ops || liveOps;
  if (on === 'dependency') {
    return ops.removeDependency ? <RemoveEdgeDialog kind={on} {...props} /> : <ReadonlyEdgeDialog {...props} />;
  }
  if (on === 'parent') {
    return ops.setParent ? <RemoveEdgeDialog kind={on} {...props} /> : <ReadonlyEdgeDialog {...props} />;
  }
  if (on === 'artifact') {
    return ops.removeArtifact ? <RemoveArtifactEdgeDialog {...props} /> : <ReadonlyEdgeDialog {...props} />;
  }
  if (on === 'github') return <EditChannelDialog {...props} />;
  if (on === 'timer') return <EditTimerDialog {...props} />;
  if (on === 'event') return <EditEventDialog {...props} />;
  if (on === 'webhook') return <EditWebhookDialog {...props} />;
  if (on === 'review' || on === 'manual') return <ReadonlyEdgeDialog {...props} />;
  return <EditLabelHandoff {...props} />;
}

/* ── Edit / remove a GitHub channel edge (#380) ─────────────────────────────
 * The channel is a port on the consumer; editing changes the routing label +
 * human-gate, removing drops the port (the backend re-derives the trigger). */
function EditChannelDialog({ edge, fromName, toName, ops = liveOps, producerChannelCount, onClose, onDone }) {
  const { from, to, artifact: art } = edge;
  const artifact = art === 'issue' ? 'issue' : 'pr';
  const [label, setLabel] = useState(edge.label || '');
  const [human, setHuman] = useState(edge.gate === 'human');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const noun = artifact === 'pr' ? 'pull request' : 'issue';
  // Produce-flag cleanup (#412): when this is the last channel consuming the
  // producer's PR/issue, offer to clear the orphaned produce flag with it.
  const lastChannel = typeof producerChannelCount === 'number' && producerChannelCount <= 1;
  const [clearProduces, setClearProduces] = useState(true);

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
    try {
      await ops.removeChannel(to, { artifact, from });
      if (lastChannel && clearProduces && ops.getRoleGithub && ops.setGithubProduces) {
        const g = (await ops.getRoleGithub(from)) || {};
        const next = { pr: !!g.producesPr, issue: !!g.producesIssue };
        if (artifact === 'pr') next.pr = false; else next.issue = false;
        await ops.setGithubProduces(from, next);
      }
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
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
        {lastChannel && (
          <label style={check}>
            <input type="checkbox" checked={clearProduces} onChange={e => setClearProduces(e.target.checked)} />
            On remove: also clear “opens {noun}s” on {fromName || from} (nothing consumes it any more)
          </label>
        )}
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
  // Actor-sourced hand-off (#412): the label is set by a human, not an agent —
  // there is no emit to edit or strip, only the listener trigger.
  const humanSource = typeof from === 'string' && from.startsWith('@');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [fromFilter, setFromFilter] = useState('any-except-self');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delListener, setDelListener] = useState(true);
  const [delEmit, setDelEmit] = useState(!humanSource);

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
      if (delEmit && !humanSource) {
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
              {!humanSource && (
                <label style={check}>
                  <input type="checkbox" checked={delEmit} onChange={e => setDelEmit(e.target.checked)} />
                  Remove <code>{label}</code> from {fromName || from}'s emits
                </label>
              )}
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

/* ── Actor-edge editors (#412): same shell, per-type properties + delete ──── */

// ⏰ → agent: edit the cron expression / one-shot timestamp, or delete.
function EditTimerDialog({ edge, toName, ops = liveOps, onClose, onDone }) {
  const { to, triggerId } = edge;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('cron');
  const [cron, setCron] = useState('');
  const [at, setAt] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tt = await ops.listTriggers(to);
        if (!alive) return;
        const t = (Array.isArray(tt) ? tt : []).find(x => x.id === triggerId);
        if (t) {
          setKind(t.type === 'once' ? 'once' : 'cron');
          setCron(t.cron || '');
          setAt(t.at || '');
        }
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  async function save() {
    setSaving(true); setError(null);
    try {
      if (kind === 'cron') await ops.updateTrigger(to, triggerId, { cron: cron.trim() });
      else await ops.updateTrigger(to, triggerId, { at });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }
  async function remove() {
    setSaving(true); setError(null);
    try { await ops.deleteTrigger(to, triggerId); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Schedule" width="520px">
      <p style={hint}>⏰ Schedule → <strong>{toName || to}</strong></p>
      {loading ? <Center><Loader2 size={14} style={spin} /> Loading…</Center> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          {kind === 'cron' ? (
            <Field label="Cron expression (min hour dom mon dow)">
              <input value={cron} onChange={e => setCron(e.target.value)} style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} />
              <small style={small}>{cronPreview(cron)}</small>
            </Field>
          ) : (
            <Field label="Run at (ISO timestamp)">
              <input value={at} onChange={e => setAt(e.target.value)} style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} />
            </Field>
          )}
          {error && <span style={errStyle}>{error}</span>}
          <div style={actions}>
            <button onClick={remove} disabled={saving}
              style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)', marginRight: 'auto' }}>Remove</button>
            <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
            <button onClick={save} disabled={saving} style={primary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

// 🐙 → agent: edit the event set, the optional label filter + origin filter,
// or delete. The same unified GitHub-trigger surface the create dialog offers.
function EditEventDialog({ edge, toName, ops = liveOps, onClose, onDone }) {
  const { to, triggerId } = edge;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [label, setLabel] = useState('');
  const [fromFilter, setFromFilter] = useState('any-except-self');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tt = await ops.listTriggers(to);
        if (!alive) return;
        const t = (Array.isArray(tt) ? tt : []).find(x => x.id === triggerId);
        if (t) {
          setEvents(Array.isArray(t.events) ? t.events : []);
          setLabel(typeof t.labelFilter === 'string' ? t.labelFilter : '');
          setFromFilter(typeof t.from === 'string' ? t.from : 'any-except-self');
        }
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  // Preserve events outside the common list (the Events API knows more keys).
  const known = new Set(GH_EVENTS.map(e => e.value));
  const extra = events.filter(e => !known.has(e));
  const toggle = (v) => setEvents(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  const showLabelFilter = events.some(e => LABEL_FILTERABLE.has(e));

  async function save() {
    setSaving(true); setError(null);
    try {
      const lf = label.trim();
      await ops.updateTrigger(to, triggerId, {
        events, from: fromFilter,
        labelFilter: (showLabelFilter && lf) ? lf : null,
      });
      onDone?.();
    }
    catch (e) { setError(e.message); setSaving(false); }
  }
  async function remove() {
    setSaving(true); setError(null);
    try { await ops.deleteTrigger(to, triggerId); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="GitHub trigger" width="520px">
      <p style={hint}>🐙 GitHub → <strong>{toName || to}</strong></p>
      {loading ? <Center><Loader2 size={14} style={spin} /> Loading…</Center> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <Field label="Events">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
              {GH_EVENTS.map(ev => (
                <label key={ev.value} style={check}>
                  <input type="checkbox" checked={events.includes(ev.value)} onChange={() => toggle(ev.value)} />
                  {ev.label}
                </label>
              ))}
              {extra.map(ev => (
                <label key={ev} style={check}>
                  <input type="checkbox" checked onChange={() => toggle(ev)} />
                  <code>{ev}</code>
                </label>
              ))}
            </div>
          </Field>
          {showLabelFilter && (
            <Field label="Label name filter (optional)">
              <input value={label} onChange={e => setLabel(e.target.value)}
                placeholder="e.g. priorisiert, human:approved — empty = any label" style={input} />
            </Field>
          )}
          <Field label="Origin filter (from)">
            <select value={fromFilter} onChange={e => setFromFilter(e.target.value)} style={input}>
              {FROM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          {error && <span style={errStyle}>{error}</span>}
          <div style={actions}>
            <button onClick={remove} disabled={saving}
              style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)', marginRight: 'auto' }}>Remove</button>
            <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
            <button onClick={save} disabled={saving} style={primary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

// ⚡ → agent: show the hook URL, rotate the secret (shown once), or delete.
function EditWebhookDialog({ edge, toName, ops = liveOps, onClose, onDone }) {
  const { to, triggerId, label } = edge;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [rotated, setRotated] = useState(null); // new secret, shown once
  const isDraft = ops.mode === 'draft';

  async function rotate() {
    setSaving(true); setError(null);
    try {
      const secret = generateHookSecret();
      await ops.updateTrigger(to, triggerId, { secret });
      setRotated(secret);
      setSaving(false);
    } catch (e) { setError(e.message); setSaving(false); }
  }
  async function remove() {
    setSaving(true); setError(null);
    try { await ops.deleteTrigger(to, triggerId); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Webhook" width="520px">
      <p style={hint}>⚡ {label || 'Webhook'} → <strong>{toName || to}</strong></p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {isDraft ? (
          <div style={small}>The URL exists once the team is materialised.</div>
        ) : (
          <Field label="URL (webhook server, HOOK_PORT)">
            <code style={{ ...input, display: 'block', userSelect: 'all' }}>POST /hooks/{to}/{triggerId}</code>
          </Field>
        )}
        <div style={small}>
          The caller must send the trigger's secret in <code>X-Hook-Secret</code>. The current
          secret is only shown at creation — rotate it to get a new one.
        </div>
        {rotated && (
          <Field label="New X-Hook-Secret (shown once — copy it now)">
            <code style={{ ...input, display: 'block', userSelect: 'all', wordBreak: 'break-all' }}>{rotated}</code>
          </Field>
        )}
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          <button onClick={remove} disabled={saving}
            style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)', marginRight: 'auto' }}>Remove</button>
          <button onClick={rotate} disabled={saving} style={ghost}>Rotate secret</button>
          <button onClick={() => (rotated ? onDone?.() : onClose())} style={primary}>{rotated ? 'Done' : 'Close'}</button>
        </div>
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

/* ── Actor-sourced connections (#411): @github / @external ──────────────────
 * Each form creates one trigger on the target agent — the same data the
 * inspector's trigger tab writes, reachable with the same ● drag gesture. */

// The ONE GitHub-trigger dialog: raw repo events AND label-based triggers
// (including labels a human sets — the former "Label set by a human" form is
// folded in here via the `humans` origin filter). No repo input: the repo is
// resolved from the agent's working environment (live) or at materialise
// time (draft), since it is unknown while modelling the flow.
export function GithubTriggerForm({ to, toName, labels, ops = liveOps, onBack, onClose, onDone }) {
  const [events, setEvents] = useState([]);
  const [label, setLabel] = useState('');
  const [fromFilter, setFromFilter] = useState('any-except-self');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toggle = (v) => setEvents(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  const showLabelFilter = events.some(e => LABEL_FILTERABLE.has(e));
  const trimmedLabel = label.trim();
  const isGate = trimmedLabel.startsWith('human:');
  const labelActive = showLabelFilter && !!trimmedLabel;

  const effectivePrompt = prompt
    || (labelActive
      ? `The label \`${trimmedLabel}\` changed on an issue/PR (${events.filter(e => LABEL_FILTERABLE.has(e)).join(', ')}). The event payload above has the details.\n\n<Describe what ${toName || to} should do.> Reply \`[PASS]\` if there's nothing to do.`
      : `A repo event (${events.join(', ') || '<event>'}) occurred. The event payload above has the details.\n\n<Describe what ${toName || to} should do.> Reply \`[PASS]\` if there's nothing to do.`);

  async function submit() {
    if (!events.length) { setError('Pick at least one event.'); return; }
    setSaving(true); setError(null);
    try {
      await ops.createTrigger(to, {
        type: 'github-event',
        events,
        from: fromFilter,
        ...(labelActive ? { labelFilter: trimmedLabel } : {}),
        enabled: true,
        description: labelActive
          ? (isGate ? `Wait for human gate \`${trimmedLabel}\`` : `Wake on label \`${trimmedLabel}\``)
          : `Wake on ${events.join(', ')}`,
        prompt: effectivePrompt,
      });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="GitHub trigger" width="520px">
      <p style={hint}>
        <strong>{toName || to}</strong> wakes on a GitHub event — a raw repo event, or a
        specific label (set by an agent or a human).
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Events">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
            {GH_EVENTS.map(ev => (
              <label key={ev.value} style={check}>
                <input type="checkbox" checked={events.includes(ev.value)} onChange={() => toggle(ev.value)} />
                {ev.label}
              </label>
            ))}
          </div>
        </Field>
        {showLabelFilter && (
          <Field label="Label name filter (optional)">
            <input list="pc-gh-label-list" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="e.g. priorisiert, stage:td, human:approved" style={input} />
            <datalist id="pc-gh-label-list">
              {(labels || []).map(l => <option key={l.name} value={l.name} />)}
            </datalist>
            <small style={small}>
              Only fire when the changed label matches this name exactly — leave empty to fire on any label.
            </small>
            {isGate && <small style={small}><code>{trimmedLabel}</code> is an approval-gate label — it renders as a gate on the edge.</small>}
          </Field>
        )}
        <Field label="Origin filter (from)">
          <select value={fromFilter} onChange={e => setFromFilter(e.target.value)} style={input}>
            {FROM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <small style={small}>Use <code>humans</code> to react only to events humans caused (e.g. a label a person applies).</small>
        </Field>
        <Field label="Listener prompt">
          <textarea value={effectivePrompt} onChange={e => setPrompt(e.target.value)}
            style={{ ...input, minHeight: 100, fontFamily: 'var(--eb-font-mono)', resize: 'vertical' }} />
        </Field>
        <small style={small}>
          The repository is resolved automatically — from the agent's working environment
          (live team) or when the draft is materialised.
        </small>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          {onBack && <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>}
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Wiring…' : 'Create trigger'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

// Webhook (@external actor): an http trigger the webhook server fires on
// POST /hooks/<agentId>/<triggerId> with X-Hook-Secret. The secret is generated
// client-side (same as the trigger inspector) and shown once after creation.
function generateHookSecret() {
  const arr = new Uint8Array(24);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function WebhookForm({ to, toName, ops = liveOps, onBack, onClose, onDone }) {
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null); // { id, secret } after submit

  const isDraft = ops.mode === 'draft';
  const effectivePrompt = prompt
    || `An external system called this agent's webhook${description ? ` (${description})` : ''}. <Describe what ${toName || to} should do.> Reply \`[PASS]\` if there's nothing to do.`;

  async function submit() {
    setSaving(true); setError(null);
    try {
      const secret = generateHookSecret();
      const t = await ops.createTrigger(to, {
        type: 'http',
        secret,
        enabled: true,
        description: description.trim() || 'Webhook',
        prompt: effectivePrompt,
      });
      setCreated({ id: t && t.id, secret });
      setSaving(false);
    } catch (e) { setError(e.message); setSaving(false); }
  }

  if (created) {
    return (
      <SidePanel open onClose={() => onDone?.()} title="Webhook created" width="520px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {isDraft ? (
            <p style={hint}>
              The webhook trigger is part of the draft. The final URL exists once the
              team is materialised; the secret below is already stored on the trigger.
            </p>
          ) : (
            <Field label="URL (webhook server, HOOK_PORT)">
              <code style={{ ...input, display: 'block', userSelect: 'all' }}>
                POST /hooks/{to}/{created.id || '<trigger-id>'}
              </code>
            </Field>
          )}
          <Field label="X-Hook-Secret (shown once — copy it now)">
            <code style={{ ...input, display: 'block', userSelect: 'all', wordBreak: 'break-all' }}>{created.secret}</code>
          </Field>
          <div style={actions}>
            <button onClick={() => onDone?.()} style={primary}>Done</button>
          </div>
        </div>
      </SidePanel>
    );
  }

  return (
    <SidePanel open onClose={onClose} title="Webhook" width="520px">
      <p style={hint}>
        An external system (CI, tooling) wakes <strong>{toName || to}</strong> via
        {' '}<code>POST /hooks/&lt;agent&gt;/&lt;trigger&gt;</code> with an <code>X-Hook-Secret</code> header.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Description">
          <input value={description} onChange={e => setDescription(e.target.value)}
            placeholder="e.g. CI pipeline finished" style={input} />
        </Field>
        <Field label="Prompt">
          <textarea value={effectivePrompt} onChange={e => setPrompt(e.target.value)}
            style={{ ...input, minHeight: 100, fontFamily: 'var(--eb-font-mono)', resize: 'vertical' }} />
        </Field>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          {onBack && <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>}
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Creating…' : 'Create webhook'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

// Human-readable cron summary — used by the schedule edit dialog (opened from
// the ⏰ row inside the agent card; new schedules are added in the inspector's
// Triggers tab).
export function cronPreview(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return 'Expected 5 fields: minute hour day-of-month month day-of-week';
  const [min, hr, dom, mon, dow] = p;
  const DAYS = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
  const two = (s) => String(s).padStart(2, '0');
  if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
    const time = `${two(hr)}:${two(min)}`;
    if (dom === '*' && mon === '*' && dow === '*') return `every day at ${time}`;
    if (dom === '*' && mon === '*' && DAYS[dow]) return `every ${DAYS[dow]} at ${time}`;
    if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `on day ${dom} of every month at ${time}`;
  }
  if (/^\*\/\d+$/.test(min) && hr === '*') return `every ${min.slice(2)} minutes`;
  if (min === '0' && /^\*\/\d+$/.test(hr)) return `every ${hr.slice(2)} hours`;
  return 'custom schedule';
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
