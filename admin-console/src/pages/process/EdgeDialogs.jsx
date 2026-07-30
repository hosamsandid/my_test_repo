import React, { useEffect, useState } from 'react';
import { Loader2, ArrowUpRight } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { liveOps } from './edit-adapters';
import { TriggerForm } from '../agent-chat/TriggersPanel';
import { defaultListenerPrompt, handoffVerb, handoffTargetNoun } from './handoff-prompt';
import { isGateLabel, isBrakeLabel } from './label-flags';
import { defaultGateKind } from './human-gate-ops';
// Every multi-write hand-off goes through the wiring engine (#1002) — dialogs
// collect input and render state; they never sequence ops calls themselves.
import {
  wireLabelHandoff, updateLabelHandoff, unwireLabelHandoff,
  wireChannel, updateChannel as engineUpdateChannel, unwireChannel,
  wireHumanDelivery, wireHumanGate, wireArtifactFlow,
} from './wiring-engine';

// Only these GitHub events carry a label name, so a labelFilter is meaningful.
const LABEL_EVENTS = [
  { value: 'issues.labeled', label: 'Issue labeled' },
  { value: 'pull_request.labeled', label: 'PR labeled' },
  { value: 'issues.unlabeled', label: 'Issue unlabeled' },
  { value: 'pull_request.unlabeled', label: 'PR unlabeled' },
];

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

// Human phrase for a label event: "added to an issue" / "removed from a pull request".
function labelEventPhrase(event) {
  const removed = String(event || '').endsWith('.unlabeled');
  const noun = String(event || '').startsWith('issues.') ? 'an issue' : 'a pull request';
  return `${removed ? 'removed from' : 'added to'} ${noun}`;
}

// A trigger now carries exactly ONE event. Legacy triggers may still carry
// several — surfaced as an explicit notice in the edit dialogs, never silently
// dropped: saving keeps only the selected event.
function LegacyMultiEventNote({ events, selected }) {
  const others = (events || []).filter(e => e !== selected);
  if (!(events || []).length || (events || []).length < 2) return null;
  return (
    <div style={{ ...small, padding: 'var(--eb-space-2)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-warning)' }}>
      This trigger still listens on several events ({(events || []).map(e => <code key={e}>{e} </code>)}).
      Triggers now carry exactly one event — saving keeps only the selected one.
      Create separate triggers for {others.length === 1 ? 'the other event' : 'the other events'}.
    </div>
  );
}

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

export function CreateHandoffDialog({ from, to, fromName, toName, labels, ops = liveOps, onBack, onClose, onDone, initialLabel = '', emitSource = true }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // `initialLabel` pre-fills the label when the dialog is opened from an outcome
  // port drag (#828): the source already declares the emit via its outcome, so
  // `emitSource` is false there and only the listener on the target is created.
  const [label, setLabel] = useState(initialLabel || '');
  const [target, setTarget] = useState('issues');       // issues | pull_request
  const [action, setAction] = useState('labeled');       // labeled | unlabeled
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
  const verb = handoffVerb(action);
  const targetNoun = handoffTargetNoun(target);

  // Gate/brake classification is CONFIGURATION, not a naming convention (#928):
  // it comes from the graph's label registry (`humanGate` / `brake` flags), never
  // from the label's name. A human gate is set by a human, never by an agent, so
  // we wire only the listener and never an agent emit (#333). A brake also has no
  // agent-wired hand-off edge — it pauses the loop rather than passing work on.
  const isGate = isGateLabel(labels, label);
  const isBrake = isBrakeLabel(labels, label);
  const humanLabel = isGate || isBrake;

  const effectivePrompt = prompt
    || defaultListenerPrompt({ label, verb, targetNoun, repo, fromLabel: fromName || from, toLabel: toName || to });

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed) { setError('Enter the label name.'); return; }
    setSaving(true); setError(null);
    try {
      // The engine wires both sides: single-event listener (+claim) on B —
      // reusing an existing matching one — and the setLabel outcome on A
      // (skipped for human gates/brakes and for outcome-port drags, #828).
      await wireLabelHandoff({ ops }, {
        from, to, label: trimmed, target, action, repo,
        prompt: effectivePrompt, labels, emitSource, fromName, toName,
      });
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
              <code>{label.trim()}</code> is configured as a {isGate ? 'human gate — only a human sets it' : 'brake — it pauses the loop'}.
              This wires <strong>{toName || to}</strong> to wait on it; <strong>{fromName || from}</strong> is not recorded as emitting it.
            </div>
          ) : (
            <div style={{ ...small, padding: 'var(--eb-space-2)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)' }}>
              <strong>{fromName || from}</strong> will be recorded as emitting <code>{label.trim() || '<label>'}</code>,
              and <strong>{toName || to}</strong> gets a listener — no need to pre-configure a trigger on {fromName || from}.
            </div>
          )}

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
  from, to, fromName, toName, labels, ops = liveOps, types, fromNode, toNode, humanOps,
  onClose, onDone,
}) {
  const common = { from, to, fromName, toName, ops, onClose, onDone };
  // Legacy token: 'github' expands to the two explicit channel tiles.
  const allowed = (Array.isArray(types) && types.length ? types : ['label', 'dependency', 'artifact'])
    .flatMap(t => (t === 'github' ? ['github-pr', 'github-issue'] : [t]));
  const [type, setType] = useState(allowed.length === 1 ? allowed[0] : null);

  // Named human roles (#987): a person is never wired as a GitHub channel on a
  // role (that lookup fails — "role <id> not found"). Route to the dedicated
  // human forms, which write the human's `consumes` / `emits` via humanOps.
  //   agent → human  = a delivery the person reviews.
  //   human → agent  = a gate label the person applies.
  if (toNode && toNode.kind === 'human') {
    return <HumanDeliveryForm {...common} humanOps={humanOps} fromNode={fromNode} />;
  }
  if (fromNode && fromNode.kind === 'human') {
    return <HumanGateForm {...common} humanOps={humanOps} />;
  }

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

/* ── Add input chooser (Routing → Inputs, #866) ─────────────────────────────
 * The inspector-side sibling of the canvas CreateEdgeDialog: one [+ Add input]
 * entry point onto the SAME plain-language vocabulary and the SAME ops the
 * canvas drags use, so an input can be authored from the inspector without
 * dragging on the canvas (closes the create-on-canvas / remove-only-in-inspector
 * asymmetry of §3). `node` is the consumer being woken; connection tiles
 * (channel / artifact) first pick the upstream producer, then reuse the exact
 * canvas form. Trigger tiles create a manual trigger directly on this node. */
export function AddInputDialog({ node, peers = [], labels = [], ops = liveOps, onClose, onDone }) {
  const [step, setStep] = useState(null);       // null = tile chooser
  const [fromPeer, setFromPeer] = useState(null);
  const toName = node.displayName || node.id;
  const sources = peers.filter(p => p && p.id !== node.id);
  const toTiles = () => { setFromPeer(null); setStep(null); };
  const common = { to: node.id, toName, ops, onClose, onDone };

  if (step === 'event') return <GithubTriggerForm {...common} labels={labels} onBack={toTiles} />;
  if (step === 'label') return <GithubTriggerForm {...common} labels={labels} initialEvent="issues.labeled" onBack={toTiles} />;
  if (step === 'webhook') return <WebhookForm {...common} onBack={toTiles} />;
  if (step === 'schedule') return <ScheduleInputForm {...common} onBack={toTiles} />;

  if (step === 'channel:pick' || step === 'artifact:pick') {
    const artifactStep = step === 'artifact:pick';
    return (
      <PeerPicker
        title={artifactStep ? 'Artifact from another agent' : 'PR / issue from another agent'}
        prompt={artifactStep
          ? `Which agent's artifact wakes ${toName}?`
          : `Which agent's pull request / issue wakes ${toName}?`}
        peers={sources}
        onPick={(p) => { setFromPeer(p); setStep(artifactStep ? 'artifact' : 'channel'); }}
        onBack={toTiles}
        onClose={onClose}
      />
    );
  }
  if (step === 'channel' && fromPeer) {
    return <CreateChannelDialog {...common} from={fromPeer.id} fromName={fromPeer.displayName || fromPeer.id}
      onBack={() => setStep('channel:pick')} />;
  }
  if (step === 'artifact' && fromPeer) {
    return <ArtifactEdgeForm {...common} from={fromPeer.id} fromName={fromPeer.displayName || fromPeer.id}
      onBack={() => setStep('artifact:pick')} />;
  }

  const choices = [
    { id: 'event', title: 'GitHub event', desc: `${toName} wakes on a repo event (issue/PR opened, push, …).` },
    { id: 'label', title: 'Label applied', desc: `${toName} wakes when a specific label is set — by an agent or a human.` },
    { id: 'channel:pick', title: 'PR / issue from another agent', desc: `${toName} reacts to a pull request or issue another agent opens.` },
    { id: 'schedule', title: 'Schedule', desc: `${toName} wakes on a recurring cron or a one-shot time.` },
    { id: 'webhook', title: 'Webhook', desc: `An external system (CI, tooling) wakes ${toName} via an HTTP call.` },
    { id: 'artifact:pick', title: 'Artifact from another agent', desc: `${toName} consumes an artifact another agent produces.` },
  ];

  return (
    <SidePanel open onClose={onClose} title="Add input" width="520px">
      <p style={hint}>What should wake <strong>{toName}</strong>?</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        {choices.map(c => (
          <button key={c.id} onClick={() => setStep(c.id)} style={{
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

// Pick the upstream agent for a channel / artifact input authored from the
// inspector (the canvas supplies this by which node you drag from).
function PeerPicker({ title, prompt, peers, onPick, onBack, onClose }) {
  return (
    <SidePanel open onClose={onClose} title={title} width="520px">
      <p style={hint}>{prompt}</p>
      {peers.length === 0 ? (
        <p style={small}>No other agents to connect from yet — add one to the flow first.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          {peers.map(p => (
            <button key={p.id} onClick={() => onPick(p)} style={{
              textAlign: 'left', background: 'var(--eb-bg-app)', cursor: 'pointer',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              padding: 'var(--eb-space-3)', fontFamily: 'inherit',
              fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
            }}>{p.displayName || p.id}</button>
          ))}
        </div>
      )}
      <div style={{ ...actions, marginTop: 'var(--eb-space-4)' }}>
        <button onClick={onBack} style={{ ...ghost, marginRight: 'auto' }}>Back</button>
        <button onClick={onClose} style={ghost}>Cancel</button>
      </div>
    </SidePanel>
  );
}

// Schedule input — wraps the reused TriggersPanel form (cron / once, with its
// cron builder) in a SidePanel and persists via ops.createTrigger. The form's
// own type selector still lets the user flip to another trigger kind, so nothing
// the Triggers tab offered is lost (concept §6 capability parity).
function ScheduleInputForm({ to, toName, ops = liveOps, onBack, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  async function save(body) {
    setSaving(true);
    try { await ops.createTrigger(to, body); onDone?.(); }
    finally { setSaving(false); }
  }
  return (
    <SidePanel open onClose={onClose} title="Add a schedule" width="520px">
      <p style={hint}>
        <strong>{toName}</strong> wakes on a recurring schedule or at a one-shot time.
      </p>
      {/* No initialValues → create mode: the Type selector stays open (cron is
          the default; the user can flip to Once), the ID auto-generates. */}
      <TriggerForm
        agentId={to}
        ops={ops}
        saving={saving}
        onSave={save}
        onCancel={onBack || onClose}
      />
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
      // The engine flags the producer (badge + prompt block, audience flags
      // preserved) and upserts the channel port on the consumer.
      await wireChannel({ ops }, {
        from, to, artifact, label,
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

/* ── Human delivery (agent → named human role, #987) ─────────────────────────
 * Drag an agent's ● port onto a human box: the producer's PR / issue / file
 * output is reviewed by that person. Writes the delivery to the human's
 * `consumes` via humanOps — never a GitHub channel on a role (dropping on a
 * human used to fail with "role <id> not found"). */
export function HumanDeliveryForm({ from, to, fromName, toName, ops = liveOps, humanOps, fromNode, onBack, onClose, onDone }) {
  const outputs = (fromNode && Array.isArray(fromNode.outputs) ? fromNode.outputs : [])
    .map(a => ((a && (a.name || a.path)) ? { key: a.name || a.path } : null)).filter(Boolean);
  const options = [
    { id: 'pr', title: 'Pull request', desc: `${fromName || from} opens a PR that ${toName || to} reviews / merges.` },
    { id: 'issue', title: 'Issue', desc: `${fromName || from} opens an issue that ${toName || to} reviews.` },
    ...outputs.map(o => ({ id: `file:${o.key}`, title: `Output · ${o.key}`, desc: `${toName || to} reads the ${o.key} artifact.` })),
  ];
  const [choice, setChoice] = useState(options[0].id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setSaving(true); setError(null);
    try {
      // The engine flags the producer for PR/issue deliveries (audience flags
      // preserved) and writes the consume onto the human role.
      const entry = (choice === 'pr' || choice === 'issue')
        ? { artifact: choice, from }
        : { artifact: 'file', name: choice.slice('file:'.length) };
      await wireHumanDelivery({ ops, humanOps }, { human: to, entry });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Deliver to a human role" width="520px">
      <p style={hint}>
        <strong>{toName || to}</strong> (a person) reviews something <strong>{fromName || from}</strong> produces.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="What does this person review?">
          <select value={choice} onChange={e => setChoice(e.target.value)} style={input}>
            {options.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          <small style={small}>{options.find(o => o.id === choice)?.desc}</small>
        </Field>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          {onBack && <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>}
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Wiring…' : 'Wire delivery'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

/* ── Human gate (named human role → agent, #987) ─────────────────────────────
 * Drag a human box's ● port onto an agent: the person applies a label that
 * wakes the agent (a gate). Adds the label to the human's `emits` (making it a
 * gate) AND creates the listener trigger on the agent so the edge draws. The
 * listener carries exactly ONE event — defaulted from the artifact the person
 * already reviews, overridable via the same Issue/PR kind selector the label
 * hand-off dialog uses — and the derived claim (#1000, D1–D3). */
export function HumanGateForm({ from, to, fromName, toName, ops = liveOps, humanOps, onBack, onClose, onDone }) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('issues'); // issues | pull_request
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Default the gate's artifact kind from the human's `consumes`: a person who
  // reviews a PR gates that PR; an issue reviewer gates the issue.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const human = await humanOps?.getHuman?.(from);
        if (alive && human) setKind(defaultGateKind(human));
      } catch { /* keep the issues default */ }
    })();
    return () => { alive = false; };
  }, [from]);

  async function submit() {
    const l = label.trim();
    if (!l) { setError('Enter the label this person applies.'); return; }
    setSaving(true); setError(null);
    try {
      await wireHumanGate({ ops, humanOps }, { human: from, to, label: l, kind });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Human gate" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> (a person) applies a label that wakes <strong>{toName || to}</strong> — an approval gate.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        <Field label="Label kind">
          <select value={kind} onChange={e => setKind(e.target.value)} style={input}>
            {LABEL_TARGETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <small style={small}>
            Listens on <code>{kind}.labeled</code> — what the person applies the label to.
          </small>
        </Field>
        <Field label="Gate label the person applies">
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. approved-for-dispatch" style={input} />
          <small style={small}>Only this person may set it (an agent setting it is a gate-violation). {toName || to} wakes when it is applied to {kind === 'pull_request' ? 'a pull request' : 'an issue'}.</small>
        </Field>
        {error && <span style={errStyle}>{error}</span>}
        <div style={actions}>
          {onBack && <button onClick={onBack} disabled={saving} style={{ ...ghost, marginRight: 'auto' }}>Back</button>}
          <button onClick={onClose} disabled={saving} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primary}>{saving ? 'Wiring…' : 'Create gate'}</button>
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
      // The engine writes both ports (or the plain dependency when no artifact
      // is given) — named artifacts are matched by name, a bare path is a
      // path-keyed artifact (BriefingPack-style).
      await wireArtifactFlow({ ops }, { from, to, name: nm, hint: h, description });
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
  if (on === 'loop') return <EditLoopDialog {...props} />;
  if (on === 'event') return <EditEventDialog {...props} />;
  if (on === 'webhook') return <EditWebhookDialog {...props} />;
  if (on === 'review' || on === 'manual') return <ReadonlyEdgeDialog {...props} />;
  return <EditLabelHandoff {...props} />;
}

/* ── Edit / remove a GitHub channel edge (#380) ─────────────────────────────
 * The channel is a port on the consumer; editing changes the routing label +
 * human-gate, removing drops the port (the backend re-derives the trigger). */
function EditChannelDialog({ edge, fromName, toName, ops = liveOps, producerChannelCount, onClose, onDone, onOpenRouting }) {
  const { from, to, artifact: art } = edge;
  const artifact = art === 'issue' ? 'issue' : 'pr';
  const [label, setLabel] = useState(edge.label || '');
  const [human, setHuman] = useState(edge.gate === 'human');
  // Optional authored wake-prompt override (#868): empty = keep the generated
  // "a PR/issue arrived" prompt; any text overrides it on the derived listener.
  const [wakePrompt, setWakePrompt] = useState(edge.wakePrompt || '');
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
      await engineUpdateChannel({ ops }, { to, spec: {
        artifact, from,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(human ? { gate: 'human' } : {}),
        ...(wakePrompt.trim() ? { wakePrompt: wakePrompt.trim() } : {}),
      } });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }
  async function remove() {
    setSaving(true); setError(null);
    try {
      // The engine drops the port and, when confirmed, the orphaned produce
      // flag with it (audience flags preserved).
      await unwireChannel({ ops }, { from, to, artifact, clearProduces: lastChannel && clearProduces });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="GitHub channel" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong>'s {noun} → <strong>{toName || to}</strong>
      </p>
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section="inputs" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', marginTop: 'var(--eb-space-3)' }}>
        <Field label="Routing label (optional)">
          <input value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. approved" style={input} />
        </Field>
        <label style={check}>
          <input type="checkbox" checked={human} onChange={e => setHuman(e.target.checked)} />
          Human approval gate — a person applies the label
        </label>
        <Field label="Wake prompt override (optional)">
          <textarea value={wakePrompt} onChange={e => setWakePrompt(e.target.value)}
            placeholder="Leave empty to use the generated prompt for this input."
            style={{ ...input, minHeight: 90, fontFamily: 'var(--eb-font-mono)', resize: 'vertical' }} />
          <span style={hint}>
            Replaces the auto-generated prompt the derived listener wakes {toName || to} with. Empty keeps the default.
          </span>
        </Field>
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

function EditLabelHandoff({ edge, fromName, toName, ops = liveOps, onClose, onDone, onOpenRouting }) {
  const { from, to, label, triggerId } = edge;
  // Actor-sourced hand-off (#412): the label is set by a human, not an agent —
  // there is no emit to edit or strip, only the listener trigger.
  const humanSource = typeof from === 'string' && from.startsWith('@');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // One trigger = one label event: kind (issue/PR) + action (added/removed).
  const [target, setTarget] = useState('issues');
  const [action, setAction] = useState('labeled');
  const [labelName, setLabelName] = useState(label || '');
  const [initialEvents, setInitialEvents] = useState([]);
  const [repo, setRepo] = useState('');
  // The stored listener prompt. `null` = untouched / not yet loaded (AC3: seed
  // the auto-generated default); any string (incl. '') = an operator-owned value
  // shown verbatim and saved as-is (AC2 + the empty-prompt / rename edge cases).
  const [prompt, setPrompt] = useState(null);
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
          const evs = Array.isArray(t.events) ? t.events : [];
          setInitialEvents(evs);
          const first = evs.find(e => LABEL_FILTERABLE.has(e)) || evs[0] || '';
          const m = String(first).match(/^(issues|pull_request)\.(labeled|unlabeled)$/);
          if (m) { setTarget(m[1]); setAction(m[2]); }
          if (typeof t.labelFilter === 'string' && t.labelFilter.trim()) {
            setLabelName(t.labelFilter.trim());
          }
          if (typeof t.repo === 'string') setRepo(t.repo);
          // Prefill the stored prompt verbatim (AC2). A trigger with no stored
          // prompt (undefined / non-string — e.g. created before this field
          // existed) stays `null`, so the default seeds it below (AC3).
          if (typeof t.prompt === 'string') setPrompt(t.prompt);
        }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  const event = `${target}.${action}`;
  const verb = handoffVerb(action);
  const targetNoun = handoffTargetNoun(target);
  // While untouched (prompt === null), show the same auto-generated default the
  // create dialog offers, derived live from the current label/kind (AC3). Once
  // loaded from storage or edited, show that value verbatim.
  const effectivePrompt = prompt !== null
    ? prompt
    : defaultListenerPrompt({
        label: labelName, verb, targetNoun, repo,
        fromLabel: fromName || from, toLabel: toName || to,
      });

  async function saveEdits() {
    const newLabel = labelName.trim();
    if (!newLabel) { setError('Enter the label name.'); return; }
    setSaving(true); setError(null);
    try {
      // The engine updates the listener (prompt persisted verbatim — the
      // seeded default when untouched, the operator's text otherwise) and, on
      // a label rename, keeps the source's outcomes in sync (agent-sourced
      // hand-offs only — human-set labels have no emitter to rewrite).
      await updateLabelHandoff({ ops }, {
        from, to, triggerId, label, newLabel, target, action,
        prompt: effectivePrompt, humanSource,
      });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  async function doDelete() {
    setSaving(true); setError(null);
    try {
      // Symmetric cleanup via the engine: the listener on B and/or the
      // setLabel outcome on A (#783/#831 — outcomes are the emit surface).
      await unwireLabelHandoff({ ops }, {
        from, to, triggerId, label,
        removeListener: delListener, removeEmit: delEmit, humanSource,
      });
      onDone?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Edit hand-off" width="520px">
      <p style={hint}>
        <strong>{fromName || from}</strong> → <code>{label}</code> → <strong>{toName || to}</strong>
      </p>
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section="inputs" />
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
          <LegacyMultiEventNote events={initialEvents} selected={event} />
          <Field label="Label name">
            <input value={labelName} onChange={e => setLabelName(e.target.value)} style={input} />
            {labelName.trim() && labelName.trim() !== label && !humanSource && (
              <small style={small}>
                Renaming updates this listener and <strong>{fromName || from}</strong>'s emitted labels.
              </small>
            )}
          </Field>

          <Field label="Listener prompt">
            <textarea value={effectivePrompt} onChange={e => setPrompt(e.target.value)}
              style={{ ...input, minHeight: 120, fontFamily: 'var(--eb-font-mono)', resize: 'vertical' }} />
          </Field>
          <small style={small}>
            The instruction <strong>{toName || to}</strong> is woken with. Leave the
            default or refine it; clearing it saves an empty prompt.
          </small>

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
function RemoveEdgeDialog({ kind, edge, fromName, toName, ops = liveOps, onClose, onDone, onOpenRouting }) {
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
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section={isDep ? 'inputs' : 'structure'} />
      <div style={{ marginTop: 'var(--eb-space-3)' }} />
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
function RemoveArtifactEdgeDialog({ edge, fromName, ops = liveOps, onClose, onDone, onOpenRouting }) {
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
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={from} section={isOutput ? 'artifacts' : 'inputs'} />
      <div style={{ marginTop: 'var(--eb-space-3)' }} />
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

// ⏰ → agent: edit the schedule trigger via the shared chat TriggerForm (#600) —
// the single source of truth for editing every trigger type. The form is
// pre-filled from the clicked edge's trigger and covers the schedule builder,
// one-shot picker, prompt, description and enabled toggle. `allowTypeChange`
// lets the user turn the schedule into a different trigger kind (the graph
// re-derives the edge on refresh); Save patches the trigger through the ops
// adapter, so unrelated fields (emits, dataFlow, channel markers) stay intact.
function EditTimerDialog({ edge, toName, ops = liveOps, onClose, onDone, onOpenRouting }) {
  const { to, triggerId } = edge;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [initialValues, setInitialValues] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tt = await ops.listTriggers(to);
        if (!alive) return;
        const t = (Array.isArray(tt) ? tt : []).find(x => x.id === triggerId);
        setInitialValues(t || null);
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  async function handleSave(body) {
    setSaving(true); setError(null);
    try { await ops.updateTrigger(to, triggerId, body); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }
  async function handleRemove() {
    setSaving(true); setError(null);
    try { await ops.deleteTrigger(to, triggerId); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Schedule" width="520px">
      <p style={hint}>⏰ Schedule → <strong>{toName || to}</strong></p>
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section="inputs" />
      {loading ? (
        <Center><Loader2 size={14} style={spin} /> Loading…</Center>
      ) : !initialValues ? (
        <span style={errStyle}>{error || 'Trigger not found.'}</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {error && <span style={errStyle}>{error}</span>}
          <TriggerForm
            initialValues={initialValues}
            agentId={to}
            ops={ops}
            allowTypeChange
            saving={saving}
            onSave={handleSave}
            onCancel={onClose}
            onRemove={handleRemove}
          />
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

// ↻ self-edge → agent: edit the loop trigger via the shared chat TriggerForm
// (#936). Same shell as EditTimerDialog — the form is the single source of
// truth for every trigger type, so it renders the loop's full stop contract
// (max iterations / token budget / `until` command / verifier) pre-filled from
// the clicked self-edge's trigger. `allowTypeChange` lets the loop be turned
// into another trigger kind; Save patches through the ops adapter so unrelated
// fields (emits, dataFlow, channel markers) stay intact.
function EditLoopDialog({ edge, toName, ops = liveOps, onClose, onDone, onOpenRouting }) {
  const { to, triggerId } = edge;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [initialValues, setInitialValues] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tt = await ops.listTriggers(to);
        if (!alive) return;
        const t = (Array.isArray(tt) ? tt : []).find(x => x.id === triggerId);
        setInitialValues(t || null);
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  async function handleSave(body) {
    setSaving(true); setError(null);
    try { await ops.updateTrigger(to, triggerId, body); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }
  async function handleRemove() {
    setSaving(true); setError(null);
    try { await ops.deleteTrigger(to, triggerId); onDone?.(); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Loop" width="520px">
      <p style={hint}>↻ Loop → <strong>{toName || to}</strong> re-arms itself until its stop contract is met.</p>
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section="inputs" />
      {loading ? (
        <Center><Loader2 size={14} style={spin} /> Loading…</Center>
      ) : !initialValues ? (
        <span style={errStyle}>{error || 'Trigger not found.'}</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {error && <span style={errStyle}>{error}</span>}
          <TriggerForm
            initialValues={initialValues}
            agentId={to}
            ops={ops}
            allowTypeChange
            saving={saving}
            onSave={handleSave}
            onCancel={onClose}
            onRemove={handleRemove}
          />
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </SidePanel>
  );
}

// 🐙 → agent: edit the event, the optional label filter + origin filter,
// or delete. The same unified GitHub-trigger surface the create dialog offers —
// one event per trigger; legacy multi-event triggers surface a notice.
function EditEventDialog({ edge, toName, ops = liveOps, onClose, onDone, onOpenRouting }) {
  const { to, triggerId } = edge;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [event, setEvent] = useState('');
  const [initialEvents, setInitialEvents] = useState([]);
  const [label, setLabel] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tt = await ops.listTriggers(to);
        if (!alive) return;
        const t = (Array.isArray(tt) ? tt : []).find(x => x.id === triggerId);
        if (t) {
          const evs = Array.isArray(t.events) ? t.events : [];
          setInitialEvents(evs);
          setEvent(evs[0] || '');
          setLabel(typeof t.labelFilter === 'string' ? t.labelFilter : '');
        }
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [to, triggerId]);

  // Preserve events outside the common list (the Events API knows more keys) —
  // they stay selectable so an exotic trigger can be re-saved untouched.
  const known = new Set(GH_EVENTS.map(e => e.value));
  const extra = [...new Set(initialEvents.filter(e => !known.has(e)))];
  const showLabelFilter = LABEL_FILTERABLE.has(event);

  async function save() {
    if (!event) { setError('Pick the event this trigger reacts to.'); return; }
    setSaving(true); setError(null);
    try {
      const lf = label.trim();
      await ops.updateTrigger(to, triggerId, {
        events: [event],
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
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section="inputs" />
      {loading ? <Center><Loader2 size={14} style={spin} /> Loading…</Center> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
          <Field label="Event">
            <select value={event} onChange={e => setEvent(e.target.value)} style={input}>
              <option value="">— select event —</option>
              {GH_EVENTS.map(ev => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
              {extra.map(ev => <option key={ev} value={ev}>{ev}</option>)}
            </select>
          </Field>
          <LegacyMultiEventNote events={initialEvents} selected={event} />
          {showLabelFilter && (
            <Field label="Label name filter (optional)">
              <input value={label} onChange={e => setLabel(e.target.value)}
                placeholder="e.g. priorisiert, ready-for-review — empty = any label" style={input} />
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

// ⚡ → agent: show the hook URL, rotate the secret (shown once), or delete.
function EditWebhookDialog({ edge, toName, ops = liveOps, onClose, onDone, onOpenRouting }) {
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
      <OpenRoutingLink onOpenRouting={onOpenRouting} nodeId={to} section="inputs" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)', marginTop: 'var(--eb-space-3)' }}>
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
// (including labels a human sets — a label the registry flags `humanGate`
// renders as an approval gate, #928). One trigger reacts to exactly ONE event —
// reacting to a second event
// (e.g. label removed as well as added) is a second, independently configured
// trigger. There is no origin filter: the trigger fires on any matching event
// regardless of who caused it. No repo input either: the repo is resolved from
// the agent's working environment (live) or at materialise time (draft), since
// it is unknown while modelling the flow.
export function GithubTriggerForm({ to, toName, labels, ops = liveOps, onBack, onClose, onDone, initialEvent = '' }) {
  const [event, setEvent] = useState(initialEvent);
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const showLabelFilter = LABEL_FILTERABLE.has(event);
  const trimmedLabel = label.trim();
  // Flag-based (#928) — the registry says whether this label is an approval gate.
  const isGate = isGateLabel(labels, trimmedLabel);
  const labelActive = showLabelFilter && !!trimmedLabel;

  const effectivePrompt = prompt
    || (labelActive
      ? `The label \`${trimmedLabel}\` was ${labelEventPhrase(event)} (${event}). The event payload above has the details.\n\n<Describe what ${toName || to} should do.> Reply \`[PASS]\` if there's nothing to do.`
      : `A repo event (${event || '<event>'}) occurred. The event payload above has the details.\n\n<Describe what ${toName || to} should do.> Reply \`[PASS]\` if there's nothing to do.`);

  async function submit() {
    if (!event) { setError('Pick the event this trigger reacts to.'); return; }
    setSaving(true); setError(null);
    try {
      await ops.createTrigger(to, {
        type: 'github-event',
        events: [event],
        ...(labelActive ? { labelFilter: trimmedLabel } : {}),
        enabled: true,
        description: labelActive
          ? (isGate ? `Wait for human gate \`${trimmedLabel}\`` : `Wake when \`${trimmedLabel}\` is ${labelEventPhrase(event)}`)
          : `Wake on ${event}`,
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
        <Field label="Event">
          <select value={event} onChange={e => setEvent(e.target.value)} style={input}>
            <option value="">— select event —</option>
            {GH_EVENTS.map(ev => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
          </select>
          <small style={small}>
            One event per trigger. To react to a second event (e.g. the label being
            removed as well as added), create another trigger.
          </small>
        </Field>
        {showLabelFilter && (
          <Field label="Label name filter (optional)">
            <input list="pc-gh-label-list" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="e.g. priorisiert, stage:td, ready-for-review" style={input} />
            <datalist id="pc-gh-label-list">
              {(labels || []).map(l => <option key={l.name} value={l.name} />)}
            </datalist>
            <small style={small}>
              Only fire when the {event.endsWith('.unlabeled') ? 'removed' : 'added'} label matches
              this name exactly — leave empty to fire on any label.
            </small>
            {isGate && <small style={small}><code>{trimmedLabel}</code> is configured as an approval-gate label — it renders as a gate on the edge.</small>}
          </Field>
        )}
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

/* ── shared bits ───────────────────────────────────────────────────────── */
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}

// "Open in Routing" jump link (#865): closes the edge dialog and opens the owning
// node's inspector focused on the row/section that carries this edge — the same
// setRoutingFocus pattern the canvas uses for outcome edges. `section` of
// 'structure' targets the Details tab (Parent lives there now); everything else
// targets a Routing section (inputs / artifacts / legacy).
function OpenRoutingLink({ onOpenRouting, nodeId, section }) {
  if (typeof onOpenRouting !== 'function' || !nodeId) return null;
  const where = section === 'structure' ? 'Details' : 'Routing';
  return (
    <button type="button" onClick={() => onOpenRouting(nodeId, section)} style={jumpLink}>
      <ArrowUpRight size={12} /> Open in {where}
    </button>
  );
}
const jumpLink = {
  display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--eb-accent-primary)', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)',
};
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
